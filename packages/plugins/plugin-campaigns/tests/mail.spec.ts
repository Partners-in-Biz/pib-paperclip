import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { decisionsMigration, inboxMigration, outboxMigration } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { clearJevCache } from "../src/jev.js";
import {
  abSuggestion,
  advanceEnrollment,
  AB_MIN_SENDS,
  assertEventType,
  campaignMailKey,
  campaignReplyPlan,
  pickVariant,
  REPLY_KINDS,
  startEnrollment,
  stepFor,
  type CampaignStepDraft,
  type ReplyKind,
} from "../src/domain.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const CO = "co-1";
const BOARD = { type: "user" as const, userId: "local-board" };
const MAILBOX = "plugin.partnersinbiz.mailbox";
const PAST = "2026-09-01T08:00:00.000Z";
const FUTURE = "2099-01-01T08:00:00.000Z";

const ROUTES: Route[] = [
  [/unnest\(emails\)/, (p, s) =>
    (s.crm_contacts ?? []).filter((row) => row.company_id === p[0] && !row.deleted && (row.emails as string[]).some((email) => email.toLowerCase() === p[1]))],
  [/campaign_id IN \(SELECT id FROM/, (_p, s) => {
    const active = new Set((s.campaigns ?? []).filter((c) => c.status === "active").map((c) => c.id));
    return (s.campaign_enrollments ?? []).filter((e) => e.status === "running" && e.open_issue_id == null && e.sending_key == null && e.next_due_at && Date.parse(e.next_due_at) <= Date.now() && active.has(e.campaign_id));
  }],
  [/JOIN \S+\.outbox o/, (_p, s) =>
    (s.campaign_enrollments ?? [])
      .filter((e) => e.status === "running" && (s.outbox ?? []).some((o) => o.key === e.sending_key && o.status === "failed"))
      .map((e) => ({ ...e, last_error: (s.outbox ?? []).find((o) => o.key === e.sending_key)?.last_error ?? null }))],
];

function contact(id: string, name: string, emails: string[], extra: Row = {}): Row {
  return { id, company_id: CO, name, emails, phones: [], lifecycle: "lead", tags: [], account_ids: [], updated_at: "2026-01-01T00:00:00Z", deleted: false, ...extra };
}

function campaign(id: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name: id, description: "", status: "active", from_name: "", from_local: "campaigns", reply_to: null, audience_tags: [],
    start_at: null, end_at: null, approval_issue_id: null, winner_variant: null, client_kind: null, client_ref: null, client_name: null,
    audience_mode: "tags", delivery: "email", owner_user_id: null, owner_agent_id: "agent-camp", ...extra,
  };
}

function step(campaignId: string, position: number, variant: "a" | "b", subject: string, body: string, delayDays = 0): Row {
  return { id: `${campaignId}-${position}${variant}`, company_id: CO, campaign_id: campaignId, position, delay_days: delayDays, subject, body, html_body: null, variant };
}

function enrollment(id: string, campaignId: string, contactId: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, campaign_id: campaignId, contact_id: contactId, status: "running", step_position: 1, variant: "a",
    next_due_at: FUTURE, open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
  };
}

function seed(): Store {
  return {
    crm_companies: [{ id: "acme", company_id: CO, name: "Acme Plumbing", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: false }],
    crm_contacts: [
      contact("ada", "Ada Lovelace", ["ada@acme.test"], { account_ids: ["acme"] }),
      contact("bob", "Bob Builder", ["bob@beta.test"]),
      contact("carl", "Carl NoMail", []),
      contact("uma", "Uma Gone", ["uma@x.test"]),
    ],
    campaigns: [campaign("camp-mail"), campaign("camp-other"), campaign("camp-issue", { delivery: "issue" })],
    campaign_steps: [
      step("camp-mail", 1, "a", "Hi {{first_name}}", "Hello {{first_name}} at {{company}}"),
      step("camp-mail", 1, "b", "Quick question, {{first_name}}", "Short B body"),
      step("camp-mail", 2, "a", "Following up", "Any thoughts?", 3),
      step("camp-other", 1, "a", "Other", "Other body"),
      step("camp-issue", 1, "a", "Manual", "Send by hand"),
    ],
    campaign_enrollments: [],
    campaign_step_events: [],
    suppressions: [],
    outbox: [],
    inbox: [],
    decisions: [],
  };
}

function stubJev(reply?: { choice: ReplyKind; confidence: number }) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    if (body.questions.reply_kind && reply) {
      answers.reply_kind = { type: "choice", choice: reply.choice, probabilities: { [reply.choice]: reply.confidence }, confidence: reply.confidence };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function boot(options: { jev?: boolean; store?: Store } = {}) {
  clearJevCache();
  const store = options.store ?? seed();
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", ...(options.jev === false ? {} : { jev: { apiKey: "test-key" } }) } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: ROUTES,
    defaults: { outbox: { status: "pending", attempts: 0, last_error: null, result: null }, campaign_step_events: { occurred_at: new Date().toISOString() } },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, emit };
}

function mail(extra: Record<string, unknown> = {}) {
  return {
    key: "mail:m-1",
    accountAddress: "peet@partnersinbiz.online",
    messageId: "m-1",
    threadId: "t-1",
    from: { email: "ada@acme.test", name: "Ada" },
    to: [{ email: "peet@partnersinbiz.online" }],
    subject: "Re: Hi Ada",
    snippet: "Sounds good, call me",
    receivedAt: "2026-09-26T09:00:00Z",
    attachments: [],
    triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null },
    replyTo: null,
    ...extra,
  };
}

const sentEvent = (enrollmentId: string, position: number, variant: string, to: string, at = "2026-09-20T08:00:00.000Z"): Row => ({
  id: `sent-${enrollmentId}-${position}`, company_id: CO, campaign_id: "camp-mail", enrollment_id: enrollmentId, step_position: position,
  event_type: "sent", variant, source_key: `sent:${campaignMailKey(enrollmentId, position)}`, meta: { to }, occurred_at: at,
});

async function receive(harness: Awaited<ReturnType<typeof boot>>["harness"], payload: Record<string, unknown>) {
  await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, payload, { companyId: CO });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaigns 010 migration", () => {
  const sql = readFileSync(new URL("../migrations/010_campaigns.sql", import.meta.url), "utf8");
  it("passes the host migration guard, widens step events and carries the kit tables", () => {
    for (const statement of splitSqlStatements(sql)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    expect(sql).toContain("CHECK (event_type IN ('open', 'click', 'sent', 'reply', 'bounce', 'unsubscribe'))");
    expect(sql).toContain(decisionsMigration(NAMESPACE).trim());
    expect(sql).toContain(inboxMigration(NAMESPACE).trim());
    expect(sql).toContain(outboxMigration(NAMESPACE).trim());
    expect(sql).not.toMatch(/\bdelete\b/i);
    // Manual step events stay open/click only.
    expect(() => assertEventType("reply")).toThrow(/open or click/);
  });
});

describe("A/B arms", () => {
  const steps: CampaignStepDraft[] = [
    { position: 1, delayDays: 0, subject: "A1", body: "", htmlBody: null, variant: "a" },
    { position: 1, delayDays: 0, subject: "B1", body: "", htmlBody: null, variant: "b" },
    { position: 2, delayDays: 2, subject: "A2", body: "", htmlBody: null, variant: "a" },
    { position: 3, delayDays: 2, subject: "A3", body: "", htmlBody: null, variant: "a" },
    { position: 3, delayDays: 0, subject: "B3", body: "", htmlBody: null, variant: "b" },
  ];

  it("splits contacts evenly and stably, and uses the declared winner", () => {
    const arms = Array.from({ length: 400 }, (_, i) => pickVariant({ id: "c1", winnerVariant: null }, steps, `contact-${i}`));
    const b = arms.filter((arm) => arm === "b").length;
    expect(b).toBeGreaterThan(160);
    expect(b).toBeLessThan(240);
    expect(pickVariant({ id: "c1", winnerVariant: null }, steps, "contact-7")).toBe(arms[7]);
    expect(pickVariant({ id: "c1", winnerVariant: "b" }, steps, "contact-7")).toBe("b");
    expect(pickVariant({ id: "c1", winnerVariant: null }, steps.filter((s) => s.variant === "a"), "contact-7")).toBe("a");
  });

  it("keeps the arm across steps and falls back to A where there is no B version", () => {
    const started = startEnrollment({ companyId: "w", campaignId: "c1", contactId: "x", existing: [], steps, now: new Date(), variant: "b" });
    expect(stepFor(steps, started.stepPosition, started.variant)!.subject).toBe("B1");
    const second = advanceEnrollment(started, steps, new Date());
    expect(second.variant).toBe("b");
    expect(stepFor(steps, second.stepPosition, second.variant)!.subject).toBe("A2");
    const third = advanceEnrollment(second, steps, new Date());
    expect(stepFor(steps, third.stepPosition, third.variant)!.subject).toBe("B3");
  });

  it("suggests a winner only from 20 sends per variant", () => {
    const sends = (n: number, replies: number) => Array.from({ length: n }, (_, i) => i < replies);
    const spread = (n: number, every: number) => Array.from({ length: n }, (_, i) => i % every === 0);
    expect(abSuggestion({ a: sends(19, 5), b: sends(40, 20) })).toMatchObject({ verdict: "inconclusive", suggestion: null });
    expect(abSuggestion({ a: sends(19, 5), b: sends(40, 20) }).reason).toMatch(`${AB_MIN_SENDS} sends per variant`);
    const bWins = abSuggestion({ a: spread(25, 5), b: spread(25, 2) });
    expect(bWins).toMatchObject({ verdict: "win", suggestion: "b", sends: { a: 25, b: 25 } });
    expect(bWins.replyRate.b).toBeGreaterThan(bWins.replyRate.a!);
    expect(abSuggestion({ a: spread(25, 2), b: spread(25, 5) })).toMatchObject({ verdict: "loss", suggestion: "a" });
    expect(abSuggestion({ a: spread(25, 3), b: spread(25, 3) })).toMatchObject({ suggestion: null });
  });
});

describe("campaign reply plans", () => {
  it("maps every reply kind", () => {
    expect(campaignReplyPlan("interested", true)).toMatchObject({ event: "reply", stop: "this", issue: "follow-up" });
    expect(campaignReplyPlan("question", true)).toMatchObject({ event: "reply", stop: "this", issue: "follow-up" });
    expect(campaignReplyPlan("not_now", true)).toMatchObject({ event: "reply", stop: "this", issue: null });
    expect(campaignReplyPlan("unsubscribe", true)).toMatchObject({ event: "unsubscribe", stop: "contact", suppress: "unsubscribe" });
    expect(campaignReplyPlan("bounce", true)).toMatchObject({ event: "bounce", stop: "contact", suppress: "bounce" });
    expect(campaignReplyPlan("out_of_office", true)).toMatchObject({ event: null, stop: "none", pushDays: 5 });
    expect(campaignReplyPlan("other", true)).toMatchObject({ event: "reply", stop: "none", issue: "review" });
    for (const kind of REPLY_KINDS) expect(campaignReplyPlan(kind, false)).toMatchObject({ event: "reply", stop: "none", suppress: null, issue: "review" });
  });
});

describe("campaign email delivery", () => {
  it("launch splits arms and a due step is sent through the outbox with the arm's copy", async () => {
    stubJev();
    const store = seed();
    const { harness, emit } = await boot({ store });
    harness.seed({ issues: [{ id: "appr-1", companyId: CO, title: "Approve", status: "done" } as never] });
    store.campaigns!.push(campaign("camp-draft", { status: "draft", approval_issue_id: "appr-1" }));
    store.campaign_steps!.push(
      step("camp-draft", 1, "a", "Hi {{first_name}}", "Hello {{first_name}} at {{company}}"),
      step("camp-draft", 1, "b", "Quick question, {{first_name}}", "B copy for {{name}}"),
    );
    const launched = await harness.performAction<{ enrolled: number }>("campaigns.launch", { campaignId: "camp-draft" }, { companyId: CO, actor: BOARD });
    expect(launched.enrolled).toBe(4);
    const steps = store.campaign_steps!.filter((row) => row.campaign_id === "camp-draft").map((row) => ({ variant: row.variant as "a" | "b" }));
    for (const row of store.campaign_enrollments!) {
      expect(row.variant).toBe(pickVariant({ id: "camp-draft", winnerVariant: null }, steps, String(row.contact_id)));
      row.next_due_at = PAST;
    }
    await harness.runJob("open-due-steps");
    // Carl has no address: an issue instead of an email.
    expect(store.outbox).toHaveLength(3);
    const ada = store.campaign_enrollments!.find((row) => row.contact_id === "ada")!;
    const adaMail = store.outbox!.find((row) => row.key === campaignMailKey(String(ada.id), 1))!;
    expect(adaMail.payload).toMatchObject({
      to: [{ email: "ada@acme.test", name: "Ada Lovelace" }],
      subject: ada.variant === "b" ? "Quick question, Ada" : "Hi Ada",
      text: ada.variant === "b" ? "B copy for Ada Lovelace" : "Hello Ada at Acme Plumbing",
      context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: ada.id },
      labels: ["PiB/Campaigns"],
    });
    expect(ada.sending_key).toBe(adaMail.key);
    expect(emit).toHaveBeenCalledWith("mail.send.requested", CO, expect.objectContaining({ key: adaMail.key }));
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues.filter((issue) => /no email address/.test(issue.description ?? ""))).toHaveLength(1);
  });

  it("a sent result records the send per variant and moves on once", async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-mail", "ada", { variant: "b", next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(store.outbox![0]!.payload.subject).toBe("Quick question, Ada");
    const result = { key: "campaigns:step:e1:1", status: "sent", messageId: "gm-1", threadId: "th-1", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" } };
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    const sends = store.campaign_step_events!.filter((row) => row.event_type === "sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ enrollment_id: "e1", step_position: 1, variant: "b", meta: { to: "ada@acme.test", messageId: "gm-1" } });
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2, variant: "b", sending_key: null, mail_thread_id: "th-1" });
    expect(store.outbox![0]!.status).toBe("done");
  });

  it("a permanent failure opens an issue for the campaign owner", async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "campaigns:step:e1:1", status: "failed", permanent: true, error: "Mailbox not connected", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" },
    }, { companyId: CO });
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue).toMatchObject({ title: "Email not sent: Hi {{first_name}}: Ada Lovelace", assigneeAgentId: "agent-camp" });
    expect(store.campaign_enrollments![0]).toMatchObject({ open_issue_id: issue!.id, sending_key: null });
    expect(store.outbox![0]!.status).toBe("failed");
  });

  it("re-uses the Mailbox's stored answer when the same step is requested again", async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-mail", "ada", { next_due_at: PAST })];
    store.outbox = [{
      key: "campaigns:step:e1:1", company_id: CO, event: "mail.send.requested", payload: { to: [{ email: "ada@acme.test" }] }, status: "done", attempts: 1, next_attempt_at: PAST, last_error: null,
      result: { key: "campaigns:step:e1:1", status: "sent", messageId: "gm-9", threadId: "th-9", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" } },
    }];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(emit).not.toHaveBeenCalled();
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2, sending_key: null, mail_thread_id: "th-9" });
    expect(store.campaign_step_events!.filter((row) => row.event_type === "sent")).toHaveLength(1);
  });

  it("a send result after a reply stopped the enrollment records the send but does not restart it", async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    store.campaign_enrollments![0]!.status = "stopped";
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "campaigns:step:e1:1", status: "sent", messageId: "gm-1", threadId: "th-1", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" },
    }, { companyId: CO });
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "stopped", step_position: 1, sending_key: null });
    expect(store.campaign_step_events!.filter((row) => row.event_type === "sent")).toHaveLength(1);
  });

  it("never emails a suppressed address", async () => {
    stubJev();
    const store = seed();
    store.suppressions = [{ company_id: CO, email: "uma@x.test", reason: "unsubscribe", contact_id: "uma", campaign_id: null }];
    store.campaign_enrollments = [enrollment("e-uma", "camp-mail", "uma", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(0);
    expect(store.campaign_enrollments![0]!.status).toBe("stopped");
  });

  it("issue-delivery campaigns keep opening issues", async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-issue", "bob", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(0);
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue!.title).toBe("Manual: Bob Builder");
    expect(issue!.description).toContain("Send to: Bob Builder <bob@beta.test>");
  });
});

describe("campaign replies", () => {
  function replyStore() {
    const store = seed();
    store.campaign_enrollments = [
      enrollment("e-ada", "camp-mail", "ada", { step_position: 2, variant: "b", next_due_at: "2026-09-28T08:00:00.000Z" }),
      enrollment("e-ada-other", "camp-other", "ada"),
      enrollment("e-bob", "camp-mail", "bob"),
    ];
    store.campaign_step_events = [sentEvent("e-ada", 1, "b", "ada@acme.test")];
    return store;
  }

  it("records a reply on the emailed step and variant, stops that enrollment and opens a follow-up for the owner", async () => {
    stubJev({ choice: "interested", confidence: 0.9 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail());
    const reply = store.campaign_step_events!.find((row) => row.event_type === "reply")!;
    expect(reply).toMatchObject({ enrollment_id: "e-ada", step_position: 1, variant: "b", source_key: "reply:m-1" });
    expect(store.campaign_enrollments!.find((row) => row.id === "e-ada")!.status).toBe("stopped");
    expect(store.campaign_enrollments!.find((row) => row.id === "e-ada-other")!.status).toBe("running");
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue).toMatchObject({ title: "Reply from Ada Lovelace: Re: Hi Ada", assigneeAgentId: "agent-camp" });
    expect(store.decisions![0]).toMatchObject({ purpose: "campaigns.reply", value_text: "interested", acted: true });
  });

  it("unsubscribe stops every campaign for the contact and suppresses the address", async () => {
    stubJev({ choice: "unsubscribe", confidence: 0.96 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail({ snippet: "Stop emailing me" }));
    expect(store.campaign_enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "stopped")).toBe(true);
    expect(store.campaign_enrollments!.find((row) => row.id === "e-bob")!.status).toBe("running");
    expect(store.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "unsubscribe", contact_id: "ada" })]);
    expect(store.campaign_step_events!.map((row) => row.event_type).sort()).toEqual(["sent", "unsubscribe"]);
  });

  it("a bounce through the send context suppresses the address we sent to", async () => {
    stubJev({ choice: "bounce", confidence: 0.98 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail({
      from: { email: "mailer-daemon@googlemail.com" },
      subject: "Delivery Status Notification (Failure)",
      replyTo: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-ada" },
    }));
    expect(store.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "bounce" })]);
    expect(store.campaign_step_events!.some((row) => row.event_type === "bounce" && row.variant === "b")).toBe(true);
    expect(store.campaign_enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "stopped")).toBe(true);
  });

  it("out of office moves the next step five days and records no reply", async () => {
    stubJev({ choice: "out_of_office", confidence: 0.9 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail({ snippet: "Away until next week" }));
    expect(store.campaign_enrollments!.find((row) => row.id === "e-ada")).toMatchObject({ status: "running", next_due_at: "2026-10-03T08:00:00.000Z" });
    expect(store.campaign_step_events!.filter((row) => row.event_type !== "sent")).toHaveLength(0);
  });

  it("without Jev it records the reply and asks the owner", async () => {
    const fetchMock = stubJev();
    const { harness, store } = await boot({ store: replyStore(), jev: false });
    await receive(harness, mail());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.campaign_step_events!.filter((row) => row.event_type === "reply")).toHaveLength(1);
    expect(store.campaign_enrollments!.find((row) => row.id === "e-ada")!.status).toBe("running");
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue!.title).toBe("Check reply from Ada Lovelace: Re: Hi Ada");
    expect(issue!.description).toMatch(/Jev is not set up/);
  });

  it("handles a repeated delivery once", async () => {
    const fetchMock = stubJev({ choice: "question", confidence: 0.9 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail());
    await receive(harness, mail());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.campaign_step_events!.filter((row) => row.event_type === "reply")).toHaveLength(1);
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(1);
  });

  it("ignores mail from people who are not in a campaign", async () => {
    stubJev({ choice: "interested", confidence: 0.9 });
    const { harness, store } = await boot({ store: replyStore() });
    await receive(harness, mail({ from: { email: "carl@nowhere.test" } }));
    expect(store.campaign_step_events!.filter((row) => row.event_type === "reply")).toHaveLength(0);
    expect(store.inbox![0]!.result).toEqual({ matched: false });
  });
});

describe("A/B suggestion tools", () => {
  function abStore(aReplies: number, bReplies: number) {
    const store = seed();
    const events: Row[] = [];
    for (const [arm, replies] of [["a", aReplies], ["b", bReplies]] as const) {
      for (let i = 0; i < 25; i += 1) {
        const id = `e-${arm}-${i}`;
        events.push({ ...sentEvent(id, 1, arm, `${id}@x.test`, `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T08:00:00.000Z`), id: `s-${id}` });
        if (i % Math.max(1, Math.round(25 / Math.max(replies, 1))) === 0 && replies > 0) {
          events.push({ id: `r-${id}`, company_id: CO, campaign_id: "camp-mail", enrollment_id: id, step_position: 1, event_type: "reply", variant: arm, source_key: `reply:${id}`, meta: {}, occurred_at: "2026-09-25T08:00:00.000Z" });
        }
      }
    }
    store.campaign_step_events = events;
    return store;
  }

  it("suggests B when it gets more replies, and declare-ab-winner still needs a person's pick", async () => {
    stubJev();
    const { harness, store } = await boot({ store: abStore(5, 13) });
    const suggestion = await harness.executeTool<{ data: Record<string, any> }>("suggest-ab-winner", { campaignId: "camp-mail" }, { companyId: CO, agentId: "agent-camp" });
    expect(suggestion.data).toMatchObject({ verdict: "win", suggestion: "b", sends: { a: 25, b: 25 } });
    expect(store.campaigns!.find((row) => row.id === "camp-mail")!.winner_variant).toBeNull();
    const declared = await harness.performAction<Record<string, any>>("campaigns.declare-winner", { campaignId: "camp-mail", winner: "a" }, { companyId: CO, actor: BOARD });
    expect(declared).toMatchObject({ winner: "a", suggestion: { suggestion: "b" } });
    expect(store.campaigns!.find((row) => row.id === "camp-mail")!.winner_variant).toBe("a");
  });

  it("is inconclusive below 20 sends per variant", async () => {
    stubJev();
    const store = seed();
    store.campaign_step_events = [sentEvent("e1", 1, "a", "x@x.test"), sentEvent("e2", 1, "b", "y@x.test")];
    const { harness } = await boot({ store });
    const result = await harness.performAction<Record<string, any>>("campaigns.ab-suggestion", { campaignId: "camp-mail" }, { companyId: CO, actor: BOARD });
    expect(result).toMatchObject({ verdict: "inconclusive", suggestion: null, sends: { a: 1, b: 1 } });
  });
});
