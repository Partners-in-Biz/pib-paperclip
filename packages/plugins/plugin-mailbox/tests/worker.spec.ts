import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MAIL_EVENTS, MAIL_SENDERS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const CO = "co-1";

/** Every statement must pass the host guard; queries return nothing (an empty Mailbox). */
function guardedEmptyDb() {
  const statements: string[] = [];
  return {
    statements,
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        statements.push(sql);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        statements.push(sql);
        return { rowCount: 1 };
      },
    },
  };
}

async function boot() {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const { db, statements } = guardedEmptyDb();
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, emit, statements };
}

describe("worker wiring", () => {
  it("answers a send request from every mail sender, through the host SQL guard", async () => {
    const { harness, emit, statements } = await boot();
    for (const sender of MAIL_SENDERS) {
      await harness.emit(
        pluginEvent(sender, MAIL_EVENTS.sendRequested),
        { key: `${sender}:doc:1`, to: [{ email: "a@b.co" }], subject: "Hi", text: "Hello", context: { plugin: sender, kind: "doc", id: "1" } },
        { companyId: CO },
      );
    }
    const results = emit.mock.calls.filter(([name]) => name === MAIL_EVENTS.sendResult);
    expect(results).toHaveLength(MAIL_SENDERS.length);
    expect(results[0]![2]).toMatchObject({ status: "failed", permanent: true, error: "No Gmail account is connected in Mailbox", context: { plugin: MAIL_SENDERS[0] } });
    expect(statements.some((sql) => sql.includes(`${NAMESPACE}.send_requests`))).toBe(true);
    expect(statements.some((sql) => sql.includes(`${NAMESPACE}.inbox`))).toBe(true);
  });

  it("runs the sync job with no connected accounts", async () => {
    const { harness, statements } = await boot();
    await harness.runJob("sync-mailbox");
    expect(statements[0]).toContain(`FROM ${NAMESPACE}.accounts WHERE status = 'connected'`);
  });

  it("keeps the delegation checks on the existing tools and keeps board actions for people", async () => {
    const { harness } = await boot();
    const draft = await harness.executeTool<{ error?: string }>("create-draft", { accountId: "acc-1", subject: "Hi" }, { agentId: "agent-1", companyId: CO });
    expect(draft.error).toMatch(/not allowed to draft/);
    const send = await harness.executeTool<{ error?: string }>("send-draft", { messageId: "nope" }, { agentId: "agent-1", companyId: CO });
    expect(send.error).toBe("Draft was not found");
    const search = await harness.executeTool<{ error?: string }>("search-mail", { query: "from:x" }, { agentId: "agent-1", companyId: CO });
    expect(search.error).toMatch(/no read delegation/);
    const status = await harness.executeTool<{ data?: { status: string } }>("mail-status", { key: "missing" }, { agentId: "agent-1", companyId: CO });
    expect(status.data?.status).toBe("unknown");
    await expect(
      harness.performAction("mailbox.connect-start", {}, { companyId: CO, actor: { type: "agent", agentId: "agent-1" } } as never),
    ).rejects.toThrow(/board users/);
  });
});
