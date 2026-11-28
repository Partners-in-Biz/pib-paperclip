/**
 * Stage B2-4 (PAR-15211): a person limited to his own companies, under `enforce`, works only on their sprints. His
 * companies are the CRM companies he owns or is on "Managed by" for (the CRM copy's `managers`). A record named by
 * id (a sprint or one of its children) is looked up to its sprint's client; a guessed id and another company's
 * record get the same refusal. With the switch off nothing changes. The real worker on an embedded Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, PERMISSION_DENIED, accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { KIT_GROWTH_TOOL_NAMES } from "../src/growth-host.js";
import { NAMESPACE } from "../src/namespace.js";
import { HANDLER_RULES } from "../src/own-rules.js";
import { OWN_SCOPE_RULES } from "../src/own-scope.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: PgHarness;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OWNER = "user-owner";
const MEMBER = "user-member";
const SEO_AGENT = "agent-seo";
const S = NAMESPACE;
const TABLES = ["audits", "keywords", "previews", "sprint_tasks", "sprints", "crm_companies", "crm_contacts"];

const isScoped = (e: unknown) => typeof e === "object" && e !== null && "scoped" in e && (e as { scoped?: boolean }).scoped === true;

describe("SEO access table and the own-scope rules", () => {
  it("a row is scoped exactly when it has an own-scope rule, and only seo.work rows are", () => {
    const scoped = Object.entries(ACCESS_TABLE).filter(([, e]) => isScoped(e));
    expect(scoped.map(([k]) => k).sort()).toEqual(Object.keys(OWN_SCOPE_RULES).sort());
    for (const [key, entry] of scoped) expect((entry as { resource: string }).resource, key).toBe("seo.work");
  });

  it("every rule names a real handler or kit Growth tool, and the company-wide keys stay closed", () => {
    const known = new Set([...Object.keys(HANDLERS), ...Object.keys(UI_ONLY_HANDLERS), ...KIT_GROWTH_TOOL_NAMES]);
    for (const name of Object.keys(HANDLER_RULES)) expect(known.has(name), name).toBe(true);
    for (const key of ["seo.clients", "seo.routine-report", "seo.upgrade-legacy", "seo.integration", "seo.call-settings", "seo.call-settings-view", "api:cockpit", "api:setup-status", "tool:compact-task-thread", "tool:attach-task-issue", "tool:link-site"]) {
      expect(isScoped(ACCESS_TABLE[key]), key).toBe(false);
    }
  });
});

type Sprint = { sprintId: string };
type Load = { sprints: Sprint[]; limitedTo?: { client: string; clients: Array<{ client: string; name: string }> }; settings: { serviceAccountEmail: unknown }; scope: string | null };
type ToolOut = { data?: { sprints?: Sprint[]; keywordId?: string }; error?: string };

describe.skipIf(!available)("a person limited to his own companies (enforce)", () => {
  let harness: TestHarness;
  const stateKey = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;

  /** Turns `enforce` (or `off`) on for the company with MEMBER on the Client manager preset (own companies). */
  function limit(mode: "enforce" | "off" = "enforce") {
    const rows = new Map<string, unknown>([
      [stateKey(accessCompanyScope(COMPANY)), { mode, rev: 1, userIds: [MEMBER], receivedAt: new Date().toISOString() }],
      [stateKey(accessGrantScope(COMPANY, MEMBER)), { preset: "clientManager" }],
    ]);
    const { get } = harness.ctx.state;
    harness.ctx.state.get = async (scope: Parameters<typeof get>[0]) => (rows.has(stateKey(scope)) ? rows.get(stateKey(scope)) : get.call(harness.ctx.state, scope));
  }
  const crmCompany = (id: string, name: string, managers: { ownerUserId: string | null; managerUserIds: string[] }) =>
    harness.emit("plugin.partnersinbiz.crm.company.upserted", { id, name, domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z", managers }, { companyId: COMPANY });
  const crmContact = (id: string, name: string, accountIds: string[]) =>
    harness.emit("plugin.partnersinbiz.crm.contact.upserted", { id, name, emails: [], phones: [], lifecycle: null, tags: [], accountIds, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
  const sprint = (id: string, client: { kind: string; ref: string } | null) =>
    pg.client.query(`INSERT INTO ${S}.sprints (id, company_id, name, site_url, site_name, start_date, client_kind, client_ref) VALUES ($1, $2, $1, $3, $1, '2026-10-01', $4, $5)`, [id, COMPANY, `https://${id}.example`, client?.kind ?? null, client?.ref ?? null]);
  const act = <T = Load>(key: string, params: Record<string, unknown> = {}, userId = MEMBER) =>
    harness.performAction<T>(key, params, { companyId: COMPANY, actor: { type: "user", userId, agentId: null, runId: null, companyId: COMPANY } } as never);
  const call = (tool: string, params: Record<string, unknown>, key = "seo.call") => act<unknown>(key, { tool, params });
  /** An agent's run for MEMBER, as core sends it (H3: the host names the person the run works for). */
  const tool = (name: string, params: Record<string, unknown> = {}) =>
    harness.executeTool<ToolOut>(name, params, { companyId: COMPANY, agentId: SEO_AGENT, runId: "run-limited", projectId: "proj-1", onBehalfOfUserId: MEMBER, onBehalfOfRestricted: true } as never);
  const refusedWith = (result: unknown) => (isRefusal(result) && result.code === PERMISSION_DENIED ? result.message : `not refused: ${JSON.stringify(result)?.slice(0, 300)}`);

  beforeEach(async () => {
    for (const name of TABLES) await pg.client.query(`DELETE FROM ${S}.${name}`);
    harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({
      companies: [{ id: COMPANY, name: "Partners in Biz", issuePrefix: "PIB", defaultResponsibleUserId: OWNER } as never],
      agents: [{ id: SEO_AGENT, companyId: COMPANY, name: "SEO", status: "idle", role: "general" } as never],
    });
    const member = (principalId: string, membershipRole: string) =>
      ({ id: `${COMPANY}:${principalId}`, companyId: COMPANY, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;
    harness.seed({ accessMembers: [member(OWNER, "owner"), member(MEMBER, "member")] });
    (harness.ctx as unknown as { db: unknown }).db = pg.ctx.db;
    await plugin.definition.setup(harness.ctx);
    await crmCompany("acme", "Acme Ltd", { ownerUserId: MEMBER, managerUserIds: [] });
    await crmCompany("beta", "Beta Bakery", { ownerUserId: OWNER, managerUserIds: [MEMBER] });
    await crmCompany("other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await crmContact("jo", "Jo Acme", ["acme"]);
    await crmContact("zed", "Zed Other", ["other"]);
    await sprint("sp-acme", { kind: "company", ref: "acme" });
    await sprint("sp-jo", { kind: "contact", ref: "jo" });
    await sprint("sp-other", { kind: "company", ref: "other" });
    await sprint("sp-own", null);
    for (const [id, sp] of [["kw-acme", "sp-acme"], ["kw-other", "sp-other"]]) {
      await pg.client.query(`INSERT INTO ${S}.keywords (id, company_id, sprint_id, phrase) VALUES ($1, $2, $3, $1)`, [id, COMPANY, sp]);
    }
    await pg.client.query(
      `INSERT INTO ${S}.previews (id, company_id, sprint_id, page_url, title, html, expires_at) VALUES ('pv-other-0001', $1, 'sp-other', 'https://other.example/', 'P', '<p></p>', now() + interval '1 day')`,
      [COMPANY],
    );
  });

  it("the page opens his first company by name, lists only its sprints and leaves out the company's settings", async () => {
    limit();
    const load = await act("seo.load");
    expect(load.limitedTo).toEqual({ client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "company:beta", name: "Beta Bakery" }] });
    expect(load.sprints.map((s) => s.sprintId)).toEqual(["sp-acme"]);
    expect(load.settings.serviceAccountEmail).toBeNull();
    expect(refusedWith(await act("seo.load", { client: "company:other" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(refusedWith(await act("seo.load", { client: "own" }))).toBe(NAME_YOUR_COMPANY);
  });

  it("a sprint of his opens; another company's sprint, own work and a guessed id get one refusal, and no redirect to a foreign sprint", async () => {
    limit();
    const mine = await act<{ sprint: { sprintId: string }; projects: unknown[] }>("seo.sprint", { sprintId: "sp-acme" });
    expect(mine.sprint.sprintId).toBe("sp-acme");
    expect(mine.projects).toEqual([]);
    // A contact of one of his companies is his client.
    expect((await act<{ sprint: { sprintId: string } }>("seo.sprint", { sprintId: "sp-jo" })).sprint.sprintId).toBe("sp-jo");
    for (const sprintId of ["sp-other", "sp-own", "sp-guessed"]) expect(refusedWith(await act("seo.sprint", { sprintId })), sprintId).toBe(NOT_AMONG_YOUR_COMPANIES);
    // His sprint asked for from another client's workspace: refused, not redirected there.
    expect(refusedWith(await act("seo.sprint", { sprintId: "sp-acme", client: "company:other" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
  });

  it("a page call names a record of his: a child id is looked up to its sprint's client", async () => {
    limit();
    expect(await call("list-keywords", { sprintId: "sp-acme" })).toMatchObject({ keywords: [expect.objectContaining({ keywordId: "kw-acme" })] });
    expect(refusedWith(await call("list-keywords", { sprintId: "sp-other" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
    // Another company's keyword and a guessed one: the same answer. His sprint does not cover a foreign child.
    for (const keywordId of ["kw-other", "kw-guessed"]) {
      expect(refusedWith(await call("retire-keyword", { keywordId }, "seo.call-edit")), keywordId).toBe(NOT_AMONG_YOUR_COMPANIES);
    }
    expect(refusedWith(await call("add-content", { sprintId: "sp-acme", targetKeywordId: "kw-other", title: "T" }, "seo.call-create"))).toBe(NOT_AMONG_YOUR_COMPANIES);
    // A preview prefix of another company's preview.
    expect(refusedWith(await call("cancel-previews", { sprintId: "sp-acme", previewIds: ["pv-other"], reason: "x" }, "seo.call-edit"))).toBe(NOT_AMONG_YOUR_COMPANIES);
    // A call with no record would read every sprint.
    expect(refusedWith(await call("needs-you", {}))).toBe(NAME_YOUR_COMPANY);
    // Settings and a handler with no rule stay closed.
    expect(refusedWith(await call("gsc-properties", { sprintId: "sp-acme" }, "seo.call-settings-view"))).not.toMatch(/^not refused/);
    expect(refusedWith(await call("compact-task-thread", { issueId: "iss-1" }, "seo.call-edit"))).not.toMatch(/^not refused/);
  });

  it("a new sprint needs one of his clients", async () => {
    limit();
    expect(refusedWith(await act("seo.create-sprint", { siteUrl: "https://new.example" }))).toBe(NAME_YOUR_COMPANY);
    expect(refusedWith(await act("seo.create-sprint", { siteUrl: "https://new.example", client: "company:other" }))).toBe(NOT_AMONG_YOUR_COMPANIES);
  });

  it("an agent's run for him names one of his clients; other clients and contacts of other companies are refused", async () => {
    limit();
    expect((await tool("list-sprints")).error).toContain(NAME_YOUR_COMPANY);
    expect((await tool("list-sprints", { client: "company:acme" })).data?.sprints?.map((s) => s.sprintId)).toEqual(["sp-acme"]);
    expect((await tool("list-sprints", { client: "contact:jo" })).data?.sprints?.map((s) => s.sprintId)).toEqual(["sp-jo"]);
    for (const client of ["company:other", "contact:zed", "contact:guessed"]) expect((await tool("list-sprints", { client })).error, client).toContain(NOT_AMONG_YOUR_COMPANIES);
    expect((await tool("check-robots", { url: "https://other.example" })).error).toContain(NAME_YOUR_COMPANY);
    expect((await tool("keyword-history", { keywordId: "kw-other" })).error).toContain(NOT_AMONG_YOUR_COMPANIES);
    // Kit Growth tools take `scope`.
    expect((await tool("list-experiments", { scope: "client:company:other" })).error).toContain(NOT_AMONG_YOUR_COMPANIES);
    expect((await tool("list-experiments", {})).error).toContain(NAME_YOUR_COMPANY);
  });

  it("the client summary answers only for his clients", async () => {
    limit();
    const route = (id: string) =>
      plugin.definition.onApiRequest!({ routeKey: "client-summary", companyId: COMPANY, method: "GET", query: { kind: "company", id }, headers: {}, params: {}, body: null, actor: { actorType: "user", actorId: MEMBER, userId: MEMBER } } as never);
    expect((await route("other")).status).toBe(403);
    expect((await route("guessed")).body).toEqual((await route("other")).body);
    expect((await route("acme")).status).toBe(200);
  });

  it("with the switch off nothing changes: the same person sees every sprint", async () => {
    limit("off");
    const load = await act("seo.load");
    expect(load.limitedTo).toBeUndefined();
    expect((await act<{ sprint: { sprintId: string } }>("seo.sprint", { sprintId: "sp-other" })).sprint.sprintId).toBe("sp-other");
    expect((await tool("list-sprints")).data?.sprints?.map((s) => s.sprintId).sort()).toEqual(["sp-acme", "sp-jo", "sp-other", "sp-own"]);
  });
});
