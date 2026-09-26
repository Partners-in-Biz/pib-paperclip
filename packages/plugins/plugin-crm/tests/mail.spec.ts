import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { decisionsMigration, inboxMigration, outboxMigration } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { clearJevCache, leadScoreState, replyState } from "../src/jev.js";
import { settleLeadScores } from "../src/mail.js";
import { personalize, pushDate, replyPlan, REPLY_KINDS, sequenceMailKey, textToHtml, type ReplyKind } from "../src/domain.js";
import { leadBand, leadLevelLabel } from "../src/lead-levels.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const CO = "co-1";
const BOARD = { type: "user" as const, userId: "local-board" };
const MAILBOX = "plugin.partnersinbiz.mailbox";
const PAST = "2026-09-01T08:00:00.000Z";
const FUTURE = "2099-01-01T08:00:00.000Z";

const ROUTES: Route[] = [
  // Lists that also include records shared by partner grants: company scope is enough here.
  [/OR id IN \(/, (p, s, sql) => (s[/FROM \S+\.(\w+)/.exec(sql)![1]!] ?? []).filter((row) => row.company_id === p[0])],
  [/make_interval/, () => []],
  [/record_grants/, () => []],
  [/\bUNION\b/, (_p, s) => [...new Set([...(s.companies ?? []), ...(s.contacts ?? [])].map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/jsonb_array_elements_text\(c\.emails\)/, (p, s) =>
    (s.contacts ?? [])
      .filter((row) => row.company_id === p[0] && (row.emails as string[]).some((email) => email.trim().toLowerCase() === p[1]))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))],
  [/contact_companies l/, (p, s) =>
    (s.contact_companies ?? [])
      .filter((link) => link.contact_id === p[0])
      .map((link) => ({ account_id: link.account_id, role_label: link.role_label, name: (s.companies ?? []).find((a) => a.id === link.account_id)?.name ?? "" }))],
  [/JOIN \S+\.outbox o/, (_p, s) =>
    (s.enrollments ?? [])
      .filter((e) => e.status === "running" && (s.outbox ?? []).some((o) => o.key === e.sending_key && o.status === "failed"))
      .map((e) => ({ ...e, last_error: (s.outbox ?? []).find((o) => o.key === e.sending_key)?.last_error ?? null }))],
  [/count\(\*\) AS count, max\(created_at\)/, (p, s) => {
    const rows = (s.activities ?? []).filter((row) => row.record_type === "contact" && row.record_id === p[0]);
    return [{ count: rows.length, last_at: rows.map((row) => row.created_at).sort().at(-1) ?? null }];
  }],
];

function contact(id: string, name: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name, emails: [], phones: [], lifecycle: "lead", custom: {}, human_owned_fields: [],
    owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null,
    email_status: "ok", lead_fit: null, lead_intent: null, lead_urgency: null, lead_confidence: null, lead_scored_at: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...extra,
  };
}

function enrollment(id: string, sequenceId: string, contactId: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, sequence_id: sequenceId, contact_id: contactId, status: "running", step_position: 1,
    next_due_at: FUTURE, open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null,
    created_at: "2026-09-01T00:00:00Z", ...extra,
  };
}

function seed(): Store {
  return {
    companies: [{ id: "acme", company_id: CO, name: "Acme Plumbing", domain: "acme.test", lifecycle: "prospect", currency: "ZAR", custom: {}, human_owned_fields: [], tags: [] }],
    contacts: [
      contact("ada", "Ada Lovelace", { emails: ["Ada@Acme.test"], assignee_agent_id: "agent-ada", tags: ["hot"] }),
      contact("ada-later", "Ada Duplicate", { emails: ["ada@acme.test"], created_at: "2026-06-01T00:00:00Z" }),
      contact("bob", "Bob Builder", { emails: ["bob@beta.test"], owner_user_id: "user-bob" }),
      contact("carl", "Carl NoMail", { emails: [] }),
      contact("uma", "Uma Unsub", { emails: ["uma@x.test"], email_status: "unsubscribed" }),
    ],
    contact_companies: [{ id: "l1", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "Owner", created_at: "2026-01-01T00:00:00Z" }],
    sequences: [
      { id: "seq-intro", company_id: CO, name: "Intro", completion_mode: "manual", delivery: "issue", email_approval_issue_id: null, email_approved_at: null, email_approved_by: null },
      { id: "seq-mail", company_id: CO, name: "Cold email", completion_mode: "sent", delivery: "email", email_approval_issue_id: null, email_approved_at: "2026-09-01T00:00:00Z", email_approved_by: "user:local-board" },
    ],
    sequence_steps: [
      { id: "s1", company_id: CO, sequence_id: "seq-mail", position: 1, delay_minutes: 0, title: "Hi {{first_name}}", body: "Hello {{first_name|there}},\n\nWe build websites for {{company}}." },
      { id: "s2", company_id: CO, sequence_id: "seq-mail", position: 2, delay_minutes: 1440, title: "Following up", body: "Any thoughts?" },
      { id: "s3", company_id: CO, sequence_id: "seq-intro", position: 1, delay_minutes: 0, title: "Say hello", body: "Call them" },
    ],
    enrollments: [],
    activities: [
      { id: "act-1", company_id: CO, record_type: "contact", record_id: "ada", kind: "call", body: "Wants a new website before the winter campaign. Budget approved.", issue_id: null, created_at: "2026-09-20T10:00:00Z" },
    ],
    facts: [],
    record_grants: [],
    outbox: [],
    inbox: [],
    decisions: [],
  };
}

interface JevReply {
  reply?: { choice: ReplyKind; confidence: number };
  scores?: { fit: number; intent: number; urgency: number; confidence: number };
}

function stubJev(answer: JevReply) {
  const calls: Array<{ state: unknown; questions: string[] }> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, unknown> };
    calls.push({ state: body.state, questions: Object.keys(body.questions) });
    const answers: Record<string, unknown> = {};
    if (body.questions.reply_kind && answer.reply) {
      answers.reply_kind = { type: "choice", choice: answer.reply.choice, probabilities: { [answer.reply.choice]: answer.reply.confidence }, confidence: answer.reply.confidence };
    }
    if (body.questions.fit && answer.scores) {
      for (const key of ["fit", "intent", "urgency"] as const) {
        answers[key] = { type: "score", score: answer.scores[key], probabilities: {}, confidence: answer.scores.confidence };
      }
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function boot(options: { jev?: boolean; store?: Store } = {}) {
  clearJevCache();
  const store = options.store ?? seed();
  const harness = createTestHarness({
    manifest,
    config: { timezone: "Africa/Johannesburg", ...(options.jev === false ? {} : { jev: { apiKey: "test-key" } }) },
  });
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
  return { harness, store, db, emit };
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
    snippet: "Yes please, can we talk on Tuesday?",
    receivedAt: "2026-09-26T09:00:00Z",
    attachments: [],
    triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null },
    replyTo: null,
    ...extra,
  };
}

async function receive(harness: Awaited<ReturnType<typeof boot>>["harness"], payload: Record<string, unknown>) {
  await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, payload, { companyId: CO });
}

async function issues(harness: Awaited<ReturnType<typeof boot>>["harness"]) {
  return harness.ctx.issues.list({ companyId: CO });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crm 005 migration", () => {
  const sql = readFileSync(new URL("../migrations/005_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard and carries the kit tables unchanged", () => {
    for (const statement of splitSqlStatements(sql)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    expect(sql).toContain(decisionsMigration(NAMESPACE).trim());
    expect(sql).toContain(inboxMigration(NAMESPACE).trim());
    expect(sql).toContain(outboxMigration(NAMESPACE).trim());
    for (const column of ["email_status text NOT NULL DEFAULT 'ok'", "lead_fit numeric", "lead_scored_at timestamptz", "delivery text NOT NULL DEFAULT 'issue'", "sending_key text", "source_key text"]) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toMatch(/\bdelete\b/i);
  });
});

describe("reply plans", () => {
  it("maps every reply kind to its action", () => {
    expect(replyPlan("interested", true)).toMatchObject({ stopEnrollments: true, issue: "follow-up", emailStatus: null });
    expect(replyPlan("question", true)).toMatchObject({ stopEnrollments: true, issue: "follow-up" });
    expect(replyPlan("not_now", true)).toMatchObject({ stopEnrollments: true, nextActionDays: 30, issue: null });
    expect(replyPlan("unsubscribe", true)).toMatchObject({ stopEnrollments: true, emailStatus: "unsubscribed", addTag: "unsubscribed" });
    expect(replyPlan("out_of_office", true)).toMatchObject({ stopEnrollments: false, pushDays: 5, issue: null });
    expect(replyPlan("bounce", true)).toMatchObject({ stopEnrollments: true, emailStatus: "bounced" });
    expect(replyPlan("other", true)).toMatchObject({ stopEnrollments: false, issue: "review" });
  });

  it("hands every unsure or unread reply to a person", () => {
    for (const kind of REPLY_KINDS) {
      expect(replyPlan(kind, false)).toMatchObject({ stopEnrollments: false, emailStatus: null, pushDays: null, issue: "review" });
    }
    expect(replyPlan(null, true).issue).toBe("review");
  });

  it("sends Jev only the subject and snippet, 500 characters at most", () => {
    const state = replyState({ subject: "Re: hello", snippet: "x".repeat(2000) });
    expect(state.startsWith("Subject: Re: hello\n\n")).toBe(true);
    expect(state.length).toBeLessThanOrEqual(500);
  });

  it("pushes from now when the step is already due", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    expect(pushDate("2026-09-01T00:00:00Z", now, 5)).toBe("2026-10-01T00:00:00.000Z");
    expect(pushDate("2026-10-10T00:00:00Z", now, 5)).toBe("2026-10-15T00:00:00.000Z");
    expect(pushDate(null, now, 5)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("replies from the Mailbox", () => {
  let jev: ReturnType<typeof stubJev>;

  async function bootWithEnrollments(reply: JevReply["reply"], options: { jev?: boolean } = {}) {
    jev = stubJev({ reply });
    const store = seed();
    store.enrollments = [
      enrollment("e-mail", "seq-mail", "ada", { step_position: 2, next_due_at: "2026-09-27T08:00:00.000Z" }),
      enrollment("e-intro", "seq-intro", "ada"),
      enrollment("e-bob", "seq-intro", "bob"),
    ];
    return boot({ store, jev: options.jev });
  }

  it("logs the email on the oldest matching contact and stops on interest, with a follow-up for the agent", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "interested", confidence: 0.92 });
    await receive(harness, mail());
    const received = store.activities!.filter((row) => row.kind === "email_received");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ record_id: "ada", source_key: "mail:m-1" });
    expect(received[0]!.body).toContain("Yes please");
    expect(received[0]!.meta).toMatchObject({ threadId: "t-1", messageId: "m-1" });
    expect(store.enrollments!.filter((row) => row.contact_id === "ada").map((row) => row.status)).toEqual(["stopped", "stopped"]);
    expect(store.enrollments!.find((row) => row.id === "e-bob")!.status).toBe("running");
    const [issue] = await issues(harness);
    expect(issue).toMatchObject({ title: "Reply from Ada Lovelace: Re: Hi Ada", assigneeAgentId: "agent-ada", status: "todo", originId: "reply:m-1" });
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions![0]).toMatchObject({ purpose: "crm.reply", question_key: "reply_kind", value_text: "interested", acted: true });
    expect(jev.calls[0]!.state).toBe("Subject: Re: Hi Ada\n\nYes please, can we talk on Tuesday?");
    expect(store.activities!.find((row) => row.kind === "reply_classified")!.body).toMatch(/interested \(92% sure\)/);
  });

  it("stops on a question and opens a follow-up for the owner", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "question", confidence: 0.8 });
    await receive(harness, mail({ from: { email: "bob@beta.test" }, messageId: "m-q", key: "mail:m-q", subject: "Price?" }));
    expect(store.enrollments!.find((row) => row.id === "e-bob")!.status).toBe("stopped");
    const [issue] = await issues(harness);
    expect(issue).toMatchObject({ title: "Reply from Bob Builder: Price?", assigneeUserId: "user-bob" });
  });

  it("unsubscribe stops every sequence, marks the email and tags the contact", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "unsubscribe", confidence: 0.95 });
    await receive(harness, mail({ snippet: "Please remove me from your list" }));
    expect(store.enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "stopped")).toBe(true);
    const ada = store.contacts!.find((row) => row.id === "ada")!;
    expect(ada.email_status).toBe("unsubscribed");
    expect(ada.tags).toEqual(["hot", "unsubscribed"]);
    expect(await issues(harness)).toHaveLength(0);
  });

  it("out of office pushes the next step by five days and keeps the sequence running", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "out_of_office", confidence: 0.9 });
    await receive(harness, mail({ snippet: "I am away until Monday" }));
    const mailEnrollment = store.enrollments!.find((row) => row.id === "e-mail")!;
    expect(mailEnrollment.status).toBe("running");
    expect(mailEnrollment.next_due_at).toBe("2026-10-02T08:00:00.000Z");
    expect(store.enrollments!.find((row) => row.id === "e-intro")!.next_due_at).toBe("2099-01-06T08:00:00.000Z");
    expect(await issues(harness)).toHaveLength(0);
  });

  it("not now stops the sequence and sets an email next action in 30 days", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "not_now", confidence: 0.85 });
    const before = Date.now();
    await receive(harness, mail({ snippet: "Not now, try us next quarter" }));
    const ada = store.contacts!.find((row) => row.id === "ada")!;
    expect(ada.next_action_kind).toBe("email");
    const due = Date.parse(String(ada.next_action_due_at));
    expect(due - before).toBeGreaterThan(29 * 86_400_000);
    expect(due - before).toBeLessThan(31 * 86_400_000);
    expect(store.enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "stopped")).toBe(true);
  });

  it("a bounce from the mailer daemon finds the contact through the send context", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "bounce", confidence: 0.97 });
    await receive(harness, mail({
      from: { email: "mailer-daemon@googlemail.com" },
      subject: "Delivery Status Notification (Failure)",
      snippet: "Address not found",
      replyTo: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e-mail", clientKind: "contact", clientRef: "ada" },
    }));
    const ada = store.contacts!.find((row) => row.id === "ada")!;
    expect(ada.email_status).toBe("bounced");
    expect(store.enrollments!.find((row) => row.id === "e-mail")!.status).toBe("stopped");
  });

  it("other replies go to the owner to decide", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "other", confidence: 0.9 });
    await receive(harness, mail({ snippet: "Please talk to my colleague Joe" }));
    expect(store.enrollments!.find((row) => row.id === "e-mail")!.status).toBe("running");
    const [issue] = await issues(harness);
    expect(issue!.title).toBe("Check reply from Ada Lovelace: Re: Hi Ada");
  });

  it("below the update threshold nothing changes and the owner decides", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "unsubscribe", confidence: 0.55 });
    await receive(harness, mail());
    expect(store.enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "running")).toBe(true);
    expect(store.contacts!.find((row) => row.id === "ada")!.email_status).toBe("ok");
    const [issue] = await issues(harness);
    expect(issue!.description).toMatch(/only 55% sure/);
    expect(store.decisions![0]!.acted).toBe(false);
  });

  it("without Jev it logs the email and opens an issue for the owner", async () => {
    const { harness, store } = await bootWithEnrollments(undefined, { jev: false });
    await receive(harness, mail());
    expect(jev.fetchMock).not.toHaveBeenCalled();
    expect(store.activities!.some((row) => row.kind === "email_received")).toBe(true);
    expect(store.enrollments!.every((row) => row.status === "running")).toBe(true);
    const [issue] = await issues(harness);
    expect(issue!.description).toMatch(/Jev is not set up/);
    expect(issue!.assigneeAgentId).toBe("agent-ada");
  });

  it("handles a repeated delivery once", async () => {
    const { harness, store } = await bootWithEnrollments({ choice: "interested", confidence: 0.9 });
    await receive(harness, mail());
    await receive(harness, mail());
    expect(jev.fetchMock).toHaveBeenCalledTimes(1);
    expect(store.activities!.filter((row) => row.kind === "email_received")).toHaveLength(1);
    expect(await issues(harness)).toHaveLength(1);
    expect(store.inbox).toHaveLength(1);
  });

  it("logs mail from a contact without a running sequence but does not classify it", async () => {
    jev = stubJev({ reply: { choice: "interested", confidence: 0.9 } });
    const { harness, store } = await boot();
    await receive(harness, mail({ from: { email: "bob@beta.test" } }));
    expect(store.activities!.filter((row) => row.kind === "email_received").map((row) => row.record_id)).toEqual(["bob"]);
    expect(jev.fetchMock).not.toHaveBeenCalled();
  });

  it("ignores senders the CRM does not know", async () => {
    jev = stubJev({ reply: { choice: "interested", confidence: 0.9 } });
    const { harness, store } = await boot();
    await receive(harness, mail({ from: { email: "stranger@nowhere.test" } }));
    expect(store.activities!.filter((row) => row.kind === "email_received")).toHaveLength(0);
    expect(store.inbox![0]!.result).toEqual({ matched: false });
  });
});

describe("lead scoring", () => {
  it("scores fit, intent and urgency in one call and stores them", async () => {
    const jev = stubJev({ scores: { fit: 2.6, intent: 2.1, urgency: 0.9, confidence: 0.74 } });
    const { harness, store } = await boot();
    const result = await harness.performAction<Record<string, any>>("crm.score-contact", { contactId: "ada" }, { companyId: CO, actor: BOARD });
    expect(result.total).toBeGreaterThan(0);
    expect(result.jev).toMatchObject({ fit: 2.6, intent: 2.1, urgency: 0.9, confidence: 0.74 });
    expect(jev.fetchMock).toHaveBeenCalledTimes(1);
    expect(jev.calls[0]!.questions).toEqual(["fit", "intent", "urgency"]);
    const state = jev.calls[0]!.state as Record<string, unknown>;
    expect(state).toMatchObject({ name: "Ada Lovelace", role: "Owner", company: "Acme Plumbing", lifecycle: "lead", tags: ["hot"] });
    expect(JSON.stringify(state)).not.toContain("@");
    const ada = store.contacts!.find((row) => row.id === "ada")!;
    expect(ada).toMatchObject({ lead_fit: 2.6, lead_intent: 2.1, lead_urgency: 0.9, lead_confidence: 0.74 });
    expect(ada.lead_scored_at).toBeTruthy();
    expect(store.decisions!.map((row) => row.question_key).sort()).toEqual(["fit", "intent", "urgency"]);
    expect(leadBand(result.jev)).toBe("hot");
    expect(leadLevelLabel("urgency", 0.9)).toBe("Later");
  });

  it("keeps the rule score when Jev is not set up", async () => {
    const jev = stubJev({});
    const { harness } = await boot({ jev: false });
    const result = await harness.performAction<Record<string, any>>("crm.score-contact", { contactId: "ada" }, { companyId: CO, actor: BOARD });
    expect(result.jev).toBeNull();
    expect(result.jevNote).toMatch(/not set up/);
    expect(jev.fetchMock).not.toHaveBeenCalled();
  });

  it("scores a new contact in the background", async () => {
    stubJev({ scores: { fit: 1, intent: 0.2, urgency: 0, confidence: 0.8 } });
    const { harness, store } = await boot();
    const created = await harness.performAction<{ id: string }>("crm.create-contact", { name: "Nia New" }, { companyId: CO, actor: BOARD });
    await settleLeadScores();
    expect(store.contacts!.find((row) => row.id === created.id)).toMatchObject({ lead_fit: 1, lead_intent: 0.2, lead_urgency: 0 });
  });

  it("caps recent activity at 800 characters", () => {
    const state = leadScoreState({ name: "A", role: null, company: null, lifecycle: "lead", tags: [], activities: ["a".repeat(700), "b".repeat(700), "c".repeat(700), "d"] });
    const recent = state.recentActivity as string[];
    expect(recent.length).toBeLessThanOrEqual(3);
    expect(recent.join("").length).toBeLessThanOrEqual(800);
  });
});

describe("sequence email", () => {
  beforeEach(() => {
    stubJev({});
  });

  it("personalises tokens with fallbacks and leaves unknown ones", () => {
    expect(personalize("Hi {{first_name}} at {{company}}", { name: "Ada Lovelace", company: "Acme" })).toBe("Hi Ada at Acme");
    expect(personalize("Hello {{ first_name | there }}, {{last_name}}", { name: "" })).toBe("Hello there, ");
    expect(personalize("{{unknown}} {{name}}", { name: "Bo" })).toBe("{{unknown}} Bo");
    expect(textToHtml("Hi <you>\n\nLine one\nline two")).toBe("<p>Hi &lt;you&gt;</p>\n<p>Line one<br>line two</p>");
    expect(sequenceMailKey("e1", 2)).toBe("crm:seq:e1:2");
  });

  it("the first switch to email opens an approval issue and nothing is sent before a board user approves", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-intro", "ada", { next_due_at: PAST })];
    const { harness, emit } = await boot({ store });
    const result = await harness.performAction<Record<string, any>>("crm.set-sequence-delivery", { sequenceId: "seq-intro", delivery: "email" }, { companyId: CO, actor: BOARD });
    expect(result).toMatchObject({ delivery: "email", emailApproved: false });
    const approval = (await issues(harness)).find((issue) => issue.id === result.approvalIssueId)!;
    expect(approval.title).toBe("Approve email sending: Intro");
    expect(store.sequences!.find((row) => row.id === "seq-intro")).toMatchObject({ delivery: "email", email_approval_issue_id: approval.id });

    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(0);
    expect(emit).not.toHaveBeenCalledWith("mail.send.requested", expect.anything(), expect.anything());
    expect((await issues(harness)).length).toBe(1);

    // An agent closing the approval issue does not count.
    harness.seed({ issues: [{ ...approval, status: "done" }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: approval.id, actorType: "agent", actorId: "agent-x" });
    expect(store.sequences!.find((row) => row.id === "seq-intro")!.email_approved_at).toBeNull();

    await harness.emit("issue.updated", {}, { companyId: CO, entityId: approval.id, actorType: "user", actorId: "user-peet" });
    expect(store.sequences!.find((row) => row.id === "seq-intro")).toMatchObject({ email_approved_by: "user:user-peet" });
    expect(store.sequences!.find((row) => row.id === "seq-intro")!.email_approved_at).toBeTruthy();

    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(1);
  });

  it("enqueues a personalised mail.send.requested once per step", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(1);
    const row = store.outbox![0]!;
    expect(row).toMatchObject({ key: "crm:seq:e1:1", company_id: CO, event: "mail.send.requested", status: "pending" });
    expect(row.payload).toMatchObject({
      key: "crm:seq:e1:1",
      to: [{ email: "Ada@Acme.test", name: "Ada Lovelace" }],
      subject: "Hi Ada",
      text: "Hello Ada,\n\nWe build websites for Acme Plumbing.",
      context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1", clientKind: "contact", clientRef: "ada" },
    });
    expect(row.payload.html).toBe("<p>Hello Ada,</p>\n<p>We build websites for Acme Plumbing.</p>");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("mail.send.requested", CO, expect.objectContaining({ key: "crm:seq:e1:1" }));
    expect(store.enrollments![0]!.sending_key).toBe("crm:seq:e1:1");
    expect(await issues(harness)).toHaveLength(0);
  });

  it("a sent result advances the enrollment once and keeps the thread", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    const result = { key: "crm:seq:e1:1", status: "sent", messageId: "gm-1", threadId: "th-1", sentAt: "2026-09-26T10:00:00Z", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" } };
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    const e1 = store.enrollments![0]!;
    expect(e1).toMatchObject({ status: "running", step_position: 2, sending_key: null, mail_thread_id: "th-1", mail_last_message_id: "gm-1" });
    expect(store.outbox![0]).toMatchObject({ status: "done" });
    expect(store.activities!.filter((row) => row.kind === "email_sent")).toHaveLength(1);

    // The next step replies in the same thread.
    e1.next_due_at = PAST;
    await harness.runJob("open-due-steps");
    expect(store.outbox![1]!.payload).toMatchObject({ key: "crm:seq:e1:2", threadId: "th-1", inReplyToMessageId: "gm-1", subject: "Following up" });
  });

  it("re-uses the Mailbox's stored answer when the same step is requested again", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    store.outbox = [{
      key: "crm:seq:e1:1", company_id: CO, event: "mail.send.requested", payload: { subject: "Hi Ada" }, status: "done", attempts: 1, next_attempt_at: PAST, last_error: null,
      result: { key: "crm:seq:e1:1", status: "sent", messageId: "gm-9", threadId: "th-9", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" } },
    }];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(emit).not.toHaveBeenCalled();
    expect(store.enrollments![0]).toMatchObject({ step_position: 2, sending_key: null, mail_thread_id: "th-9" });
  });

  it("a send result after a reply stopped the sequence does not restart it", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    store.enrollments![0]!.status = "stopped";
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "crm:seq:e1:1", status: "sent", messageId: "gm-1", threadId: "th-1", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" },
    }, { companyId: CO });
    expect(store.enrollments![0]).toMatchObject({ status: "stopped", step_position: 1, sending_key: null });
  });

  it("ignores results for other plugins", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, { key: "crm:seq:e1:1", status: "sent", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" } }, { companyId: CO });
    expect(store.enrollments![0]!.step_position).toBe(1);
    expect(store.outbox![0]!.status).toBe("pending");
  });

  it("a permanent failure opens an issue; marking it done moves the contact on", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "crm:seq:e1:1", status: "failed", permanent: true, error: "Invalid address", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" },
    }, { companyId: CO });
    expect(store.outbox![0]).toMatchObject({ status: "failed", last_error: "Invalid address" });
    const [issue] = await issues(harness);
    expect(issue).toMatchObject({ title: "Email not sent: Hi {{first_name}}: Ada Lovelace", assigneeAgentId: "agent-ada" });
    expect(issue!.description).toContain("Invalid address");
    expect(store.enrollments![0]).toMatchObject({ open_issue_id: issue!.id, sending_key: null, step_position: 1 });

    harness.seed({ issues: [{ ...issue!, status: "done" }] });
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: issue!.id, actorType: "user", actorId: "user-peet" });
    expect(store.enrollments![0]).toMatchObject({ step_position: 2, open_issue_id: null });
  });

  it("a transient failure stays pending for the redeliver job", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { next_due_at: PAST })];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "crm:seq:e1:1", status: "failed", permanent: false, error: "Rate limited", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" },
    }, { companyId: CO });
    expect(store.outbox![0]).toMatchObject({ status: "pending", last_error: "Rate limited" });
    expect(await issues(harness)).toHaveLength(0);

    store.outbox![0]!.next_attempt_at = PAST;
    await harness.runJob("redeliver-mail");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(store.outbox![0]!.attempts).toBe(2);
  });

  it("hands a send the outbox gave up on to a person", async () => {
    const store = seed();
    store.enrollments = [enrollment("e1", "seq-mail", "ada", { sending_key: "crm:seq:e1:1" })];
    store.outbox = [{ key: "crm:seq:e1:1", company_id: CO, event: "mail.send.requested", payload: {}, status: "failed", attempts: 21, next_attempt_at: PAST, last_error: "No answer from the receiving plugin", result: null }];
    const { harness } = await boot({ store });
    await harness.runJob("redeliver-mail");
    const [issue] = await issues(harness);
    expect(issue!.title).toMatch(/^Email not sent/);
    expect(store.enrollments![0]).toMatchObject({ sending_key: null, open_issue_id: issue!.id });
  });

  it("never emails unsubscribed contacts and opens an issue when there is no address", async () => {
    const store = seed();
    store.enrollments = [
      enrollment("e-uma", "seq-mail", "uma", { next_due_at: PAST }),
      enrollment("e-carl", "seq-mail", "carl", { next_due_at: PAST }),
    ];
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(0);
    expect(store.enrollments!.find((row) => row.id === "e-uma")!.status).toBe("stopped");
    const [issue] = await issues(harness);
    expect(issue!.description).toMatch(/no email address/);
    expect(store.enrollments!.find((row) => row.id === "e-carl")!.open_issue_id).toBe(issue!.id);
  });

  it("refuses to enroll an unsubscribed contact in an email sequence", async () => {
    const { harness } = await boot();
    await expect(
      harness.performAction("crm.enroll", { sequenceId: "seq-mail", contactId: "uma" }, { companyId: CO, actor: BOARD }),
    ).rejects.toThrow(/unsubscribed/);
  });

  it("the tool switches delivery back to issues and keeps the approval", async () => {
    const { harness, store } = await boot();
    const result = await harness.executeTool<{ data: Record<string, unknown> }>("set-sequence-delivery", { sequenceId: "seq-mail", delivery: "issue" }, { companyId: CO, agentId: "agent-1" });
    expect(result.data).toMatchObject({ delivery: "issue", emailApproved: true });
    expect(store.sequences!.find((row) => row.id === "seq-mail")!.delivery).toBe("issue");
  });
});
