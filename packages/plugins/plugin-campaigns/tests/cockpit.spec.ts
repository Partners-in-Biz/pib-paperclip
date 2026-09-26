import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { COCKPIT_ROUTE, trackJob, type CockpitSnapshot, type RolesPayload } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin, { launchReviewBrief } from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import { clearJevCache } from "../src/jev.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";

const CO = "co-1";
const BOARD = { type: "user" as const, userId: "local-board" };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

const ROUTES: Route[] = [
  [/AS active,/, (p, s) => {
    const mine = <T extends Row>(rows: T[] | undefined) => (rows ?? []).filter((r) => r.company_id === p[0]);
    const active = new Set(mine(s.campaigns).filter((c) => c.status === "active").map((c) => c.id));
    const events = mine(s.campaign_step_events).filter((e) => e.occurred_at >= monthStart());
    const failed = mine(s.outbox).filter((o) => o.status === "failed");
    return [{
      active: String(active.size),
      enrolled: String(mine(s.campaign_enrollments).filter((e) => e.status === "running").length),
      due: String(mine(s.campaign_enrollments).filter((e) => e.status === "running" && active.has(e.campaign_id) && e.next_due_at && e.next_due_at <= new Date().toISOString() && !e.open_issue_id && !e.sending_key).length),
      sent_month: String(events.filter((e) => e.event_type === "sent").length),
      replies_month: String(events.filter((e) => e.event_type === "reply").length),
      failed_7d: String(failed.length),
      retrying: String(mine(s.outbox).filter((o) => o.status === "pending" && o.last_error).length),
      oldest_failed: failed[0]?.settled_at ?? null,
    }];
  }],
  [/JOIN public\.issues/, (p, s) =>
    (s.campaigns ?? [])
      .filter((c) => c.company_id === p[0] && c.status === "draft" && c.approval_issue_id)
      .map((c) => ({ c, i: (s.issues ?? []).find((i) => i.id === c.approval_issue_id) }))
      .filter(({ i }) => i && !["done", "cancelled"].includes(i.status) && !i.assignee_agent_id)
      .map(({ c, i }) => ({ id: c.id, name: c.name, client_name: c.client_name, client_ref: c.client_ref, approval_issue_id: c.approval_issue_id, created_at: i!.created_at }))],
  [/GROUP BY c\.name, e\.event_type/, (p, s) => {
    const groups = new Map<string, Row>();
    for (const e of (s.campaign_step_events ?? []).filter((row) => row.company_id === p[0])) {
      const name = (s.campaigns ?? []).find((c) => c.id === e.campaign_id)?.name;
      const key = `${name}:${e.event_type}`;
      const g = groups.get(key) ?? { name, event_type: e.event_type, n: 0, at: "" };
      g.n += 1;
      if (e.occurred_at > g.at) g.at = e.occurred_at;
      groups.set(key, g);
    }
    return [...groups.values()].map((g): Row => ({ ...g, n: String(g.n) })).sort((a, b) => (a.at < b.at ? 1 : -1));
  }],
  [/AND EXISTS \(SELECT 1 FROM/, (p, s) =>
    (s.campaigns ?? []).filter((c) => c.company_id === p[0] && c.status === "active" && !c.winner_variant && (s.campaign_steps ?? []).some((st) => st.campaign_id === c.id && st.variant === "b")).map((c) => ({ id: c.id }))],
  [/event_type = ANY/, (p, s) => (s.campaign_step_events ?? []).filter((e) => e.campaign_id === p[0] && (e.event_type === "sent" || e.event_type === "reply"))],
  [/GROUP BY purpose, question_key/, () => [{ purpose: "campaigns.reply", question_key: "reply_kind", total: "20", corrected: "1", avg_confidence: "0.9" }]],
  [/AS stuck/, (p, s) => {
    const rows = (s.outbox ?? []).filter((o) => o.company_id === p[0]);
    return [{ stuck: "0", failed: String(rows.filter((o) => o.status === "failed").length), oldest: null }];
  }],
];

function campaign(id: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name: id, description: "", status: "active", from_name: "", from_local: "campaigns", reply_to: null, audience_tags: [],
    start_at: null, end_at: null, approval_issue_id: null, winner_variant: null, client_kind: null, client_ref: null, client_name: null,
    audience_mode: "tags", delivery: "email", owner_user_id: null, owner_agent_id: "agent-camp", updated_at: ago(10), ...extra,
  };
}
const step = (campaignId: string, position: number, variant: "a" | "b", subject: string): Row =>
  ({ id: `${campaignId}-${position}${variant}`, company_id: CO, campaign_id: campaignId, position, delay_days: 0, subject, body: "Body", html_body: null, variant });
const enrollment = (id: string, campaignId: string, extra: Row = {}): Row => ({
  id, company_id: CO, campaign_id: campaignId, contact_id: `ct-${id}`, status: "running", step_position: 1, variant: "a",
  next_due_at: ago(5), open_issue_id: null, sending_key: null, created_at: ago(100), updated_at: ago(100), ...extra,
});
const event = (id: string, campaignId: string, type: string, variant = "a", at = ago(30)): Row =>
  ({ id, company_id: CO, campaign_id: campaignId, enrollment_id: `e-${id}`, step_position: 1, event_type: type, variant, source_key: id, meta: null, occurred_at: at });

async function boot(store: Store, config: Record<string, unknown> = { timezone: "Africa/Johannesburg" }) {
  clearJevCache();
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: ROUTES,
    defaults: { outbox: { status: "pending", attempts: 0, last_error: null, result: null } },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, emit };
}

async function setRoles(harness: Awaited<ReturnType<typeof boot>>["harness"], roles: Partial<RolesPayload>) {
  await harness.emit("plugin.partnersinbiz.cockpit.roles.updated", {
    companyId: CO, operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: new Date().toISOString(), ...roles,
  }, { companyId: CO });
}

describe("Campaigns cockpit snapshot", () => {
  it("declares the cockpit route", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: COCKPIT_ROUTE.routeKey, path: "/cockpit" }));
  });

  it("unconfigured, empty company: zero KPIs, healthy jobs, nothing waiting", async () => {
    const { harness } = await boot({ campaigns: [], campaign_enrollments: [], campaign_step_events: [], outbox: [] }, {});
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap).toMatchObject({ plugin: "partnersinbiz.campaigns", title: "Campaigns", waiting: [], activity: [] });
    expect(snap.kpis.map((k) => [k.key, k.value])).toEqual([
      ["active_campaigns", "0"],
      ["campaign_enrolled", "0"],
      ["campaign_reply_rate", "–"],
      ["campaign_due_steps", "0"],
    ]);
    expect(snap.health.map((h) => [h.key, h.status])).toEqual([
      ["job:open-due-steps", "ok"],
      ["job:redeliver-mail", "ok"],
      ["job:setup-status", "ok"],
      ["outbox", "ok"],
      ["campaigns:sends", "ok"],
    ]);
  });

  it("configured company: KPIs, failing sends, open launch approvals, activity, quality", async () => {
    const store: Store = {
      campaigns: [
        campaign("Spring"),
        campaign("Autumn"),
        campaign("Draft", { status: "draft", approval_issue_id: "iss-1", client_ref: "acme", client_name: "Acme" }),
        campaign("WithReviewer", { status: "draft", approval_issue_id: "iss-2" }),
      ],
      campaign_steps: [step("Spring", 1, "a", "A"), step("Spring", 1, "b", "B")],
      campaign_enrollments: [enrollment("e1", "Spring"), enrollment("e2", "Spring", { next_due_at: ago(-60) }), enrollment("e3", "Autumn", { sending_key: "k" })],
      campaign_step_events: [event("s1", "Spring", "sent"), event("s2", "Spring", "sent"), event("s3", "Spring", "sent"), event("s4", "Spring", "sent"), event("r1", "Spring", "reply", "a", ago(20))],
      outbox: [{ key: "campaigns:step:x:1", company_id: CO, status: "failed", settled_at: ago(120), last_error: "Gmail not connected" }],
      issues: [
        { id: "iss-1", status: "todo", assignee_agent_id: null, created_at: ago(300) },
        { id: "iss-2", status: "todo", assignee_agent_id: "agent-reviewer", created_at: ago(200) },
      ],
    };
    const { harness } = await boot(store);
    const snap = await cockpitSnapshot(harness.ctx, CO);
    const kpi = (key: string) => snap.kpis.find((k) => k.key === key)!;
    expect(kpi("active_campaigns").raw).toBe(2);
    expect(kpi("campaign_enrolled").raw).toBe(3);
    expect(kpi("campaign_reply_rate")).toMatchObject({ value: "25%", raw: 0.25, delta: "1 replies to 4 emails", group: "marketing" });
    expect(kpi("campaign_due_steps")).toMatchObject({ raw: 1, tone: "warn" });
    expect(snap.health.find((h) => h.key === "outbox")?.status).toBe("bad");
    expect(snap.health.find((h) => h.key === "campaigns:sends")).toMatchObject({ status: "bad", since: ago(120) });
    // Only the approval that sits with a person is waiting; the one with the Reviewer is not.
    expect(snap.waiting).toEqual([expect.objectContaining({ key: "approval:iss-1", issueId: "iss-1", title: "[Acme] Approve campaign Draft", kind: "review", href: "/issues/iss-1" })]);
    expect(snap.activity.map((a) => a.text)).toEqual(["Handled 1 reply to campaign Spring", "Sent 4 emails for campaign Spring"]);
    expect(snap.quality.find((q) => q.key === "reply_classification_corrected_rate")).toMatchObject({ value: "5% (1 of 20)", tone: "ok" });
    expect(snap.quality.find((q) => q.key === "ab_suggestions_pending")).toMatchObject({ raw: 0, tone: "ok" });
  });

  it("job health reflects tracked failures", async () => {
    const { harness } = await boot({ campaigns: [] });
    await trackJob(harness.ctx, "open-due-steps", async () => undefined);
    await trackJob(harness.ctx, "open-due-steps", async () => { throw new Error("db down"); }).catch(() => undefined);
    await trackJob(harness.ctx, "open-due-steps", async () => { throw new Error("db down"); }).catch(() => undefined);
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.health.find((h) => h.key === "job:open-due-steps")).toMatchObject({ status: "warn", detail: "Last error: db down" });
  });

  it("serves GET /cockpit and pushes it hourly only for saved companies", async () => {
    const saved = await boot({ campaigns: [campaign("Spring")] });
    const response = await plugin.definition.onApiRequest!({
      routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as CockpitSnapshot).kpis.find((k) => k.key === "active_campaigns")?.raw).toBe(1);
    await saved.harness.runJob("setup-status");
    expect(saved.emit).toHaveBeenCalledWith("cockpit.snapshot", CO, expect.objectContaining({ plugin: "partnersinbiz.campaigns" }));

    const unsaved = await boot({ campaigns: [campaign("Spring")] }, {});
    await unsaved.harness.runJob("setup-status");
    expect(unsaved.emit).not.toHaveBeenCalledWith("cockpit.snapshot", expect.anything(), expect.anything());
  });
});

describe("Campaign launch approval: Reviewer routing", () => {
  const draftStore = (): Store => ({
    campaigns: [campaign("camp-draft", { status: "draft", owner_user_id: "user-owner", audience_tags: ["newsletter"] })],
    campaign_steps: [step("camp-draft", 1, "a", "Hi {{first_name}}"), step("camp-draft", 1, "b", "Quick one")],
    campaign_enrollments: [],
  });

  it("without a Reviewer the approval issue is unassigned, as before", async () => {
    const store = draftStore();
    const { harness } = await boot(store);
    const result = await harness.performAction<{ approvalIssueId: string }>("campaigns.request-approval", { campaignId: "camp-draft" }, { companyId: CO, actor: BOARD });
    const issue = await harness.ctx.issues.get(result.approvalIssueId, CO);
    expect(issue?.assigneeAgentId ?? null).toBeNull();
    expect(issue?.description).not.toContain("Reviewer");
  });

  it("with a Reviewer the approval goes to the Reviewer first with the launch checks and who to hand it to", async () => {
    const store = draftStore();
    const { harness } = await boot(store);
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true, ownerUserId: "user-peet" });
    const result = await harness.performAction<{ approvalIssueId: string }>("campaigns.request-approval", { campaignId: "camp-draft" }, { companyId: CO, actor: BOARD });
    const issue = await harness.ctx.issues.get(result.approvalIssueId, CO);
    expect(issue?.assigneeAgentId).toBe("agent-reviewer");
    expect(issue?.status).toBe("todo");
    expect(issue?.description).toContain("## Reviewer: check before the person approves");
    expect(issue?.description).toContain("every A/B variant");
    expect(issue?.description).toContain("contacts tagged `newsletter`");
    expect(issue?.description).toContain("reassign this issue to the approver (user `user-owner`)");
  });

  it("a Reviewer set but outward review off: unchanged", async () => {
    const store = draftStore();
    const { harness } = await boot(store);
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: false });
    const result = await harness.performAction<{ approvalIssueId: string }>("campaigns.request-approval", { campaignId: "camp-draft" }, { companyId: CO, actor: BOARD });
    expect((await harness.ctx.issues.get(result.approvalIssueId, CO))?.assigneeAgentId ?? null).toBeNull();
  });

  it("an approval closed while still with an agent does not launch; a person's approval does", async () => {
    const store = draftStore();
    store.campaigns![0]!.approval_issue_id = "appr-1";
    const { harness } = await boot(store);
    harness.seed({ issues: [{ id: "appr-1", companyId: CO, title: "Approve", status: "done", assigneeAgentId: "agent-reviewer" } as never] });
    await expect(harness.performAction("campaigns.launch", { campaignId: "camp-draft", contactIds: [] }, { companyId: CO, actor: BOARD })).rejects.toThrow(/A person must approve it/);
    harness.seed({ issues: [{ id: "appr-1", companyId: CO, title: "Approve", status: "done", assigneeAgentId: null, assigneeUserId: "user-owner" } as never] });
    const launched = await harness.performAction<{ status: string }>("campaigns.launch", { campaignId: "camp-draft" }, { companyId: CO, actor: BOARD });
    expect(launched.status).toBe("active");
  });

  it("the brief falls back to the board when there is no approver", () => {
    const brief = launchReviewBrief({ name: "X", delivery: "issue", audienceMode: "client_contacts", audienceTags: [], clientName: "Acme", clientRef: "acme" }, null);
    expect(brief).toContain("the contacts at Acme");
    expect(brief).toContain("reassign this issue to a board member");
  });
});
