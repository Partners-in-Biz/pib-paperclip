import { describe, expect, it } from "vitest";
import { MAIL_SENDERS } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { parseMailboxConfig, parseTriageAssignee, validateMailboxConfig, DEFAULT_GOOGLE_CLIENT_ID } from "../src/config.js";

describe("manifest", () => {
  it("declares the Gmail job, the OAuth route and the capabilities it uses", () => {
    expect(manifest.version).toBe("0.2.1");
    for (const cap of ["jobs.schedule", "http.outbound", "secrets.read-ref", "events.emit", "events.subscribe", "api.routes.register", "plugin.state.read", "plugin.state.write", "issues.create", "issues.wakeup", "issues.read", "issues.update", "ui.page.register"]) {
      expect(manifest.capabilities).toContain(cap);
    }
    expect(manifest.jobs).toEqual([
      expect.objectContaining({ jobKey: "sync-mailbox", schedule: "*/2 * * * *" }),
      expect.objectContaining({ jobKey: "setup-status", schedule: "29 * * * *" }),
    ]);
    expect(manifest.apiRoutes).toEqual([
      expect.objectContaining({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", auth: "board" }),
      expect.objectContaining({ routeKey: "setup-status", method: "GET", path: "/setup-status", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
    ]);
    const props = (manifest.instanceConfigSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const key of ["publicBaseUrl", "encryptionKey", "google", "jev", "labelPrefix", "triageIssueAssignee", "sendRatePerMinute"]) expect(props).toHaveProperty(key);
    expect(props.encryptionKey).toMatchObject({ format: "secret-ref" });
    expect(props.encryptionKey).not.toHaveProperty("type");
    expect((props.google!.properties as Record<string, Record<string, unknown>>).clientId!.default).toBe(DEFAULT_GOOGLE_CLIENT_ID);
  });

  it("keeps every existing tool name and adds the new ones", () => {
    const names = manifest.tools!.map((t) => t.name);
    for (const name of ["create-draft", "send-draft", "list-inbox", "mark-read", "create-email-template", "list-email-templates", "list-threads", "search-mail", "get-message", "correct-triage", "mail-status"]) {
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
