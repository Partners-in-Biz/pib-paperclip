/**
 * The worker side of the Flows view: the Cockpit's own stages (open
 * onboarding, grant questions), flows kept from other plugins' snapshots,
 * the Operator's "Stuck in the flows" list, and the skills that tell agents.
 */
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { BRIEF_STUCK_STAGES, companyBrief } from "../src/brief.js";
import { companySkillBody } from "../src/company-skill.js";
import { ORIGIN } from "../src/constants.js";
import { DAILY_ROUTINE_DESCRIPTION } from "../src/manifest.js";
import { cockpitFlowReports, ONBOARDING_STUCK_DAYS } from "../src/own-flows.js";
import { createEnv, handleApiRoute, onSnapshotEvent, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { OPERATOR_SKILL_BODY } from "../src/skills.js";
import { buildView, type LoadResult } from "../src/view.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";
import type { Row } from "./helpers/fake-db.js";

const A = "company-a";
const NOW = "2026-09-28T08:00:00.000Z";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();
const agents: FakeAgent[] = [
  { id: "op", companyId: A, name: "Olive", status: "active" },
  { id: "am", companyId: A, name: "Ama", status: "active" },
  { id: "bk", companyId: A, name: "Bea", status: "idle" },
];

function setup(options: { coreIssues?: Row[] } = {}) {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: agents.map((a) => ({ ...a })), coreIssues: options.coreIssues });
  const env = createEnv(fake.ctx, fixedClock(NOW).now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env };
}

const snap = (plugin: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW, kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });
const stored = (payload: CockpitSnapshot) => ({ company_id: A, plugin_key: payload.plugin, kind: "cockpit", payload, checked_at: NOW, received_at: NOW });
const apiInput = (routeKey: string): PluginApiRequestInput => ({ routeKey, method: "GET", path: `/${routeKey}`, params: {}, query: { companyId: A }, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId: A, headers: {} });
const ask = (id: string, kind: string, askedAt: string, status = "open") => ({ id, company_id: A, issue_id: `issue-${id}`, question: "Give access?", kind, status, asked_at: askedAt, updated_at: askedAt, asked_count: 1 });

describe("the Cockpit's own stages", () => {
  it("counts open onboarding issues (stuck after 7 days) and grant questions (stuck after 3 days)", async () => {
    const s = setup({
      coreIssues: [
        { id: "o1", company_id: A, origin_kind: ORIGIN.onboarding, status: "todo", created_at: ago(10) },
        { id: "o2", company_id: A, origin_kind: ORIGIN.onboarding, status: "backlog", created_at: ago(2) },
        { id: "o3", company_id: A, origin_kind: ORIGIN.onboarding, status: "done", created_at: ago(30) },
        { id: "o4", company_id: A, origin_kind: ORIGIN.onboarding, status: "todo", created_at: ago(20), hidden_at: ago(1) },
        { id: "h1", company_id: A, origin_kind: ORIGIN.health, status: "todo", created_at: ago(20) },
        { id: "x1", company_id: "other", origin_kind: ORIGIN.onboarding, status: "todo", created_at: ago(20) },
      ],
    });
    s.store.asks = [ask("g1", "grant", ago(5)), ask("g2", "grant", ago(1)), ask("d1", "decision", ago(9)), ask("g3", "grant", ago(10), "answered")];
    const reports = await cockpitFlowReports(s.env, A);
    expect(ONBOARDING_STUCK_DAYS).toBe(7);
    expect(reports).toEqual([
      { stage: "onboarding.open", count: 2, stuck: 1, stuckReason: "1 open for more than 7 days", oldestDays: 10 },
      { stage: "onboarding.grants", count: 2, stuck: 1, stuckReason: "1 asked more than 3 days ago", oldestDays: 5 },
    ]);
    // The same numbers in the Cockpit's own snapshot (GET /cockpit and the page).
    const route = await handleApiRoute(s.env, apiInput("cockpit"));
    expect((route.body as CockpitSnapshot).flows).toEqual(reports);
  });

  it("reports zeros when nothing is open, and nothing for a part it cannot read", async () => {
    const s = setup();
    expect(await cockpitFlowReports(s.env, A)).toEqual([
      { stage: "onboarding.open", count: 0, stuck: 0, stuckReason: null, oldestDays: null },
      { stage: "onboarding.grants", count: 0, stuck: 0, stuckReason: null, oldestDays: null },
    ]);
    s.ctx.db.query = async () => {
      throw new Error("down");
    };
    expect(await cockpitFlowReports(s.env, A)).toEqual([]);
  });
});

describe("flows from other plugins", () => {
  it("keeps the flows a plugin pushes, and the page shows them", async () => {
    const s = setup();
    await onSnapshotEvent(s.env, PIB_PLUGINS.billing, { companyId: A, payload: { ...snap(PIB_PLUGINS.billing), flows: [{ stage: "invoice.open", count: 3, stuck: 1, stuckReason: "1 overdue" }, { stage: "lead.in", count: 9 }] } });
    expect(s.store.snapshots![0]!.payload.flows).toEqual([{ stage: "invoice.open", count: 3, stuck: 1, stuckReason: "1 overdue", amountMinor: null, currency: null, oldestDays: null }]);
    const load = (await s.actions.get("cockpit.load")!({ team: false }, { companyId: A, actor: { type: "user", userId: "u1" } })) as LoadResult;
    const view = buildView({ load, installed: null, modules: null, live: {}, now: new Date(NOW), windowMs: DAY });
    const stages = view.flows.flows.flatMap((f) => f.stages);
    expect(stages.find((st) => st.key === "invoice.open")).toMatchObject({ count: 3, stuck: 1, stuckReason: "1 overdue" });
    expect(stages.find((st) => st.key === "lead.in")!.count).toBeNull();
    // The Cockpit's own stages come with its snapshot.
    expect(stages.find((st) => st.key === "onboarding.open")!.count).toBe(0);
  });
});

describe("the Operator's brief", () => {
  it("lists the top stuck stages, worst first, with who they wait on and links", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    s.store.snapshots = [
      stored(snap(PIB_PLUGINS.crm, { team: [{ role: "account-manager", agentId: "am", status: "active" }], flows: [{ stage: "lead.in", count: 7, stuck: 2, stuckReason: "2 over a day without a follow-up" }, { stage: "deal.open", count: 4, stuck: 1, stuckReason: "1 quiet for 14 days" }] })),
      stored(snap(PIB_PLUGINS.billing, { flows: [{ stage: "invoice.open", count: 5, stuck: 2, stuckReason: "2 overdue", amountMinor: 1_175_000, currency: "ZAR", oldestDays: 12 }, { stage: "quote.approval", count: 1, stuck: 1, stuckReason: "1 waiting over a day" }, { stage: "quote.draft", count: 2, stuck: 0 }] })),
      stored(snap(PIB_PLUGINS.accounting, { team: [{ role: "bookkeeper", agentId: "bk", status: "idle" }], flows: [{ stage: "bank.match", count: 14, stuck: 3, stuckReason: "3 over a week old" }] })),
    ];
    const brief = await companyBrief(s.env, A);
    expect(brief.stuckFlows).toHaveLength(BRIEF_STUCK_STAGES);
    expect(brief.stuckFlows.map((f) => f.stage)).toEqual(["Bank lines to match", "New leads", "Owed to you", "Quotes to approve", "Open deals"]);
    expect(brief.stuckFlows[0]).toEqual({ flow: "Lead to cash", stage: "Bank lines to match", stuck: 3, of: 14, why: "3 over a week old", waitsOn: "agent", agent: "Bea (Bookkeeper)", href: "/PIB/accounting?tab=bank" });
    expect(brief.stuckFlows[2]).toMatchObject({ waitsOn: "customer", amount: "R 11,750.00", oldestDays: 12, href: "/PIB/billing?tab=invoices" });
    expect(brief.stuckFlows[3]).toMatchObject({ waitsOn: "person", href: "/PIB/billing?tab=quotes" });
    expect(brief.stuckFlows[3]).not.toHaveProperty("agent");
    expect(brief.links.flows).toBe("/PIB/cockpit?tab=flows");
    // The tool's one line says so too.
    const result = (await s.tools.get("company-brief")!({}, { companyId: A, agentId: "op", runId: "r1" })) as { content?: string };
    expect(JSON.stringify(result)).toContain("5 stuck stages in the flows");
  });
});

describe("what the skills say", () => {
  it("the operating manual explains done-checks and points to the Flows tab", () => {
    const body = companySkillBody();
    expect(body).toContain("- **Done-checks**: closing an issue a module opened runs its done-check. If the issue reopens, it lists what is missing: finish those items, then close it.");
    expect(body).toContain("**Cockpit → Flows** shows every flow stage by stage");
    // Under "How work moves", before "Where knowledge lives".
    expect(body.indexOf("**Done-checks**")).toBeGreaterThan(body.indexOf("## How work moves"));
    expect(body.indexOf("**Done-checks**")).toBeLessThan(body.indexOf("## Where knowledge lives"));
  });

  it("the Operator works the stuck stages every morning and knows the onboarding check", () => {
    expect(OPERATOR_SKILL_BODY).toContain("6. **Stuck in the flows.** `stuckFlows` lists the 5 stages");
    expect(OPERATOR_SKILL_BODY).toContain("10. Close the routine issue");
    expect(OPERATOR_SKILL_BODY).toContain("If it reopens, it lists what's missing: finish those.");
    expect(OPERATOR_SKILL_BODY).toContain("closing it yourself reopens it");
    expect(DAILY_ROUTINE_DESCRIPTION).toContain("6. Work the stuck stages (`stuckFlows`)");
  });
});
