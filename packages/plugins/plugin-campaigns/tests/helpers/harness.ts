/**
 * Shared fixtures for worker-level tests: a harness wired to the guarded
 * fake db, seed rows, and the routes for the statements the generic fake db
 * cannot run (joins, EXISTS, counts).
 */
import { vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { NAMESPACE } from "../../src/namespace.js";
import { clearJevCache } from "../../src/jev.js";
import { clearLinkCache } from "../../src/links.js";
import { clearMessagingCache } from "../../src/messaging.js";
import { clearProjectCache } from "../../src/projects.js";
import { createFakeDb, type Route, type Row, type Store } from "./fake-db.js";

export const CO = "co-1";
/** The plugin's public UI path, as the Campaigns page reports it. Unsubscribe links are built on it. */
export const UI_BASE = "/_plugins/11111111-1111-4111-8111-111111111111/ui/";
export const PUBLIC_URL = "https://paperclip.test";
export const PAST = "2026-09-01T08:00:00.000Z";
export const FUTURE = "2099-01-01T08:00:00.000Z";

/** The approval and step-issue sweeps read `public.issues`; tests keep those rows in `store.issues`. */
export const SWEEP_ROUTES: Route[] = [
  [/JOIN public\.issues i ON i\.id::text = c\.approval_issue_id\s+WHERE c\.status = 'draft' AND i\.status = 'done'/, (_p, s) =>
    (s.campaigns ?? [])
      .filter((c) => c.status === "draft" && c.approval_issue_id)
      .map((c) => ({ c, i: (s.issues ?? []).find((i) => i.id === c.approval_issue_id) }))
      .filter(({ i }) => i?.status === "done")
      .map(({ c, i }) => ({ ...c, issue_status: i!.status, issue_agent_id: i!.assignee_agent_id ?? null, issue_user_id: i!.assignee_user_id ?? null }))],
  [/JOIN public\.issues i ON i\.id::text = e\.open_issue_id/, (_p, s) =>
    (s.campaign_enrollments ?? [])
      .filter((e) => e.status === "running" && e.open_issue_id)
      .map((e) => ({ e, i: (s.issues ?? []).find((i) => i.id === e.open_issue_id) }))
      .filter(({ i }) => i && ["done", "cancelled"].includes(i.status))
      .map(({ e, i }) => ({ ...e, issue_status: i!.status }))],
];

const DAY = 86_400_000;
const olderThan = (at: unknown, ms: number) => Boolean(at) && Date.parse(String(at)) < Date.now() - ms;

/** The Cockpit's flow queries (`campaignFlows`), emulated on the store (the SQL itself runs in flows.pg.spec.ts). */
export const FLOW_ROUTES: Route[] = [
  [/AS drafts,/, (p, s) => {
    const mine = (s.campaigns ?? []).filter((c) => c.company_id === p[0]);
    const issueOf = (c: Row) => (s.issues ?? []).find((i) => i.id === c.approval_issue_id);
    const drafts = mine.filter((c) => c.status === "draft");
    const open = drafts.filter((c) => issueOf(c) && issueOf(c)!.status !== "cancelled").length;
    return [{ drafts: String(drafts.length - open), approval: String(open), active: String(mine.filter((c) => c.status === "active").length) }];
  }],
  [/LEFT JOIN \S+\.outbox o ON o\.key = 'campaigns:step:'/, (p, s) => {
    const active = new Set((s.campaigns ?? []).filter((c) => c.status === "active").map((c) => c.id));
    const groups = new Map<string, { failed: number; waiting: number; oldest: string | null }>();
    for (const e of (s.campaign_enrollments ?? []).filter((row) => row.company_id === p[0] && row.status === "running" && active.has(row.campaign_id))) {
      const out = (s.outbox ?? []).find((o) => o.key === `campaigns:step:${e.id}:${e.step_position}`);
      const failed = out?.status === "failed";
      const waiting = !failed && olderThan(e.next_due_at, DAY);
      const g = groups.get(e.campaign_id) ?? { failed: 0, waiting: 0, oldest: null };
      if (failed) g.failed += 1;
      if (waiting) g.waiting += 1;
      if ((failed || waiting) && (!g.oldest || String(e.next_due_at) < g.oldest)) g.oldest = String(e.next_due_at);
      groups.set(e.campaign_id, g);
    }
    return [...groups].map(([campaign_id, g]) => ({ campaign_id, failed: String(g.failed), waiting: String(g.waiting), oldest: g.oldest }));
  }],
  [/FROM public\.issues i\s+WHERE i\.company_id = \$1::uuid/, (p, s) => {
    const prefixes = [String(p[2]).replace(/%$/, ""), String(p[3]).replace(/%$/, "")];
    const open = (s.issues ?? []).filter((i) => (i.company_id ?? p[0]) === p[0] && (i.origin_kind ?? p[1]) === p[1] && prefixes.some((prefix) => String(i.origin_id ?? "").startsWith(prefix)) && !["done", "cancelled"].includes(i.status));
    const oldest = open.map((i) => String(i.created_at)).sort()[0] ?? null;
    return [{ open: String(open.length), stuck: String(open.filter((i) => olderThan(i.created_at, 2 * DAY)).length), oldest }];
  }],
];

export const ROUTES: Route[] = [
  ...FLOW_ROUTES,
  [/unnest\(emails\)/, (p, s) =>
    (s.crm_contacts ?? []).filter((row) => row.company_id === p[0] && !row.deleted && (row.emails as string[]).some((email) => email.toLowerCase() === p[1]))],
  // listCampaigns for one client (kit clientWhere uses COALESCE on the kind).
  [/FROM \S+\.campaigns\s+WHERE company_id = \$1 AND client_ref = \$3 AND COALESCE\(client_kind/, (p, s) =>
    (s.campaigns ?? []).filter((c) => c.company_id === p[0] && c.client_ref === p[2] && (c.client_kind ?? "company") === p[1])],
  // crmContactsByPhone: projected contacts whose phone ends in the same nine digits.
  [/right\(regexp_replace/, (p, s) =>
    (s.crm_contacts ?? []).filter((row) => row.company_id === p[0] && !row.deleted && ((row.phones ?? []) as string[]).some((phone) => phone.replace(/\D/g, "").slice(-9) === p[1]))],
  [/campaign_id IN \(SELECT id FROM/, (_p, s) => {
    const active = new Set((s.campaigns ?? []).filter((c) => c.status === "active").map((c) => c.id));
    return (s.campaign_enrollments ?? []).filter((e) => e.status === "running" && e.open_issue_id == null && e.sending_key == null && e.next_due_at && Date.parse(e.next_due_at) <= Date.now() && active.has(e.campaign_id));
  }],
  [/JOIN \S+\.outbox o/, (_p, s) =>
    (s.campaign_enrollments ?? [])
      .filter((e) => e.status === "running" && (s.outbox ?? []).some((o) => o.key === e.sending_key && o.status === "failed"))
      .map((e) => ({ ...e, last_error: (s.outbox ?? []).find((o) => o.key === e.sending_key)?.last_error ?? null }))],
  [/SELECT count\(\*\)::text AS n FROM \S+\.suppressions/, (p, s) => [{ n: String((s.suppressions ?? []).filter((row) => row.company_id === p[0]).length) }]],
  // campaignStats: enrollments of one campaign per status.
  [/SELECT status, count\(\*\) AS count\s+FROM \S+\.campaign_enrollments\s+WHERE campaign_id = \$1\s+GROUP BY status/, (p, s) => {
    const counts = new Map<string, number>();
    for (const e of (s.campaign_enrollments ?? []).filter((row) => row.campaign_id === p[0])) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    return [...counts].map(([status, count]) => ({ status, count }));
  }],
  // enrollmentViews: a campaign's enrollments with the contact's name, running first, soonest due first.
  [/LEFT JOIN \S+\.crm_contacts c ON c\.id = e\.contact_id/, (p, s) =>
    (s.campaign_enrollments ?? [])
      .filter((e) => e.campaign_id === p[0])
      .map((e): Row => ({ ...e, name: (s.crm_contacts ?? []).find((c) => c.id === e.contact_id)?.name ?? null }))
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || String(a.next_due_at ?? "9").localeCompare(String(b.next_due_at ?? "9")))],
  ...SWEEP_ROUTES,
];

export function contact(id: string, name: string, emails: string[], extra: Row = {}): Row {
  return { id, company_id: CO, name, emails, phones: [], lifecycle: "lead", tags: [], account_ids: [], updated_at: "2026-01-01T00:00:00Z", deleted: false, ...extra };
}

export function campaign(id: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name: id, description: "", status: "active", from_name: "", from_local: "campaigns", reply_to: null, audience_tags: [],
    start_at: null, end_at: null, approval_issue_id: null, winner_variant: null, client_kind: null, client_ref: null, client_name: null,
    audience_mode: "tags", delivery: "email", owner_user_id: null, owner_agent_id: "agent-camp", approved_by_user_id: null, launched_at: null, launch_error: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
  };
}

export function step(campaignId: string, position: number, variant: "a" | "b", subject: string, body: string, delayDays = 0): Row {
  return { id: `${campaignId}-${position}${variant}`, company_id: CO, campaign_id: campaignId, position, delay_days: delayDays, subject, body, html_body: null, variant };
}

export function enrollment(id: string, campaignId: string, contactId: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, campaign_id: campaignId, contact_id: contactId, status: "running", step_position: 1, variant: "a",
    next_due_at: FUTURE, open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
  };
}

export function seed(): Store {
  return {
    crm_companies: [{ id: "acme", company_id: CO, name: "Acme Plumbing", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: false }],
    crm_contacts: [
      contact("ada", "Ada Lovelace", ["ada@acme.test"], { account_ids: ["acme"], tags: ["vip"] }),
      contact("bob", "Bob Builder", ["bob@beta.test"], { tags: ["vip"] }),
      contact("carl", "Carl NoMail", []),
      contact("uma", "Uma Gone", ["uma@x.test"], { tags: ["vip"] }),
    ],
    campaigns: [],
    campaign_steps: [],
    campaign_enrollments: [],
    campaign_step_events: [],
    suppressions: [],
    outbox: [],
    inbox: [],
    decisions: [],
    issues: [],
  };
}

export interface BootOptions {
  store?: Store;
  jev?: boolean;
  config?: Record<string, unknown>;
  /** Agents in the company (default: the campaign creator `agent-camp`, idle). */
  agents?: Array<{ id: string; status: string }>;
}

export async function boot(options: BootOptions = {}) {
  clearJevCache();
  clearLinkCache();
  clearMessagingCache();
  clearProjectCache();
  const store = options.store ?? seed();
  const config = options.config ?? { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, ...(options.jev ? { jev: { apiKey: "test-key" } } : {}) };
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never],
    agents: (options.agents ?? [{ id: "agent-camp", status: "idle" }]).map((agent) => ({ id: agent.id, companyId: CO, name: agent.id, status: agent.status }) as never),
  });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: ROUTES,
    defaults: {
      outbox: { status: "pending", attempts: 0, last_error: null, result: null },
      campaign_step_events: { occurred_at: new Date().toISOString() },
      suppressions: { scope: "marketing", source: "partnersinbiz.campaigns", created_at: new Date().toISOString() },
    },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  await rememberPluginUiBase(harness.ctx, UI_BASE);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  const comments = vi.spyOn(harness.ctx.issues, "createComment");
  return { harness, store, emit, comments, db };
}

export type Harness = Awaited<ReturnType<typeof boot>>["harness"];

/** Seeds an issue in the host (for ctx.issues) and in `store.issues` (for the sweep joins). */
export function seedIssue(harness: Harness, store: Store, issue: { id: string; status: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; description?: string; title?: string }): void {
  harness.seed({ issues: [{ companyId: CO, title: issue.title ?? "Issue", description: issue.description ?? null, assigneeAgentId: issue.assigneeAgentId ?? null, assigneeUserId: issue.assigneeUserId ?? null, ...issue } as never] });
  (store.issues ??= []).push({ id: issue.id, status: issue.status, assignee_agent_id: issue.assigneeAgentId ?? null, assignee_user_id: issue.assigneeUserId ?? null, created_at: new Date().toISOString() });
}

/** Changes an issue's status in both places, like a person or agent would. */
export async function setIssueStatus(harness: Harness, store: Store, issueId: string, status: string, patch: Record<string, unknown> = {}): Promise<void> {
  await harness.ctx.issues.update(issueId, { status, ...patch } as never, CO);
  const row = (store.issues ?? []).find((i) => i.id === issueId);
  if (row) {
    row.status = status;
    if ("assigneeAgentId" in patch) row.assignee_agent_id = patch.assigneeAgentId;
    if ("assigneeUserId" in patch) row.assignee_user_id = patch.assigneeUserId;
  }
}

/** Emits `issue.updated` as the host would after an issue change. */
export async function issueUpdated(harness: Harness, issueId: string, actor: { type: "user" | "agent" | "plugin" | "system"; id: string }): Promise<void> {
  await harness.emit("issue.updated", { status: "done" }, { companyId: CO, entityId: issueId, entityType: "issue", actorType: actor.type, actorId: actor.id });
}

/** The Cockpit's roles broadcast (owner, team). */
export async function setRoles(harness: Harness, roles: Record<string, unknown>): Promise<void> {
  await harness.emit("plugin.partnersinbiz.cockpit.roles.updated", {
    companyId: CO, operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: new Date().toISOString(), ...roles,
  }, { companyId: CO });
}
