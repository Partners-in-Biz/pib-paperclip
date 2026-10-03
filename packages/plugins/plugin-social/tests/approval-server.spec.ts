/**
 * 0.8.0 (Q1a-2): ops/approval-server, the public page where a client approves a post. The page and the form checks are pure
 * (render.mjs) and tested here; server.mjs, the unit and the SQL are checked against the contract they must keep.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashToken as pluginHash } from "../src/client-approval.js";
import { approvalPage, esc, hashToken, messagePage, parseDecision, SECURITY_HEADERS, TOKEN_RE } from "../ops/approval-server/render.mjs";

const read = (file: string) => readFileSync(new URL(`../ops/approval-server/${file}`, import.meta.url), "utf8");

const snapshot = {
  version: 1,
  poster: "Partners in Biz",
  clientName: "Acme",
  timezone: "Africa/Johannesburg",
  scheduledAt: "2026-10-09T07:30:00Z",
  firstComment: "More at the shop",
  media: [
    { url: "https://media.test/a.png", kind: "image", altText: "A shop front" },
    { url: "https://media.test/b.mp4", kind: "video", altText: null },
    { url: "http://insecure.test/c.png", kind: "image", altText: null },
    { url: "javascript:alert(1)", kind: "image", altText: null },
  ],
  destinations: [{ platform: "linkedin", label: "LinkedIn", account: "Acme <Page>", text: "Spring sale <script>alert(1)</script>\nFriday", title: "Sale", link: "https://acme.test/sale" }],
};

describe("tokens", () => {
  it("hashes exactly like the plugin does (the service looks up by this hash)", () => {
    for (const token of ["a".repeat(43), "Zy_-0123456789abcdefghijklmnopqrstuvwxyzABCDE"]) expect(hashToken(token)).toBe(pluginHash(token));
  });

  it("accepts only the 43-character tokens the plugin makes", () => {
    expect(TOKEN_RE.test("a".repeat(43))).toBe(true);
    for (const bad of ["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, `../${"a".repeat(40)}`]) expect(TOKEN_RE.test(bad), bad).toBe(false);
  });
});

describe("the page", () => {
  const html = approvalPage(snapshot, { status: "pending", action: "/a/TOKEN/decision" });

  it("shows the post as it will appear on each account, with the time, and the two answers", () => {
    expect(html).toContain("Please approve this post");
    expect(html).toContain("For Acme. Prepared by Partners in Biz");
    expect(html).toContain("Planned for");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("Spring sale");
    expect(html).toContain("More at the shop");
    expect(html).toContain('action="/a/TOKEN/decision"');
    expect(html).toContain('name="decision" value="approved"');
    expect(html).toContain('name="decision" value="changes_requested"');
    expect(html).toContain("Nothing is posted until you approve");
  });

  it("escapes everything that came from the post, so a caption cannot inject markup", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Spring sale &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Acme &lt;Page&gt;");
    expect(esc(`"><img src=x onerror=alert(1)>`)).toBe("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows media only from https addresses", () => {
    expect(html).toContain('src="https://media.test/a.png"');
    expect(html).toContain('alt="A shop front"');
    expect(html).toContain('<video controls playsinline preload="metadata" src="https://media.test/b.mp4">');
    expect(html).not.toContain("insecure.test");
    expect(html).not.toContain("javascript:");
  });

  it("an answered post shows the answer and no form", () => {
    const done = approvalPage(snapshot, { status: "approved", answeredBy: "Sam <Jones>", answeredAt: "2026-10-04T09:00:00Z", action: "/a/T/decision" });
    expect(done).toContain("You approved this post, Sam &lt;Jones&gt;");
    expect(done).not.toContain("<form");
    expect(approvalPage(snapshot, { status: "changes_requested" })).toContain("You asked for changes");
  });

  it("a failed answer is shown again with what the client typed and the reason", () => {
    const again = approvalPage(snapshot, { status: "pending", error: "Please type your name.", values: { name: 'Sam "S"', note: "<b>x</b>" }, action: "/a/T/decision" });
    expect(again).toContain("Please type your name.");
    expect(again).toContain('value="Sam &quot;S&quot;"');
    expect(again).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("survives a snapshot it does not understand", () => {
    expect(() => approvalPage(null)).not.toThrow();
    expect(() => approvalPage({ destinations: "nope", media: 5 })).not.toThrow();
  });

  it("message pages are plain and escaped", () => {
    const page = messagePage("This <link> is not valid", "Ask <us>.", "err");
    expect(page).toContain("This &lt;link&gt; is not valid");
    expect(page).toContain("Ask &lt;us&gt;.");
    expect(page).toContain('class="err"');
  });
});

describe("the decision form", () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  it("needs a decision and a name; asking for changes needs a note", () => {
    expect(parseDecision(form({ decision: "approved", name: "Sam Jones" }))).toEqual({ ok: true, decision: "approved", name: "Sam Jones", note: null });
    expect(parseDecision(form({ decision: "approved", name: "Sam", note: " Looks good " }))).toMatchObject({ ok: true, note: "Looks good" });
    expect(parseDecision(form({ decision: "maybe", name: "Sam" }))).toMatchObject({ ok: false, error: "Please choose Approve or Request changes." });
    expect(parseDecision(form({ decision: "approved", name: " S " }))).toMatchObject({ ok: false, error: expect.stringContaining("your name") });
    expect(parseDecision(form({ decision: "changes_requested", name: "Sam", note: " " }))).toMatchObject({ ok: false, error: expect.stringContaining("what you would like changed"), values: { name: "Sam", note: "" } });
    expect(parseDecision(form({ decision: "changes_requested", name: "Sam", note: "New logo" }))).toMatchObject({ ok: true, decision: "changes_requested", note: "New logo" });
  });

  it("cuts long input", () => {
    const parsed = parseDecision(form({ decision: "approved", name: "n".repeat(300), note: "x".repeat(3000) }));
    expect(parsed.ok && parsed.name.length).toBe(120);
    expect(parsed.ok && parsed.note?.length).toBe(1000);
  });
});

describe("what the service may do", () => {
  it("never runs scripts, never sends the referrer (the token is in the URL) and is never cached or indexed", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("script-src");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("img-src https: data:");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["Cache-Control"]).toBe("no-store");
    expect(SECURITY_HEADERS["X-Robots-Tag"]).toContain("noindex");
  });

  it("answers only on POST, once, for a pending unexpired link, and a GET changes nothing", () => {
    const server = read("server.mjs");
    const updates = server.match(/UPDATE \$\{SCHEMA\}\.client_approvals[\s\S]*?\[hashToken/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()");
    expect(updates[0]).toContain("notified_at = NULL");
    expect(server).toContain('req.method === "POST" && m[2]');
    expect(server).not.toMatch(/INSERT|DELETE|DROP/);
    expect(server).toContain("/health");
    expect(server).toContain("SELECT 1");
  });

  it("has a database role that reads the snapshot and writes only the answer columns", () => {
    const sql = read("setup.sql");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA plugin_social_e70c4e79f2 FROM pib_approval");
    expect(sql).toContain("GRANT SELECT (token_hash, status, snapshot, answered_by_name, answered_at, expires_at) ON plugin_social_e70c4e79f2.client_approvals TO pib_approval");
    expect(sql).toContain("GRANT UPDATE (status, answered_by_name, answer_note, answered_at, notified_at) ON plugin_social_e70c4e79f2.client_approvals TO pib_approval");
    expect(sql).not.toMatch(/GRANT (ALL|INSERT|DELETE|TRUNCATE)/i);
    expect(sql).not.toMatch(/SUPERUSER(?!.*NO)/);
    expect(sql).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
    // Every column the server selects or updates is one the role is granted.
    const server = read("server.mjs");
    for (const column of ["status", "snapshot", "answered_by_name", "answered_at", "expires_at", "token_hash"]) expect(sql, column).toContain(column);
    expect(server).toContain("SELECT ${COLUMNS} FROM");
    expect(server).toContain("status, snapshot, answered_by_name, answered_at, expires_at < now() AS expired");
  });

  it("the unit runs as the paperclip user, hardened like the preview service, on its own port", () => {
    const unit = read("pib-approval.service");
    for (const line of ["User=paperclip", "EnvironmentFile=/root/pib-ops/approval.env", "NoNewPrivileges=true", "ProtectSystem=strict", "PrivateTmp=true", "ProtectHome=read-only", "/home/paperclip/pib-approval/server.mjs"]) expect(unit).toContain(line);
    expect(read("server.mjs")).toContain("PORT ?? 3032");
  });

  it("the install script never prints the password and creates the settings file once, readable only by root", () => {
    const script = read("install.sh");
    expect(script).toContain("umask 077");
    expect(script).toContain("chmod 600");
    expect(script).toMatch(/to_regclass\('plugin_social_e70c4e79f2\.client_approvals'\)/);
    expect(script).not.toMatch(/echo[^\n]*\$PASSWORD|printf[^\n]*\$PASSWORD[^\n]*>&?2/);
    expect(script).toContain("set -euo pipefail");
  });

  it("the install script waits for the service to answer instead of failing the one check after a one-second sleep", () => {
    const script = read("install.sh");
    const start = script.indexOf("systemctl restart pib-approval");
    const after = script.slice(start);
    expect(after).toMatch(/for attempt in 1 2 3 4 5 6 7 8 9 10/);
    expect(after).toContain("curl -fsS http://127.0.0.1:3032/a/health >/dev/null 2>&1");
    expect(after).toContain("journalctl -u pib-approval");
    // A genuinely dead service still fails the install (the loop ends in an exit, and the final check is strict).
    expect(after).toMatch(/\[ "\$attempt" = "10" \] && \{[^}]*exit 1/);
    expect(after).not.toMatch(/\|\| true/);
  });

  it("the service refuses answers from the server itself and survives a dropped database connection", () => {
    const server = read("server.mjs");
    expect(server).toContain("os.networkInterfaces()");
    expect(server).toContain("fromThisServer(ip)");
    // The check sits inside the POST branch, before anything is read or written.
    expect(server.indexOf("fromThisServer(ip)")).toBeGreaterThan(server.indexOf('req.method === "POST" && m[2]'));
    expect(server.indexOf("fromThisServer(ip)")).toBeLessThan(server.indexOf("await readForm(req)"));
    expect(server).toContain('pool.on("error"');
  });
});
