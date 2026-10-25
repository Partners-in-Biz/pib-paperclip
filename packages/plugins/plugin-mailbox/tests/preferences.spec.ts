import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { loadMailboxConfig } from "../src/config.js";
import { mailboxPreferences, mailboxPrefs, preferencesLoad, preferencesSave } from "../src/preferences.js";
import { CLIENT_MAIL_REFERENCE, EMAIL_PROVIDER_REFERENCE, PRIVACY_REFERENCE, SENDER_DOMAINS_REFERENCE, SKILLS } from "../src/skills.js";

const PAR = "co-par";
const CLIENT = "co-client";
const OWNER = { type: "user", userId: "u-owner" } as const;
const member = (companyId: string, principalId: string, membershipRole: string) =>
  ({ id: `${companyId}:${principalId}`, companyId, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

function boot(config: Record<string, unknown> = {}, capabilities = manifest.capabilities) {
  const harness = createTestHarness({ manifest: { ...manifest, capabilities } as never, config });
  harness.seed({
    companies: [
      { id: PAR, name: "Partners in Biz", issuePrefix: "PAR" } as never,
      { id: CLIENT, name: "Acme Plumbing", issuePrefix: "ACM" } as never,
    ],
    accessMembers: [member(PAR, "u-owner", "owner"), member(CLIENT, "u-owner", "owner"), member(CLIENT, "u-viewer", "viewer")],
  });
  return harness.ctx;
}

const legacy = { fromName: "PiB Mail", labelPrefix: "Ops", replyIssues: false, triageIssueAssignee: "agent:a1", autoDelegate: "off" };

describe("mailbox preferences", () => {
  it("a company with no config gets neutral defaults with no PiB text", async () => {
    const ctx = boot();
    const { config } = await loadMailboxConfig(ctx, CLIENT);
    expect(config).toMatchObject({ labelPrefix: "ACM", fromName: null, replyIssues: true, triageAssignee: null, autoDelegate: "operator" });
    const loaded = await preferencesLoad(ctx, CLIENT);
    expect(JSON.stringify(loaded)).not.toMatch(/PiB|Partners in Biz/);
  });

  it("precedence: a saved preference beats an explicitly saved host value, which beats the default", async () => {
    const ctx = boot({ labelPrefix: "Acme", fromName: "Acme Mail" });
    expect(await mailboxPrefs(ctx, CLIENT)).toMatchObject({ labelPrefix: "Acme", fromName: "Acme Mail", autoDelegate: "operator" });
    const saved = await preferencesSave(ctx, { companyId: CLIENT, actor: OWNER }, { labelPrefix: "Plumb", autoDelegate: "operator+roles", triageIssueAssignee: "user:u9", replyIssues: false });
    expect(saved.ok).toBe(true);
    const { config } = await loadMailboxConfig(ctx, CLIENT);
    expect(config).toMatchObject({ labelPrefix: "Plumb", fromName: "Acme Mail", autoDelegate: "operator+roles", triageAssignee: { userId: "u9" }, replyIssues: false });
  });

  it("PAR keeps its effective values: the pinned prefix with no config, and every saved host value", async () => {
    expect((await loadMailboxConfig(boot(), PAR)).config).toMatchObject({ labelPrefix: "PiB", fromName: null, replyIssues: true, triageAssignee: null, autoDelegate: "operator" });
    expect((await loadMailboxConfig(boot(legacy), PAR)).config).toMatchObject({ labelPrefix: "Ops", fromName: "PiB Mail", replyIssues: false, triageAssignee: { agentId: "a1" }, autoDelegate: "off" });
  });

  it("another company never inherits the PAR pin", async () => {
    expect((await loadMailboxConfig(boot(), CLIENT)).config.labelPrefix).toBe("ACM");
  });

  it("refuses a viewer and an agent, and never writes", async () => {
    const ctx = boot();
    expect((await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "user", userId: "u-viewer" } }, { labelPrefix: "X" })).ok).toBe(false);
    expect((await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "agent", userId: null } }, { labelPrefix: "X" })).ok).toBe(false);
    expect((await mailboxPrefs(ctx, CLIENT))?.labelPrefix).toBe("ACM");
  });

  it("fails if the manifest lacks access.members.read while preferences-save is registered", async () => {
    expect(manifest.capabilities).toContain("access.members.read");
    expect(manifest.capabilities).toContain("companies.read");
    expect(manifest.capabilities).toContain("plugin.state.write");
    expect(readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")).toContain('"mailbox.preferences-save"');
    // Without the capability the save is refused, not written.
    const ctx = boot({}, manifest.capabilities.filter((c) => c !== "access.members.read"));
    expect(await preferencesSave(ctx, { companyId: CLIENT, actor: OWNER }, { labelPrefix: "X" })).toMatchObject({ ok: false });
    expect((await mailboxPrefs(ctx, CLIENT))?.labelPrefix).toBe("ACM");
  });

  it("moves exactly the five person-facing settings", () => {
    expect(Object.keys(mailboxPreferences.fields)).toEqual(["fromName", "labelPrefix", "replyIssues", "triageIssueAssignee", "autoDelegate"]);
  });

  it("the agent skill text follows the company's label prefix instead of naming PiB", () => {
    const text = [...SKILLS.map((s) => s.markdown ?? ""), SENDER_DOMAINS_REFERENCE, CLIENT_MAIL_REFERENCE, PRIVACY_REFERENCE, EMAIL_PROVIDER_REFERENCE].join("\n");
    expect(text).toContain("`<prefix>/<Category>`");
    expect(text).toContain("`<prefix>/Suspicious`");
    expect(text).not.toMatch(/PiB\/(?:<|Suspicious|Lead)/);
  });
});
