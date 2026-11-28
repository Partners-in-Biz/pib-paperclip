/**
 * Stage B2 (PAR-12582): a person limited to his own companies, under `enforce`, works only on their ad scopes. His
 * companies are the CRM companies he owns or is on "Managed by" for (the CRM copy's `managers`). A guessed id and
 * another company's record get the same refusal. With the switch off nothing changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, PERMISSION_DENIED, accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { ACCESS_TABLE } from "../src/access-table.js";
import { OWN_SCOPE_RULES } from "../src/own-scope.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, MEMBER, OWNER, world, type World } from "./helpers/world.js";
import { CREATE, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const RUN = "run-limited";
const stateKey = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;
const crmCompany = (w: World, id: string, name: string, managers: { ownerUserId: string | null; managerUserIds: string[] }) =>
  w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id, name, domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z", managers }, { companyId: COMPANY });
const crmContact = (w: World, id: string, name: string, accountIds: string[]) =>
  w.harness.emit("plugin.partnersinbiz.crm.contact.upserted", { id, name, emails: [], phones: [], lifecycle: null, tags: [], accountIds, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });

/** Turns `enforce` on for the company with MEMBER on the Client manager preset (own companies). */
function limit(w: World, mode: "enforce" | "off" = "enforce") {
  const rows = new Map<string, unknown>([
    [stateKey(accessCompanyScope(COMPANY)), { mode, rev: 1, userIds: [MEMBER], receivedAt: new Date().toISOString() }],
    [stateKey(accessGrantScope(COMPANY, MEMBER)), { preset: "clientManager" }],
  ]);
  const { get } = w.ctx.state;
  w.ctx.state.get = async (scope: Parameters<typeof get>[0]) => (rows.has(stateKey(scope)) ? rows.get(stateKey(scope)) : get.call(w.ctx.state, scope));
}

/** The parts of the answers these tests read. */
type Row = { scopeKey?: string; id?: string; proposalId?: string };
type Load = { limitedTo?: { scopeKey: string; scopeKeys: string[] }; accounts: Row[]; proposals: Row[]; connections: unknown[]; clients: Record<string, string> };
type ToolOut = { data?: { accounts?: Row[]; proposalId?: string }; error?: string };
/** An agent's run for MEMBER, as core sends it (H3: the host names the person the run works for). */
const tool = (w: World, name: string, params: Record<string, unknown> = {}, forMember = true) =>
  w.harness.executeTool<ToolOut>(name, params, { companyId: COMPANY, agentId: ADS_AGENT, runId: RUN, projectId: "proj-1", ...(forMember ? { onBehalfOfUserId: MEMBER, onBehalfOfRestricted: true } : {}) } as never);
const act = <T = Load>(w: World, key: string, params: Record<string, unknown> = {}, userId = MEMBER) =>
  w.harness.performAction<T>(key, params, { companyId: COMPANY, actor: { type: "user", userId, agentId: null, runId: null, companyId: COMPANY } } as never);
const refusedWith = (result: unknown) => (isRefusal(result) && result.code === PERMISSION_DENIED ? result.message : `not refused: ${JSON.stringify(result)?.slice(0, 200)}`);

describe("Ads access table and the own-scope rules", () => {
  it("a row is scoped exactly when it has an own-scope rule, and only ads.work rows are", () => {
    const scoped = Object.entries(ACCESS_TABLE).filter(([, e]) => typeof e === "object" && "resource" in e && e.scoped === true);
    expect(scoped.map(([k]) => k).sort()).toEqual(Object.keys(OWN_SCOPE_RULES).sort());
    for (const [key, entry] of scoped) expect((entry as { resource: string }).resource, key).toBe("ads.work");
  });
});

describe.skipIf(!available)("a person limited to his own companies (enforce)", () => {
  let w: World;
  let acme: { accountId: string };
  let other: { accountId: string };
  let otherProposal: string;
  let acmeProposal: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    await crmCompany(w, "acme", "Acme Ltd", { ownerUserId: MEMBER, managerUserIds: [] });
    await crmCompany(w, "beta", "Beta Bakery", { ownerUserId: OWNER, managerUserIds: [MEMBER] });
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await crmContact(w, "jo", "Jo Acme", ["acme"]);
    await crmContact(w, "zed", "Zed Other", ["other"]);
    await syncedAccount(w);
    acme = await syncedAccount(w, { scope: "company:acme", externalId: "ext-acme" });
    await syncedAccount(w, { scope: "company:beta", externalId: "ext-beta" });
    other = await syncedAccount(w, { scope: "company:other", externalId: "ext-other" });
    await syncedAccount(w, { scope: "contact:jo", externalId: "ext-jo" });
    await syncedAccount(w, { scope: "contact:zed", externalId: "ext-zed" });
    // Made before the switch goes on: the agent's own run has no person, so under enforce it could not.
    const propose = async (accountId: string, scopeKey: string) => {
      const out = await tool(w, "propose-ad-change", CREATE(accountId, { scopeKey }), false);
      if (!out.data?.proposalId) throw new Error(`no proposal: ${out.error}`);
      return out.data.proposalId;
    };
    otherProposal = await propose(other.accountId, "company:other");
    acmeProposal = await propose(acme.accountId, "company:acme");
    limit(w);
  });

  it("the page opens his first company, lists only his, and leaves out the company-wide parts", async () => {
    const load = await act(w, "ads.load", {});
    expect(load.limitedTo).toEqual({ scopeKey: "company:acme", scopeKeys: ["company:acme", "company:beta", "contact:jo"] });
    expect(load.accounts.map((a) => a.scopeKey)).toEqual(["company:acme"]);
    expect(load.connections).toEqual([]);
    expect(Object.keys(load.clients).sort()).toEqual(["company:acme", "company:beta", "contact:jo"]);
    expect(load.proposals.map((p) => p.id ?? p.proposalId)).toEqual([acmeProposal]);
    expect((await act(w, "ads.load", { client: "contact:jo" })).limitedTo?.scopeKey).toBe("contact:jo");
    for (const client of ["company:other", "contact:zed", "own", "company:guessed"]) {
      expect(refusedWith(await act(w, "ads.load", { client })), client).toBe(NOT_AMONG_YOUR_COMPANIES);
    }
  });

  it("an agent tool for him names one of his companies; none, all, own and another company's are refused", async () => {
    expect((await tool(w, "list-ad-accounts", { client: "company:acme" })).data?.accounts?.map((a) => a.scopeKey)).toEqual(["company:acme"]);
    expect((await tool(w, "list-ad-accounts", { client: "contact:jo" })).error).toBeUndefined();
    expect((await tool(w, "list-ad-accounts", { client: "company:beta" })).error).toBeUndefined();
    expect((await tool(w, "list-ad-accounts")).error).toBe(`Access refused: ${NAME_YOUR_COMPANY}.`);
    expect((await tool(w, "get-ads-summary", { client: "all" })).error).toBe(`Access refused: ${NAME_YOUR_COMPANY}.`);
    for (const client of ["own", "company:other", "contact:zed", "contact:nobody"]) {
      expect((await tool(w, "list-ad-proposals", { client })).error, client).toBe(`Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`);
    }
    expect((await tool(w, "propose-ad-change", CREATE(other.accountId, { scopeKey: "company:other" }))).error).toBe(`Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`);
    // His company as `client` does not carry another company's `scopeKey` through.
    expect((await tool(w, "propose-ad-change", CREATE(other.accountId, { client: "company:acme", scopeKey: "company:other" }))).error).toBe(`Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`);
    // His own scope with another scope's account, named either way: the proposal's own check refuses it (proposal-input.ts).
    for (const named of [{ scopeKey: "company:acme" }, { client: "company:acme", scopeKey: undefined }]) {
      expect((await tool(w, "propose-ad-change", CREATE(other.accountId, named))).error, JSON.stringify(named)).toMatch(/belongs to another scope/);
    }
  });

  it("a record by id must sit in one of his scopes; a guessed id gets the same answer as another company's", async () => {
    expect((await tool(w, "get-ad-proposal", { proposalId: acmeProposal })).error).toBeUndefined();
    for (const proposalId of [otherProposal, "guessed-id"]) {
      expect((await tool(w, "get-ad-proposal", { proposalId })).error, proposalId).toBe(`Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`);
      expect((await tool(w, "cancel-ad-proposal", { proposalId })).error, proposalId).toBe(`Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`);
      for (const key of ["ads.proposal", "ads.approve", "ads.cancel-proposal", "ads.mark-done", "ads.execute"]) {
        expect(refusedWith(await act(w, key, { proposalId })), `${key} ${proposalId}`).toBe(NOT_AMONG_YOUR_COMPANIES);
      }
    }
    expect(refusedWith(await act(w, "ads.ack-alert", { alertId: "guessed-id" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(refusedWith(await act(w, "ads.sync", {}))).toBe(NAME_YOUR_COMPANY);
    expect(refusedWith(await act(w, "ads.sync", { accountId: other.accountId }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(isRefusal(await act(w, "ads.sync", { accountId: acme.accountId }))).toBe(false);
  });

  it("fails closed: when his companies or a contact's companies cannot be read, the page and the tools refuse", async () => {
    const { query } = w.ctx.db;
    const failOn = (part: string) => {
      w.ctx.db.query = (async (sql: string, params?: unknown[]) => {
        if (sql.includes(part)) throw new Error("read failed");
        return query.call(w.ctx.db, sql, params);
      }) as typeof w.ctx.db.query;
    };
    // The guard's resolver (his companies): a refusal, not "every company".
    failOn("managers->>'ownerUserId'");
    expect(isRefusal(await act(w, "ads.load", {}))).toBe(true);
    expect((await tool(w, "list-ad-accounts", { client: "company:acme" })).error).toMatch(/^Access refused/);
    // A contact's companies: an error, never the records.
    failOn("SELECT account_ids FROM");
    const contact = await tool(w, "list-ad-accounts", { client: "contact:jo" });
    expect(contact.data?.accounts).toBeUndefined();
    expect(JSON.stringify(contact)).toMatch(/read failed/);
    w.ctx.db.query = query;
  });

  it("company-wide rows stay closed to him; an owner is not limited", async () => {
    for (const key of ["ads.campaign-caps", "ads.agent", "ads.set-cap", "ads.register-account"]) expect(isRefusal(await act(w, key, {})), key).toBe(true);
    expect((await tool(w, "list-campaigns-without-cap")).error).toMatch(/^Access refused/);
    const owner = await act(w, "ads.load", {}, OWNER);
    expect(owner.limitedTo).toBeUndefined();
    expect(owner.accounts).toHaveLength(6);
  });
});

describe.skipIf(!available)("the same person with the switch off", () => {
  it("is not limited: the page shows every scope, as today", async () => {
    await pg.reset();
    const w = await world(pg);
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await syncedAccount(w);
    await syncedAccount(w, { scope: "company:other", externalId: "ext-other" });
    limit(w, "off");
    const load = await act(w, "ads.load", {});
    expect(load.limitedTo).toBeUndefined();
    expect(load.accounts.map((a) => a.scopeKey).sort()).toEqual(["company:other", "own"]);
  });
});
