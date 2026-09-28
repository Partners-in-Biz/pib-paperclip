import { describe, expect, it } from "vitest";
import { FLOW_STAGES, flowStagesFor } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot, DEAL_IDLE_DAYS, dealOpenReport, LEAD_STUCK_DAYS, leadInReport } from "../src/cockpit.js";
import { PLUGIN_ID } from "../src/namespace.js";
import { CO, ago, boot, deal, seed } from "./helpers/crm.js";
import type { Route, Row, Store } from "./helpers/fake-db.js";

const DAY = 1440;
const ORIGIN = "plugin:partnersinbiz.crm";
const stageKind = (s: Store, id: string) => (s.pipeline_stages ?? []).find((row) => row.id === id)?.kind;

/** The Cockpit's aggregate queries, done the way Postgres would. */
const FLOW_ROUTES: Route[] = [
  [/AS late/, (p, s) => {
    const origin = new RegExp(String(p[2]));
    const cutoff = Date.now() - Number(p[3]) * 86_400_000;
    const open = (s.issues ?? []).filter((i) => i.company_id === p[0] && i.origin_kind === p[1] && origin.test(i.origin_id) && !["done", "cancelled"].includes(i.status));
    const late = (i: Row) => Date.parse(i.created_at) < cutoff;
    const unowned = (i: Row) => !i.assignee_agent_id && !i.assignee_user_id;
    return [{
      open: String(open.length),
      stuck: String(open.filter((i) => late(i) || i.status === "blocked" || unowned(i)).length),
      late: String(open.filter(late).length),
      blocked: String(open.filter((i) => i.status === "blocked").length),
      unowned: String(open.filter(unowned).length),
      oldest: open.map((i) => i.created_at).sort()[0] ?? null,
    }];
  }],
  [/LEFT JOIN LATERAL/, (p, s) => {
    const cutoff = Date.now() - Number(p[1]) * 86_400_000;
    const open = (s.deals ?? []).filter((d) => d.company_id === p[0] && stageKind(s, d.stage_id) === "open");
    const lastTouch = (d: Row) => Math.max(
      Date.parse(d.updated_at),
      ...(s.activities ?? [])
        .filter((a) => a.company_id === d.company_id && ((a.record_type === "deal" && a.record_id === d.id) || (a.record_type === "contact" && a.record_id === d.contact_id) || (a.record_type === "company" && a.record_id === d.account_id)))
        .map((a) => Date.parse(a.created_at)),
    );
    return [{ open: String(open.length), idle: String(open.filter((d) => lastTouch(d) < cutoff).length), oldest: open.map((d) => d.created_at).sort()[0] ?? null }];
  }],
  [/GROUP BY d\.currency/, (p, s) => {
    const by = new Map<string, Row>();
    for (const row of (s.deals ?? []).filter((d) => d.company_id === p[0])) {
      const entry = by.get(row.currency) ?? { currency: row.currency, open_minor: 0, open_deals: 0, won_minor: 0 };
      if (stageKind(s, row.stage_id) === "open") {
        entry.open_minor += row.amount_minor;
        entry.open_deals += 1;
      }
      by.set(row.currency, entry);
    }
    return [...by.values()].map((row) => ({ currency: row.currency, open_minor: String(row.open_minor), open_deals: String(row.open_deals), won_minor: "0" }));
  }],
];

function issueRow(id: string, originId: string, extra: Row = {}): Row {
  return { id, company_id: CO, origin_kind: ORIGIN, origin_id: originId, status: "todo", assignee_agent_id: "am-1", assignee_user_id: null, created_at: ago(60), ...extra };
}

function held(key: string, minutesAgo: number): Row {
  return { id: `h-${key}`, key, company_id: CO, event: "e", payload: {}, reason: "unsaved", attempts: 0, held_at: ago(minutesAgo), processed_at: null };
}

describe("company graph stages the CRM owns", () => {
  it("are lead.in and deal.open, worked by the Account Manager", () => {
    expect(flowStagesFor(PLUGIN_ID).map((stage) => [stage.key, stage.role, stage.flow])).toEqual([
      ["lead.in", "account-manager", "lead-to-cash"],
      ["deal.open", "account-manager", "lead-to-cash"],
    ]);
    expect(FLOW_STAGES["lead.in"]!.href).toBe("/crm?tab=contacts");
  });

  it("the snapshot reports exactly those stages", async () => {
    const { harness } = await boot({ routes: FLOW_ROUTES });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.flows!.map((report) => report.stage)).toEqual(["lead.in", "deal.open"]);
  });
});

describe("lead.in: leads waiting for a first follow-up", () => {
  it("counts open follow-ups (old and new ids) and held leads; late, unowned, blocked and held ones are stuck", async () => {
    const store = seed();
    store.issues = [
      issueRow("fresh", "crm:lead-followup:mail:a"),
      issueRow("late", "crm:lead-followup:mail:b", { created_at: ago(3 * DAY) }),
      issueRow("legacy", "lead:social:inbox:1", { assignee_agent_id: null }),
      issueRow("blocked", "crm:lead-followup:mail:c", { status: "blocked" }),
      issueRow("late-unowned", "crm:lead-followup:mail:d", { created_at: ago(5 * DAY), assignee_agent_id: null }),
      issueRow("done", "crm:lead-followup:mail:e", { status: "done", created_at: ago(9 * DAY) }),
      issueRow("reply", "crm:reply:m-1"),
      { ...issueRow("other", "crm:lead-followup:mail:f"), origin_kind: "plugin:partnersinbiz.social" },
    ];
    store.held_leads = [held("mail:x", 30), held("mail:y", 2 * DAY)];
    const { harness } = await boot({ store, routes: FLOW_ROUTES });
    const report = await leadInReport(harness.ctx, CO, { enabled: true, saved: false });
    expect(report).toEqual({
      stage: "lead.in",
      count: 7,
      stuck: 6,
      stuckReason: `2 open over ${LEAD_STUCK_DAYS} days, 2 with nobody assigned, 1 blocked, 2 held until the CRM settings are saved`,
      oldestDays: 5,
    });
  });

  it("says why leads are held, and nothing is stuck when every follow-up is fresh and owned", async () => {
    const store = seed();
    store.issues = [issueRow("fresh", "crm:lead-followup:mail:a")];
    store.held_leads = [held("mail:x", 30)];
    const { harness } = await boot({ store, routes: FLOW_ROUTES });
    expect((await leadInReport(harness.ctx, CO, { enabled: false, saved: true })).stuckReason).toBe("1 held until the CRM is switched on");
    expect((await leadInReport(harness.ctx, CO, { enabled: true, saved: true })).stuckReason).toBe("1 held until the next run adds them");
    store.held_leads = [];
    expect(await leadInReport(harness.ctx, CO, { enabled: true, saved: true })).toEqual({ stage: "lead.in", count: 1, stuck: 0, stuckReason: null, oldestDays: 0 });
  });
});

describe("deal.open: open deals and their value", () => {
  const dealStore = (): Store => {
    const store = seed();
    store.deals = [
      deal("busy", "Busy deal", { account_id: "acme", amount_minor: 500_000, created_at: ago(40 * DAY), updated_at: ago(30 * DAY) }),
      deal("quiet", "Quiet deal", { contact_id: "grace", amount_minor: 250_000, created_at: ago(20 * DAY), updated_at: ago(20 * DAY) }),
      deal("new", "New deal", { amount_minor: 100_000, created_at: ago(DAY), updated_at: ago(DAY) }),
      deal("dollars", "US deal", { currency: "USD", amount_minor: 90_000, created_at: ago(2 * DAY), updated_at: ago(2 * DAY) }),
      deal("won", "Won deal", { stage_id: "st-won", created_at: ago(90 * DAY), updated_at: ago(90 * DAY) }),
    ];
    // A call with the company last week keeps its deal alive.
    store.activities = [{ id: "a1", company_id: CO, record_type: "company", record_id: "acme", kind: "call", body: "Call", created_at: ago(7 * DAY) }];
    return store;
  };

  it("uses the Open pipeline KPI's numbers; a deal with nothing on it for 14 days is stuck", async () => {
    const { harness } = await boot({ store: dealStore(), routes: FLOW_ROUTES });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    const kpi = snap.kpis.find((row) => row.key === "pipeline")!;
    const report = snap.flows!.find((row) => row.stage === "deal.open")!;
    expect(kpi).toMatchObject({ value: "R 8,500.00", raw: 850_000, delta: "4 open deals · plus $900.00" });
    expect(report).toEqual({
      stage: "deal.open",
      count: 4,
      stuck: 1,
      stuckReason: `1 with no activity for ${DEAL_IDLE_DAYS} days`,
      amountMinor: 850_000,
      currency: "ZAR",
      oldestDays: 40,
    });
  });

  it("without the money query it still counts, with no amount", async () => {
    const { harness } = await boot({ store: dealStore(), routes: FLOW_ROUTES });
    expect(await dealOpenReport(harness.ctx, CO, null)).toMatchObject({ stage: "deal.open", count: 4, stuck: 1, amountMinor: null, currency: null });
  });

  it("a stage whose query fails reports nothing; the other still reports", async () => {
    const { harness } = await boot({ store: dealStore(), routes: [[/AS late/, () => { throw new Error("issues unavailable"); }], ...FLOW_ROUTES] });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.flows!.map((row) => row.stage)).toEqual(["deal.open"]);
  });
});
