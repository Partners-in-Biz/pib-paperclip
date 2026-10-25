import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { clearJevCache } from "../src/jev.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";
import { SWEEP_ROUTES } from "./helpers/harness.js";

const CO = "co-1";
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
  ...SWEEP_ROUTES,
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
    ],
    campaigns: [campaign("camp-mail")],
    campaign_steps: [
      step("camp-mail", 1, "a", "Hi {{first_name}}", "Hello {{first_name}} at {{company}}"),
      step("camp-mail", 1, "b", "Quick question, {{first_name}}", "Short B body"),
      step("camp-mail", 2, "a", "Following up", "Any thoughts?", 3),
    ],
    campaign_enrollments: [],
    campaign_step_events: [],
    suppressions: [],
    outbox: [],
    inbox: [],
    decisions: [],
  };
}

function stubJev() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function boot(options: { store?: Store } = {}) {
  clearJevCache();
  const store = options.store ?? seed();
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", jev: { apiKey: "test-key" } } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never], agents: [{ id: "agent-camp", companyId: CO, name: "Campaigner", status: "idle" } as never] });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: ROUTES,
    defaults: { outbox: { status: "pending", attempts: 0, last_error: null, result: null }, campaign_step_events: { occurred_at: new Date().toISOString() } },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  return { harness, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applySendResult returns while saveSendRecord never resolves", () => {
  it("applySendResult returns promptly even when saveSendRecord never resolves", { timeout: 2000 }, async () => {
    stubJev();
    const store = seed();
    store.campaign_enrollments = [enrollment("e1", "camp-mail", "ada", { variant: "b", next_due_at: PAST })];
    const { harness } = await boot({ store });

    await harness.runJob("open-due-steps");
    expect(store.outbox![0]!.payload.subject).toBe("Quick question, Ada");

    const result = { key: "campaigns:step:e1:1", status: "sent", messageId: "gm-1", threadId: "th-1", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" } };

    // This should resolve immediately even though saveSendRecord internally waits for Drive;
    // Drive saves are not awaited in the job path.
    const start = Date.now();
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, result, { companyId: CO });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    const sends = store.campaign_step_events!.filter((row) => row.event_type === "sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ enrollment_id: "e1", step_position: 1, variant: "b" });
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2, variant: "b", sending_key: null });
  });
});
