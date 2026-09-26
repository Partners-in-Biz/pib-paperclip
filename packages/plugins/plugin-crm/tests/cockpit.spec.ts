import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { COCKPIT_ROUTE, trackJob, type CockpitSnapshot, type RolesPayload } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { clearJevCache } from "../src/jev.js";
import { activityText, cockpitSnapshot, pipelineValue } from "../src/cockpit.js";
import { asLead, handleKey } from "../src/leads.js";
import { sequenceReviewBrief, settleLeadScores } from "../src/mail.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";

const CO = "co-1";
const BOARD = { type: "user" as const, userId: "local-board" };
const MAILBOX_LEAD = "plugin.partnersinbiz.mailbox.lead.captured";
const SOCIAL_LEAD = "plugin.partnersinbiz.social.lead.captured";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const mine = (rows: Row[] | undefined, p: unknown[]) => (rows ?? []).filter((row) => row.company_id === p[0]);
const stageOf = (s: Store, deal: Row) => (s.pipeline_stages ?? []).find((st) => st.id === deal.stage_id);
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

const ROUTES: Route[] = [
  [/OR id IN \(/, (p, s, sql) => (s[/FROM \S+\.(\w+)/.exec(sql)![1]!] ?? []).filter((row) => row.company_id === p[0])],
  // Changed contacts for the projection broadcast (companies: none).
  [/make_interval/, (p, s, sql) => (/FROM \S+\.contacts c/.test(sql) ? mine(s.contacts, p).map((c) => ({ ...c, account_ids: [] })) : [])],
  [/record_grants/, () => []],
  [/\bUNION\b/, (_p, s) => [...new Set([...(s.companies ?? []), ...(s.contacts ?? [])].map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/jsonb_array_elements_text\(c\.emails\)/, (p, s) =>
    mine(s.contacts, p).filter((row) => (row.emails as string[]).some((email) => email.trim().toLowerCase() === p[1]))],
  [/custom -> 'handles' @>/, (p, s) => {
    const [key] = JSON.parse(String(p[1])) as string[];
    return mine(s.contacts, p).filter((row) => Array.isArray(row.custom?.handles) && row.custom.handles.includes(key));
  }],
  [/contact_companies l/, (p, s) =>
    (s.contact_companies ?? []).filter((link) => link.contact_id === p[0]).map((link) => ({ account_id: link.account_id, role_label: link.role_label, name: (s.companies ?? []).find((a) => a.id === link.account_id)?.name ?? "" }))],
  [/count\(\*\) AS count, max\(created_at\)/, () => [{ count: 0, last_at: null }]],
  // Cockpit
  [/GROUP BY d\.currency/, (p, s) => {
    const by = new Map<string, Row>();
    for (const deal of mine(s.deals, p)) {
      const kind = stageOf(s, deal)?.kind;
      const row = by.get(deal.currency) ?? { currency: deal.currency, open_minor: 0, open_deals: 0, won_minor: 0 };
      if (kind === "open") { row.open_minor += deal.amount_minor; row.open_deals += 1; }
      if (kind === "won" && deal.updated_at >= monthStart()) row.won_minor += deal.amount_minor;
      by.set(deal.currency, row);
    }
    return [...by.values()].map((row) => ({ currency: row.currency, open_minor: String(row.open_minor), open_deals: String(row.open_deals), won_minor: String(row.won_minor) }));
  }],
  [/AS won_month/, (p, s) => {
    const contacts = mine(s.contacts, p);
    const open = contacts.filter((c) => c.lifecycle === "lead" || c.lifecycle === "prospect");
    return [{
      won_month: String(mine(s.deals, p).filter((d) => stageOf(s, d)?.kind === "won" && d.updated_at >= monthStart()).length),
      new_leads_week: String(contacts.filter((c) => c.lifecycle === "lead" && c.created_at >= ago(7 * 1440)).length),
      follow_up: String(contacts.filter((c) => c.next_action_due_at && c.next_action_due_at <= new Date().toISOString()).length),
      active_sequences: String(new Set(mine(s.enrollments, p).filter((e) => e.status === "running").map((e) => e.sequence_id)).size),
      open_leads: String(open.length),
      scored_leads: String(open.filter((c) => c.lead_scored_at).length),
    }];
  }],
  [/JOIN public\.issues i ON i\.id::text = q\.email_approval_issue_id/, (p, s) =>
    mine(s.sequences, p)
      .filter((q) => !q.email_approved_at && q.email_approval_issue_id)
      .map((q) => ({ q, i: (s.issues ?? []).find((i) => i.id === q.email_approval_issue_id) }))
      .filter(({ i }) => i && !["done", "cancelled"].includes(i.status) && !i.assignee_agent_id)
      .map(({ q, i }) => ({ id: q.id, name: q.name, email_approval_issue_id: q.email_approval_issue_id, created_at: i!.created_at }))],
  [/origin_id LIKE 'reply:%'/, (p, s) =>
    (s.issues ?? []).filter((i) => i.company_id === p[0] && i.origin_kind === p[1] && /^(reply|lead):/.test(i.origin_id) && !["done", "cancelled"].includes(i.status) && i.assignee_user_id && !i.assignee_agent_id)],
  [/LEFT JOIN \S+\.contacts c ON/, (p, s) =>
    mine(s.activities, p)
      .filter((a) => ["deal_moved", "email_sent", "reply_classified", "lead_captured"].includes(a.kind))
      .map((a) => ({ kind: a.kind, body: a.body, name: a.record_type === "deal" ? (s.deals ?? []).find((d) => d.id === a.record_id)?.title : (s.contacts ?? []).find((c) => c.id === a.record_id)?.name, at: a.created_at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))],
  [/SELECT name, created_at::text AS at FROM/, (p, s) => mine(s.contacts, p).map((c) => ({ name: c.name, at: c.created_at })).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5)],
  [/GROUP BY purpose, question_key/, () => [{ purpose: "crm.reply", question_key: "reply_kind", total: "10", corrected: "3", avg_confidence: "0.8" }]],
  [/AS stuck/, (p, s) => [{ stuck: "0", failed: String(mine(s.outbox, p).filter((o) => o.status === "failed").length), oldest: null }]],
];

function contact(id: string, name: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name, emails: [], phones: [], lifecycle: "lead", custom: {}, human_owned_fields: [],
    owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null,
    email_status: "ok", lead_fit: null, lead_intent: null, lead_urgency: null, lead_confidence: null, lead_scored_at: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...extra,
  };
}

function seed(): Store {
  return {
    companies: [{ id: "acme", company_id: CO, name: "Acme Plumbing", domain: "acme.test", lifecycle: "prospect", currency: "ZAR", custom: {}, human_owned_fields: [], tags: [], owner_user_id: null, assignee_agent_id: null }],
    contacts: [
      contact("ada", "Ada Lovelace", { emails: ["ada@acme.test"], assignee_agent_id: "agent-ada", lifecycle: "customer" }),
      contact("ig", "Insta Person", { custom: { handles: ["instagram:jane.doe"] } }),
    ],
    contact_companies: [],
    sequences: [
      { id: "seq-intro", company_id: CO, name: "Intro", completion_mode: "manual", delivery: "issue", email_approval_issue_id: null, email_approved_at: null, email_approved_by: null },
    ],
    sequence_steps: [{ id: "s1", company_id: CO, sequence_id: "seq-intro", position: 1, delay_minutes: 0, title: "Hi {{first_name}}", body: "Hello" }],
    enrollments: [],
    activities: [],
    facts: [],
    record_grants: [],
    outbox: [],
    inbox: [],
    decisions: [],
    pipelines: [{ id: "p1", company_id: CO, name: "Sales" }],
    pipeline_stages: [
      { id: "st-open", company_id: CO, pipeline_id: "p1", name: "Proposal", kind: "open", position: 1 },
      { id: "st-won", company_id: CO, pipeline_id: "p1", name: "Won", kind: "won", position: 3 },
    ],
    deals: [],
  };
}

function stubJev(scores?: { fit: number; intent: number; urgency: number; confidence: number }) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    if (body.questions.fit && scores) {
      for (const key of ["fit", "intent", "urgency"] as const) answers[key] = { type: "score", score: scores[key], probabilities: {}, confidence: scores.confidence };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function boot(options: { store?: Store; config?: Record<string, unknown> } = {}) {
  clearJevCache();
  const store = options.store ?? seed();
  const harness = createTestHarness({ manifest, config: options.config ?? { timezone: "Africa/Johannesburg", jev: { apiKey: "test-key" } } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: ROUTES,
    defaults: { outbox: { status: "pending", attempts: 0, last_error: null, result: null }, contacts: { email_status: "ok", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, activities: { created_at: new Date().toISOString() } },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, emit };
}

type Harness = Awaited<ReturnType<typeof boot>>["harness"];

async function setRoles(harness: Harness, roles: Partial<RolesPayload>) {
  await harness.emit("plugin.partnersinbiz.cockpit.roles.updated", {
    companyId: CO, operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: new Date().toISOString(), ...roles,
  }, { companyId: CO });
}

const issues = (harness: Harness) => harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CRM cockpit snapshot", () => {
  it("declares the cockpit route", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: COCKPIT_ROUTE.routeKey, path: "/cockpit" }));
  });

  it("a company with no deals: pipeline R 0.00, healthy jobs, nothing waiting", async () => {
    const store = seed();
    store.contacts = [];
    const { harness } = await boot({ store, config: {} });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap).toMatchObject({ plugin: "partnersinbiz.crm", title: "CRM", waiting: [], activity: [] });
    expect(snap.kpis.map((k) => [k.key, k.value])).toEqual([
      ["pipeline", "R 0.00"],
      ["deals_won_month", "0"],
      ["new_leads_week", "0"],
      ["contacts_follow_up", "0"],
      ["active_sequences", "0"],
    ]);
    expect(snap.health.map((h) => h.key)).toEqual(["job:open-due-steps", "job:redeliver-mail", "job:emit-recent", "job:emit-all", "job:setup-status", "outbox"]);
    expect(snap.health.every((h) => h.status === "ok")).toBe(true);
  });

  it("configured company: money KPIs, waiting approvals and follow-ups, activity, quality", async () => {
    const store = seed();
    store.deals = [
      { id: "d1", company_id: CO, pipeline_id: "p1", stage_id: "st-open", title: "Website", amount_minor: 1_250_000, currency: "ZAR", updated_at: ago(60) },
      { id: "d2", company_id: CO, pipeline_id: "p1", stage_id: "st-open", title: "SEO", amount_minor: 50_000, currency: "USD", updated_at: ago(60) },
      { id: "d3", company_id: CO, pipeline_id: "p1", stage_id: "st-won", title: "Retainer", amount_minor: 800_000, currency: "ZAR", updated_at: ago(30) },
    ];
    store.contacts!.push(
      contact("new", "Nina New", { created_at: ago(60), next_action_due_at: ago(10), lead_scored_at: ago(50) }),
      contact("old", "Oscar Old", { lifecycle: "prospect" }),
    );
    store.enrollments = [{ id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "new", status: "running", step_position: 1 }];
    store.sequences![0]!.email_approval_issue_id = "iss-appr";
    store.issues = [
      { id: "iss-appr", company_id: CO, status: "todo", assignee_agent_id: null, assignee_user_id: null, created_at: ago(120), origin_kind: "plugin:partnersinbiz.crm", origin_id: "sequence-email:seq-intro" },
      { id: "iss-reply", company_id: CO, title: "Reply from Nina: Hi", status: "todo", assignee_agent_id: null, assignee_user_id: "user-peet", created_at: ago(90), origin_kind: "plugin:partnersinbiz.crm", origin_id: "reply:m1" },
      { id: "iss-agent", company_id: CO, title: "Reply from X", status: "todo", assignee_agent_id: "agent-ada", assignee_user_id: null, created_at: ago(80), origin_kind: "plugin:partnersinbiz.crm", origin_id: "reply:m2" },
    ];
    store.activities = [
      { id: "a1", company_id: CO, record_type: "deal", record_id: "d3", kind: "deal_moved", body: "Moved to Won", created_at: ago(30) },
      { id: "a2", company_id: CO, record_type: "contact", record_id: "new", kind: "email_sent", body: "Sequence email sent: Hi", created_at: ago(20) },
    ];
    const { harness } = await boot({ store });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    const kpi = (key: string) => snap.kpis.find((k) => k.key === key)!;
    expect(kpi("pipeline")).toMatchObject({ value: "R 12,500.00", raw: 1_250_000, delta: "2 open deals · plus $500.00", group: "pipeline", href: "/crm" });
    expect(kpi("deals_won_month")).toMatchObject({ raw: 1, delta: "R 8,000.00" });
    expect(kpi("new_leads_week").raw).toBe(1);
    expect(kpi("contacts_follow_up")).toMatchObject({ raw: 1, tone: "warn" });
    expect(kpi("active_sequences").raw).toBe(1);
    expect(snap.waiting.map((w) => [w.key, w.kind])).toEqual([["approval:iss-appr", "review"], ["followup:iss-reply", "judgement"]]);
    expect(snap.activity.slice(0, 3).map((a) => a.text)).toEqual(["Sent a sequence email to Nina New", "Moved deal Retainer to Won", "Added contact Nina New"]);
    expect(snap.quality.find((q) => q.key === "reply_classification_corrected_rate")).toMatchObject({ value: "30% (3 of 10)", tone: "bad" });
    expect(snap.quality.find((q) => q.key === "lead_score_coverage")).toMatchObject({ value: "33% (1 of 3)", tone: "bad" });
  });

  it("repeated job failures turn the job check bad", async () => {
    const { harness } = await boot();
    for (let i = 0; i < 3; i += 1) await trackJob(harness.ctx, "emit-recent", async () => { throw new Error("host refused"); }).catch(() => undefined);
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.health.find((h) => h.key === "job:emit-recent")).toMatchObject({ status: "bad", detail: "Last error: host refused" });
  });

  it("serves GET /cockpit and pushes it hourly; skips a company whose settings were never saved", async () => {
    const saved = await boot();
    const response = await plugin.definition.onApiRequest!({
      routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as CockpitSnapshot).plugin).toBe("partnersinbiz.crm");
    await saved.harness.runJob("setup-status");
    expect(saved.emit).toHaveBeenCalledWith("cockpit.snapshot", CO, expect.objectContaining({ plugin: "partnersinbiz.crm" }));

    const unsaved = await boot({ config: {} });
    await unsaved.harness.runJob("setup-status");
    expect(unsaved.emit).not.toHaveBeenCalledWith("cockpit.snapshot", expect.anything(), expect.anything());
  });

  it("formats multi-currency pipelines and activity lines", () => {
    expect(pipelineValue([{ currency: "USD", open_minor: "100", open_deals: "1", won_minor: "0" }], "ZAR")).toMatchObject({ value: "$1.00", raw: 100, delta: "1 open deal" });
    expect(activityText("lead_captured", "x", "Jane")).toBe("Captured a lead: Jane");
    expect(activityText("reply_classified", "x", null)).toBe("Handled a reply from a contact");
  });

  it("moving a deal logs a deal_moved activity", async () => {
    const store = seed();
    store.deals = [{ id: "d1", company_id: CO, pipeline_id: "p1", stage_id: "st-open", account_id: null, contact_id: null, title: "Website", amount_minor: 100, currency: "ZAR", owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null, custom: {}, human_owned_fields: [] }];
    const { harness } = await boot({ store });
    await harness.performAction("crm.move-deal", { dealId: "d1", stageId: "st-won" }, { companyId: CO, actor: BOARD });
    expect(store.activities!.find((a) => a.kind === "deal_moved")).toMatchObject({ record_type: "deal", record_id: "d1", body: "Moved to Won" });
  });
});

describe("Sequence email approval: Reviewer routing", () => {
  it("without a Reviewer the approval stays unassigned and asleep, as before", async () => {
    const { harness } = await boot();
    const result = await harness.performAction<{ approvalIssueId: string }>("crm.set-sequence-delivery", { sequenceId: "seq-intro", delivery: "email" }, { companyId: CO, actor: BOARD });
    const issue = (await issues(harness)).find((row) => row.id === result.approvalIssueId)!;
    expect(issue.assigneeAgentId ?? null).toBeNull();
    expect(issue.description).not.toContain("Reviewer");
  });

  it("with a Reviewer the approval goes to the Reviewer with the sequence checks, then to the owner", async () => {
    const { harness } = await boot({ config: { timezone: "Africa/Johannesburg", mailFrom: "sales@partnersinbiz.online" } });
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true, ownerUserId: "user-peet" });
    const result = await harness.performAction<{ approvalIssueId: string }>("crm.set-sequence-delivery", { sequenceId: "seq-intro", delivery: "email" }, { companyId: CO, actor: BOARD });
    const issue = (await issues(harness)).find((row) => row.id === result.approvalIssueId)!;
    expect(issue.assigneeAgentId).toBe("agent-reviewer");
    expect(issue.status).toBe("todo");
    for (const text of ["## Reviewer: check before the person approves", "{{first_name}}", "Tone:", "Claims:", "Unsubscribe:", "sales@partnersinbiz.online", "reassign this issue to the approver (user `user-peet`)"]) {
      expect(issue.description).toContain(text);
    }
  });

  it("an approval an agent closed is asked again; only a board user's done approves", async () => {
    const { harness, store } = await boot();
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true });
    const first = await harness.performAction<{ approvalIssueId: string }>("crm.set-sequence-delivery", { sequenceId: "seq-intro", delivery: "email" }, { companyId: CO, actor: BOARD });
    const approval = (await issues(harness)).find((row) => row.id === first.approvalIssueId)!;
    harness.seed({ issues: [{ ...approval, status: "done" }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: approval.id, actorType: "agent", actorId: "agent-reviewer" });
    expect(store.sequences![0]!.email_approved_at ?? null).toBeNull();
    const again = await harness.performAction<{ approvalIssueId: string }>("crm.set-sequence-delivery", { sequenceId: "seq-intro", delivery: "email" }, { companyId: CO, actor: BOARD });
    expect(again.approvalIssueId).not.toBe(first.approvalIssueId);
  });

  it("the brief falls back to a board member", () => {
    expect(sequenceReviewBrief("Intro", "the Mailbox's default Gmail account", null)).toContain("reassign this issue to a board member");
  });
});

describe("lead.captured intake", () => {
  const mailLead = (extra: Record<string, unknown> = {}) => ({
    key: "mail:g-1", source: "email", name: "Nina New", email: "Nina@NewCo.test", handle: null, platform: null,
    text: "Website quote?: Can you quote us for a new site?", url: null, clientKind: null, clientRef: null, confidence: 0.82, capturedAt: "2026-09-26T09:00:00Z", ...extra,
  });

  it("a new email lead: contact (lifecycle lead), activity, lead score and one follow-up for the company owner", async () => {
    stubJev({ fit: 3, intent: 3, urgency: 2, confidence: 0.9 });
    const { harness, store, emit } = await boot();
    await setRoles(harness, { ownerUserId: "user-peet" });
    await harness.emit(MAILBOX_LEAD, mailLead(), { companyId: CO });
    await settleLeadScores();
    const nina = store.contacts!.find((c) => c.name === "Nina New")!;
    expect(nina).toMatchObject({ lifecycle: "lead", emails: ["nina@newco.test"], tags: ["lead"] });
    expect(nina.custom).toMatchObject({ leadSource: "email" });
    expect(nina.lead_fit).toBe(3);
    expect(store.activities!.filter((a) => a.kind === "lead_captured")).toEqual([expect.objectContaining({ record_id: nina.id, source_key: "lead:mail:g-1" })]);
    const followUps = (await issues(harness)).filter((i) => i.originId === "lead:mail:g-1");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ title: "Follow up new lead: Nina New", assigneeUserId: "user-peet" });
    expect(followUps[0]!.description).toContain("Lead score: hot");
    expect(followUps[0]!.description).toContain("nina@newco.test");
    // The new contact is shared with the other plugins' projections.
    expect(emit).toHaveBeenCalledWith("contact.upserted", CO, expect.objectContaining({ id: nina.id }));

    // A re-delivery (the Mailbox re-emits for 30 minutes) changes nothing.
    await harness.emit(MAILBOX_LEAD, mailLead(), { companyId: CO });
    expect(store.contacts!.filter((c) => c.name === "Nina New")).toHaveLength(1);
    expect((await issues(harness)).filter((i) => i.originId === "lead:mail:g-1")).toHaveLength(1);
    expect(store.inbox!.map((row) => row.key)).toContain("lead:mail:g-1");
  });

  it("an existing contact keeps its lifecycle; the follow-up goes to the contact's agent", async () => {
    const { harness, store } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    await harness.emit(MAILBOX_LEAD, mailLead({ key: "mail:g-2", email: "ada@acme.test", name: "Ada" }), { companyId: CO });
    expect(store.contacts).toHaveLength(2);
    expect(store.contacts!.find((c) => c.id === "ada")!.lifecycle).toBe("customer");
    const [issue] = (await issues(harness)).filter((i) => i.originId === "lead:mail:g-2");
    expect(issue).toMatchObject({ title: "Follow up lead: Ada Lovelace", assigneeAgentId: "agent-ada" });
  });

  it("a social lead matches by handle, and a new handle creates a contact that stores it", async () => {
    const { harness, store } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    await harness.emit(SOCIAL_LEAD, { key: "social:inbox:1", source: "social", handle: "@Jane.Doe", platform: "Instagram", text: "How much for a logo?", clientKind: "company", clientRef: "acme" }, { companyId: CO });
    expect(store.contacts).toHaveLength(2);
    expect(store.activities!.find((a) => a.source_key === "lead:social:inbox:1")!.record_id).toBe("ig");

    await harness.emit(SOCIAL_LEAD, { key: "social:inbox:2", source: "social", name: "Sam", handle: "sam_s", platform: "x", text: "DM me prices" }, { companyId: CO });
    const sam = store.contacts!.find((c) => c.name === "Sam")!;
    expect(sam.custom).toMatchObject({ handles: ["x:sam_s"], leadSource: "social", leadPlatform: "x" });
    const [issue] = (await issues(harness)).filter((i) => i.originId === "lead:social:inbox:2");
    expect(issue!.description).toContain("X: @sam_s");
    // Social scope never links the contact to the client company.
    expect(store.contact_companies).toEqual([]);
  });

  it("the lead and the mail.received for the same message do not collide in the inbox", async () => {
    const { harness, store } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    await harness.emit("plugin.partnersinbiz.mailbox.mail.received", {
      key: "mail:g-9", accountAddress: "peet@partnersinbiz.online", messageId: "g-9", threadId: "t-9", from: { email: "zed@new.test", name: "Zed" }, to: [], subject: "Quote", snippet: "Hi", receivedAt: "2026-09-26T09:00:00Z", attachments: [], triage: {}, replyTo: null,
    }, { companyId: CO });
    await harness.emit(MAILBOX_LEAD, mailLead({ key: "mail:g-9", email: "zed@new.test", name: "Zed" }), { companyId: CO });
    expect(store.contacts!.find((c) => c.name === "Zed")).toBeTruthy();
    expect(store.inbox!.map((row) => row.key).sort()).toEqual(["lead:mail:g-9", "mail:g-9"]);
  });

  it("an email lead whose domain matched a CRM company is linked to it", async () => {
    const { harness, store } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    await harness.emit(MAILBOX_LEAD, mailLead({ key: "mail:g-3", email: "new.person@acme.test", name: "New Person", clientKind: "company", clientRef: "acme" }), { companyId: CO });
    const person = store.contacts!.find((c) => c.name === "New Person")!;
    expect(store.contact_companies).toEqual([expect.objectContaining({ contact_id: person.id, account_id: "acme" })]);
  });

  it("skips when the CRM settings were never saved, and ignores payloads without a way to reach the person", async () => {
    const unsaved = await boot({ config: {} });
    await unsaved.harness.emit(MAILBOX_LEAD, mailLead(), { companyId: CO });
    expect(unsaved.store.contacts).toHaveLength(2);
    expect(asLead({ key: "x", source: "email", text: "hi" })).toBeNull();
    expect(asLead({ key: "x", source: "weird", email: "a@b.co" })).toMatchObject({ source: "other", email: "a@b.co" });
    expect(handleKey({ handle: "Jane", platform: null })).toBe("social:jane");
  });
});
