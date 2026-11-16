import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { cleanPurpose, holdFor, purposeKeyFor, replaceOlderDrafts } from "../src/draft-purpose.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const CO = "co-1";

/** A tiny in-memory `messages` table behind the host SQL guard, with an agent that may draft AND send. */
async function boot() {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes(".delegations WHERE account_id")) return [{ can_read: true, can_draft: true, can_send: true }];
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
  return { harness, rows };
}

const agent = { agentId: "agent-am", companyId: CO };
type Result = { error?: string; data?: { id: string; heldForPerson?: boolean; replaced?: string[] } };

describe("mail the client did not ask for is held for a person (PAR-12249)", () => {
  it("send-draft by an agent is refused for an upsell draft, and the draft stays", async () => {
    const { harness, rows } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "A new idea for you", to: "ann@client.co.za", purpose: "upsell" }, agent);
    expect(made.data).toMatchObject({ heldForPerson: true });
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error).toMatch(/Not sent: Mail the client did not ask for/);
    expect(rows.get(made.data!.id)!.status).toBe("draft");
  });

  it("the `unasked` flag holds a draft whatever its purpose", async () => {
    const { harness } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hello", to: "ann@client.co.za", unasked: true }, agent);
    expect((await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent)).error).toMatch(/Not sent/);
  });

  it("a plain draft (no unasked purpose) is not held by the guard", async () => {
    const { harness } = await boot();
    const made = await harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Re: your question", to: "ann@client.co.za", purpose: "reply" }, agent);
    expect(made.data?.heldForPerson).toBeUndefined();
    // Past the guard it meets the next rule (no Gmail connected in this fake): queued, not refused for being unasked.
    const sent = await harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, agent);
    expect(sent.error ?? "").not.toMatch(/did not ask for/);
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

describe("draft-purpose helpers", () => {
  it("normalises purposes and builds keys", () => {
    expect(cleanPurpose(" Review Ask ")).toBe("review-ask");
    expect(cleanPurpose(5)).toBeNull();
    expect(holdFor("upsell", false)).not.toBeNull();
    expect(holdFor("reply", false)).toBeNull();
    expect(holdFor(null, true)).not.toBeNull();
    expect(purposeKeyFor(null, "upsell", [{ email: "Ann@Client.co.za" }])).toBe("upsell:ann@client.co.za");
    expect(purposeKeyFor(null, null, [{ email: "a@b.co" }])).toBeNull();
    expect(purposeKeyFor("mine", null, [])).toBe("mine");
  });
  it("replaceOlderDrafts keeps the new one", async () => {
    const deleted: string[] = [];
    const store = { draftsByPurpose: async () => [{ id: "new" }, { id: "old" }] as never, deleteDraft: async (_c: string, id: string) => (deleted.push(id), true) };
    expect(await replaceOlderDrafts(store, CO, "a", "k", "new")).toEqual(["old"]);
  });
});
