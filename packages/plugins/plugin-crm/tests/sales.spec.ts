import { describe, expect, it } from "vitest";
import { checkDuplicates, checkPipeline } from "../src/done-checks.js";
import { CARE_EVENT_KIND } from "../src/care-clients.js";
import { idleDeals, openDuplicateCheck, openHygieneReport, openPipelineCheck, openPipelineSummary } from "../src/sales.js";
import type { Route, Row, Store } from "./helpers/fake-db.js";
import { boot, CO, contact, crmIssues, deal, seed } from "./helpers/crm.js";

const mine = (rows: Row[] | undefined, p: unknown[]) => (rows ?? []).filter((row) => row.company_id === p[0]);
const DAY = 86_400_000;

/** The idle-deal query: open-stage deals whose last change or activity is older than `$2` days. */
const IDLE: Route = [/LEFT JOIN LATERAL/, (p, s) => {
  const cutoff = Date.now() - Number(p[1]) * DAY;
  return mine(s.deals, p)
    .filter((d) => (s.pipeline_stages ?? []).find((st) => st.id === d.stage_id)?.kind === "open")
    .map((d) => {
      // `$4` is the kind the care features log their own bookkeeping as: it is not contact with the client.
      const acts = (s.activities ?? []).filter((a) => [d.id, d.contact_id, d.account_id].includes(a.record_id) && a.kind !== p[3]).map((a) => Date.parse(String(a.created_at)));
      const last = Math.max(Date.parse(String(d.updated_at)), ...acts);
      return { ...d, last_at: new Date(last).toISOString() };
    })
    .filter((d) => Date.parse(d.last_at) < cutoff)
    .slice(0, Number(p[2]));
}];
const COUNT: Route = [/count\(\*\)::text AS n FROM \S+\.contacts/, (p, s) => [{ n: String(mine(s.contacts, p).length) }]];

function store(extra: Partial<Store> = {}): Store {
  const base = seed();
  return {
    ...base,
    deals: [
      deal("quiet", "Website rebuild", { account_id: "acme", updated_at: new Date(Date.now() - 20 * DAY).toISOString() }),
      deal("busy", "SEO retainer", { updated_at: new Date().toISOString() }),
    ],
    ...extra,
  };
}

async function linked(harness: Awaited<ReturnType<typeof boot>>["harness"], role: string, agentId: string) {
  harness.seed({ agents: [{ id: agentId, companyId: CO, name: agentId, status: "idle" } as never] });
  await harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-hire", stateKey: `role:${role}` }, { agentId, linkedAt: "2026-09-28T08:00:00Z", linkedBy: "manual", hire: null });
}

describe("daily pipeline check", () => {
  it("lists only quiet open deals, for the Sales Lead, once while open", async () => {
    const { harness } = await boot({ store: store(), routes: [IDLE] });
    await linked(harness, "account-manager", "am-1");
    await linked(harness, "sales-lead", "sl-1");
    const id = await openPipelineCheck(harness.ctx, CO);
    const [issue] = await crmIssues(harness);
    expect(issue).toMatchObject({ id, assigneeAgentId: "sl-1" });
    expect(issue!.title).toBe("Pipeline: 1 deal with no activity for 14 days");
    expect(issue!.description).toContain("Website rebuild");
    expect(issue!.description).not.toContain("SEO retainer");
    expect(await openPipelineCheck(harness.ctx, CO, new Date(Date.now() + DAY))).toBeNull();
    expect(await crmIssues(harness)).toHaveLength(1);
  });

  it("opens nothing when every deal is moving", async () => {
    const { harness } = await boot({ store: store({ deals: [deal("busy", "SEO retainer", { updated_at: new Date().toISOString() })] }), routes: [IDLE] });
    expect(await openPipelineCheck(harness.ctx, CO)).toBeNull();
  });

  it("the care features' own bookkeeping on the client is not contact: a quiet deal stays quiet, a call or note wakes it", async () => {
    const s = store();
    s.activities = [{ id: "ce1", company_id: CO, record_type: "company", record_id: "acme", kind: "care_event", body: "Monthly report sent to the client.", created_at: new Date().toISOString() }];
    const { harness, db } = await boot({ store: s, routes: [IDLE] });
    expect((await idleDeals(harness.ctx, CO)).map((d) => d.id)).toEqual(["quiet"]);
    // The query itself names the kind, so the real database leaves them out too (the route above only follows its parameters).
    const sql = db.log.queries.find((q) => /LEFT JOIN LATERAL/.test(q.sql))!;
    expect(sql.sql).toMatch(/x\.kind <> \$4/);
    expect(sql.params[3]).toBe(CARE_EVENT_KIND);
    s.activities.push({ id: "n1", company_id: CO, record_type: "company", record_id: "acme", kind: "note", body: "Spoke to the client", created_at: new Date().toISOString() });
    expect(await idleDeals(harness.ctx, CO)).toEqual([]);
  });

  it("closing checks no deal is still quiet", async () => {
    const s = store();
    const { harness } = await boot({ store: s, routes: [IDLE] });
    const issue = { id: "i1", companyId: CO, originId: "crm:pipeline-check:2026-09-28", createdAt: new Date().toISOString() } as never;
    const open = await checkPipeline(harness.ctx, issue);
    expect(open.done).toBe(false);
    expect(open.missing?.[0]).toContain("Website rebuild");
    s.activities!.push({ id: "a1", company_id: CO, record_type: "deal", record_id: "quiet", kind: "call", body: "Called", created_at: new Date().toISOString() });
    expect((await checkPipeline(harness.ctx, issue)).done).toBe(true);
  });
});

describe("duplicate contacts", () => {
  const dupes = () => store({
    contacts: [...seed().contacts!, contact("jaco-1", "Jaco", { emails: ["jaco@intellidrive.co.za"] }), contact("jaco-2", "Jaco van Niekerk", { emails: ["Jaco@IntelliDrive.co.za"] })],
  });

  it("opens one issue for the Data Steward, else the Account Manager covers it", async () => {
    const { harness } = await boot({ store: dupes() });
    await linked(harness, "account-manager", "am-1");
    await openDuplicateCheck(harness.ctx, CO);
    const [issue] = await crmIssues(harness);
    expect(issue).toMatchObject({ assigneeAgentId: "am-1", title: "Duplicate contacts: 1 email on more than one contact" });
    expect(issue!.description).toContain("jaco@intellidrive.co.za");
    expect(await openDuplicateCheck(harness.ctx, CO, new Date(Date.now() + DAY))).toBeNull();
  });

  it("opens nothing without duplicates, and closing checks they were merged", async () => {
    const clean = await boot();
    expect(await openDuplicateCheck(clean.harness.ctx, CO)).toBeNull();
    const s = dupes();
    const { harness } = await boot({ store: s });
    const issue = { id: "i1", companyId: CO, originId: "crm:duplicates:2026-09-28", createdAt: new Date().toISOString() } as never;
    expect((await checkDuplicates(harness.ctx, issue)).done).toBe(false);
    s.contacts = s.contacts!.filter((row) => row.id !== "jaco-2");
    expect((await checkDuplicates(harness.ctx, issue)).done).toBe(true);
  });
});

describe("Monday reports", () => {
  it("open once per week for companies with CRM records, for the right roles", async () => {
    const { harness } = await boot({ routes: [COUNT] });
    await linked(harness, "sales-lead", "sl-1");
    await linked(harness, "crm-data-steward", "ds-1");
    const monday = new Date("2026-09-28T06:00:00Z");
    await openPipelineSummary(harness.ctx, CO, monday);
    await openHygieneReport(harness.ctx, CO, monday);
    expect(await openPipelineSummary(harness.ctx, CO, monday)).toBeNull();
    const issues = await crmIssues(harness);
    expect(issues.map((i) => [i.title, i.assigneeAgentId])).toEqual([
      ["Weekly pipeline summary (week of 2026-09-28)", "sl-1"],
      ["CRM hygiene (week of 2026-09-28)", "ds-1"],
    ]);
  });

  it("skip a company with no contacts", async () => {
    const { harness } = await boot({ store: { ...seed(), contacts: [] }, routes: [COUNT] });
    expect(await openPipelineSummary(harness.ctx, CO)).toBeNull();
    expect(await openHygieneReport(harness.ctx, CO)).toBeNull();
  });
});
