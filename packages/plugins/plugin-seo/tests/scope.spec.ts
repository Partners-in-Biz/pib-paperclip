import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { scopeParamValue, scopeRedirect, sprintPagePath, sprintScope } from "../src/engine/scope.js";
import { cockpitPath } from "../src/service/common.js";
import { scopeParam } from "../src/service/scope.js";
import { sprintHeadline, summaryClient } from "../src/service/summary.js";
import { SKILLS } from "../src/skills.js";
import { SEO_TOOLS } from "../src/tools.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

function sprintRow(extra: Row): Row {
  return {
    id: "sp", company_id: "co-1", name: "Site", site_url: "https://site.co.za", site_name: "Site", client_kind: null, client_ref: null, client_name: null,
    status: "active", start_date: "2026-09-03", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
    project_id: null, root_issue_id: null, root_issue_identifier: null, agent_id: null, notes: null, paused_reason: null,
    health: {}, scoreboard: {}, today: {}, current_day: 23, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
    audit_days_done: [], seeded_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
    ...extra,
  };
}

const OWN = sprintRow({ id: "own-1", site_name: "Partners in Biz", site_url: "https://partnersinbiz.online" });
const LEGACY = sprintRow({ id: "legacy-1", site_name: "Old", client_name: "Old Client Ltd" });
const ACME = sprintRow({ id: "acme-1", site_name: "Acme", client_ref: "crm-1", client_kind: "company", client_name: "Acme Ltd", health: { score: 62 } });
const JO = sprintRow({ id: "jo-1", site_name: "Jo's Plumbing", client_ref: "ct-1", client_kind: "contact", client_name: "Jo Soap" });

const CRM = {
  companies: [{ id: "crm-1", name: "Acme Ltd", domain: "acme.co.za", lifecycle: "customer" }],
  contacts: [{ id: "ct-1", name: "Jo Soap", emails: ["jo@soap.co.za"], phones: [], lifecycle: "customer", tags: [], account_ids: [] }],
};

/** Emulates the scope clause `clientWhere` writes, so filtering is checked end to end. */
function inScope(sql: string, params: unknown[], row: Row): boolean {
  if (sql.includes("client_ref IS NULL")) return row.client_ref == null;
  const m = sql.match(/client_ref = \$(\d+) AND COALESCE\(client_kind, 'company'\) = \$(\d+)/);
  if (m) return row.client_ref === params[Number(m[1]) - 1] && (row.client_kind ?? "company") === params[Number(m[2]) - 1];
  return true;
}

function insertedRow(params: unknown[]): Row {
  const [id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes] = params;
  return sprintRow({ id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes, seeded_at: null });
}

async function boot(sprints: Row[], extra: { tasks?: Row[]; keywords?: Row[] } = {}) {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
  const rows = [...sprints];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<Row[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.query = async (sql, params = []) => {
    validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
    validateParams(sql, params);
    if (/\.sprints WHERE id = \$1/.test(sql)) return rows.filter((r) => r.id === params[0]);
    if (/\.sprints WHERE company_id = \$1/.test(sql)) return rows.filter((r) => r.company_id === params[0] && inScope(sql, params, r));
    if (/\.crm_companies/.test(sql)) return CRM.companies.filter((c) => params.length < 2 || c.id === params[1]);
    if (/\.crm_contacts/.test(sql)) {
      const ids = typeof params[1] === "string" ? (JSON.parse(params[1]) as string[]) : null;
      return CRM.contacts.filter((c) => !ids || ids.includes(c.id));
    }
    if (/\.sprint_tasks WHERE company_id = \$1 AND sprint_id = \$2/.test(sql)) return (extra.tasks ?? []).filter((t) => t.sprint_id === params[1]);
    if (/\.keywords/.test(sql) && /sprint_id = \$2/.test(sql)) return (extra.keywords ?? []).filter((k) => k.sprint_id === params[1]);
    return [];
  };
  db.execute = async (sql, params = []) => {
    validateRuntimeExecute(sql, NAMESPACE);
    validateParams(sql, params);
    executes.push({ sql, params });
    if (sql.startsWith(`INSERT INTO ${NAMESPACE}.sprints `)) rows.push(insertedRow(params));
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  return { harness, executes };
}

const user = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scope helpers", () => {
  it("reads the scope a sprint lives in and builds its page path", () => {
    expect(sprintScope({ clientKind: null, clientRef: null })).toBeNull();
    expect(sprintScope({ clientKind: null, clientRef: "crm-1" })).toEqual({ kind: "company", id: "crm-1" });
    expect(scopeParamValue({ kind: "contact", id: "ct-1" })).toBe("contact:ct-1");
    expect(sprintPagePath("/seo", "sp-1", null, { tab: "plan" })).toBe("/seo?sprint=sp-1&tab=plan");
    expect(sprintPagePath("/seo", null, { kind: "contact", id: "ct-1" })).toBe("/seo?client=contact%3Act-1");
    expect(cockpitPath({ prefix: "PIB" }, { id: "sp-1", clientKind: "company", clientRef: "crm-1" })).toBe("/PIB/seo?sprint=sp-1&client=company%3Acrm-1");
    expect(cockpitPath({ prefix: "PIB" }, { id: "sp-1", clientKind: null, clientRef: null })).toBe("/PIB/seo?sprint=sp-1");
  });

  it("redirects only when the sprint is outside the page's scope", () => {
    expect(scopeRedirect(null, null)).toBeNull();
    expect(scopeRedirect({ kind: "company", id: "a" }, { kind: "company", id: "a" })).toBeNull();
    expect(scopeRedirect(null, { kind: "contact", id: "ct-1" })).toEqual({ client: "contact:ct-1" });
    expect(scopeRedirect({ kind: "company", id: "a" }, { kind: "contact", id: "a" })).toEqual({ client: "contact:a" });
    expect(scopeRedirect({ kind: "company", id: "a" }, null)).toEqual({ client: null });
  });

  it("parses tool scope strictly", () => {
    expect(scopeParam({})).toBeUndefined();
    expect(scopeParam({ client: null })).toBeNull();
    expect(scopeParam({ client: "own" })).toBeNull();
    expect(scopeParam({ client: "contact:ct-1" })).toEqual({ kind: "contact", id: "ct-1" });
    expect(scopeParam({ clientKind: "contact", clientRef: "ct-1" })).toEqual({ kind: "contact", id: "ct-1" });
    expect(scopeParam({ clientRef: "crm-1" })).toEqual({ kind: "company", id: "crm-1" });
    expect(() => scopeParam({ client: "acme" })).toThrow(/client must be/);
    expect(() => scopeParam({ clientKind: "person", clientRef: "x" })).toThrow(/clientKind/);
    expect(() => scopeParam({ clientKind: "contact" })).toThrow(/needs clientRef/);
  });
});

describe("agent guidance", () => {
  it("explains own vs client scope in the skill and the tools", () => {
    const skill = SKILLS[0]!.markdown;
    expect(skill).toContain("## Scope: PiB's own sites vs client sprints");
    expect(skill).toContain('client: "company:<id>"');
    const create = SEO_TOOLS.find((t) => t.name === "create-sprint")!;
    const props = (create.parametersSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.client!.description).toMatch(/Omit for Partners in Biz's own sites/);
    expect(props.clientName).toBeUndefined();
    for (const name of ["list-sprints", "today", "update-sprint"]) {
      const tool = SEO_TOOLS.find((t) => t.name === name)!;
      expect(Object.keys((tool.parametersSchema as { properties: Record<string, unknown> }).properties), name).toEqual(expect.arrayContaining(["client", "clientKind", "clientRef"]));
    }
  });
});

describe("seo.load scope", () => {
  const all = [OWN, LEGACY, ACME, JO];

  it("shows only PiB's own sprints without a client param", async () => {
    const { harness } = await boot(all);
    const load = await harness.performAction<{ scope: string | null; client: unknown; sprints: Array<{ sprintId: string; client: string | null; legacyClientName?: string }> } & Row>("seo.load", {}, user);
    expect(load.scope).toBeNull();
    expect(load.client).toBeNull();
    expect(load.clients).toBeUndefined();
    expect(load.sprints.map((s) => s.sprintId).sort()).toEqual(["legacy-1", "own-1"]);
    expect(load.sprints.every((s) => s.client === null)).toBe(true);
    expect(load.sprints.find((s) => s.sprintId === "legacy-1")?.legacyClientName).toBe("Old Client Ltd");
  });

  it("shows one client's sprints with the client for the workspace bar", async () => {
    const { harness } = await boot(all);
    const contact = await harness.performAction<{ scope: string; client: Row; sprints: Array<{ sprintId: string; client: string; clientName: string }> }>("seo.load", { client: "contact:ct-1" }, user);
    expect(contact.scope).toBe("contact:ct-1");
    expect(contact.client).toMatchObject({ kind: "contact", id: "ct-1", name: "Jo Soap", email: "jo@soap.co.za", known: true });
    expect(contact.sprints.map((s) => [s.sprintId, s.client, s.clientName])).toEqual([["jo-1", "contact:ct-1", "Jo Soap"]]);
    const company = await harness.performAction<{ client: Row; sprints: Array<{ sprintId: string }> }>("seo.load", { client: "company:crm-1" }, user);
    expect(company.client).toMatchObject({ kind: "company", name: "Acme Ltd", domain: "acme.co.za", known: true });
    expect(company.sprints.map((s) => s.sprintId)).toEqual(["acme-1"]);
  });

  it("reports a client the CRM list does not know", async () => {
    const { harness } = await boot(all);
    const load = await harness.performAction<{ client: Row; clientError: string | null; sprints: unknown[] }>("seo.load", { client: "company:nope" }, user);
    expect(load.client).toMatchObject({ kind: "company", id: "nope", known: false });
    expect(load.clientError).toMatch(/not in the SEO plugin's CRM list/);
    expect(load.sprints).toEqual([]);
  });

  it("tells the page to reopen a sprint in its own scope", async () => {
    const { harness } = await boot(all);
    await expect(harness.performAction("seo.sprint", { sprintId: "jo-1", client: null }, user)).resolves.toEqual({ redirect: { client: "contact:ct-1", clientName: "Jo Soap" } });
    await expect(harness.performAction("seo.sprint", { sprintId: "own-1", client: "company:crm-1" }, user)).resolves.toEqual({ redirect: { client: null, clientName: null } });
    const bundle = await harness.performAction<{ sprint: { sprintId: string; client: string } }>("seo.sprint", { sprintId: "jo-1", client: "contact:ct-1" }, user);
    expect(bundle.sprint).toMatchObject({ sprintId: "jo-1", client: "contact:ct-1" });
  });

  it("filters list-sprints and today by client and lists every sprint without one", async () => {
    const { harness } = await boot(all);
    const every = await harness.executeTool<{ data: { sprints: Array<{ sprintId: string }> } }>("list-sprints", {}, { companyId: "co-1" });
    expect(every.data.sprints).toHaveLength(4);
    const own = await harness.executeTool<{ data: { sprints: Array<{ sprintId: string }> } }>("list-sprints", { client: "own" }, { companyId: "co-1" });
    expect(own.data.sprints.map((s) => s.sprintId).sort()).toEqual(["legacy-1", "own-1"]);
    const acme = await harness.executeTool<{ data: { sprints: Array<{ sprintId: string; client: string }> } }>("list-sprints", { clientKind: "company", clientRef: "crm-1" }, { companyId: "co-1" });
    expect(acme.data.sprints.map((s) => [s.sprintId, s.client])).toEqual([["acme-1", "company:crm-1"]]);
    const today = await harness.executeTool<{ data: { sprints: Array<{ sprintId: string; client: string; clientName: string }> } }>("today", { client: "contact:ct-1" }, { companyId: "co-1" });
    expect(today.data.sprints.map((s) => [s.sprintId, s.client, s.clientName])).toEqual([["jo-1", "contact:ct-1", "Jo Soap"]]);
    const bad = await harness.executeTool<{ error?: string }>("list-sprints", { client: "Acme" }, { companyId: "co-1" });
    expect(bad.error).toMatch(/client must be/);
  });
});

describe("create-sprint scope", () => {
  it("creates a sprint for a CRM contact with the CRM name and a client-prefixed root issue", async () => {
    const { harness, executes } = await boot([]);
    const create = vi.spyOn(harness.ctx.issues, "create");
    const result = await harness.executeTool<{ data?: Row; error?: string }>("create-sprint", { siteUrl: "https://jo.co.za", siteName: "Jo's Plumbing", client: "contact:ct-1" }, { companyId: "co-1" });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ client: "contact:ct-1", clientKind: "contact", clientRef: "ct-1", clientName: "Jo Soap", siteName: "Jo's Plumbing" });
    const insert = executes.find((e) => e.sql.startsWith(`INSERT INTO ${NAMESPACE}.sprints `))!;
    expect(insert.params.slice(4, 8)).toEqual(["Jo's Plumbing", "contact", "ct-1", "Jo Soap"]);
    const root = create.mock.calls.map(([input]) => input as { title: string; description: string }).find((i) => i.title.startsWith("SEO sprint"));
    expect(root?.title).toBe("SEO sprint: Jo's Plumbing (Jo Soap)");
    expect(root?.description).toContain("/PIB/seo?sprint=");
    expect(root?.description).toContain("client=contact%3Act-1");
  });

  it("creates an own sprint without a client and refuses a pretend client name", async () => {
    const { harness, executes } = await boot([]);
    const own = await harness.executeTool<{ data?: Row; error?: string }>("create-sprint", { siteUrl: "https://partnersinbiz.online" }, { companyId: "co-1" });
    expect(own.error).toBeUndefined();
    expect(own.data).toMatchObject({ client: null, clientRef: null, clientName: null, siteName: "partnersinbiz.online" });
    const insert = executes.find((e) => e.sql.startsWith(`INSERT INTO ${NAMESPACE}.sprints `))!;
    expect(insert.params.slice(5, 8)).toEqual([null, null, null]);
    const fake = await harness.executeTool<{ error?: string }>("create-sprint", { siteUrl: "https://x.co.za", clientName: "Someone" }, { companyId: "co-1" });
    expect(fake.error).toMatch(/clientName is not accepted/);
    const unknown = await harness.executeTool<{ error?: string }>("create-sprint", { siteUrl: "https://x.co.za", client: "contact:ghost" }, { companyId: "co-1" });
    expect(unknown.error).toMatch(/not in the SEO plugin's client list/);
  });

  it("lets only a person move a sprint to a client", async () => {
    const { harness, executes } = await boot([LEGACY]);
    const agentTry = await harness.executeTool<{ error?: string }>("update-sprint", { sprintId: "legacy-1", client: "company:crm-1" }, { companyId: "co-1" });
    expect(agentTry.error).toMatch(/Only a person/);
    const moved = await harness.performAction<Row>("seo.call", { tool: "update-sprint", params: { sprintId: "legacy-1", client: "company:crm-1" } }, user);
    expect(moved).toMatchObject({ client: "company:crm-1", clientName: "Acme Ltd" });
    const update = executes.find((e) => e.sql.startsWith(`UPDATE ${NAMESPACE}.sprints SET`))!;
    expect(update.params).toEqual(expect.arrayContaining(["company", "crm-1", "Acme Ltd"]));
  });
});

describe("client-summary route", () => {
  const request = (query: Record<string, string>) => ({
    routeKey: "client-summary",
    method: "GET",
    path: "/client-summary",
    params: {},
    query: { companyId: "co-1", ...query },
    body: null,
    actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1" },
    companyId: "co-1",
    headers: {},
  });

  const task = (extra: Row): Row => ({ id: "t", company_id: "co-1", sprint_id: "acme-1", week: 4, phase: 1, due_day: 23, focus: "", title: "t", task_type: "custom", owner: "agent", autopilot_eligible: true, status: "not_started", source: "template", ...extra });

  it("summarises the client's running sprint", async () => {
    const { harness } = await boot([OWN, ACME, JO], {
      tasks: [
        task({ id: "t1", due_day: 23 }),
        task({ id: "t2", due_day: 10, status: "in_progress" }),
        task({ id: "t3", due_day: 5, status: "blocked" }),
        task({ id: "t4", due_day: 30 }),
        task({ id: "t5", sprint_id: "own-1", due_day: 1 }),
      ],
      keywords: [{ id: "k1", sprint_id: "acme-1", phrase: "a" }, { id: "k2", sprint_id: "acme-1", phrase: "b" }, { id: "k3", sprint_id: "own-1", phrase: "c" }],
    });
    void harness;
    const res = await plugin.definition.onApiRequest!(request({ kind: "company", id: "crm-1" }));
    expect(res).toEqual({
      status: 200,
      body: {
        headline: "Day 23/90 · Foundation",
        stats: [
          { label: "Due today", value: 1 },
          { label: "Overdue", value: 1, tone: "warn" },
          { label: "Blocked", value: 1, tone: "warn" },
          { label: "Health", value: "62/100", tone: "warn" },
          { label: "Keywords tracked", value: 2 },
        ],
      },
    });
  });

  it("answers for a client without sprints and rejects a bad reference", async () => {
    await boot([OWN, ACME]);
    expect(await plugin.definition.onApiRequest!(request({ kind: "contact", id: "ct-1" }))).toEqual({ status: 200, body: { headline: "No SEO sprint", stats: [] } });
    expect((await plugin.definition.onApiRequest!(request({ kind: "person", id: "x" }))).status).toBe(400);
    expect((await plugin.definition.onApiRequest!(request({ kind: "company" }))).status).toBe(400);
  });

  it("formats headlines across the sprint", () => {
    expect(sprintHeadline(-3, 0, "pre_launch")).toBe("Starts in 3 days · Pre-launch");
    expect(sprintHeadline(0, 0, "pre_launch")).toBe("Day 0/90 · Pre-launch");
    expect(sprintHeadline(120, 4, "compounding")).toBe("Day 120 · Compounding");
    expect(sprintHeadline(40, 2, "paused")).toBe("Paused · Day 40/90 · Content engine");
    expect(summaryClient({ kind: ["contact"], id: "ct-1" })).toEqual({ kind: "contact", id: "ct-1" });
    expect(summaryClient({ kind: "company", id: "bad id!" })).toBeNull();
  });
});
