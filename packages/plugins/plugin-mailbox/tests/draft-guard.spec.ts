import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { cleanPurpose, HOLD_REASON_PLUGIN, holdFor, purposeKeyFor, replaceOlderDrafts, replaceOlderDraftsSafely } from "../src/draft-purpose.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const CO = "co-1";

/** A tiny in-memory `messages` table behind the host SQL guard, with an agent that may draft AND send. */
async function boot() {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const rows = new Map<string, Record<string, unknown>>();
  // The CRM projection behind `clientRecipients`: addresses that belong to a customer, or a failing lookup.
  const crm = { clients: new Set<string>(), fail: false, lookups: 0, failReplace: false };
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes("crm_contacts") && sql.includes("lower(e.email)")) {
        crm.lookups += 1;
        if (crm.fail) throw new Error("crm projection unavailable");
        return (JSON.parse(String(params[1])) as string[]).filter((e) => crm.clients.has(e)).map((email) => ({ email }));
      }
      if (sql.includes(".delegations WHERE account_id")) return [{ can_read: true, can_draft: true, can_send: true }];
      if (sql.includes("draft ->> 'purposeKey'") && crm.failReplace) throw new Error("statement timeout");
      if (sql.includes("draft ->> 'purposeKey'")) return [...rows.values()].filter((r) => (r.draft as { purposeKey?: string }).purposeKey === params[2] && r.status === "draft").reverse();
      if (sql.includes("WHERE company_id = $1 AND id = $2 LIMIT 1")) return rows.has(String(params[1])) ? [rows.get(String(params[1]))] : [];
      return [];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes(".messages (id, company_id, account_id, subject, body, direction, status")) {
        rows.set(String(params[0]), { id: params[0], company_id: params[1], account_id: params[2], subject: params[3], body: params[4], direction: "outbound", status: "draft", to_addrs: JSON.parse(String(params[5])), cc_addrs: [], bcc_addrs: [], draft: JSON.parse(String(params[8])) });
        return { rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM") && sql.includes(".messages")) return { rowCount: rows.delete(String(params[1])) ? 1 : 0 };
      return { rowCount: 1 };
    },
  };
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  return { harness, rows, crm };
}

const agent = { agentId: "agent-am", companyId: CO };
type Result = { error?: string; data?: { id: string; heldForPerson?: boolean; replaced?: string[] } };

describe("mail the client did not ask for is held for a person (PAR-12249)", () => {
  it("send-draft by an agent is refused for an upsell draft to an existing client, and the draft stays", async () => {
    const { harness, rows, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "A new idea for you", to: "ann@client.co.za", purpose: "upsell" }, agent);
    expect(made.data).toMatchObject({ heldForPerson: true });
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error).toMatch(/Not sent: Mail an existing client did not ask for/);
    expect(sent.error).toMatch(/ann@client.co.za is an existing client/);
    expect(rows.get(made.data!.id)!.status).toBe("draft");
  });

  it("cold outreach to a prospect with no customer record is not held (Peet, 16 Nov)", async () => {
    const { harness, crm } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hello from PiB", to: "cold@prospect.co.za", purpose: "outreach" }, agent);
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(crm.lookups).toBe(1);
    // Past the guard it meets the next rule (no Gmail connected in this fake): queued, not refused as unasked client mail.
    expect(sent.error ?? "").not.toMatch(/Not sent|existing client/);
  });

  it("a CRM lookup that fails refuses the send, with the reason (fail closed)", async () => {
    const { harness, rows, crm } = await boot();
    crm.fail = true;
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hello", to: "cold@prospect.co.za", purpose: "outreach" }, agent);
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error).toMatch(/CRM check of its recipients failed \(crm projection unavailable\)/);
    expect(rows.get(made.data!.id)!.status).toBe("draft");
  });

  it("a held draft with one client among several recipients is refused", async () => {
    const { harness, crm } = await boot();
    crm.clients.add("billing@client.co.za");
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hi", to: ["cold@prospect.co.za", "billing@client.co.za"], purpose: "outreach" }, agent);
    expect((await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent)).error).toMatch(/billing@client.co.za is an existing client/);
  });
  it("the `unasked` flag holds a draft whatever its purpose", async () => {
    const { harness, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hello", to: "ann@client.co.za", unasked: true }, agent);
    expect((await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent)).error).toMatch(/Not sent/);
  });

  it("a plain draft (no unasked purpose) is not held by the guard", async () => {
    const { harness } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Re: your question", to: "ann@client.co.za", purpose: "reply" }, agent);
    expect(made.data?.heldForPerson).toBeUndefined();
    // Past the guard it meets the next rule (no Gmail connected in this fake): queued, not refused for being unasked.
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error ?? "").not.toMatch(/did not ask for|existing client/);
  });

  it("a person on the Mailbox page can still send a held draft", async () => {
    const { harness, rows } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Idea", to: "ann@client.co.za", purpose: "proposal" }, agent);
    const done = await harness.performAction<{ status: string }>("mailbox.send-draft", { messageId: made.data!.id }, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
    expect(done.status).toBe("queued");
    expect(rows.get(made.data!.id)).toBeTruthy();
  });

  it("a newer draft with the same purpose and recipient replaces the older open one", async () => {
    const { harness, rows } = await boot();
    const first = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "v1", to: "ann@client.co.za", purpose: "proposal" }, agent);
    const second = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "v2", to: "ann@client.co.za", purpose: "proposal" }, agent);
    expect(second.data!.replaced).toEqual([first.data!.id]);
    expect([...rows.values()].map((r) => r.subject)).toEqual(["v2"]);
  });
});

describe("untagged agent mail to an existing client waits for a person (PAR-1558, PAR-14329)", () => {
  it("an agent's draft with NO purpose to an existing client is held and its send-draft is refused", async () => {
    const { harness, rows, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Something new", to: "ann@client.co.za" }, agent);
    expect(made.data).toMatchObject({ heldForPerson: true });
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error).toMatch(/Not sent: .*ann@client.co.za is an existing client/);
    expect(rows.get(made.data!.id)!.status).toBe("draft");
  });

  it("purpose other is held; followup and invoice are not", async () => {
    const { harness, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    const other = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "FYI", to: "ann@client.co.za", purpose: "other" }, agent);
    expect((await harness.executeTool<Result>("send-draft", { messageId: other.data!.id }, agent)).error).toMatch(/existing client/);
    for (const purpose of ["followup", "invoice"]) {
      const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: purpose, to: "ann@client.co.za", purpose }, agent);
      expect(made.data?.heldForPerson).toBeUndefined();
      expect((await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent)).error ?? "").not.toMatch(/existing client/);
    }
  });

  it("a draft saved with no hold and no purpose (a person's, or one from before the default hold) is held when an agent sends it", async () => {
    const { harness, rows, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    rows.set("legacy", { id: "legacy", company_id: CO, account_id: "acc-1", subject: "Old", body: "x", direction: "outbound", status: "draft", to_addrs: [{ email: "ann@client.co.za" }], cc_addrs: [], bcc_addrs: [], draft: {} });
    expect((await harness.executeTool<Result>("send-draft", { messageId: "legacy" }, agent)).error).toMatch(/existing client/);
  });

  it("a plugin's draft: an agent's send-draft is refused for a client (the plugin reason), and passes the guard for a prospect", async () => {
    const { harness, rows, crm } = await boot();
    crm.clients.add("ann@client.co.za");
    const plugin = (id: string, email: string) =>
      rows.set(id, { id, company_id: CO, account_id: "acc-1", subject: "Please review", body: "x", direction: "outbound", status: "draft", to_addrs: [{ email }], cc_addrs: [], bcc_addrs: [], draft: { by: { kind: "agent", id: "partnersinbiz.seo" }, requestKey: `seo:${id}`, holdForPerson: { reason: HOLD_REASON_PLUGIN } } });
    plugin("p-client", "ann@client.co.za");
    plugin("p-prospect", "cold@prospect.co.za");
    const refused = await harness.executeTool<Result>("send-draft", { messageId: "p-client" }, agent);
    expect(refused.error).toMatch(/A plugin made this draft.*ann@client.co.za is an existing client/);
    expect(rows.get("p-client")!.status).toBe("draft");
    expect((await harness.executeTool<Result>("send-draft", { messageId: "p-prospect" }, agent)).error ?? "").not.toMatch(/existing client|Not sent/);
  });

  it("an agent's purposeKey stays in its own namespace: it never replaces another agent's or a plugin's draft", async () => {
    const { harness, rows } = await boot();
    rows.set("plugin-draft", { id: "plugin-draft", company_id: CO, account_id: "acc-1", subject: "Approval", direction: "outbound", status: "draft", to_addrs: [], draft: { purposeKey: "partnersinbiz.seo:seo-approval:acme", requestKey: "k" } });
    const mine = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "mine", to: "ann@client.co.za", purposeKey: "shared" }, agent);
    const theirs = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "theirs", to: "ann@client.co.za", purposeKey: "shared" }, { agentId: "agent-b", companyId: CO });
    const hijack = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "hijack", to: "ann@client.co.za", purposeKey: "partnersinbiz.seo:seo-approval:acme" }, agent);
    expect(theirs.data!.replaced).toBeUndefined();
    expect(hijack.data!.replaced).toBeUndefined();
    expect(rows.has(mine.data!.id)).toBe(true);
    expect(rows.has("plugin-draft")).toBe(true);
    expect((rows.get(mine.data!.id)!.draft as { purposeKey: string }).purposeKey).toBe("agent:agent-am:shared");
  });

  it("a failing replacement does not fail create-draft: the draft is saved once and the error is logged", async () => {
    const { harness, rows, crm } = await boot();
    crm.failReplace = true;
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "v1", to: "ann@client.co.za", purpose: "proposal" }, agent);
    expect(made.error).toBeUndefined();
    expect(made.data!.id).toBeTruthy();
    expect([...rows.keys()]).toEqual([made.data!.id]);
  });
});

describe("draft-purpose helpers", () => {
  it("normalises purposes and builds keys", () => {
    expect(cleanPurpose(" Review Ask ")).toBe("review-ask");
    expect(cleanPurpose(5)).toBeNull();
    expect(holdFor("upsell", false)).not.toBeNull();
    expect(holdFor("reply", false)).toBeNull();
    expect(holdFor("invoice", false)).toBeNull();
    expect(holdFor("invoice", true)).not.toBeNull();
    expect(holdFor(null, false)).not.toBeNull();
    expect(holdFor("other", false)).not.toBeNull();
    expect(holdFor(null, true)).not.toBeNull();
    expect(purposeKeyFor(null, "upsell", [{ email: "Ann@Client.co.za" }])).toBe("upsell:ann@client.co.za");
    expect(purposeKeyFor(null, "upsell", [{ email: "Ann@Client.co.za" }], "agent-1")).toBe("agent:agent-1:upsell:ann@client.co.za");
    expect(purposeKeyFor("partnersinbiz.seo:x", null, [], "agent-1")).toBe("agent:agent-1:partnersinbiz.seo:x");
    expect(purposeKeyFor(null, null, [{ email: "a@b.co" }])).toBeNull();
    expect(purposeKeyFor("mine", null, [])).toBe("mine");
  });
  it("replaceOlderDrafts leaves a draft a person edited or asked to rewrite", async () => {
    const deleted: string[] = [];
    const store = {
      draftsByPurpose: async () => [{ id: "new" }, { id: "edited", draft: { editedByPerson: true } }, { id: "rewrite", draft: { rewrite: { note: "x", requestedAt: "", issueId: null } } }, { id: "old" }] as never,
      deleteDraft: async (_c: string, id: string) => (deleted.push(id), true),
    };
    expect(await replaceOlderDrafts(store, CO, "a", "k", "new")).toEqual(["old"]);
    expect(deleted).toEqual(["old"]);
  });
  it("replaceOlderDraftsSafely logs a failure and reports nothing replaced", async () => {
    const logged: string[] = [];
    const store = { draftsByPurpose: async () => Promise.reject(new Error("boom")), deleteDraft: async () => true };
    expect(await replaceOlderDraftsSafely(store, CO, "a", "k", "new", (message) => logged.push(message))).toEqual([]);
    expect(logged).toEqual(["Older drafts not replaced"]);
  });
  it("replaceOlderDrafts keeps the new one", async () => {
    const deleted: string[] = [];
    const store = { draftsByPurpose: async () => [{ id: "new" }, { id: "old" }] as never, deleteDraft: async (_c: string, id: string) => (deleted.push(id), true) };
    expect(await replaceOlderDrafts(store, CO, "a", "k", "new")).toEqual(["old"]);
  });
});
