import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { connectorKeyId, newConnectorKey, signConnectorRequest } from "../src/connector.js";
import { NAMESPACE } from "../src/namespace.js";
import { normalizeSiteUrl } from "../src/sites.js";
import { BOARD, boot, CO, tool, toolRaw, type Harness } from "./helpers/crm.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

type Call = { url: string; headers: Record<string, string>; body: string };

/** Answers Connector calls like the WordPress plugin would; records every request. */
function fakeSite(harness: Harness, answer: (route: string, body: Record<string, unknown>, call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = String(init?.body ?? "");
    const call = { url, headers, body };
    calls.push(call);
    const route = url.includes("rest_route=") ? decodeURIComponent(url.split("rest_route=")[1]!) : new URL(url).pathname.replace(/^\/wp-json/, "");
    const res = answer(route, JSON.parse(body || "{}") as Record<string, unknown>, call);
    return new Response(JSON.stringify(res.json), { status: res.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

function verify(call: Call, key: string, route: string): boolean {
  const payload = [call.headers["x-pib-timestamp"], call.headers["x-pib-nonce"], "POST", route, createHash("sha256").update(call.body).digest("hex")].join("\n");
  return createHmac("sha256", key).update(payload).digest("hex") === call.headers["x-pib-signature"] && call.headers["x-pib-key-id"] === connectorKeyId(key);
}

async function addWordPressSite(harness: Harness) {
  const saved = await tool(harness, "save-client-site", { client: "company:acme", url: "https://www.Acme.co.za/about/", platform: "wordpress", hosting: "xneelo" });
  return saved.site as Record<string, any>;
}

describe("crm 007 migration", () => {
  const sql = readFileSync(new URL("../migrations/007_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments", () => {
    for (const statement of splitSqlStatements(sql)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    for (const table of ["client_sites", "site_changes", "client_projects"]) expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
  });
});

describe("connector signing", () => {
  it("makes pibc_ keys and signs ts, nonce, method, route and body hash", () => {
    const key = newConnectorKey();
    expect(key).toMatch(/^pibc_[A-Za-z0-9_-]{43}$/);
    expect(connectorKeyId(key)).toMatch(/^[0-9a-f]{12}$/);
    const sig = signConnectorRequest("pibc_test", { timestamp: 1_700_000_000, nonce: "ab".repeat(16), route: "/pib-connector/v1/ping", body: "{}" });
    const expected = createHmac("sha256", "pibc_test")
      .update(["1700000000", "ab".repeat(16), "POST", "/pib-connector/v1/ping", createHash("sha256").update("{}").digest("hex")].join("\n"))
      .digest("hex");
    expect(sig).toBe(expected);
  });

  it("matches the WordPress plugin's fixed test vector", () => {
    const key = "pibc_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    expect(connectorKeyId(key)).toBe("ff6dfdf7cd7d");
    expect(signConnectorRequest(key, { timestamp: 1767225600, nonce: "0123456789abcdef0123456789abcdef", route: "/pib-connector/v1/seo/get", body: '{"url":"/about/"}' }))
      .toBe("55fae793f35512198dec6aaf9cefe0f85f84df3295739891c2ac8c7b374fc723");
  });

  it("normalises site addresses to scheme and host", () => {
    expect(normalizeSiteUrl("Acme.co.za/shop")).toBe("https://acme.co.za");
    expect(normalizeSiteUrl("http://www.acme.co.za/")).toBe("http://www.acme.co.za");
    expect(() => normalizeSiteUrl("ftp://acme.co.za")).toThrow();
    expect(() => normalizeSiteUrl("localhost")).toThrow();
  });
});

describe("client websites", () => {
  it("an agent adds a site; the same host twice is refused; other modules get it without a key", async () => {
    const { harness, emit, store } = await boot();
    const site = await addWordPressSite(harness);
    expect(site).toMatchObject({ url: "https://www.acme.co.za", platform: "wordpress", hosting: "xneelo", connector: { status: "none", keyId: null } });
    expect(store.client_sites).toHaveLength(1);
    const upserts = emit.mock.calls.filter((call) => call[0] === "site.upserted");
    expect(upserts.at(-1)?.[2]).toMatchObject({ id: site.id, clientKind: "company", clientRef: "acme", platform: "wordpress" });
    expect(JSON.stringify(upserts)).not.toContain("connector_key");

    const clash = await toolRaw(harness, "save-client-site", { client: "company:globex", url: "acme.co.za" });
    expect(clash.error).toMatch(/already saved as a website of company:acme/);

    const second = await tool(harness, "save-client-site", { client: "company:acme", url: "shop.acme.co.za", platform: "custom", label: "shop" });
    const listed = await tool(harness, "list-client-sites", { client: "company:acme" });
    expect(listed.sites.map((s: { id: string }) => s.id)).toEqual([site.id, second.site.id]);
  });

  it("repo and sftp access need the site's project; connector only on WordPress", async () => {
    const { harness } = await boot();
    const noProject = await toolRaw(harness, "save-client-site", { client: "company:acme", url: "acme.co.za", platform: "wordpress", access: ["sftp"] });
    expect(noProject.error).toMatch(/need the site's Paperclip project/);
    const notWp = await toolRaw(harness, "save-client-site", { client: "company:acme", url: "acme.co.za", platform: "nextjs", access: ["connector"] });
    expect(notWp.error).toMatch(/only works on WordPress/);
  });

  it("only a person connects: the key is shown once, then Check marks the site connected", async () => {
    const { harness, store } = await boot();
    const site = await addWordPressSite(harness);
    const agentTry = await toolRaw(harness, "connect-client-site", { siteId: site.id });
    expect(agentTry.error).toMatch(/Only a person can connect a WordPress site without SFTP access/);
    const connected = await harness.performAction<Record<string, any>>("crm.connect-client-site", { siteId: site.id }, { companyId: CO, actor: BOARD });
    expect(connected.key).toMatch(/^pibc_/);
    expect(store.client_sites![0]).toMatchObject({ connector_status: "pending", connector_key: connected.key });

    const calls = fakeSite(harness, (route) => route.endsWith("/ping")
      ? { status: 200, json: { ok: true, data: { connector: { version: "1.0.0" }, keyId: connected.keyId } } }
      : { status: 200, json: { ok: true, data: { connector: { version: "1.0.0", features: { seo: true } }, seoPlugin: { key: "yoast", version: "27.7" }, site: { blogPublic: false }, plugins: [] } } });
    const checked = await harness.performAction<Record<string, any>>("crm.check-client-site", { siteId: site.id }, { companyId: CO, actor: BOARD });
    expect(checked.connected).toBe(true);
    expect(checked.site).toMatchObject({ seoPlugin: "yoast", connector: { status: "connected", version: "1.0.0" } });
    expect(checked.warnings.join(" ")).toMatch(/Search engines are discouraged/);
    expect(calls[0]!.url).toBe("https://www.acme.co.za/wp-json/pib-connector/v1/ping");
    expect(verify(calls[0]!, connected.key, "/pib-connector/v1/ping")).toBe(true);
    // The tool never hands the key to an agent.
    const listed = await tool(harness, "list-client-sites", { client: "company:acme" });
    expect(JSON.stringify(listed)).not.toContain(connected.key);
  });

  it("an agent pairs a site it can reach over SFTP, and gets the SFTP steps", async () => {
    const { harness, store } = await boot();
    harness.seed({ projects: [{ id: "proj-acme", companyId: CO, name: "Acme site" } as never] });
    const saved = await tool(harness, "save-client-site", { client: "company:acme", url: "acme.co.za", platform: "wordpress", access: ["sftp"], projectId: "proj-acme", webRoot: "public_html" });
    const paired = await tool(harness, "connect-client-site", { siteId: saved.site.id });
    expect(paired.key).toMatch(/^pibc_/);
    expect(paired.steps.join(" ")).toContain("public_html/wp-content/pib-connector-key.php");
    expect(store.client_sites![0]).toMatchObject({ connector_status: "pending", access: ["connector", "sftp"] });
  });

  it("wp-seo set sends a signed, filtered body, needs a reason and is logged; plugin installs are for people", async () => {
    const { harness, store } = await boot();
    const site = await addWordPressSite(harness);
    const { key } = await harness.performAction<Record<string, any>>("crm.connect-client-site", { siteId: site.id }, { companyId: CO, actor: BOARD });
    const calls = fakeSite(harness, (route, body) => ({ status: 200, json: { ok: true, data: { changeId: "chg-1", route, echo: body } } }));

    const noReason = await toolRaw(harness, "wp-seo", { siteId: site.id, op: "set", url: "/about", title: "About Acme" });
    expect(noReason.error).toMatch(/reason is required/);

    const out = await tool(harness, "wp-seo", { siteId: site.id, op: "set", url: "/about", title: "About Acme Plumbing", description: "Durban plumbers", reason: "Title had no brand" });
    expect(out).toMatchObject({ endpoint: "seo/set", changeId: "chg-1" });
    const call = calls.at(-1)!;
    expect(JSON.parse(call.body)).toEqual({ url: "/about", title: "About Acme Plumbing", description: "Durban plumbers", reason: "Title had no brand" });
    expect(verify(call, key, "/pib-connector/v1/seo/set")).toBe(true);
    expect(call.headers["x-pib-actor"]).toBe("agent:agent-1");
    expect(store.site_changes).toEqual([expect.objectContaining({ site_id: site.id, endpoint: "seo/set", target: "/about", change_ref: "chg-1", ok: true })]);
    // A successful call proves the key works.
    expect(store.client_sites![0]!.connector_status).toBe("connected");

    const install = await toolRaw(harness, "wp-plugins", { siteId: site.id, op: "install", zipUrl: "https://x.test/p.zip", sha256: "a".repeat(64), slug: "p", reason: "deploy" });
    expect(install.error).toMatch(/Only a person/);
    const list = await tool(harness, "wp-plugins", { siteId: site.id, op: "list" });
    expect(list.endpoint).toBe("plugins/list");
  });

  it("falls back to ?rest_route= when /wp-json is not there, and explains a missing plugin", async () => {
    const { harness } = await boot();
    const site = await addWordPressSite(harness);
    await harness.performAction("crm.connect-client-site", { siteId: site.id }, { companyId: CO, actor: BOARD });
    const calls = fakeSite(harness, (_route, _body, call) => call.url.includes("/wp-json/")
      ? { status: 404, json: "Not Found" }
      : { status: 200, json: { ok: true, data: { fields: {} } } });
    await tool(harness, "wp-seo", { siteId: site.id, op: "get", url: "/" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://www.acme.co.za/wp-json/pib-connector/v1/seo/get",
      "https://www.acme.co.za/?rest_route=%2Fpib-connector%2Fv1%2Fseo%2Fget",
    ]);

    fakeSite(harness, () => ({ status: 404, json: { code: "rest_no_route", message: "No route", data: { status: 404 } } }));
    const missing = await toolRaw(harness, "wp-health", { siteId: site.id });
    expect(missing.error).toMatch(/not installed or not active/);
  });

  it("a site without a key refuses wp-* tools with the Needs you hint", async () => {
    const { harness } = await boot();
    const site = await addWordPressSite(harness);
    const res = await toolRaw(harness, "wp-health", { siteId: site.id });
    expect(res.error).toMatch(/has no PiB Connector yet/);
  });
});

describe("client projects", () => {
  it("links a project to one client, suggests by name, and only a person unlinks", async () => {
    const { harness, store } = await boot();
    harness.seed({
      projects: [
        { id: "proj-acme", companyId: CO, name: "Acme Plumbing website", status: "in_progress" } as never,
        { id: "proj-other", companyId: CO, name: "Internal tools", status: "planned" } as never,
      ],
    });
    const before = await tool(harness, "list-client-projects", { client: "company:acme" });
    expect(before.projects).toEqual([]);
    expect(before.unlinkedProjects[0]).toMatchObject({ projectId: "proj-acme", suggested: true });

    await tool(harness, "link-client-project", { client: "company:acme", projectId: "proj-acme" });
    const taken = await toolRaw(harness, "link-client-project", { client: "company:globex", projectId: "proj-acme" });
    expect(taken.error).toMatch(/already belongs to company:acme/);
    expect(store.client_projects).toHaveLength(1);

    const ws = await harness.performAction<Record<string, any>>("crm.client-workspace", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    expect(ws.projects).toEqual([expect.objectContaining({ projectId: "proj-acme", name: "Acme Plumbing website", link: "/PIB/projects/proj-acme" })]);
    expect(ws.sites).toEqual([]);

    await expect(harness.performAction("crm.unlink-client-project", { client: "company:acme", projectId: "proj-acme" }, { companyId: CO, actor: { type: "agent", agentId: "agent-1" } as never })).rejects.toThrow(/Only a person/);
    await harness.performAction("crm.unlink-client-project", { client: "company:acme", projectId: "proj-acme" }, { companyId: CO, actor: BOARD });
    expect(store.client_projects).toHaveLength(0);
  });
});
