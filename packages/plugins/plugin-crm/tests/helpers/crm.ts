/**
 * A booted CRM worker on the test harness with the fake namespace, shared by
 * the 0.4.0 specs (lookup, hand-offs, the Account Manager).
 */
import { vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { RolesPayload } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { NAMESPACE } from "../../src/namespace.js";
import { clearJevCache } from "../../src/jev.js";
import { createFakeDb, type Route, type Row, type Store } from "./fake-db.js";

export const CO = "co-1";
export const BOARD = { type: "user" as const, userId: "local-board" };
export const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const mine = (rows: Row[] | undefined, p: unknown[]) => (rows ?? []).filter((row) => row.company_id === p[0]);

export const ROUTES: Route[] = [
  // Lists that also include records shared by partner grants: company scope is enough here.
  [/OR id IN \(/, (p, s, sql) => mine(s[/FROM \S+\.(\w+)/.exec(sql)![1]!], p)],
  [/make_interval\(secs/, () => []],
  [/make_interval\(hours => \$2::int\)/, (p, s) => mine(s.handoffs, p).filter((row) => Date.parse(String(row.created_at)) >= NOW - Number(p[1]) * 3_600_000)],
  [/SELECT DISTINCT company_id FROM \S+\.handoffs/, (p, s) => [...new Set((s.handoffs ?? []).filter((row) => Date.parse(String(row.created_at)) >= NOW - Number(p[0]) * 3_600_000).map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/SELECT DISTINCT company_id FROM \S+\.held_leads/, (_p, s) => [...new Set((s.held_leads ?? []).filter((row) => !row.processed_at).map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/min\(held_at\)::text AS oldest/, (p, s) => {
    const rows = mine(s.held_leads, p).filter((row) => !row.processed_at);
    return [{ count: String(rows.length), oldest: rows.map((row) => row.held_at).sort()[0] ?? null }];
  }],
  [/record_grants/, () => []],
  [/\bUNION\b/, (_p, s) => [...new Set([...(s.companies ?? []), ...(s.contacts ?? [])].map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/jsonb_array_elements_text\(c\.emails\)/, (p, s) =>
    mine(s.contacts, p)
      .filter((row) => (row.emails as string[]).some((email) => email.trim().toLowerCase() === p[1]))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))],
  [/jsonb_array_elements_text\(c\.phones\)/, (p, s) =>
    mine(s.contacts, p)
      .filter((row) => (row.phones as string[]).some((phone) => phone.replace(/\D/g, "").slice(-9) === p[1]))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))],
  [/regexp_replace\(split_part/, (p, s) => {
    const bare = (d: unknown) => String(d ?? "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split("/")[0]!.replace(/^www\./, "");
    const byDomain = (row: Row) => p[1] != null && bare(row.domain) === p[1];
    return mine(s.companies, p)
      .filter((row) => byDomain(row) || String(row.name).trim().toLowerCase() === p[2])
      .sort((a, b) => Number(byDomain(b)) - Number(byDomain(a)) || String(a.created_at).localeCompare(String(b.created_at)));
  }],
  [/custom -> 'handles' @>/, (p, s) => {
    const [key] = JSON.parse(String(p[1])) as string[];
    return mine(s.contacts, p).filter((row) => Array.isArray(row.custom?.handles) && row.custom.handles.includes(key));
  }],
  [/contact_companies l/, (p, s) =>
    (s.contact_companies ?? []).filter((link) => link.contact_id === p[0]).map((link) => ({ account_id: link.account_id, role_label: link.role_label, name: (s.companies ?? []).find((a) => a.id === link.account_id)?.name ?? "" }))],
  [/count\(\*\) AS count, max\(created_at\)/, () => [{ count: 0, last_at: null }]],
  [/GROUP BY sequence_id/, (p, s) => {
    const by = new Map<string, number>();
    for (const row of mine(s.enrollments, p).filter((e) => e.status === "running")) by.set(row.sequence_id, (by.get(row.sequence_id) ?? 0) + 1);
    return [...by.entries()].map(([sequence_id, running]) => ({ sequence_id, running: String(running) }));
  }],
];

export function company(id: string, name: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name, domain: null, lifecycle: "lead", currency: "ZAR", custom: {}, human_owned_fields: [],
    owner_user_id: null, assignee_agent_id: null, tags: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...extra,
  };
}

export function contact(id: string, name: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name, emails: [], phones: [], lifecycle: "lead", custom: {}, human_owned_fields: [],
    owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null,
    email_status: "ok", lead_fit: null, lead_intent: null, lead_urgency: null, lead_confidence: null, lead_scored_at: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...extra,
  };
}

export function deal(id: string, title: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, pipeline_id: "p1", stage_id: "st-open", account_id: null, contact_id: null, title, amount_minor: 100_000, currency: "ZAR",
    owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null, custom: {}, human_owned_fields: [],
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
  };
}

export function seed(): Store {
  return {
    companies: [
      company("acme", "Acme Plumbing", { domain: "acme.co.za", lifecycle: "prospect", tags: ["retainer"] }),
      company("globex", "Globex", { domain: "globex.test" }),
      { ...company("foreign", "Foreign Co"), company_id: "co-2" },
    ],
    contacts: [
      contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"], phones: ["+27 82 123 4567"], tags: ["decision-maker"] }),
      contact("grace", "Grace Hopper", { emails: ["grace@globex.test"] }),
      contact("solo", "Sipho Solo", { emails: ["sipho@solo.test"], lifecycle: "customer" }),
    ],
    contact_companies: [
      { id: "l1", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "owner", created_at: "2026-01-01T00:00:00Z" },
      { id: "l2", company_id: CO, contact_id: "grace", account_id: "globex", role_label: "buyer", created_at: "2026-01-01T00:00:00Z" },
    ],
    pipelines: [{ id: "p1", company_id: CO, name: "Sales", created_at: "2026-01-01T00:00:00Z" }],
    pipeline_stages: [
      { id: "st-open", company_id: CO, pipeline_id: "p1", name: "Discovery", kind: "open", position: 0 },
      { id: "st-prop", company_id: CO, pipeline_id: "p1", name: "Proposal", kind: "open", position: 1 },
      { id: "st-won", company_id: CO, pipeline_id: "p1", name: "Won", kind: "won", position: 3 },
      { id: "st-lost", company_id: CO, pipeline_id: "p1", name: "Lost", kind: "lost", position: 4 },
    ],
    deals: [
      deal("d-acme", "Acme SEO retainer", { account_id: "acme", contact_id: "ada", stage_id: "st-prop" }),
      deal("d-solo", "Solo website", { contact_id: "solo", amount_minor: 1_500_000 }),
    ],
    sequences: [
      { id: "seq-intro", company_id: CO, name: "Intro", completion_mode: "manual", delivery: "issue", email_approval_issue_id: null, email_approved_at: null, email_approved_by: null },
      { id: "seq-mail", company_id: CO, name: "Cold email", completion_mode: "sent", delivery: "email", email_approval_issue_id: null, email_approved_at: "2026-09-01T00:00:00Z", email_approved_by: "user:local-board" },
    ],
    sequence_steps: [
      { id: "s1", company_id: CO, sequence_id: "seq-intro", position: 1, delay_minutes: 0, title: "Say hello", body: "Call {{first_name|there}}" },
      { id: "s2", company_id: CO, sequence_id: "seq-intro", position: 2, delay_minutes: 1440, title: "Follow up", body: "Email them" },
      { id: "s3", company_id: CO, sequence_id: "seq-mail", position: 1, delay_minutes: 0, title: "Hi {{first_name}}", body: "Hello" },
    ],
    enrollments: [],
    activities: [],
    facts: [],
    record_grants: [],
    outbox: [],
    inbox: [],
    decisions: [],
    handoffs: [],
    held_leads: [],
    client_profiles: [],
    client_leads: [],
    // The agent's run is on behalf of the owner (the host resolves a responsible user for every run).
    heartbeat_runs: [{ id: "run-1", company_id: CO, agent_id: "agent-1", responsible_user_id: "local-board" }],
  };
}

/** `routes` are tried before the shared ones (e.g. the Cockpit's aggregate queries). */
export async function boot(options: { store?: Store; config?: Record<string, unknown>; routes?: Route[] } = {}) {
  clearJevCache();
  const store = options.store ?? seed();
  const harness = createTestHarness({ manifest, config: options.config ?? { timezone: "Africa/Johannesburg" } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, {
    namespace: NAMESPACE,
    coreReadTables: ["heartbeat_runs", "issues"],
    routes: [...(options.routes ?? []), ...ROUTES],
    defaults: {
      outbox: { status: "pending", attempts: 0, last_error: null, result: null },
      handoffs: { created_at: new Date(NOW).toISOString() },
      activities: { created_at: new Date(NOW).toISOString() },
      contacts: { email_status: "ok", created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() },
    },
  });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, db, emit };
}

export type Harness = Awaited<ReturnType<typeof boot>>["harness"];

export async function setRoles(harness: Harness, roles: Partial<RolesPayload>) {
  await harness.emit("plugin.partnersinbiz.cockpit.roles.updated", {
    companyId: CO, operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: new Date().toISOString(), ...roles,
  }, { companyId: CO });
}

/** Runs an agent tool; returns the result's data (throws on a tool error). */
export async function tool<T = Record<string, any>>(harness: Harness, name: string, params: Record<string, unknown>, agentId = "agent-1"): Promise<T> {
  const result = await harness.executeTool<{ data?: T; error?: string; content?: string }>(name, params, { companyId: CO, agentId, runId: "run-1" });
  if (result.error) throw new Error(result.error);
  return result.data as T;
}

export async function toolRaw(harness: Harness, name: string, params: Record<string, unknown>, agentId = "agent-1") {
  return harness.executeTool<{ data?: Record<string, any>; error?: string; content?: string }>(name, params, { companyId: CO, agentId, runId: "run-1" });
}

export const crmIssues = (harness: Harness) => harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm" });
