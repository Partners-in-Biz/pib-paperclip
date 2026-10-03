import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { askCardProblems, askEffectKeys, ASK_EVENTS, clearAskEffects, COCKPIT_EVENTS, describeAskEffect, PIB_PLUGINS, pluginEvent, registerAskEffect, runAskEffect, type AskAnswered } from "@partnersinbiz/pib-plugin-kit";
import { listMailboxes } from "../src/agent-mail.js";
import { DELEGATE_EFFECT_KEY, defaultTargets, delegationAsk, ensureDefaultDelegations, grantDelegation, mailboxDelegateEffect, removeDelegation, resetEnsureMemo } from "../src/delegations.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { CO, MemoryStore } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const ROLES = { operatorAgentId: "agent-op", operatorStatus: "idle", team: { "account-manager": { agentId: "agent-am", status: "idle" }, bookkeeper: { agentId: "agent-bk", status: "idle" } } };

beforeEach(() => resetEnsureMemo());

describe("default delegations", () => {
  it("gives the Operator read and draft (never send) on the company's own mailbox when it is connected", async () => {
    const { env, store } = setup();
    const result = await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(result.created).toEqual([{ accountId: "acc-1", address: "peet@partnersinbiz.online", agentId: "agent-op", role: "operator", scope: "read+draft" }]);
    expect(await store.delegationFor("acc-1", "agent-op")).toEqual({ can_read: true, can_draft: true, can_send: false });
    expect(store.delegations.get("acc-1:agent-op")).toMatchObject({ source: "default", granted_by: "default:operator" });
    // Only the Operator by default: the Account Manager and Bookkeeper keep their one-click grants.
    expect(await store.delegationFor("acc-1", "agent-am")).toBeNull();
    expect(await store.delegationFor("acc-1", "agent-bk")).toBeNull();
  });

  it("is idempotent, and tolerates the delegation that was applied by hand without widening it", async () => {
    const { env, store } = setup();
    // The live Operator delegation was made by hand and is read-only here: it stays as it is.
    store.delegate("acc-1", "agent-op", { can_draft: false });
    const first = await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(first).toMatchObject({ created: [], existing: 1 });
    expect(await store.delegationFor("acc-1", "agent-op")).toEqual({ can_read: true, can_draft: false, can_send: false });
    store.delegations.delete("acc-1:agent-op");
    await ensureDefaultDelegations(env, CO, { roles: ROLES });
    const again = await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(again).toMatchObject({ created: [], existing: 1 });
    expect(store.delegations.size).toBe(1);
  });

  it("never recreates a delegation a person removed; only an explicit grant does", async () => {
    const { env, store } = setup();
    await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(await removeDelegation(store, CO, "acc-1", "agent-op", "user-peet")).toEqual({ removed: true });
    expect(await store.delegationFor("acc-1", "agent-op")).toBeNull();
    const after = await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(after).toMatchObject({ created: [], removed: 1 });
    expect(await store.delegationFor("acc-1", "agent-op")).toBeNull();
    // A person's grant (a click, or an answered ask) ends the removal.
    await grantDelegation(store, { companyId: CO, accountId: "acc-1", agentId: "agent-op", scope: "read+draft", source: "manual", grantedBy: "user-peet" });
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true, can_draft: true });
    expect(await store.hasDelegationRemoval("acc-1", "agent-op")).toBe(false);
  });

  it("covers only the company's own connected Gmail mailboxes: not a client's, not one without a sign-in, not a disconnected one", async () => {
    const { env, store } = setup();
    store.addAccount({ id: "acc-client", company_id: CO, address: "info@ahslaw.co.za", token_sealed: "sealed", client_kind: "company", client_ref: "crm-ahs" });
    store.addAccount({ id: "acc-manual", company_id: CO, address: "x@y.co", status: "manual", token_sealed: null });
    store.addAccount({ id: "acc-off", company_id: CO, address: "off@y.co", status: "disconnected", token_sealed: "sealed" });
    store.addAccount({ id: "acc-recon", company_id: CO, address: "recon@y.co", status: "needs_reconnect", token_sealed: "sealed" });
    const result = await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(result.created.map((c) => c.accountId).sort()).toEqual(["acc-1", "acc-recon"]);
  });

  it("does nothing without an Operator, without a mailbox, with a terminated Operator, or when switched off", async () => {
    const { env, store, host } = setup();
    expect((await ensureDefaultDelegations(env, CO, { roles: null })).skipped).toBe("no-roles");
    expect((await ensureDefaultDelegations(env, CO, { roles: { ...ROLES, operatorStatus: "terminated" } })).skipped).toBe("no-roles");
    store.accounts.clear();
    expect((await ensureDefaultDelegations(env, CO, { roles: ROLES })).skipped).toBe("no-mailbox");
    const off = setup({ autoDelegate: "off" });
    expect((await ensureDefaultDelegations(off.env, CO, { roles: ROLES })).skipped).toBe("off");
    expect(off.store.delegations.size).toBe(0);
    expect(store.delegations.size + host.emitted.length).toBe(0);
  });

  it("operator+roles also gives the Account Manager read and draft and the Bookkeeper read only", async () => {
    const { env, store } = setup({ autoDelegate: "operator+roles" });
    await ensureDefaultDelegations(env, CO, { roles: ROLES });
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true, can_draft: true, can_send: false });
    expect(await store.delegationFor("acc-1", "agent-am")).toMatchObject({ can_read: true, can_draft: true, can_send: false });
    expect(await store.delegationFor("acc-1", "agent-bk")).toEqual({ can_read: true, can_draft: false, can_send: false });
    expect(defaultTargets(ROLES, "operator").map((t) => t.role)).toEqual(["operator"]);
    expect(defaultTargets(ROLES, "operator+roles").map((t) => t.role)).toEqual(["operator", "account-manager", "bookkeeper"]);
    expect(defaultTargets({ ...ROLES, team: { bookkeeper: { agentId: "b", status: "terminated" } } }, "operator+roles").map((t) => t.role)).toEqual(["operator"]);
    expect(defaultTargets(ROLES, "off")).toEqual([]);
  });

  it("reads the roles copy when none is passed, and does not repeat the pass within ten minutes", async () => {
    const { env, store, host } = setup();
    const state = host.ctx.state as unknown as { get: (key: { namespace?: string; stateKey?: string }) => Promise<unknown> };
    const original = state.get;
    state.get = vi.fn(async (key) => (key.namespace === "pib-cockpit" && key.stateKey === "roles" ? { companyId: CO, ...ROLES, ownerUserId: "u", reviewerAgentId: null, reviewOutward: false, updatedAt: new Date().toISOString() } : original(key)));
    const list = vi.spyOn(store, "listAccounts");
    await ensureDefaultDelegations(env, CO);
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true });
    await ensureDefaultDelegations(env, CO);
    expect(list).toHaveBeenCalledTimes(1);
    await ensureDefaultDelegations(env, CO, { force: true });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a failing store never breaks the caller (the sync job)", async () => {
    const { env, store } = setup();
    vi.spyOn(store, "listAccounts").mockRejectedValue(new Error("db down"));
    await expect(ensureDefaultDelegations(env, CO, { roles: ROLES })).resolves.toMatchObject({ created: [] });
  });
});

describe("the roles broadcast and the worker", () => {
  it("creates the default when the Cockpit announces an Operator, with SQL the host guard accepts", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const account = { id: "acc-1", company_id: CO, provider: "gmail", address: "peet@partnersinbiz.online", status: "connected", token_sealed: "sealed", is_default: true, client_kind: null, client_ref: null, from_name: null, created_at: new Date().toISOString() };
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        return sql.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 ORDER BY address`) ? [account] : [];
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
    await harness.emit(pluginEvent(PIB_PLUGINS.cockpit, COCKPIT_EVENTS.rolesUpdated), { companyId: CO, ...ROLES, ownerUserId: "u", reviewerAgentId: null, reviewOutward: false, updatedAt: new Date().toISOString() }, { companyId: CO });
    const insert = executed.find((e) => e.sql.includes(`INSERT INTO ${NAMESPACE}.delegations`) && e.sql.includes("'default'"));
    expect(insert).toBeTruthy();
    expect(insert!.params.slice(2, 8)).toEqual(["acc-1", "agent-op", true, true, false, "default:operator"]);
    // The removal check sits in the same statement as the insert, so a removal can never be raced.
    expect(insert!.sql).toContain(`NOT EXISTS (SELECT 1 FROM ${NAMESPACE}.delegation_removals`);
  });

  it("registers the mailbox.delegate ask effect and answers an ask for a mailbox that is not this company's with a refusal", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        return { rowCount: 1 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    await plugin.definition.setup(harness.ctx);
    expect(askEffectKeys()).toContain(DELEGATE_EFFECT_KEY);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    const ask = answered({ effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "not-ours", agentId: "agent-op", scope: "read+draft" } } });
    await harness.emit(pluginEvent(PIB_PLUGINS.cockpit, ASK_EVENTS.answered), ask as unknown as Record<string, unknown>, { companyId: CO });
    const result = emit.mock.calls.find(([name]) => name === ASK_EVENTS.effectResult)![2] as Record<string, unknown>;
    expect(result).toMatchObject({ key: ask.key, askId: "ask-1", effectKey: DELEGATE_EFFECT_KEY, status: "refused", plugin: "partnersinbiz.mailbox" });
    expect(String(result.detail)).toMatch(/not a mailbox of this company/);
  });
});

// ---------------------------------------------------------------------------
// The ask effect
// ---------------------------------------------------------------------------

function answered(over: Partial<AskAnswered> = {}): AskAnswered {
  return {
    key: "ask:ask-1:2026-10-03T10:00:00.000Z",
    askId: "ask-1",
    issueId: "iss-1",
    kind: "grant",
    effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "acc-1", agentId: "agent-op", scope: "read+draft" } },
    question: "May the Operator read and draft mail on peet@partnersinbiz.online?",
    options: ["Yes: read and draft, never send", "No"],
    answer: "Yes",
    answeredByUserId: "user-peet",
    answeredAt: "2026-10-03T10:00:00.000Z",
    returnAgentId: "agent-op",
    ...over,
  };
}

describe("the mailbox.delegate ask effect", () => {
  const agents: Record<string, { name: string; status: string }> = { "agent-op": { name: "Operator", status: "idle" }, "agent-gone": { name: "Old", status: "terminated" } };

  /** A host with a memory for the kit's stored results and an agents client. */
  function effectSetup(config: Record<string, unknown> = {}) {
    const s = setup(config);
    const memo = new Map<string, unknown>();
    const state = s.host.ctx.state as unknown as { get: (k: { stateKey?: string }) => Promise<unknown>; set: (k: { stateKey?: string }, v: unknown) => Promise<void> };
    state.get = async (key) => memo.get(String(key.stateKey)) ?? null;
    state.set = async (key, value) => void memo.set(String(key.stateKey), value);
    (s.host.ctx as unknown as { agents: unknown }).agents = { get: vi.fn(async (id: string) => (agents[id] ? { id, ...agents[id] } : null)) };
    (s.host.ctx as unknown as { manifest: unknown }).manifest = { id: "partnersinbiz.mailbox" };
    clearAskEffects();
    registerAskEffect(DELEGATE_EFFECT_KEY, mailboxDelegateEffect(() => ({ store: s.store })));
    return s;
  }
  afterEach(() => clearAskEffects());

  it("an answered yes creates the delegation, reads it back and says what it did; sending is never granted", async () => {
    const { host, store } = effectSetup();
    const result = await runAskEffect(host.ctx, CO, answered());
    expect(result).toMatchObject({ status: "applied", verified: true, effectKey: DELEGATE_EFFECT_KEY, plugin: "partnersinbiz.mailbox" });
    expect(result!.detail).toBe("Operator can now read and draft on peet@partnersinbiz.online. Sending stays with a person.");
    expect(await store.delegationFor("acc-1", "agent-op")).toEqual({ can_read: true, can_draft: true, can_send: false });
    expect(store.delegations.get("acc-1:agent-op")).toMatchObject({ source: "ask", granted_by: "user-peet" });
  });

  it("is idempotent: the same answer again returns the stored result and does not grant twice", async () => {
    const { host, store } = effectSetup();
    const spy = vi.spyOn(store, "grantDelegation");
    await runAskEffect(host.ctx, CO, answered());
    const again = await runAskEffect(host.ctx, CO, answered());
    expect(again).toMatchObject({ status: "already_applied" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a read-only scope grants read only; a wider existing delegation is never lowered; an ask clears an earlier removal", async () => {
    const { host, store } = effectSetup();
    await runAskEffect(host.ctx, CO, answered({ key: "k1", effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "acc-1", agentId: "agent-op", scope: "read" } } }));
    expect(await store.delegationFor("acc-1", "agent-op")).toEqual({ can_read: true, can_draft: false, can_send: false });
    store.delegate("acc-1", "agent-op", { can_send: true });
    const wider = await runAskEffect(host.ctx, CO, answered({ key: "k2", effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "acc-1", agentId: "agent-op", scope: "read" } } }));
    expect(wider!.detail).toMatch(/already could read/);
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true, can_draft: true, can_send: true });
    await removeDelegation(store, CO, "acc-1", "agent-op", "user-peet");
    expect(await store.hasDelegationRemoval("acc-1", "agent-op")).toBe(true);
    await runAskEffect(host.ctx, CO, answered({ key: "k3" }));
    expect(await store.hasDelegationRemoval("acc-1", "agent-op")).toBe(false);
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true, can_draft: true });
  });

  it("finds the mailbox by its address too, and treats 'no problem, go ahead' as a yes", async () => {
    const { host, store } = effectSetup();
    const result = await runAskEffect(host.ctx, CO, answered({ answer: "No problem, go ahead", effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "Peet@PartnersInBiz.online", agentId: "agent-op" } } }));
    expect(result!.status).toBe("applied");
    expect(await store.delegationFor("acc-1", "agent-op")).toMatchObject({ can_read: true, can_draft: true });
  });

  it("does nothing for a no, and nothing for an answer that adds to the ask ('yes, and send too')", async () => {
    const { host, store } = effectSetup();
    expect(await runAskEffect(host.ctx, CO, answered({ key: "no", answer: "No" }))).toMatchObject({ status: "declined" });
    expect(await runAskEffect(host.ctx, CO, answered({ key: "wide", answer: "yes, and let it send too" }))).toMatchObject({ status: "unclear" });
    expect(store.delegations.size).toBe(0);
  });

  it("refuses an answer with no person behind it, and never calls the handler", async () => {
    const { host, store } = effectSetup();
    for (const answeredByUserId of ["", "local-board", "agent-op"]) {
      expect(await runAskEffect(host.ctx, CO, answered({ key: `p-${answeredByUserId}`, answeredByUserId }))).toMatchObject({ status: "refused" });
    }
    expect(store.delegations.size).toBe(0);
  });

  it("refuses params the agent should not be able to choose: unknown keys, another company's mailbox, an unknown or removed agent, a wider scope", async () => {
    const { host, store } = effectSetup();
    store.addAccount({ id: "acc-other", company_id: "co-2", address: "other@x.co", token_sealed: "x" });
    store.addAccount({ id: "acc-off", company_id: CO, address: "off@x.co", status: "disconnected", token_sealed: "x" });
    const refused = async (params: Record<string, string | boolean | number>, why: RegExp) => {
      const result = await runAskEffect(host.ctx, CO, answered({ key: `r-${JSON.stringify(params)}`, effect: { key: DELEGATE_EFFECT_KEY, params } }));
      expect(result, JSON.stringify(params)).toMatchObject({ status: "refused" });
      expect(result!.detail).toMatch(why);
    };
    await refused({ accountId: "acc-1", agentId: "agent-op", scope: "read+draft", canSend: true }, /"canSend" is not a parameter this effect accepts/);
    await refused({ accountId: "acc-1", agentId: "agent-op", scope: "read+draft+send" }, /"scope" must be one of read, read\+draft/);
    await refused({ accountId: "acc-1", agentId: "agent-op", scope: "send" }, /"scope" must be one of/);
    await refused({ accountId: "acc-other", agentId: "agent-op" }, /not a mailbox of this company/);
    await refused({ accountId: "acc-off", agentId: "agent-op" }, /off@x\.co is disconnected/);
    await refused({ accountId: "acc-1", agentId: "agent-nobody" }, /not an active agent of this company/);
    await refused({ accountId: "acc-1", agentId: "agent-gone" }, /not an active agent of this company/);
    await refused({ accountId: "acc-1", agentId: "bad id!" }, /not in the expected form/);
    await refused({ agentId: "agent-op" }, /"accountId" is required/);
    expect(store.delegations.size).toBe(0);
  });

  it("an effect that applied but cannot be read back is a failure, not a success", async () => {
    const { host, store } = effectSetup();
    vi.spyOn(store, "grantDelegation").mockResolvedValue(undefined);
    const result = await runAskEffect(host.ctx, CO, answered());
    expect(result).toMatchObject({ status: "failed", verified: false });
    expect(result!.detail).toMatch(/reading it back did not confirm it.*still has no read and draft delegation/);
  });

  it("the card an agent hands to ask-owner passes the card checks, names the effect and says what a yes does", () => {
    const card = delegationAsk({ accountId: "acc-1", address: "peet@partnersinbiz.online", agentId: "agent-op", agentName: "Operator", prefix: "PIB" });
    expect(askCardProblems(card)).toEqual([]);
    expect(card).toMatchObject({ kind: "grant", options: ["Yes: read and draft, never send", "No"], links: [{ label: "Mailboxes", href: "/PIB/mailbox?tab=mailboxes" }], effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "acc-1", agentId: "agent-op", scope: "read+draft" } } });
    expect(card.question).toBe("May Operator read and draft mail on peet@partnersinbiz.online? It cannot send: sending stays with a person.");
    expect(describeAskEffect(card.effect)).toBe("Runs mailbox.delegate with accountId=acc-1, agentId=agent-op, scope=read+draft when you say yes.");
    expect(delegationAsk({ accountId: "a", address: "x@y.co", agentId: "g" }).links[0]!.href).toBe("/mailbox?tab=mailboxes");
  });
});

describe("list-mailboxes tells an agent how to get access once", () => {
  it("a mailbox with no access carries the ask card; one with access, a client binding and a domain check say so", async () => {
    const { env, store, host } = setup();
    (host.ctx as unknown as { agents: unknown }).agents = { get: async () => ({ name: "Account Manager" }) };
    (host.ctx as unknown as { companies: unknown }).companies = { get: async () => ({ issuePrefix: "PIB" }) };
    store.addAccount({ id: "acc-client", company_id: CO, address: "info@ahslaw.co.za", token_sealed: "sealed", client_kind: "company", client_ref: "crm-ahs", from_name: "AHS Law" });
    store.delegate("acc-client", "agent-am");
    await store.upsertDomainCheck({ company_id: CO, domain: "ahslaw.co.za", status: "bad", result: {}, source: "account", client_kind: "company", client_ref: "crm-ahs", checked_at: "2026-10-03T05:17:00.000Z", first_checked_at: "2026-10-03T05:17:00.000Z", status_since: "2026-10-03T05:17:00.000Z", dmarc_none_since: null });
    const result = await listMailboxes(env, CO, "agent-am");
    const own = result.accounts.find((a) => a.accountId === "acc-1")!;
    const client = result.accounts.find((a) => a.accountId === "acc-client")!;
    expect(own.mayRead).toBe(false);
    expect(own.askToOwner).toMatchObject({ kind: "grant", effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: "acc-1", agentId: "agent-am", scope: "read+draft" } }, links: [{ href: "/PIB/mailbox?tab=mailboxes" }] });
    expect(own.askToOwner!.question).toContain("May Account Manager read and draft mail on peet@partnersinbiz.online");
    expect(client).toMatchObject({ mayRead: true, askToOwner: null, client: { kind: "company", ref: "crm-ahs" }, fromName: "AHS Law", domainHealth: { domain: "ahslaw.co.za", status: "bad", healthy: false } });
    expect(result.defaultAccountId).toBe("acc-1");
    expect(result.next).toMatch(/Use an accountId where mayDraft is true/);
    const none = await listMailboxes(env, CO, "agent-nobody");
    expect(none.next).toMatch(/partnersinbiz\.cockpit:ask-owner once with the askToOwner card/);
  });
});

describe("a store with removals", () => {
  it("MemoryStore keeps a removal until a grant ends it (the stand-in matches the SQL)", async () => {
    const store = new MemoryStore();
    store.addAccount({ id: "a", company_id: CO, address: "a@x.co", token_sealed: "x" });
    await store.removeDelegation(CO, "a", "g", "u");
    expect(await store.insertDefaultDelegation({ id: "1", companyId: CO, accountId: "a", agentId: "g", canRead: true, canDraft: true, canSend: false, grantedBy: "default:operator" })).toBe(false);
    await store.grantDelegation({ id: "2", companyId: CO, accountId: "a", agentId: "g", canRead: true, canDraft: false, canSend: false, source: "manual", grantedBy: "u" });
    expect(await store.insertDefaultDelegation({ id: "3", companyId: CO, accountId: "a", agentId: "g", canRead: true, canDraft: true, canSend: false, grantedBy: "default:operator" })).toBe(false);
    expect(await store.delegationFor("a", "g")).toEqual({ can_read: true, can_draft: false, can_send: false });
  });
});
