/**
 * 0.8.0 (Q1a-2): the real ops/approval-server/server.mjs, run as a child process against a stand-in for the `pg` module (the service
 * loads pg from the Paperclip runtime on the VPS). Proves the routes, the answer-once rule, that a GET never changes anything, and the
 * security headers, over real HTTP.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../ops/approval-server/render.mjs";

const OPS = fileURLToPath(new URL("../ops/approval-server/", import.meta.url));
const TOKENS = { fresh: "F".repeat(43), guarded: "G".repeat(43), answered: "A".repeat(43), expired: "E".repeat(43), superseded: "S".repeat(43), unknown: "U".repeat(43) };
const SNAPSHOT = { version: 1, poster: "Partners in Biz", clientName: "Acme", timezone: "Africa/Johannesburg", scheduledAt: "2026-10-09T07:30:00Z", firstComment: null, media: [{ url: "https://m.test/a.png", kind: "image", altText: "Shop" }], destinations: [{ platform: "linkedin", label: "LinkedIn", account: "Acme", text: "Spring sale <b>Friday</b>", title: null, link: null }] };

/** A `pg` stand-in whose Pool answers the three statements the service runs, from rows kept in a JSON file the test also reads. */
const FAKE_PG = `
const fs = require("node:fs");
const FILE = process.env.FAKE_DB;
const load = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const save = (rows) => fs.writeFileSync(FILE, JSON.stringify(rows));
class Pool {
  // The service registers a handler for the pool's 'error' event (an idle connection the database dropped must not crash it).
  on(event) {
    fs.appendFileSync(FILE + ".events", event + "\\n");
    return this;
  }
  async query(sql, params = []) {
    if (/^SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    const rows = load();
    if (/^SELECT/.test(sql) && sql.includes("client_approvals WHERE token_hash = $1")) {
      const row = rows.find((r) => r.token_hash === params[0]);
      return { rows: row ? [{ status: row.status, snapshot: row.snapshot, answered_by_name: row.answered_by_name, answered_at: row.answered_at, expired: Date.parse(row.expires_at) < Date.now() }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^UPDATE/.test(sql) && sql.includes("SET status = $2")) {
      const row = rows.find((r) => r.token_hash === params[0] && r.status === "pending" && Date.parse(r.expires_at) > Date.now());
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: params[1], answered_by_name: params[2], answer_note: params[3], answered_at: new Date().toISOString(), notified_at: null });
      save(rows);
      return { rows: [], rowCount: 1 };
    }
    throw new Error("unexpected statement: " + sql.slice(0, 80));
  }
}
module.exports = { Pool };
`;

let child: ChildProcess;
let dir: string;
let base: string;
const dbFile = () => join(dir, "db.json");
const rowsNow = () => JSON.parse(readFileSync(dbFile(), "utf8")) as Array<Record<string, unknown>>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-http-"));
  mkdirSync(join(dir, "node_modules", "pg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pg", "index.js"), FAKE_PG);
  cpSync(join(OPS, "render.mjs"), join(dir, "render.mjs"));
  writeFileSync(join(dir, "server.mjs"), readFileSync(join(OPS, "server.mjs"), "utf8").replace('createRequire("/home/paperclip/paperclip-runtime/current/node_modules/")', `createRequire(${JSON.stringify(`${dir}/`)})`));
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const row = (token: string, extra: Record<string, unknown>) => ({ token_hash: hashToken(token), status: "pending", snapshot: SNAPSHOT, answered_by_name: null, answer_note: null, answered_at: null, notified_at: null, expires_at: future, ...extra });
  writeFileSync(dbFile(), JSON.stringify([
    row(TOKENS.fresh, {}),
    row(TOKENS.guarded, {}),
    row(TOKENS.answered, { status: "approved", answered_by_name: "Sam Jones", answered_at: "2026-10-04T09:00:00Z" }),
    row(TOKENS.expired, { expires_at: past }),
    row(TOKENS.superseded, { status: "superseded" }),
  ]));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(dir, "server.mjs")], { env: { ...process.env, PORT: String(port), FAKE_DB: dbFile(), APPROVAL_DATABASE_URL: "postgres://unused" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("approval server did not start")), 8000);
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("approval service on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr!.on("data", (chunk) => reject(new Error(String(chunk))));
    child.on("exit", (code) => reject(new Error(`approval server exited ${code}`)));
  });
});

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
/** A client's answer as Caddy forwards it: X-Forwarded-For carries the client's own address (a documentation address here). */
const CLIENT_IP = "203.0.113.50";
const post = (token: string, fields: Record<string, string>, path = `/a/${token}/decision`, ip: string | null = CLIENT_IP) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: new URLSearchParams(fields).toString(),
  });

describe("approval service over HTTP", () => {
  it("answers its health check, which only a working database passes", async () => {
    const res = await get("/a/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("shows the post to the client, escaped, with the security headers", async () => {
    const res = await get(`/a/${TOKENS.fresh}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Please approve this post");
    expect(html).toContain("Spring sale &lt;b&gt;Friday&lt;/b&gt;");
    expect(html).not.toContain("<b>Friday</b>");
    expect(html).toContain(`action="/a/${TOKENS.fresh}/decision"`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("a GET never changes anything, however many times a mail scanner opens the link", async () => {
    const before = JSON.stringify(rowsNow());
    for (let i = 0; i < 3; i += 1) await get(`/a/${TOKENS.fresh}`);
    await get(`/a/${TOKENS.fresh}/decision?decision=approved&name=Scanner`);
    expect(JSON.stringify(rowsNow())).toBe(before);
  });

  it("an invalid, unknown, expired or replaced link is a plain page, never an error", async () => {
    expect((await get("/a/short")).status).toBe(404);
    expect((await get(`/a/${"x".repeat(60)}`)).status).toBe(404);
    expect((await get(`/a/${TOKENS.unknown}`)).status).toBe(404);
    expect((await get("/other")).status).toBe(404);
    const expired = await get(`/a/${TOKENS.expired}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("This link has expired");
    const replaced = await get(`/a/${TOKENS.superseded}`);
    expect(replaced.status).toBe(410);
    expect(await replaced.text()).toContain("no longer current");
    // An expired or replaced link takes no answer either.
    expect((await post(TOKENS.expired, { decision: "approved", name: "Sam" })).status).toBe(410);
    expect((await post(TOKENS.superseded, { decision: "approved", name: "Sam" })).status).toBe(410);
    expect(rowsNow().filter((r) => r.status === "approved").length).toBe(1);
  });

  it("a bad answer is shown again with the reason and records nothing", async () => {
    const res = await post(TOKENS.fresh, { decision: "approved", name: "" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Please type your name");
    const changes = await post(TOKENS.fresh, { decision: "changes_requested", name: "Sam", note: "" });
    expect(changes.status).toBe(422);
    expect(rowsNow().find((r) => r.token_hash === hashToken(TOKENS.fresh))!.status).toBe("pending");
  });

  it("refuses a body that is too big and a method it does not serve", async () => {
    expect((await post(TOKENS.fresh, { decision: "approved", name: "Sam", note: "x".repeat(20_000) })).status).toBe(413);
    expect((await get(`/a/${TOKENS.fresh}`, { method: "DELETE" })).status).toBe(405);
    expect((await get(`/a/${TOKENS.fresh}/decision`)).status).toBe(405);
  });

  it("an answer is recorded once: the name and note are stored, the plugin's job is told to pick it up, a second answer is refused", async () => {
    const res = await post(TOKENS.fresh, { decision: "changes_requested", name: " Sam   Jones ", note: "Use the new logo" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("we have your comments");
    const row = rowsNow().find((r) => r.token_hash === hashToken(TOKENS.fresh))!;
    expect(row).toMatchObject({ status: "changes_requested", answered_by_name: "Sam Jones", answer_note: "Use the new logo", notified_at: null });
    expect(typeof row.answered_at).toBe("string");
    const again = await post(TOKENS.fresh, { decision: "approved", name: "Someone Else" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("You asked for changes");
    expect(rowsNow().find((r) => r.token_hash === hashToken(TOKENS.fresh))!.status).toBe("changes_requested");
    // The link now shows the answer and no form.
    const page = await (await get(`/a/${TOKENS.fresh}`)).text();
    expect(page).toContain("You asked for changes, Sam Jones");
    expect(page).not.toContain("<form");
  });

  it("an answered link keeps its answer when someone posts to it again", async () => {
    const res = await post(TOKENS.answered, { decision: "changes_requested", name: "Mallory", note: "no" });
    expect(res.status).toBe(409);
    expect(rowsNow().find((r) => r.token_hash === hashToken(TOKENS.answered))).toMatchObject({ status: "approved", answered_by_name: "Sam Jones" });
  });

  it("refuses an answer that comes from the server itself (an agent holding the link), and records nothing", async () => {
    const before = JSON.stringify(rowsNow());
    // No X-Forwarded-For: a call straight to the port from this machine. Loopback and this machine's own addresses are refused too,
    // however they are written, including a call to the public address from the same server (Caddy then forwards the server's own address).
    const own = Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address));
    const attempts: Array<string | null> = [null, "127.0.0.1", "::1", "::ffff:127.0.0.1", ...own, ...own.map((address) => `${address}, 198.51.100.7`)];
    for (const ip of attempts) {
      const res = await post(TOKENS.guarded, { decision: "approved", name: "An Agent" }, undefined, ip);
      expect(res.status, `from ${ip}`).toBe(403);
      expect(await res.text()).toContain("Please answer from your own device");
    }
    expect(JSON.stringify(rowsNow())).toBe(before);
    // The same link answered from a client's address works.
    const ok = await post(TOKENS.guarded, { decision: "approved", name: "Sam Jones" });
    expect(ok.status).toBe(200);
    const page = await ok.text();
    expect(page).toContain("your approval is recorded");
    // The copy does not promise what the plugin decides later (a team member may still have to approve).
    expect(page).not.toContain("will post it");
    expect(rowsNow().find((r) => r.token_hash === hashToken(TOKENS.guarded))).toMatchObject({ status: "approved", answered_by_name: "Sam Jones" });
  });

  it("handles a dropped database connection instead of crashing on it: the pool's error event has a handler", () => {
    expect(readFileSync(`${dbFile()}.events`, "utf8").split("\n")).toContain("error");
  });

  it("a page view and the health check are not affected by where they come from", async () => {
    expect((await get("/a/health")).status).toBe(200);
    expect((await get(`/a/${TOKENS.answered}`)).status).toBe(200);
  });

  it("slows a flood from one address", async () => {
    const results = await Promise.all(Array.from({ length: 80 }, () => get(`/a/${TOKENS.unknown}`, { headers: { "x-forwarded-for": "203.0.113.9" } })));
    expect(results.some((r) => r.status === 429)).toBe(true);
    // Another address is not affected.
    expect((await get(`/a/${TOKENS.unknown}`, { headers: { "x-forwarded-for": "203.0.113.10" } })).status).toBe(404);
  });
});
