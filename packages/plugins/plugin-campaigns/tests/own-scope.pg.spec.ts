/**
 * Stage B2 (PAR-15209): a person limited to his own companies, under `enforce`, works only on their campaigns. His
 * companies are the CRM companies he owns or is on "Managed by" for (the CRM copy's `managers`, migration 022). A
 * guessed id and another company's record get the same refusal. With the switch off nothing changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, PERMISSION_DENIED, accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { CAMPAIGNS_ACCESS_TABLE } from "../src/access-table.js";
import { addAudienceMember, insertCampaign, insertEnrollment, upsertConsent } from "../src/db.js";
import type { CampaignDraft } from "../src/domain.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { limitToOwnClients, ONE_CAMPAIGN_ONLY, OWN_SCOPE_RULES, TAG_AUDIENCE_CLOSED } from "../src/own-scope.js";
import plugin from "../src/worker.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: PgHarness;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OWNER = "user-owner";
const MEMBER = "user-member";
const AGENT = "agent-camp";
const REFUSED = `Access refused: ${NOT_AMONG_YOUR_COMPANIES}.`;
const NAME_ONE = `Access refused: ${NAME_YOUR_COMPANY}.`;

type World = { harness: TestHarness };
const stateKey = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;

async function world(): Promise<World> {
  const harness = createTestHarness({ manifest, config: { timezone: "UTC", publicBaseUrl: "https://paperclip.test" } });
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: role, grants: [], createdAt: at, updatedAt: at }) as never;
  harness.seed({
    companies: [{ id: COMPANY, issuePrefix: "PIB", name: "PiB" } as never],
    agents: [{ id: AGENT, companyId: COMPANY, name: AGENT, status: "idle" } as never],
    accessMembers: [member(OWNER, "owner"), member(MEMBER, "member")],
  });
  (harness.ctx as unknown as { db: unknown }).db = pg.ctx.db;
  await plugin.definition.setup(harness.ctx);
  return { harness };
}

const crmCompany = (w: World, id: string, name: string, managers: { ownerUserId: string | null; managerUserIds: string[] }) =>
  w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id, name, domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z", managers }, { companyId: COMPANY });
const crmContact = (w: World, id: string, name: string, accountIds: string[], emails: string[] = []) =>
  w.harness.emit("plugin.partnersinbiz.crm.contact.upserted", { id, name, emails, phones: [], lifecycle: null, tags: [], accountIds, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });

/** Turns `enforce` on for the company with MEMBER on the Client manager preset (own companies). */
function limit(w: World, mode: "enforce" | "off" = "enforce") {
  const rows = new Map<string, unknown>([
    [stateKey(accessCompanyScope(COMPANY)), { mode, rev: 1, userIds: [MEMBER], receivedAt: new Date().toISOString() }],
    [stateKey(accessGrantScope(COMPANY, MEMBER)), { preset: "clientManager" }],
  ]);
  const { get } = w.harness.ctx.state;
  w.harness.ctx.state.get = async (scope: Parameters<typeof get>[0]) => (rows.has(stateKey(scope)) ? rows.get(stateKey(scope)) : get.call(w.harness.ctx.state, scope));
}

const draft = (id: string, client: { kind: "company" | "contact"; id: string; name: string } | null, over: Partial<CampaignDraft> = {}): CampaignDraft => ({
  id, companyId: COMPANY, name: `Campaign ${id}`, description: "", status: "draft", fromName: "Sam", fromLocal: "hello", replyTo: null, audienceTags: [],
  startAt: null, endAt: null, approvalIssueId: null, winnerVariant: null, clientKind: client?.kind ?? null, clientRef: client?.id ?? null, clientName: client?.name ?? null,
  audienceMode: client ? (client.kind === "contact" ? "client_contact" : "client_contacts") : "tags", delivery: "issue", ownerUserId: OWNER, ownerAgentId: null, ...over,
}) as CampaignDraft;

/** The parts of the answers these tests read. */
type Row = { id: string };
type Load = { limitedTo?: { client: string; clients: Array<{ client: string; name: string }> }; campaigns: Row[]; series: { byCampaign?: Record<string, unknown> }; brands: unknown[]; messaging: unknown };
type ToolData = {
  campaigns?: Row[]; client?: { kind: string; id: string }; sender?: string;
  listMemberships?: Array<{ client: { id: string } }>; consents?: unknown[]; person?: { emails: string[]; phones: string[] }; counts?: Record<string, number>;
};
type ToolOut = { data?: ToolData; error?: string };
/** An agent's run for MEMBER, as core sends it (the host names the person the run works for). */
const tool = (w: World, name: string, params: Record<string, unknown> = {}, forUser = MEMBER) =>
  w.harness.executeTool<ToolOut>(name, params, { companyId: COMPANY, agentId: AGENT, runId: "run-1", projectId: "proj-1", onBehalfOfUserId: forUser, onBehalfOfRestricted: forUser === MEMBER } as never);
const act = <T = Load>(w: World, key: string, params: Record<string, unknown> = {}, userId = MEMBER) =>
  w.harness.performAction<T>(key, params, { companyId: COMPANY, actor: { type: "user", userId, agentId: null, runId: null, companyId: COMPANY } } as never);
const route = (userId: string, query: Record<string, string>) =>
  plugin.definition.onApiRequest!({ routeKey: "client-summary", method: "GET", path: "/client-summary", params: {}, query, body: null, actor: { actorType: "user", actorId: userId, userId }, companyId: COMPANY, headers: {} } as never);
const refusedWith = (result: unknown) => (isRefusal(result) && result.code === PERMISSION_DENIED ? result.message : `not refused: ${JSON.stringify(result)?.slice(0, 200)}`);
/** A page action that ran (it may still throw its own error, which is not a refusal). */
const ran = async (p: Promise<unknown>) => {
  try {
    return !isRefusal(await p);
  } catch {
    return true;
  }
};

describe("Campaigns access table and the own-scope rules", () => {
  it("a row is scoped exactly when it has an own-scope rule, and only campaigns.campaigns rows are", () => {
    const scoped = Object.entries(CAMPAIGNS_ACCESS_TABLE).filter(([, e]) => typeof e === "object" && "resource" in e && e.scoped === true);
    expect(scoped.map(([k]) => k).sort()).toEqual(Object.keys(OWN_SCOPE_RULES).sort());
    for (const [key, entry] of scoped) expect((entry as { resource: string }).resource, key).toBe("campaigns.campaigns");
  });

  it("a key with no rule is refused before anything is read (fail closed)", async () => {
    const ctx = {} as PluginContext;
    for (const key of ["campaigns.move", "tool:list-campaign-templates", "campaigns.no-such-key"]) {
      expect(await limitToOwnClients(ctx, COMPANY, new Set(["acme"]), key, { client: "company:acme" }), key).toEqual({ refused: NOT_AMONG_YOUR_COMPANIES });
    }
  });
});

describe.skipIf(!available)("a person limited to his own companies (enforce)", () => {
  let w: World;
  beforeEach(async () => {
    await pg.reset();
    w = await world();
    await crmCompany(w, "acme", "Acme Ltd", { ownerUserId: MEMBER, managerUserIds: [] });
    await crmCompany(w, "beta", "Beta Bakery", { ownerUserId: OWNER, managerUserIds: [MEMBER] });
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await crmContact(w, "jo", "Jo Acme", ["acme"], ["jo@acme.test"]);
    await crmContact(w, "zed", "Zed Other", ["other"], ["zed@other.test"]);
    await insertCampaign(pg.ctx, draft("c-acme", { kind: "company", id: "acme", name: "Acme Ltd" }));
    await insertCampaign(pg.ctx, draft("c-acme-tags", { kind: "company", id: "acme", name: "Acme Ltd" }, { audienceMode: "tags", audienceTags: ["vip"] }));
    await insertCampaign(pg.ctx, draft("c-jo", { kind: "contact", id: "jo", name: "Jo Acme" }));
    await insertCampaign(pg.ctx, draft("c-zed", { kind: "contact", id: "zed", name: "Zed Other" }));
    await insertCampaign(pg.ctx, draft("c-other", { kind: "company", id: "other", name: "Other Co" }, { status: "active" }));
    await insertCampaign(pg.ctx, draft("c-own", null));
    await insertEnrollment(pg.ctx, { id: "e-acme", companyId: COMPANY, campaignId: "c-acme", contactId: "jo", status: "running", stepPosition: 1, variant: "a", nextDueAt: "2099-01-01T08:00:00.000Z", openIssueId: null } as never);
    await insertEnrollment(pg.ctx, { id: "e-other", companyId: COMPANY, campaignId: "c-other", contactId: "zed", status: "running", stepPosition: 1, variant: "a", nextDueAt: "2099-01-01T08:00:00.000Z", openIssueId: null } as never);
    await pg.client.query(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, source_key) VALUES ('ev-1', $1, 'c-other', 'e-other', 1, 'reply', 'reply:msg-other')`, [COMPANY]);
    limit(w);
  });

  it("the page opens his first client, lists only his client-bound campaigns, and leaves out the company-wide parts", async () => {
    const load = await act(w, "campaigns.load", {});
    expect(load.limitedTo).toEqual({ client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "company:beta", name: "Beta Bakery" }, { client: "contact:jo", name: "Jo Acme" }] });
    expect(load.campaigns.map((c) => c.id)).toEqual(["c-acme"]);
    expect(Object.keys(load.series.byCampaign ?? {})).not.toContain("c-acme-tags");
    expect(load.brands).toEqual([]);
    expect(load.messaging).toBeNull();
    expect((await act(w, "campaigns.load", { client: "contact:jo" })).campaigns.map((c) => c.id)).toEqual(["c-jo"]);
    for (const client of ["company:other", "contact:zed", "own", "company:guessed"]) {
      expect(refusedWith(await act(w, "campaigns.load", { client })), client).toBe(NOT_AMONG_YOUR_COMPANIES);
    }
  });

  it("a list or a create names one of his clients; none, all, own and another company's are refused", async () => {
    expect((await tool(w, "list-campaigns", { client: "company:acme" })).data?.campaigns?.map((c) => c.id)).toEqual(["c-acme"]);
    expect((await tool(w, "list-campaigns", { clientKind: "contact", clientRef: "jo" })).data?.campaigns?.map((c) => c.id)).toEqual(["c-jo"]);
    for (const params of [{}, { client: "all" }, { client: "own" }]) expect((await tool(w, "list-campaigns", params)).error, JSON.stringify(params)).toBe(NAME_ONE);
    for (const client of ["company:other", "contact:zed", "contact:nobody"]) expect((await tool(w, "list-campaigns", { client })).error, client).toBe(REFUSED);
    expect((await tool(w, "create-campaign", { name: "New", client: "company:beta" })).data?.client).toMatchObject({ kind: "company", id: "beta" });
    expect((await tool(w, "create-campaign", { name: "New" })).error).toBe(NAME_ONE);
    expect((await tool(w, "create-campaign", { name: "New", client: "company:other" })).error).toBe(REFUSED);
    expect((await tool(w, "create-campaign", { name: "New", client: "company:acme", audienceMode: "tags" })).error).toBe(`Access refused: ${TAG_AUDIENCE_CLOSED}.`);
    expect(refusedWith(await act(w, "campaigns.create-campaign", { name: "New", client: "company:other" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(refusedWith(await act(w, "campaigns.create-campaign", { name: "New" }))).toBe(NAME_YOUR_COMPANY);
  });

  it("a campaign by id must be his; another company's, a tag audience and a guessed id get the same answer", async () => {
    expect((await tool(w, "campaign-stats", { campaignId: "c-acme" })).error).toBeUndefined();
    expect(await ran(act(w, "campaigns.detail", { campaignId: "c-acme" }))).toBe(true);
    for (const campaignId of ["c-other", "c-zed", "c-acme-tags", "c-own", "guessed-id"]) {
      for (const name of ["campaign-stats", "update-campaign", "launch-campaign", "pause-campaign", "preflight-campaign", "campaign-results", "suggest-ab-winner"]) {
        expect((await tool(w, name, { campaignId })).error, `${name} ${campaignId}`).toBe(REFUSED);
      }
      for (const key of ["campaigns.detail", "campaigns.results", "campaigns.launch", "campaigns.approve", "campaigns.pause", "campaigns.audience-members", "campaigns.set-mode"]) {
        expect(refusedWith(await act(w, key, { campaignId })), `${key} ${campaignId}`).toBe(NOT_AMONG_YOUR_COMPANIES);
      }
    }
  });

  it("his campaign does not carry another company's client or contact through", async () => {
    for (const client of ["company:other", "own", "company:guessed"]) {
      expect((await tool(w, "update-campaign", { campaignId: "c-acme", client })).error, client).toBe(REFUSED);
    }
    expect((await tool(w, "update-campaign", { campaignId: "c-acme", audienceMode: "tags" })).error).toBe(`Access refused: ${TAG_AUDIENCE_CLOSED}.`);
    for (const contactId of ["zed", "nobody"]) expect((await tool(w, "enroll-contact", { campaignId: "c-acme", contactId })).error, contactId).toBe(REFUSED);
    expect((await tool(w, "launch-campaign", { campaignId: "c-acme", contactIds: ["jo", "zed"] })).error).toBe(REFUSED);
    expect(refusedWith(await act(w, "campaigns.enroll", { campaignId: "c-acme", contactId: "zed" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect((await tool(w, "enroll-contact", { campaignId: "c-acme", contactId: "jo" })).error ?? "").not.toMatch(/^Access refused/);
  });

  it("an enrollment and a reply lead to their campaign; stopping a person everywhere is refused", async () => {
    expect((await tool(w, "stop-enrollment", { enrollmentId: "e-acme" })).error).toBeUndefined();
    expect((await tool(w, "stop-enrollment", { enrollmentId: "e-acme", everyCampaign: true })).error).toBe(`Access refused: ${ONE_CAMPAIGN_ONLY}.`);
    for (const enrollmentId of ["e-other", "guessed-id"]) {
      expect((await tool(w, "stop-enrollment", { enrollmentId })).error, enrollmentId).toBe(REFUSED);
      expect((await tool(w, "record-step-event", { enrollmentId, eventType: "open" })).error, enrollmentId).toBe(REFUSED);
    }
    for (const messageId of ["msg-other", "msg-guessed"]) {
      expect((await tool(w, "log-reply", { messageId, outcome: "answered", note: "n" })).error, messageId).toBe(REFUSED);
    }
  });

  it("suppressions name one of his clients", async () => {
    expect((await tool(w, "suppress-address", { email: "a@b.test", client: "company:acme" })).data?.sender).toBe("company:acme");
    expect((await tool(w, "suppress-address", { email: "a@b.test" })).error).toBe(NAME_ONE);
    expect((await tool(w, "suppress-address", { email: "a@b.test", client: "company:other" })).error).toBe(REFUSED);
    expect((await tool(w, "suppress-phone", { phone: "+27821234567", client: "own" })).error).toBe(NAME_ONE);
    expect((await tool(w, "record-channel-consent", { channel: "sms", contactIds: ["zed"], client: "company:acme", evidence: "form" })).error).toBe(REFUSED);
  });

  it("the client counts show only his clients; the API route refuses another company's and a guessed id alike", async () => {
    await pg.client.query(`UPDATE ${NAMESPACE}.campaigns SET status = 'active' WHERE id IN ('c-acme', 'c-zed')`);
    expect((await act<{ clients: Row[] }>(w, "campaigns.client-summary", {})).clients.map((c) => c.id)).toEqual(["acme"]);
    expect((await act<{ clients: Row[] }>(w, "campaigns.client-summary", {}, OWNER)).clients.map((c) => c.id).sort()).toEqual(["acme", "other", "zed"]);
    expect(await route(MEMBER, { kind: "company", id: "acme" })).toMatchObject({ status: 200 });
    for (const query of [{ kind: "company", id: "other" }, { kind: "contact", id: "zed" }, { kind: "company", id: "guessed" }]) {
      expect(await route(MEMBER, query), JSON.stringify(query)).toMatchObject({ status: 403, body: { refused: true, code: PERMISSION_DENIED, message: NOT_AMONG_YOUR_COMPANIES } });
    }
  });

  it("a person's export holds only what sits on his clients' lists and senders", async () => {
    const base = { companyId: COMPANY, listName: "Expo", name: "Ann", source: "sheet", lawfulBasis: "consent" as const };
    await addAudienceMember(pg.ctx, { ...base, client: { kind: "company", id: "acme" }, email: "ann@x.test" });
    await addAudienceMember(pg.ctx, { ...base, client: { kind: "company", id: "other" }, email: "ann@x.test", phone: "+27820000001" });
    const consent = { companyId: COMPANY, channel: "sms" as const, address: "+27820000001", granted: true, basis: "consent", source: "form", evidence: null, recordedAt: "2026-10-01T00:00:00Z" };
    await upsertConsent(pg.ctx, { ...consent, senderKey: "company:other" } as never);
    const owner = await tool(w, "export-person-data", { email: "ann@x.test" }, OWNER);
    expect(owner.data?.counts).toEqual({ list_members: 2, consents: 1 });
    const his = await tool(w, "export-person-data", { email: "ann@x.test" });
    expect(his.data?.listMemberships?.map((m) => m.client.id)).toEqual(["acme"]);
    expect(his.data?.consents).toEqual([]);
    expect(his.data?.person).toEqual({ emails: ["ann@x.test"], phones: [] });
    expect(his.data?.counts).toEqual({ list_members: 1, consents: 0 });
  });

  it("templates, senders, preferences, brands, moves, Growth Lab, Cockpit and Setup stay closed; an owner is not limited", async () => {
    for (const key of ["campaigns.preferences-load", "campaigns.move", "campaigns.set-own-brand", "campaigns.growth-load", "campaigns.audience-tick", "canvas.cards.search"]) {
      expect(isRefusal(await act(w, key, { campaignId: "c-acme" })), key).toBe(true);
    }
    for (const name of ["list-campaign-templates", "create-campaign-from-template", "list-sender-identities", "set-sender-identity", "create-feed-digest", "get-playbook"]) {
      expect((await tool(w, name, { client: "company:acme" })).error, name).toMatch(/^Access refused/);
    }
    for (const routeKey of ["cockpit", "setup-status"]) {
      const out = await plugin.definition.onApiRequest!({ routeKey, method: "GET", path: `/${routeKey}`, params: {}, query: {}, body: null, actor: { actorType: "user", actorId: MEMBER, userId: MEMBER }, companyId: COMPANY, headers: {} } as never);
      expect(out.status, routeKey).toBe(403);
    }
    const owner = await act(w, "campaigns.load", {}, OWNER);
    expect(owner.limitedTo).toBeUndefined();
    expect(owner.campaigns.map((c) => c.id)).toEqual(["c-own"]);
  });

  it("fails closed: when his companies or a contact's companies cannot be read, the page and the tools refuse", async () => {
    const db = pg.ctx.db;
    const { query } = db;
    const failOn = (part: string) => {
      db.query = (async (sql: string, params?: unknown[]) => {
        if (sql.includes(part)) throw new Error("read failed");
        return query.call(db, sql, params);
      }) as typeof db.query;
    };
    try {
      failOn("managers->>'ownerUserId'");
      expect(isRefusal(await act(w, "campaigns.load", {}))).toBe(true);
      expect((await tool(w, "list-campaigns", { client: "company:acme" })).error).toMatch(/^Access refused/);
      failOn("SELECT account_ids FROM");
      const contact = await tool(w, "list-campaigns", { client: "contact:jo" });
      expect(contact.data?.campaigns).toBeUndefined();
      expect(JSON.stringify(contact)).toMatch(/read failed/);
    } finally {
      db.query = query;
    }
  });
});

describe.skipIf(!available)("the same person with the switch off", () => {
  it("is not limited: the page, the lists and the counts are as today", async () => {
    await pg.reset();
    const w = await world();
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await insertCampaign(pg.ctx, draft("c-other", { kind: "company", id: "other", name: "Other Co" }));
    await insertCampaign(pg.ctx, draft("c-own", null));
    limit(w, "off");
    const load = await act(w, "campaigns.load", {});
    expect(load.limitedTo).toBeUndefined();
    expect(load.campaigns.map((c) => c.id)).toEqual(["c-own"]);
    expect((await tool(w, "list-campaigns", { client: "company:other" })).data?.campaigns?.map((c) => c.id)).toEqual(["c-other"]);
    expect((await tool(w, "campaign-stats", { campaignId: "c-other" })).error).toBeUndefined();
  });
});
