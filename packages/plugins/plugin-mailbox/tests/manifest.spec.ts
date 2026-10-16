import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAIL_SENDERS } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { parseMailboxConfig, parseTriageAssignee, validateMailboxConfig, DEFAULT_GOOGLE_CLIENT_ID } from "../src/config.js";

type SafeParse = { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } };

/** The host's own manifest schema (read-only, loaded at runtime so tsc keeps its rootDir). */
async function hostManifestSchema(): Promise<SafeParse> {
  const url = new URL("../../../shared/src/validators/plugin.ts", import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ url)) as { pluginManifestV1Schema: SafeParse };
  return mod.pluginManifestV1Schema;
}

describe("manifest", () => {
  it("ships one version: package.json, the manifest and the README agree", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(pkg.version).toBe(manifest.version);
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(`## ${manifest.version.replace(/\.\d+$/, ".0")}:`);
  });

  it("passes the host manifest validator (webhooks need their capability, tools their schema, jobs a valid cron)", async () => {
    const result = (await hostManifestSchema()).safeParse(manifest);
    expect(result.success ? [] : result.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
    // A webhook without its capability is refused: the capability is what makes the host serve the route.
    const without = { ...manifest, capabilities: manifest.capabilities.filter((cap) => cap !== "webhooks.receive") };
    expect((await hostManifestSchema()).safeParse(without).success).toBe(false);
  });

  it("declares the Gmail job, the OAuth route and the capabilities it uses", () => {
    expect(manifest.version).toBe("0.6.5");
    for (const cap of ["jobs.schedule", "http.outbound", "secrets.read-ref", "events.emit", "events.subscribe", "api.routes.register", "plugin.state.read", "plugin.state.write", "issues.create", "issues.wakeup", "issues.read", "issues.update", "issue.comments.create", "ui.page.register", "agents.read", "webhooks.receive"]) {
      expect(manifest.capabilities).toContain(cap);
    }
    expect(manifest.jobs).toEqual([
      expect.objectContaining({ jobKey: "sync-mailbox", schedule: "*/2 * * * *" }),
      expect.objectContaining({ jobKey: "setup-status", schedule: "29 * * * *" }),
      expect.objectContaining({ jobKey: "check-domain-health", schedule: "17 5 * * *" }),
    ]);
    // The public one-click unsubscribe address (RFC 8058) and the capability the host needs to serve it.
    expect(manifest.webhooks).toEqual([expect.objectContaining({ endpointKey: "resend" }), expect.objectContaining({ endpointKey: "unsubscribe" })]);
    expect(manifest.apiRoutes).toEqual([
      expect.objectContaining({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", auth: "board" }),
      expect.objectContaining({ routeKey: "setup-status", method: "GET", path: "/setup-status", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
      expect.objectContaining({ routeKey: "cockpit", method: "GET", path: "/cockpit", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
    ]);
    const props = (manifest.instanceConfigSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const key of ["publicBaseUrl", "encryptionKey", "google", "jev", "labelPrefix", "triageIssueAssignee", "sendRatePerMinute", "replyIssues", "r2", "autoDelegate", "domainChecks", "dkimSelectors", "unsubscribe", "esp"]) expect(props).toHaveProperty(key);
    expect((props.unsubscribe!.properties as Record<string, Record<string, unknown>>).secret).toMatchObject({ format: "secret-ref" });
    expect(props.autoDelegate).toMatchObject({ enum: ["operator", "operator+roles", "off"], default: "operator" });
    expect((props.r2!.properties as Record<string, Record<string, unknown>>).secretAccessKey).toMatchObject({ format: "secret-ref" });
    expect(props.encryptionKey).toMatchObject({ format: "secret-ref" });
    expect(props.encryptionKey).not.toHaveProperty("type");
    expect((props.google!.properties as Record<string, Record<string, unknown>>).clientId!.default).toBe(DEFAULT_GOOGLE_CLIENT_ID);
  });

  it("keeps every existing tool name and adds the new ones", () => {
    const names = manifest.tools!.map((t) => t.name);
    for (const name of ["create-draft", "send-draft", "list-inbox", "mark-read", "create-email-template", "list-email-templates", "list-threads", "search-mail", "get-message", "correct-triage", "mail-status", "list-mailboxes", "get-attachment", "check-sender-domain", "sender-domain-health", "map-client-mail", "list-client-mail-maps", "remove-client-mail-map", "add-sending-domain", "list-sending-domains"]) {
      expect(names).toContain(name);
    }
    const draft = manifest.tools!.find((t) => t.name === "create-draft")!.parametersSchema as { required: string[] };
    expect(draft.required).toEqual(["accountId", "subject"]);
  });

  it("listens to every mail sender in the contract", () => {
    expect(MAIL_SENDERS.length).toBeGreaterThanOrEqual(7);
  });
});

describe("config", () => {
  it("parses defaults, the assignee and the rate", () => {
    expect(parseMailboxConfig({})).toMatchObject({ saved: false, labelPrefix: "PiB", sendRatePerMinute: 20, googleClientId: DEFAULT_GOOGLE_CLIENT_ID, triageAssignee: null });
    expect(parseMailboxConfig({ labelPrefix: " /Ops/ ", sendRatePerMinute: 5 })).toMatchObject({ saved: true, labelPrefix: "Ops", sendRatePerMinute: 5 });
    expect(parseTriageAssignee("user:abc")).toEqual({ userId: "abc" });
    expect(parseTriageAssignee("agent:xyz")).toEqual({ agentId: "xyz" });
    expect(parseTriageAssignee("xyz")).toEqual({ agentId: "xyz" });
    expect(validateMailboxConfig({ publicBaseUrl: "http://example.com", sendRatePerMinute: 0 }).errors).toHaveLength(2);
    expect(validateMailboxConfig({ encryptionKey: "typed-in" }).warnings).toHaveLength(1);
  });
});
