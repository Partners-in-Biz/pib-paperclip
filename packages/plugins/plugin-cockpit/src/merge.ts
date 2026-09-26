/**
 * The Cockpit's pure logic, shared by the page and the worker (no node
 * imports): parsing snapshots, merging "waiting on you", KPI groups, health,
 * stale plugins, agent budget alerts, activity grouping and scorecards.
 */
import {
  worstHealth,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type HealthCheck,
  type HealthStatus,
  type QualityMetric,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit/cockpit";
import { MODULES, moduleOfPlugin, setupProgress, type ModuleKey, type SetupStatus } from "@partnersinbiz/pib-plugin-kit/setup";
import { BUDGET_ALERT_RATIO, PLUGIN_KEY, STALE_AFTER_MS } from "./constants.js";

export type { ActivityItem, CockpitKpi, CockpitSnapshot, HealthCheck, HealthStatus, QualityMetric, Tone, WaitingItem };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TONES: readonly Tone[] = ["ok", "warn", "bad", "neutral"];
const HEALTH: readonly HealthStatus[] = ["ok", "warn", "bad"];
const KPI_GROUPS: readonly CockpitKpi["group"][] = ["money", "pipeline", "marketing", "delivery", "people", "other"];
const WAITING_KINDS: readonly WaitingItem["kind"][] = ["money", "legal", "grant", "judgement", "review", "other"];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row)) : [];
}

function parseKpi(row: Record<string, unknown>): CockpitKpi | null {
  const key = str(row.key);
  const label = str(row.label);
  if (!key || !label) return null;
  return {
    key,
    label,
    value: str(row.value) ?? (num(row.value) != null ? String(row.value) : "—"),
    raw: num(row.raw),
    tone: TONES.includes(row.tone as Tone) ? (row.tone as Tone) : "neutral",
    delta: str(row.delta),
    href: str(row.href),
    group: KPI_GROUPS.includes(row.group as CockpitKpi["group"]) ? (row.group as CockpitKpi["group"]) : "other",
  };
}

function parseHealth(row: Record<string, unknown>): HealthCheck | null {
  const key = str(row.key);
  const title = str(row.title);
  if (!key || !title) return null;
  return {
    key,
    title,
    status: HEALTH.includes(row.status as HealthStatus) ? (row.status as HealthStatus) : "warn",
    detail: str(row.detail),
    href: str(row.href),
    fix: str(row.fix),
    since: isoOrNull(row.since),
  };
}

function parseWaiting(row: Record<string, unknown>): WaitingItem | null {
  const key = str(row.key);
  const title = str(row.title);
  if (!key || !title) return null;
  return {
    key,
    title,
    why: str(row.why) ?? "Needs a person.",
    href: str(row.href),
    issueId: str(row.issueId),
    kind: WAITING_KINDS.includes(row.kind as WaitingItem["kind"]) ? (row.kind as WaitingItem["kind"]) : "other",
    since: isoOrNull(row.since),
  };
}

function parseActivity(row: Record<string, unknown>): ActivityItem | null {
  const at = isoOrNull(row.at);
  const text = str(row.text);
  if (!at || !text) return null;
  return { at, text, href: str(row.href), agentId: str(row.agentId) };
}

function parseQuality(row: Record<string, unknown>): QualityMetric | null {
  const key = str(row.key);
  const label = str(row.label);
  if (!key || !label) return null;
  return {
    key,
    label,
    value: str(row.value) ?? (num(row.value) != null ? String(row.value) : "—"),
    raw: num(row.raw),
    tone: TONES.includes(row.tone as Tone) ? (row.tone as Tone) : "neutral",
    agentId: str(row.agentId),
  };
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

/**
 * A `CockpitSnapshot` from a route body or event payload (plain, or wrapped
 * in `{ data }` / `{ snapshot }`). The plugin comes from the caller (the
 * subscription or route that delivered it), so a payload cannot claim to be
 * another plugin. Null when it is not a snapshot.
 */
export function parseSnapshot(body: unknown, pluginKey: string): CockpitSnapshot | null {
  let root = body;
  for (let i = 0; i < 2; i += 1) {
    if (root && typeof root === "object" && !Array.isArray(root) && !("checkedAt" in root) && !("kpis" in root)) {
      const inner = (root as Record<string, unknown>).data ?? (root as Record<string, unknown>).snapshot;
      if (inner && typeof inner === "object") root = inner;
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const source = root as Record<string, unknown>;
  const lists = ["kpis", "health", "waiting", "activity", "quality"];
  if (!lists.some((key) => Array.isArray(source[key]))) return null;
  return {
    plugin: pluginKey,
    title: str(source.title) ?? pluginTitle(pluginKey),
    checkedAt: isoOrNull(source.checkedAt) ?? new Date().toISOString(),
    kpis: compact(records(source.kpis).map(parseKpi)),
    health: compact(records(source.health).map(parseHealth)),
    waiting: compact(records(source.waiting).map(parseWaiting)),
    activity: compact(records(source.activity).map(parseActivity))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 10),
    quality: compact(records(source.quality).map(parseQuality)),
  };
}

export function pluginTitle(pluginKey: string): string {
  if (pluginKey === PLUGIN_KEY) return "Cockpit";
  const module = moduleOfPlugin(pluginKey);
  if (module) return MODULES[module].title;
  const tail = pluginKey.split(".").pop() ?? pluginKey;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

// ---------------------------------------------------------------------------
// Module switches
// ---------------------------------------------------------------------------

/** False only when the company switched this plugin's module off (no choice saved = on). */
export function pluginEnabled(modules: Partial<Record<ModuleKey, boolean>> | null | undefined, pluginKey: string): boolean {
  const module = moduleOfPlugin(pluginKey);
  if (!module || !modules) return true;
  return modules[module] !== false;
}

export function enabledSnapshots(snapshots: CockpitSnapshot[], modules: Partial<Record<ModuleKey, boolean>> | null | undefined): CockpitSnapshot[] {
  return snapshots.filter((snapshot) => pluginEnabled(modules, snapshot.plugin));
}

// ---------------------------------------------------------------------------
// Waiting on you
// ---------------------------------------------------------------------------

export const KIND_RANK: Record<WaitingItem["kind"], number> = { money: 0, legal: 1, grant: 2, judgement: 3, review: 4, other: 5 };

export const KIND_LABEL: Record<WaitingItem["kind"], string> = {
  money: "Money",
  legal: "Legal",
  grant: "One-time grant",
  judgement: "Your call",
  review: "Review",
  other: "Other",
};

export interface WaitingEntry extends WaitingItem {
  /** Where it came from: a plugin key, or `host`. */
  source: string;
  sourceTitle: string;
}

function sinceMs(item: WaitingItem): number {
  const t = item.since ? Date.parse(item.since) : Number.NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * All waiting items, deduped and ordered: money and legal first, then grants,
 * judgement, reviews; oldest first within a kind. Duplicates (same key, or the
 * same issue) keep the first source given, so pass plugins before the host.
 */
export function mergeWaiting(sources: Array<{ source: string; sourceTitle?: string; items: WaitingItem[] }>): WaitingEntry[] {
  const seenKeys = new Set<string>();
  const seenIssues = new Set<string>();
  const out: WaitingEntry[] = [];
  for (const { source, sourceTitle, items } of sources) {
    for (const item of items) {
      if (seenKeys.has(item.key)) continue;
      if (item.issueId && seenIssues.has(item.issueId)) continue;
      seenKeys.add(item.key);
      if (item.issueId) seenIssues.add(item.issueId);
      out.push({ ...item, source, sourceTitle: sourceTitle ?? pluginTitle(source) });
    }
  }
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || sinceMs(a) - sinceMs(b) || a.title.localeCompare(b.title));
}

export interface ApprovalLite {
  id: string;
  type: string;
  status: string;
  payload?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface IssueLite {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

const OPEN_APPROVAL = new Set(["pending", "revision_requested"]);
export const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const MONEY_RE = /\b(invoice|quote|payment|pay|payroll|payslip|vat|tax|bank|budget|refund|statement|expense|bill|emp201|irp5|money)\b/i;
const LEGAL_RE = /\b(contract|legal|terms|agreement|popia|gdpr|consent|licen[cs]e|sign[- ]?off)\b/i;

function approvalTitle(approval: ApprovalLite): string {
  const payload = approval.payload ?? {};
  const named = str(payload.title) ?? str(payload.name) ?? str(payload.summary) ?? str(payload.agentName);
  const label: Record<string, string> = {
    hire_agent: "Approve a new agent",
    approve_ceo_strategy: "Approve the CEO's strategy",
    budget_override_required: "Budget override needed",
    request_board_approval: "Board approval requested",
  };
  const base = label[approval.type] ?? "Approval requested";
  return named ? `${base}: ${named}` : base;
}

function approvalKind(approval: ApprovalLite): WaitingItem["kind"] {
  if (approval.type === "budget_override_required") return "money";
  if (approval.type === "hire_agent") return "grant";
  const text = `${approvalTitle(approval)} ${JSON.stringify(approval.payload ?? {})}`;
  if (MONEY_RE.test(text)) return "money";
  if (LEGAL_RE.test(text)) return "legal";
  return "judgement";
}

export function issueKind(issue: Pick<IssueLite, "title" | "status">): WaitingItem["kind"] {
  if (MONEY_RE.test(issue.title)) return "money";
  if (LEGAL_RE.test(issue.title)) return "legal";
  if (issue.status === "in_review") return "review";
  return "judgement";
}

export function issueHref(issue: Pick<IssueLite, "id" | "identifier">): string {
  return `/issues/${issue.identifier || issue.id}`;
}

/** Waiting items from the host: open approvals, open issues assigned to the person, missing setup items. */
export function hostWaiting(input: { approvals?: ApprovalLite[]; myIssues?: IssueLite[]; setupMissing?: number | null }): WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const approval of input.approvals ?? []) {
    if (!OPEN_APPROVAL.has(approval.status)) continue;
    items.push({
      key: `host-approval:${approval.id}`,
      title: approvalTitle(approval),
      why: approval.status === "revision_requested" ? "Changes were asked for; check the new version." : "Only a board member can approve this.",
      href: `/approvals/${approval.id}`,
      issueId: null,
      kind: approvalKind(approval),
      since: approval.createdAt ?? null,
    });
  }
  for (const issue of input.myIssues ?? []) {
    if (!(OPEN_ISSUE_STATUSES as readonly string[]).includes(issue.status)) continue;
    items.push({
      key: `issue:${issue.id}`,
      title: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
      why: issue.status === "in_review" ? "Waiting for your review." : issue.status === "blocked" ? "Assigned to you and blocked." : "Assigned to you.",
      href: issueHref(issue),
      issueId: issue.id,
      kind: issueKind(issue),
      since: issue.updatedAt ?? issue.createdAt ?? null,
    });
  }
  if (input.setupMissing && input.setupMissing > 0) {
    items.push({
      key: "setup:missing",
      title: `Finish setup: ${input.setupMissing} required ${input.setupMissing === 1 ? "item" : "items"}`,
      why: "Agents cannot run these parts on their own until they are set up.",
      href: "/setup",
      issueId: null,
      kind: "grant",
      since: null,
    });
  }
  return items;
}

/** Missing required setup items across enabled modules (from Setup statuses). */
export function setupMissingCount(statuses: Record<string, SetupStatus | null | undefined>, modules: Partial<Record<ModuleKey, boolean>> | null | undefined): number {
  let missing = 0;
  for (const [pluginKey, status] of Object.entries(statuses)) {
    if (!status || !pluginEnabled(modules, pluginKey)) continue;
    missing += setupProgress(status.items ?? []).missing.length;
  }
  return missing;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export const KPI_GROUP_TITLES: Record<CockpitKpi["group"], string> = {
  money: "Money",
  pipeline: "Pipeline",
  marketing: "Marketing",
  delivery: "Delivery",
  people: "People",
  other: "Other",
};

export interface KpiEntry extends CockpitKpi {
  plugin: string;
  pluginTitle: string;
}

export function groupKpis(snapshots: CockpitSnapshot[]): Record<CockpitKpi["group"], KpiEntry[]> {
  const groups = Object.fromEntries(KPI_GROUPS.map((group) => [group, [] as KpiEntry[]])) as Record<CockpitKpi["group"], KpiEntry[]>;
  for (const snapshot of snapshots) {
    for (const kpi of snapshot.kpis) groups[kpi.group].push({ ...kpi, plugin: snapshot.plugin, pluginTitle: snapshot.title });
  }
  return groups;
}

/** A few headline KPIs for the widget and the Today line: first of each group, bad/warn first. */
export function headlineKpis(snapshots: CockpitSnapshot[], count = 4): KpiEntry[] {
  const groups = groupKpis(snapshots);
  const toneRank = (tone?: Tone) => (tone === "bad" ? 0 : tone === "warn" ? 1 : 2);
  const picks: KpiEntry[] = [];
  for (const group of ["money", "pipeline", "marketing", "delivery"] as const) {
    const sorted = [...groups[group]].sort((a, b) => toneRank(a.tone) - toneRank(b.tone));
    if (sorted[0]) picks.push(sorted[0]);
  }
  return picks.slice(0, count);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const HEALTH_RANK: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2 };

export interface HealthEntry extends HealthCheck {
  plugin: string;
  pluginTitle: string;
}

export interface HealthGroup {
  plugin: string;
  title: string;
  status: HealthStatus;
  checks: HealthEntry[];
}

/** Health checks grouped by plugin, worst group first, worst check first within a group. */
export function healthGroups(snapshots: CockpitSnapshot[], extra: HealthEntry[] = []): HealthGroup[] {
  const byPlugin = new Map<string, HealthGroup>();
  const add = (entry: HealthEntry) => {
    const group = byPlugin.get(entry.plugin) ?? { plugin: entry.plugin, title: entry.pluginTitle, status: "ok" as HealthStatus, checks: [] };
    group.checks.push(entry);
    byPlugin.set(entry.plugin, group);
  };
  for (const snapshot of snapshots) for (const check of snapshot.health) add({ ...check, plugin: snapshot.plugin, pluginTitle: snapshot.title });
  for (const entry of extra) add(entry);
  const groups = [...byPlugin.values()].map((group) => ({
    ...group,
    status: worstHealth(group.checks),
    checks: [...group.checks].sort((a, b) => HEALTH_RANK[a.status] - HEALTH_RANK[b.status] || a.title.localeCompare(b.title)),
  }));
  return groups.sort((a, b) => HEALTH_RANK[a.status] - HEALTH_RANK[b.status] || a.title.localeCompare(b.title));
}

export function worstOf(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("bad")) return "bad";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

export interface StaleInput {
  /** Plugins whose module is on and that are installed and ready (or known to report). */
  expected: string[];
  /** Latest snapshot time per plugin. */
  lastSnapshot: Record<string, string | null | undefined>;
  now: Date;
  /** When the Cockpit started listening for this company; a plugin with no snapshot is only stale 3h after this. */
  listeningSince?: string | null;
}

/** "Plugin not reporting" warnings: on, but no snapshot for 3 hours. */
export function staleChecks(input: StaleInput): HealthEntry[] {
  const now = input.now.getTime();
  const listening = input.listeningSince ? Date.parse(input.listeningSince) : Number.NaN;
  const out: HealthEntry[] = [];
  for (const plugin of input.expected) {
    if (plugin === PLUGIN_KEY) continue;
    const last = input.lastSnapshot[plugin];
    const lastMs = last ? Date.parse(last) : Number.NaN;
    let detail: string | null = null;
    if (!Number.isNaN(lastMs)) {
      if (now - lastMs <= STALE_AFTER_MS) continue;
      detail = `Last report ${hoursAgo(now - lastMs)}.`;
    } else {
      if (Number.isNaN(listening) || now - listening <= STALE_AFTER_MS) continue;
      detail = "It has never reported to the Cockpit.";
    }
    const title = pluginTitle(plugin);
    out.push({
      key: `stale:${plugin}`,
      title: `${title} plugin not reporting`,
      status: "warn",
      detail,
      href: "/company/settings/instance/plugins",
      fix: `Check the ${title} plugin is enabled, upgraded and its settings are saved for this company. It reports every hour.`,
      since: last ?? null,
      plugin,
      pluginTitle: title,
    });
  }
  return out;
}

export function hoursAgo(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentLite {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  urlKey?: string | null;
  status: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastRunAt?: string | null;
  errorReason?: string | null;
  pauseReason?: string | null;
}

export interface RunLite {
  agentId: string;
  status: string;
  startedAt: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

export interface AgentRow extends AgentLite {
  budgetRatio: number | null;
  alert: "budget" | "error" | null;
  alertText: string | null;
  runs: { total: number; failed: number };
  quality: QualityMetric[];
}

const INACTIVE_AGENT = new Set(["terminated", "archived", "deleted"]);
const FAILED_RUN = new Set(["failed", "error", "timed_out", "timeout", "cancelled_error"]);

export function budgetRatio(agent: Pick<AgentLite, "budgetMonthlyCents" | "spentMonthlyCents">): number | null {
  return agent.budgetMonthlyCents > 0 ? agent.spentMonthlyCents / agent.budgetMonthlyCents : null;
}

export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** Budget (≥80%) and error alerts for one agent. */
export function agentAlert(agent: AgentLite): { alert: AgentRow["alert"]; text: string | null } {
  if (agent.status === "error") return { alert: "error", text: agent.errorReason ? `In error: ${agent.errorReason}` : "In error." };
  const ratio = budgetRatio(agent);
  if (ratio !== null && ratio >= BUDGET_ALERT_RATIO) {
    return { alert: "budget", text: `Used ${Math.round(ratio * 100)}% of its ${formatCents(agent.budgetMonthlyCents)} monthly budget (${formatCents(agent.spentMonthlyCents)}).` };
  }
  return { alert: null, text: null };
}

export function agentRows(agents: AgentLite[], input: { runs?: RunLite[]; snapshots?: CockpitSnapshot[]; since?: Date } = {}): AgentRow[] {
  const since = input.since?.getTime() ?? 0;
  const quality = new Map<string, QualityMetric[]>();
  for (const snapshot of input.snapshots ?? []) {
    for (const metric of snapshot.quality) {
      if (!metric.agentId) continue;
      quality.set(metric.agentId, [...(quality.get(metric.agentId) ?? []), metric]);
    }
  }
  const runs = new Map<string, { total: number; failed: number; last: string | null }>();
  for (const run of input.runs ?? []) {
    const at = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    const entry = runs.get(run.agentId) ?? { total: 0, failed: 0, last: null };
    if (!Number.isNaN(at) && (!entry.last || at > Date.parse(entry.last))) entry.last = run.startedAt;
    if (!Number.isNaN(at) && at >= since) {
      entry.total += 1;
      if (FAILED_RUN.has(run.status)) entry.failed += 1;
    }
    runs.set(run.agentId, entry);
  }
  return agents
    .filter((agent) => !INACTIVE_AGENT.has(agent.status))
    .map((agent) => {
      const { alert, text } = agentAlert(agent);
      const run = runs.get(agent.id);
      const lastRunAt = latest(agent.lastRunAt ?? null, run?.last ?? null);
      return {
        ...agent,
        lastRunAt,
        budgetRatio: budgetRatio(agent),
        alert,
        alertText: text,
        runs: { total: run?.total ?? 0, failed: run?.failed ?? 0 },
        quality: quality.get(agent.id) ?? [],
      };
    })
    .sort((a, b) => (a.alert ? 0 : 1) - (b.alert ? 0 : 1) || a.name.localeCompare(b.name));
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Health entries for agents over budget or in error (for the System health issue). */
export function agentHealth(agents: AgentLite[]): HealthEntry[] {
  const out: HealthEntry[] = [];
  for (const agent of agents) {
    if (INACTIVE_AGENT.has(agent.status)) continue;
    const { alert, text } = agentAlert(agent);
    if (!alert) continue;
    out.push({
      key: `agent:${alert}:${agent.id}`,
      title: alert === "budget" ? `${agent.name} is near its budget` : `${agent.name} is in error`,
      status: alert === "error" ? "bad" : (budgetRatio(agent) ?? 0) >= 1 ? "bad" : "warn",
      detail: text,
      href: `/agents/${agent.urlKey || agent.id}`,
      fix: alert === "budget"
        ? "Check what it is spending on (Costs), then raise its budget or narrow its work. It stops at 100%."
        : "Open the agent, read the error on its last run, fix the cause (often the model key), then clear the error and resume it.",
      since: null,
      plugin: "agents",
      pluginTitle: "Agents",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface HostActivityLite {
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityLine {
  at: string;
  text: string;
  href: string | null;
  source: string;
}

export interface ActivityGroup {
  /** Agent id, or `plugin:<key>` for work a plugin did without an agent. */
  key: string;
  name: string;
  agentId: string | null;
  lines: ActivityLine[];
  runs: { total: number; failed: number };
}

function words(value: string): string {
  return value.replace(/[._]+/g, " ").trim();
}

function capital(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** A readable past-tense-ish line for a host activity row. */
export function hostActivityText(row: HostActivityLite): { text: string; href: string | null } {
  const parts = row.action.split(".");
  const verb = words(parts.length > 1 ? parts.slice(1).join(" ") : parts[0] ?? row.action);
  const details = row.details ?? {};
  const label = str(details.identifier) ?? str(details.issueIdentifier) ?? str(details.title) ?? str(details.name) ?? null;
  const entity = words(row.entityType);
  const text = label ? `${capital(verb)} ${entity} ${label}` : `${capital(verb)} ${entity}`;
  const href = row.entityType === "issue" ? `/issues/${str(details.identifier) ?? row.entityId}` : row.entityType === "approval" ? `/approvals/${row.entityId}` : null;
  return { text, href };
}

/**
 * What the agents did in the window, grouped by agent (busiest first):
 * plugin activity lines, host activity by agents, and run counts.
 */
export function activityGroups(input: {
  snapshots: CockpitSnapshot[];
  host?: HostActivityLite[];
  runs?: RunLite[];
  agents?: Array<Pick<AgentLite, "id" | "name">>;
  now: Date;
  windowMs: number;
  perGroup?: number;
}): ActivityGroup[] {
  const from = input.now.getTime() - input.windowMs;
  const names = new Map((input.agents ?? []).map((agent) => [agent.id, agent.name]));
  const groups = new Map<string, ActivityGroup>();
  const group = (key: string, name: string, agentId: string | null) => {
    const found = groups.get(key);
    if (found) return found;
    const created: ActivityGroup = { key, name, agentId, lines: [], runs: { total: 0, failed: 0 } };
    groups.set(key, created);
    return created;
  };
  const inWindow = (at: string | null | undefined) => {
    const t = at ? Date.parse(at) : Number.NaN;
    return !Number.isNaN(t) && t >= from && t <= input.now.getTime() + 60_000;
  };
  for (const snapshot of input.snapshots) {
    for (const item of snapshot.activity) {
      if (!inWindow(item.at)) continue;
      const g = item.agentId ? group(item.agentId, names.get(item.agentId) ?? "Agent", item.agentId) : group(`plugin:${snapshot.plugin}`, snapshot.title, null);
      g.lines.push({ at: item.at, text: item.text, href: item.href ?? null, source: snapshot.title });
    }
  }
  for (const row of input.host ?? []) {
    const agentId = row.actorType === "agent" ? row.actorId : row.agentId ?? null;
    if (!agentId || !inWindow(row.createdAt)) continue;
    const { text, href } = hostActivityText(row);
    group(agentId, names.get(agentId) ?? "Agent", agentId).lines.push({ at: row.createdAt, text, href, source: "Paperclip" });
  }
  for (const run of input.runs ?? []) {
    if (!inWindow(run.startedAt)) continue;
    const g = group(run.agentId, names.get(run.agentId) ?? "Agent", run.agentId);
    g.runs.total += 1;
    if (FAILED_RUN.has(run.status)) g.runs.failed += 1;
  }
  const limit = input.perGroup ?? 8;
  return [...groups.values()]
    .map((g) => {
      const seen = new Set<string>();
      const lines = g.lines
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .filter((line) => {
          const k = `${line.text}|${line.href ?? ""}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      return { ...g, lines: lines.slice(0, limit), total: lines.length };
    })
    .filter((g) => g.lines.length > 0 || g.runs.total > 0)
    .sort((a, b) => b.total + b.runs.total - (a.total + a.runs.total) || a.name.localeCompare(b.name))
    .map(({ total: _total, ...g }) => g);
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export function todayLine(input: { waiting: number; health: HealthStatus; problems: number; agentAlerts: number; activeAgents: number | null }): string {
  const parts: string[] = [];
  parts.push(input.waiting === 0 ? "Nothing waiting on you" : `${input.waiting} ${input.waiting === 1 ? "thing waits" : "things wait"} on you`);
  if (input.problems > 0) parts.push(`${input.problems} ${input.problems === 1 ? "problem" : "problems"} to fix`);
  else parts.push(input.health === "ok" ? "all systems ok" : "a few warnings");
  if (input.agentAlerts > 0) parts.push(`${input.agentAlerts} agent ${input.agentAlerts === 1 ? "alert" : "alerts"}`);
  if (input.activeAgents !== null) parts.push(`${input.activeAgents} ${input.activeAgents === 1 ? "agent" : "agents"} working`);
  return `${parts.join(" · ")}.`;
}

export const HEALTH_LABEL: Record<HealthStatus, string> = { ok: "All good", warn: "Needs attention", bad: "Problems" };
