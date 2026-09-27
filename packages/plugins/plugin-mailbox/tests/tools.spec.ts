import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { HANDOFF_EVENTS, pluginEvent, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { MAILBOX_DRAFT_SKILL, SKILLS } from "../src/skills.js";
import { MAILBOX_TOOLS } from "../src/tools.js";
import { syncAccount } from "../src/gmail/sync.js";
import { createFakeDb, type Store } from "./helpers/fake-db.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";

type Schema = { description?: string; enum?: unknown[]; properties?: Record<string, Schema> };

describe("Mailbox tool surface", () => {
  it("describes every parameter", () => {
    const missing: string[] = [];
    for (const tool of MAILBOX_TOOLS) {
      for (const [name, schema] of Object.entries((tool.parametersSchema as Schema).properties ?? {})) if (!schema.description?.trim()) missing.push(`${tool.name}.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("offers list-mailboxes and get-attachment with the right inputs", () => {
    const tool = (name: string) => MAILBOX_TOOLS.find((t) => t.name === name)!.parametersSchema as { required: string[]; properties: Record<string, Schema> };
    expect(tool("list-mailboxes").required).toEqual([]);
    expect(tool("get-attachment").required).toEqual(["messageId", "attachmentId"]);
    expect(Object.keys(tool("get-attachment").properties)).toEqual(["messageId", "attachmentId", "account"]);
    expect(MAILBOX_TOOLS.find((t) => t.name === "get-attachment")!.description).toMatch(/feeds partnersinbiz\.accounting:import-statement/);
    expect(tool("list-inbox").properties.category!.enum).toContain("bank_statement");
  });
});

describe("Mailbox skill", () => {
  it("has the inbound routing table and names every tool", () => {
    for (const row of ["Lead, sender not in the CRM", "Proof of payment", "Bank statement", "Reply to an email we sent", "Spam or phishing"]) expect(MAILBOX_DRAFT_SKILL).toContain(row);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/Bookkeeper .* `get-attachment`, then `partnersinbiz\.accounting:import-statement`, then reconcile/);
    for (const tool of MAILBOX_TOOLS) expect(MAILBOX_DRAFT_SKILL, tool.name).toContain(`\`${tool.name}\``);
  });

  it("explains the do-not-email list and attachments", () => {
    expect(MAILBOX_DRAFT_SKILL).toMatch(/"unsubscribe" or "stop"/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/hard bounce/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/200 KB/);
    expect(MAILBOX_DRAFT_SKILL).toContain("partnersinbiz.campaigns:suppress-address");
    expect(SKILLS[0]!.markdown).toContain("## Asking a person");
  });
});

describe("lead hand-off answers", () => {
  it("settles a lead when the CRM answers, and ignores other keys", async () => {
    const tables: Store = {
      outbox: [
        { key: "mail:m1", company_id: CO, event: "lead.captured", payload: {}, status: "pending", attempts: 1, next_attempt_at: new Date().toISOString(), last_error: null, result: null, settled_at: null },
        { key: "mail:m2", company_id: CO, event: "lead.captured", payload: {}, status: "pending", attempts: 1, next_attempt_at: new Date().toISOString(), last_error: null, result: null, settled_at: null },
      ],
    };
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com" } });
    (harness.ctx as unknown as { db: unknown }).db = createFakeDb(tables, { namespace: NAMESPACE });
    await plugin.definition.setup(harness.ctx);
    const result = pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.leadCapturedResult) as `plugin.${string}`;
    await harness.emit(result, { key: "mail:m1", status: "stored", contactId: "c-1" }, { companyId: CO });
    await harness.emit(result, { key: "social:inbox:9", status: "stored" }, { companyId: CO });
    await harness.emit(result, { key: "mail:m2", status: "maybe" }, { companyId: CO });
    expect(tables.outbox!.map((row) => [row.key, row.status])).toEqual([["mail:m1", "done"], ["mail:m2", "pending"]]);
    expect(tables.outbox![0]!.result).toMatchObject({ contactId: "c-1" });
  });

  it("with the CRM switched off, a new lead gets a reply issue instead of a hand-off", async () => {
    const ctx = setup({ triageIssueAssignee: "agent-am" });
    const state = ctx.host.ctx.state as unknown as { get: (key: { namespace?: string; stateKey?: string }) => Promise<unknown> };
    const original = state.get;
    state.get = vi.fn(async (key) => (key.namespace === "pib-setup" && key.stateKey === "modules" ? { companyId: CO, modules: { crm: false }, updatedAt: new Date().toISOString() } : original(key)));
    ctx.gmail.addMessage({ id: "q1", headers: { From: "new@prospect.co.za", Subject: "Quote for a website?" }, snippet: "We are interested in a new site" });
    await syncAccount(ctx.env, await ctx.loaded(), ctx.account, await ctx.run());
    expect(ctx.host.emitted.filter((e) => e.name === HANDOFF_EVENTS.leadCaptured)).toHaveLength(0);
    expect([...ctx.host.issues.values()]).toEqual([expect.objectContaining({ title: "Reply needed: Quote for a website?", assigneeAgentId: "agent-am" })]);
  });

  it("routes reply issues to the Account Manager when no assignee is configured", async () => {
    const ctx = setup();
    const state = ctx.host.ctx.state as unknown as { get: (key: { namespace?: string; stateKey?: string }) => Promise<unknown> };
    const original = state.get;
    state.get = vi.fn(async (key) => (key.namespace === "pib-cockpit" && key.stateKey === "roles"
      ? { companyId: CO, operatorAgentId: "agent-op", reviewerAgentId: null, ownerUserId: "user-owner", reviewOutward: false, team: { "account-manager": { agentId: "agent-am", status: "idle" } }, updatedAt: new Date().toISOString() }
      : original(key)));
    ctx.store.crm.push({ kind: "contact", id: "c1", name: "Ann", domain: null, emails: ["ann@client.co.za"], accountIds: [] });
    ctx.gmail.addMessage({ id: "c1", headers: { From: "Ann <ann@client.co.za>", Subject: "Can we move the launch?" }, snippet: "Can we move the launch to Friday?" });
    await syncAccount(ctx.env, await ctx.loaded(), ctx.account, await ctx.run());
    const [issue] = [...ctx.host.issues.values()];
    expect(issue).toMatchObject({ assigneeAgentId: "agent-am", title: "Reply needed: Can we move the launch?" });
    expect(String(issue!.description)).toContain("`list-mailboxes`");
  });

  it("opens no reply issues when they are switched off", async () => {
    const ctx = setup({ replyIssues: false, triageIssueAssignee: "agent-am" });
    ctx.store.crm.push({ kind: "contact", id: "c1", name: "Ann", domain: null, emails: ["ann@client.co.za"], accountIds: [] });
    ctx.gmail.addMessage({ id: "c1", headers: { From: "Ann <ann@client.co.za>", Subject: "Can we move the launch?" }, snippet: "Can we move the launch to Friday?" });
    await syncAccount(ctx.env, await ctx.loaded(), ctx.account, await ctx.run());
    expect(ctx.host.issues.size).toBe(0);
  });
});
