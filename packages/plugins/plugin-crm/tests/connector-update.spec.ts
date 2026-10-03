import { describe, expect, it, vi } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";

// The build writes the real version and hash; these tests pin a newer bundle than any site reports.
vi.mock("../src/connector-bundle.generated.js", () => ({
  BUNDLED_CONNECTOR_VERSION: "1.2.0",
  BUNDLED_CONNECTOR_SHA256: "ab".repeat(32),
}));

const { BOARD, boot, CO, tool, toolRaw } = await import("./helpers/crm.js");
const { connectorUpdateVia, connectorVersionWarning, DEFAULT_PUBLIC_ORIGIN } = await import("../src/sites.js");

const UI_BASE = "/_plugins/11111111-2222-3333-4444-555555555555/ui/";
const ZIP = `${DEFAULT_PUBLIC_ORIGIN}${UI_BASE}pib-connector.zip`;

type Answer = { status: number; json: unknown } | null;
type Call = { route: string; body: Record<string, unknown> };

/** A paired WordPress site whose Connector reports `version`; every call is recorded. */
async function pairedSite(version: string, extra: { config?: Record<string, unknown>; endpoints?: string[]; answer?: (route: string) => Answer } = {}) {
  const { harness, store } = await boot(extra.config ? { config: { timezone: "Africa/Johannesburg", ...extra.config } } : {});
  await rememberPluginUiBase(harness.ctx, UI_BASE);
  const saved = await tool(harness, "save-client-site", { client: "company:acme", url: "https://www.acme.co.za", platform: "wordpress" });
  await harness.performAction("crm.connect-client-site", { siteId: saved.site.id }, { companyId: CO, actor: BOARD });
  const state = { version };
  const calls: Call[] = [];
  vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.replace(/^\/wp-json\/pib-connector\/v1\//, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ route, body });
    const custom = extra.answer?.(route);
    if (custom) return new Response(JSON.stringify(custom.json), { status: custom.status, headers: { "content-type": "application/json" } });
    const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    if (route === "ping") return ok({ connector: { version: state.version } });
    if (route === "health") return ok({ connector: { version: state.version, features: {}, ...(extra.endpoints ? { endpoints: extra.endpoints } : {}) }, seoPlugin: { key: "yoast" }, site: { blogPublic: true }, plugins: [] });
    if (route === "self/update") {
      state.version = "1.2.0";
      return ok({ changeId: "chg-upd", before: { version: "1.1.0" }, after: { version: "1.2.0" }, backupId: "pib-connector-1.1.0-20261001" });
    }
    return ok({ changeId: "chg-x" });
  });
  return { harness, store, siteId: saved.site.id as string, calls };
}

describe("connector version helpers", () => {
  it("says which way an out-of-date Connector gets updated", () => {
    expect(connectorUpdateVia("1.0.3", "1.2.0")).toBe("wp-admin upload");
    expect(connectorUpdateVia("1.1.0", "1.2.0")).toBe("wp-connector");
    expect(connectorUpdateVia("1.2.0", "1.2.0")).toBeNull();
    expect(connectorUpdateVia("1.3.0", "1.2.0")).toBeNull();
    expect(connectorUpdateVia(null, "1.2.0")).toBeNull();
  });

  it("warns in the wording each case needs", () => {
    expect(connectorVersionWarning("1.1.0", ZIP)).toBe("Connector 1.1.0 is out of date (bundled 1.2.0): run wp-connector update.");
    const old = connectorVersionWarning("1.0.4", ZIP)!;
    expect(old).toContain("Connector 1.0.4 is out of date (bundled 1.2.0)");
    expect(old).toContain("cannot update itself");
    expect(old).toContain("Needs you");
    expect(old).toContain(ZIP);
    expect(connectorVersionWarning("1.2.0", ZIP)).toBeNull();
  });
});

describe("check-client-site and the Connector version", () => {
  it("1.0.x: the warning puts the zip upload on Needs you with the download link, and the version is stored", async () => {
    const { harness, store, siteId } = await pairedSite("1.0.2");
    const checked = await harness.performAction<Record<string, any>>("crm.check-client-site", { siteId }, { companyId: CO, actor: BOARD });
    expect(checked.site.connector).toMatchObject({ version: "1.0.2", bundledVersion: "1.2.0", updateAvailable: true, updateVia: "wp-admin upload" });
    expect(checked.warnings.join(" ")).toContain("Connector 1.0.2 is out of date (bundled 1.2.0)");
    expect(checked.warnings.join(" ")).toContain(ZIP);
    expect(store.client_sites![0]!.connector_version).toBe("1.0.2");
  });

  it("1.1+: the warning says the agent runs wp-connector update", async () => {
    const { harness, siteId } = await pairedSite("1.1.0");
    const checked = await tool(harness, "check-client-site", { siteId });
    expect(checked.warnings).toContain("Connector 1.1.0 is out of date (bundled 1.2.0): run wp-connector update.");
    expect(checked.site.connector.updateVia).toBe("wp-connector");
  });
});

describe("wp-connector", () => {
  it("update sends the bundled zip address and hash itself, needs a reason, and refuses a caller-supplied zipUrl or sha256", async () => {
    const { harness, store, siteId, calls } = await pairedSite("1.1.0");
    expect((await toolRaw(harness, "wp-connector", { siteId, op: "update" })).error).toMatch(/reason is required/);
    const withUrl = await toolRaw(harness, "wp-connector", { siteId, op: "update", reason: "Update", zipUrl: "https://evil.test/x.zip" });
    expect(withUrl.error).toMatch(/takes no zipUrl or sha256/);
    const withHash = await toolRaw(harness, "wp-connector", { siteId, op: "update", reason: "Update", sha256: "c".repeat(64) });
    expect(withHash.error).toMatch(/takes no zipUrl or sha256/);
    expect(calls.some((c) => c.route === "self/update")).toBe(false);

    const out = await tool(harness, "wp-connector", { siteId, op: "update", reason: "Needs the media routes" });
    expect(out).toMatchObject({ endpoint: "self/update", changeId: "chg-upd", installedBefore: "1.1.0", bundledVersion: "1.2.0", backupId: "pib-connector-1.1.0-20261001" });
    const sent = calls.find((c) => c.route === "self/update")!;
    expect(sent.body).toEqual({ zipUrl: ZIP, sha256: "ab".repeat(32), reason: "Needs the media routes" });
    expect(store.site_changes).toEqual([expect.objectContaining({ endpoint: "self/update", change_ref: "chg-upd", ok: true, target: "connector 1.1.0 → 1.2.0" })]);
    expect(store.client_sites![0]!.connector_version).toBe("1.2.0");
  });

  it("uses the public address saved in the CRM settings for the zip", async () => {
    const { harness, siteId, calls } = await pairedSite("1.1.0", { config: { publicBaseUrl: "https://paperclip.example.test/" } });
    await tool(harness, "wp-connector", { siteId, op: "update", reason: "Update" });
    expect(calls.find((c) => c.route === "self/update")!.body.zipUrl).toBe(`https://paperclip.example.test${UI_BASE}pib-connector.zip`);
  });

  it("refuses when the site already reports the bundled version", async () => {
    const { harness, siteId, calls } = await pairedSite("1.2.0");
    const res = await toolRaw(harness, "wp-connector", { siteId, op: "update", reason: "Update" });
    expect(res.error).toMatch(/already runs Connector 1\.2\.0 \(bundled 1\.2\.0\): nothing to update/);
    expect(calls.some((c) => c.route === "self/update")).toBe(false);
  });

  it("refuses on 1.0.x with the one-time upload instruction and the download link", async () => {
    const { harness, siteId, calls } = await pairedSite("1.0.3");
    const res = await toolRaw(harness, "wp-connector", { siteId, op: "update", reason: "Update" });
    expect(res.error).toMatch(/cannot update itself/);
    expect(res.error).toContain(ZIP);
    expect(res.error).toMatch(/Needs you/);
    expect(calls.some((c) => c.route === "self/update")).toBe(false);
  });

  it("refuses when the site lists its endpoints and self/update is not one of them", async () => {
    const { harness, siteId } = await pairedSite("1.1.0", { endpoints: ["ping", "health", "seo/get"] });
    const res = await toolRaw(harness, "wp-connector", { siteId, op: "update", reason: "Update" });
    expect(res.error).toMatch(/cannot update itself/);
  });

  it("rollback passes only backupId and reason, and works for an agent", async () => {
    const { harness, siteId, calls } = await pairedSite("1.2.0", { answer: (route) => (route === "self/rollback" ? { status: 200, json: { ok: true, data: { changeId: "chg-rb", restoredVersion: "1.1.0" } } } : null) });
    const out = await tool(harness, "wp-connector", { siteId, op: "rollback", backupId: "pib-connector-1.1.0-20261001", reason: "Update broke the shop", zipUrl: "https://evil.test/x.zip" });
    expect(out).toMatchObject({ endpoint: "self/rollback", restoredVersion: "1.1.0" });
    expect(calls.find((c) => c.route === "self/rollback")!.body).toEqual({ backupId: "pib-connector-1.1.0-20261001", reason: "Update broke the shop" });
  });
});

describe("1.1 tools against an older Connector", () => {
  it("explains an old install instead of calling it missing, and does not mark the site as broken", async () => {
    const { harness, store, siteId } = await pairedSite("1.0.1", {
      answer: (route) => (route.startsWith("media/") ? { status: 404, json: { code: "rest_no_route", message: "No route", data: { status: 404 } } } : null),
    });
    const res = await toolRaw(harness, "wp-media", { siteId, op: "list" });
    expect(res.error).toMatch(/runs Connector 1\.0\.1/);
    expect(res.error).toMatch(/cannot update itself/);
    expect(res.error).not.toMatch(/not installed or not active/);
    expect(store.client_sites![0]!.connector_status).toBe("connected");
  });
});
