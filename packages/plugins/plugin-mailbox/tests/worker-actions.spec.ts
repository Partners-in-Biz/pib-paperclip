import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { CO } from "./helpers/memory.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const account = (id: string, address: string, over: Row = {}): Row => ({ id, company_id: CO, provider: "gmail", address, status: "connected", token_sealed: "sealed", is_default: false, client_kind: null, client_ref: null, from_name: null, created_at: "2026-09-26T08:00:00.000Z", ...over });

/** A harness over a small, stateful database: every statement passes the host guard and is recorded. */
async function boot(data: { accounts?: Row[]; crm_companies?: Row[]; delegations?: Row[] } = {}) {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const rows = { accounts: [] as Row[], crm_companies: [] as Row[], delegations: [] as Row[], ...data };
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 AND id = $2`)) return rows.accounts.filter((r) => r.id === params[1]);
      if (sql.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 ORDER BY address`)) return rows.accounts;
      if (sql.includes(`FROM ${NAMESPACE}.crm_companies WHERE company_id = $1 AND id = $2`)) return rows.crm_companies.filter((r) => r.id === params[1]);
      if (sql.includes(`FROM ${NAMESPACE}.delegations WHERE account_id = $1 AND agent_id = $2`)) return rows.delegations.filter((r) => r.account_id === params[0] && r.agent_id === params[1]);
      return [];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      executed.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const act = (key: string, params: Record<string, unknown>, actor: { type: "user" | "agent"; userId?: string; agentId?: string } = { type: "user", userId: "user-peet" }) =>
    harness.performAction<Record<string, any>>(key, params, { companyId: CO, actor } as never);
  return { harness, act, executed, rows };
}

const own = account("acc-1", "peet@partnersinbiz.online", { is_default: true });

describe("removing and granting access", () => {
  it("a person removes an agent's access: the delegation goes and the removal is remembered, with who did it", async () => {
    const { act, executed } = await boot({ accounts: [own] });
    expect(await act("mailbox.remove-delegation", { accountId: "acc-1", agentId: "agent-op" })).toEqual({ removed: true });
    const del = executed.find((e) => e.sql.includes(`DELETE FROM ${NAMESPACE}.delegations`))!;
    expect(del.params).toEqual([CO, "acc-1", "agent-op"]);
    const marker = executed.find((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.delegation_removals`))!;
    expect(marker.params).toEqual(["acc-1", "agent-op", CO, "user-peet"]);
  });

  it("only a board user can remove it, and only on a mailbox of this company", async () => {
    const { act } = await boot({ accounts: [own] });
    await expect(act("mailbox.remove-delegation", { accountId: "acc-1", agentId: "agent-op" }, { type: "agent", agentId: "agent-op" })).rejects.toThrow(/board users/);
    await expect(act("mailbox.remove-delegation", { accountId: "acc-other", agentId: "agent-op" })).rejects.toThrow(/Mailbox not found/);
    await expect(act("mailbox.create-delegation", { accountId: "acc-other", agentId: "agent-op" })).rejects.toThrow(/Mailbox not found/);
  });

  it("an agent cannot hand out access or undo a person's removal: the grant is for a signed-in person only, nothing is written", async () => {
    const { act, executed } = await boot({ accounts: [own] });
    // The host lets any agent with company access call an action; the delegation check is the plugin's job.
    await expect(act("mailbox.create-delegation", { accountId: "acc-1", agentId: "agent-evil", canSend: true }, { type: "agent", agentId: "agent-evil" })).rejects.toThrow(/board users/);
    // A user actor with no user id is no person either.
    await expect(act("mailbox.create-delegation", { accountId: "acc-1", agentId: "agent-evil" }, { type: "user" })).rejects.toThrow(/board users/);
    await expect(act("mailbox.create-account", { provider: "manual", address: "evil@x.co" }, { type: "agent", agentId: "agent-evil" })).rejects.toThrow(/board users/);
    expect(executed.filter((e) => /delegations|delegation_removals|accounts/.test(e.sql))).toEqual([]);
    // The person's own grant still works.
    expect(await act("mailbox.create-delegation", { accountId: "acc-1", agentId: "agent-op" })).toMatchObject({ canSend: false });
    expect(executed.some((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.delegations AS d`))).toBe(true);
  });

  it("an agent cannot read the inbox through an action either (it has no delegation check): the tools of the same names do check it", async () => {
    const { act, executed } = await boot({ accounts: [own] });
    for (const key of ["mailbox.list-inbox", "mailbox.list-threads", "mailbox.mark-read"]) {
      await expect(act(key, { accountId: "acc-1", messageId: "m1" }, { type: "agent", agentId: "agent-evil" }), key).rejects.toThrow(/board users/);
    }
    expect(executed).toEqual([]);
    expect(await act("mailbox.list-inbox", { accountId: "acc-1" })).toEqual([]);
  });

  it("a person's grant records who gave it and ends an earlier removal in the same go", async () => {
    const { act, executed } = await boot({ accounts: [own] });
    const result = await act("mailbox.create-delegation", { accountId: "acc-1", agentId: "agent-op" });
    expect(result).toMatchObject({ canRead: true, canDraft: true, canSend: false });
    const insert = executed.find((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.delegations AS d`))!;
    expect(insert.params.slice(2)).toEqual(["acc-1", "agent-op", true, true, false, "manual", "user-peet"]);
    expect(executed.some((e) => e.sql.includes(`DELETE FROM ${NAMESPACE}.delegation_removals`) && e.params[0] === "acc-1")).toBe(true);
    // Sending is only ever on when the person says so.
    await act("mailbox.create-delegation", { accountId: "acc-1", agentId: "agent-x", canSend: true });
    expect(executed.filter((e) => e.sql.includes("INSERT INTO") && e.sql.includes(".delegations AS d")).at(-1)!.params.slice(4, 7)).toEqual([true, true, true]);
  });
});

describe("checking the one-click unsubscribe proxy", () => {
  it("is for a person; with no unsubscribe secret it says what to set first and posts nothing", async () => {
    const { act, harness } = await boot({ accounts: [own] });
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    (harness.ctx as unknown as { http: unknown }).http = { fetch };
    await expect(act("mailbox.check-unsubscribe-proxy", {}, { type: "agent", agentId: "agent-x" })).rejects.toThrow(/board users/);
    expect(await act("mailbox.check-unsubscribe-proxy", {})).toMatchObject({ configured: false, ok: false, detail: expect.stringMatching(/unsubscribe secret/) });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a mailbox that belongs to a client", () => {
  const client = account("acc-ahs", "info@ahslaw.co.za", { client_kind: "company", client_ref: "crm-ahs", from_name: "AHS Law" });
  const ahs = { id: "crm-ahs", name: "AHS Law", domain: "ahslaw.co.za" };

  it("a company mailbox is given to a client that exists in the CRM, as the client's own name, and stops being the default", async () => {
    const second = account("acc-2", "info@ahslaw.co.za");
    const { act, executed } = await boot({ accounts: [own, second], crm_companies: [ahs] });
    expect(await act("mailbox.set-account-client", { accountId: "acc-2", clientKind: "company", clientRef: "crm-ahs" })).toEqual({ id: "acc-2", droppedDefaultAccess: 1, client: { kind: "company", ref: "crm-ahs", name: "AHS Law" } });
    const update = executed.find((e) => e.sql.includes(`UPDATE ${NAMESPACE}.accounts SET client_kind`))!;
    expect(update.params).toEqual(["acc-2", CO, "company", "crm-ahs", "AHS Law"]);
    // No agent gets a client's mailbox automatically: the access the defaults gave while it was the company's goes; a person's grant stays.
    const dropped = executed.find((e) => e.sql.includes(`DELETE FROM ${NAMESPACE}.delegations`))!;
    expect(dropped.sql).toContain("source = 'default'");
    expect(dropped.params).toEqual([CO, "acc-2"]);
    expect(executed.some((e) => e.sql.includes("delegation_removals"))).toBe(false);
    expect(update.sql).toContain("is_default = CASE WHEN $4::text IS NULL THEN is_default ELSE false END");
  });

  it("refuses a client the CRM does not know, and giving away the company's only Gmail mailbox", async () => {
    const { act } = await boot({ accounts: [own], crm_companies: [ahs] });
    await expect(act("mailbox.set-account-client", { accountId: "acc-1", clientKind: "company", clientRef: "crm-made-up" })).rejects.toThrow(/The CRM has no company crm-made-up/);
    await expect(act("mailbox.set-account-client", { accountId: "acc-1", clientKind: "company", clientRef: "crm-ahs" })).rejects.toThrow(/only mailbox with Gmail/);
  });

  it("takes a mailbox back for the company, clearing the client", async () => {
    const { act, executed } = await boot({ accounts: [own, client] });
    expect(await act("mailbox.set-account-client", { accountId: "acc-ahs" })).toEqual({ id: "acc-ahs", client: null });
    expect(executed.find((e) => e.sql.includes(`UPDATE ${NAMESPACE}.accounts SET client_kind`))!.params).toEqual(["acc-ahs", CO, null, null, null]);
  });

  it("is never made the default sender", async () => {
    const { act, executed } = await boot({ accounts: [own, client] });
    await expect(act("mailbox.set-default", { accountId: "acc-ahs" })).rejects.toThrow(/belongs to a client is never the default sender/);
    expect(executed.some((e) => e.sql.includes("is_default = (id = $2)"))).toBe(false);
    expect(await act("mailbox.set-default", { accountId: "acc-1" })).toEqual({ id: "acc-1", isDefault: true });
  });

  it("a send-only provider address is never the default mailbox, even a connected company-owned one: the default stays a Gmail account", async () => {
    const sendOnly = account("acc-esp", "hello@mail.partnersinbiz.online", { provider: "resend", token_sealed: null });
    const { act, executed } = await boot({ accounts: [own, sendOnly] });
    await expect(act("mailbox.set-default", { accountId: "acc-esp" })).rejects.toThrow(/send-only provider address is never the default mailbox.*the default is a Gmail account/);
    expect(executed.some((e) => e.sql.includes("is_default = (id = $2)"))).toBe(false);
    // The Gmail account still can.
    expect(await act("mailbox.set-default", { accountId: "acc-1" })).toEqual({ id: "acc-1", isDefault: true });
  });

  it("the page's list of clients for the pickers comes from the CRM copy", async () => {
    const { act } = await boot({ accounts: [own] });
    expect(await act("mailbox.crm-clients", {})).toEqual({ clients: [] });
  });
});

describe("drafting for a client", () => {
  it("a draft saves the Reply-To and the display name it will be sent with, and an unusable Reply-To is refused", async () => {
    const { harness, executed } = await boot({ accounts: [own], delegations: [{ account_id: "acc-1", agent_id: "agent-am", can_read: true, can_draft: true, can_send: false }] });
    const ok = await harness.executeTool<{ data?: { id: string }; error?: string }>("create-draft", { accountId: "acc-1", subject: "Hello", to: ["ann@lead.co.za"], replyTo: "Intake <INTAKE@ahslaw.co.za>", fromName: "AHS\r\nLaw" }, { agentId: "agent-am", companyId: CO });
    expect(ok.error).toBeUndefined();
    const insert = executed.find((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.messages (id, company_id, account_id, subject, body, direction, status`))!;
    expect(JSON.parse(String(insert.params[8]))).toMatchObject({ replyTo: { email: "intake@ahslaw.co.za", name: "Intake" }, fromName: "AHS Law", by: { kind: "agent", id: "agent-am" } });
    const bad = await harness.executeTool<{ error?: string }>("create-draft", { accountId: "acc-1", subject: "Hello", to: ["ann@lead.co.za"], replyTo: "not an address" }, { agentId: "agent-am", companyId: CO });
    expect(bad.error).toBe("Invalid replyTo address");
  });
});
