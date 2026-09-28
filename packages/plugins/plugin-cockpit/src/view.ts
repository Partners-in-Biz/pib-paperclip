/**
 * The page's view model (pure, no node imports): which snapshot to use per
 * plugin (live → stored), module switches, and everything the sections show.
 */
import type { ModuleKey } from "@partnersinbiz/pib-plugin-kit/setup";
import { askWaitingItem, type AskView } from "./ask-model.js";
import { BACKUP_STALE_HOURS, PLUGIN_KEY } from "./constants.js";
import { buildFlows, type FlowsView } from "./flows.js";
import {
  activityGroups,
  agentRows,
  groupKpis,
  headlineKpis,
  healthGroups,
  hostWaiting,
  mergeWaiting,
  parseSnapshot,
  pluginEnabled,
  setupMissingCount,
  shownIssueIds,
  staleChecks,
  todayLine,
  unassignedWaiting,
  worstOf,
  type ActivityGroup,
  type AgentLite,
  type AgentRow,
  type ApprovalLite,
  type CockpitSnapshot,
  type HealthGroup,
  type HealthStatus,
  type HostActivityLite,
  type IssueLite,
  type KpiEntry,
  type RunLite,
  type WaitingEntry,
} from "./merge.js";

export interface InstalledLite {
  id: string;
  status: string;
}

export interface LoadResult {
  roles: {
    companyId: string;
    operatorAgentId: string | null;
    reviewerAgentId: string | null;
    ownerUserId: string | null;
    reviewOutward: boolean;
    updatedAt: string;
  } | null;
  rolesSavedAt: string | null;
  settingsSaved: boolean;
  snapshots: Record<string, { snapshot: unknown; receivedAt: string }>;
  setupStatuses: Record<string, unknown>;
  own: unknown;
  team: Record<"operator" | "reviewer", {
    agent: { id: string; name: string; status: string; title?: string | null } | null;
    hire: { issueId: string; identifier: string | null; status: string; assigneeAgentId: string | null; assigneeUserId: string | null } | null;
    candidates: Array<{ id: string; name: string }>;
    linkedBy: string | null;
  }> | null;
  healthIssueId: string | null;
  /** Questions agents asked the owner that wait for a reply (older workers do not send it). */
  asks?: AskView[];
  /** Open issues nobody is assigned to, older than a day: the count and the first five. */
  unassigned?: { count: number; items: Array<{ id: string; identifier: string | null; title: string; status?: string; createdAt: string | null }> };
  /** When the Cockpit first saw each warning (`<plugin>:<check key>`), for checks that do not say. */
  warningSince?: Record<string, string>;
}

export type SnapshotSource = "live" | "stored";

export interface BackupInfo {
  at: string | null;
  ageHours: number | null;
  status: HealthStatus;
  text: string;
}

export interface ViewInput {
  load: LoadResult;
  installed: Record<string, InstalledLite> | null;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  live: Record<string, CockpitSnapshot | null | undefined>;
  approvals?: ApprovalLite[];
  myIssues?: IssueLite[];
  /** Required setup steps left: the Setup plugin's own count (kit `setupSummary`) when available; falls back to the Cockpit projection. */
  setupMissing?: number | null;
  /** The open Finish setup issue, so it is listed once (as the setup item). */
  setupIssueId?: string | null;
  /** The setup statuses the Setup plugin stored (by plugin), for "settings not saved" on the Flows tab. */
  setupStatuses?: Record<string, unknown> | null;
  agents?: AgentLite[];
  hostActivity?: HostActivityLite[];
  runs?: RunLite[];
  backup?: { mtime: string | null; ageHours: number | null } | null;
  now: Date;
  windowMs: number;
}

export interface CockpitView {
  snapshots: Array<CockpitSnapshot & { source: SnapshotSource }>;
  today: string;
  health: HealthStatus;
  waiting: WaitingEntry[];
  kpis: Record<"money" | "pipeline" | "marketing" | "delivery" | "people" | "other", KpiEntry[]>;
  headline: KpiEntry[];
  activity: ActivityGroup[];
  agents: AgentRow[];
  healthGroups: HealthGroup[];
  backup: BackupInfo | null;
  problems: number;
  /** The company graph: every flow's stages, numbers, what is stuck and what is switched off. */
  flows: FlowsView;
}

/**
 * The stored setup statuses by plugin: the Cockpit's own copy, else the
 * Setup plugin's. Null while no plugin has reported at all (a fresh install):
 * then the Flows tab cannot tell whose settings are missing, so it does not say.
 */
export function knownSetupStatuses(load: Pick<LoadResult, "setupStatuses">, fromSetup: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const valid = (source: Record<string, unknown> | null | undefined) =>
    Object.entries(source ?? {}).filter(([, status]) => !!status && typeof status === "object" && Array.isArray((status as { items?: unknown }).items));
  const merged = Object.fromEntries([...valid(fromSetup), ...valid(load.setupStatuses)]);
  return Object.keys(merged).length > 0 ? merged : null;
}

const INACTIVE = new Set(["terminated", "archived", "deleted"]);

/** Snapshot per plugin: module on; installed (when known); live answer first, then the stored one. */
export function pickSnapshots(input: Pick<ViewInput, "load" | "installed" | "modules" | "live">): Array<CockpitSnapshot & { source: SnapshotSource }> {
  const keys = new Set<string>([...Object.keys(input.live), ...Object.keys(input.load.snapshots ?? {})]);
  const out: Array<CockpitSnapshot & { source: SnapshotSource }> = [];
  for (const key of [...keys].sort()) {
    if (key === PLUGIN_KEY) continue;
    if (!pluginEnabled(input.modules, key)) continue;
    if (input.installed && !input.installed[key]) continue;
    const live = input.live[key];
    if (live) {
      out.push({ ...live, source: "live" });
      continue;
    }
    const stored = input.load.snapshots?.[key];
    const parsed = stored ? parseSnapshot(stored.snapshot, key) : null;
    if (parsed) out.push({ ...parsed, source: "stored" });
  }
  const own = parseSnapshot(input.load.own, PLUGIN_KEY);
  if (own) out.push({ ...own, source: "live" });
  return out;
}

export function backupInfo(backup: ViewInput["backup"], now: Date): BackupInfo | null {
  if (!backup || (!backup.mtime && backup.ageHours == null)) return null;
  const age = backup.ageHours ?? (backup.mtime ? (now.getTime() - Date.parse(backup.mtime)) / 3_600_000 : null);
  const status: HealthStatus = age == null ? "warn" : age > BACKUP_STALE_HOURS ? "warn" : "ok";
  const text = age == null ? "Backup time unknown." : age < 1 ? "Less than an hour ago." : `${Math.round(age)} ${Math.round(age) === 1 ? "hour" : "hours"} ago.`;
  return { at: backup.mtime, ageHours: age, status, text };
}

/** Warnings that do not say since when get the time the Cockpit first saw them. */
export function withWarningSince(snapshots: Array<CockpitSnapshot & { source: SnapshotSource }>, since: Record<string, string> | null | undefined): Array<CockpitSnapshot & { source: SnapshotSource }> {
  if (!since || Object.keys(since).length === 0) return snapshots;
  return snapshots.map((snapshot) => ({
    ...snapshot,
    health: snapshot.health.map((check) => (check.status === "warn" && !check.since && since[`${snapshot.plugin}:${check.key}`] ? { ...check, since: since[`${snapshot.plugin}:${check.key}`] } : check)),
  }));
}

export function buildView(input: ViewInput): CockpitView {
  const snapshots = withWarningSince(pickSnapshots(input), input.load.warningSince);
  const storedTimes = Object.fromEntries(
    Object.entries(input.load.snapshots ?? {}).map(([key, row]) => [key, parseSnapshot(row.snapshot, key)?.checkedAt ?? row.receivedAt]),
  );
  const expected = [
    ...new Set([
      ...Object.keys(storedTimes),
      ...Object.entries(input.installed ?? {})
        .filter(([key, p]) => p.status === "ready" && key !== "partnersinbiz.setup")
        .map(([key]) => key),
    ]),
  ].filter((key) => key !== PLUGIN_KEY && pluginEnabled(input.modules, key) && (!input.installed || input.installed[key]));
  const stale = staleChecks({ expected, lastSnapshot: storedTimes, now: input.now, listeningSince: input.load.rolesSavedAt }).map((check) =>
    input.live[check.plugin]
      ? { ...check, detail: `It answers this page, but its hourly report has not arrived, so health alerts and the Operator cannot see it. ${check.detail ?? ""}`.trim() }
      : check);
  const backup = backupInfo(input.backup, input.now);
  const extra = [...stale];
  if (backup && backup.status !== "ok") {
    extra.push({
      key: "backup",
      title: "Database backup is old",
      status: "warn",
      detail: `Last backup ${backup.text.toLowerCase()}`,
      href: null,
      fix: "Check the server's hourly backup job (the lead restores from these).",
      since: backup.at,
      plugin: "host",
      pluginTitle: "Paperclip",
    });
  }
  const groups = healthGroups(snapshots, extra);
  const setupMissing = input.setupMissing ?? setupMissingCount(
    Object.fromEntries(Object.entries(input.load.setupStatuses ?? {}).filter(([, s]) => s && typeof s === "object" && Array.isArray((s as { items?: unknown }).items))) as Record<string, never>,
    input.modules,
  );
  const own = [
    { source: "asks", sourceTitle: "Asked by agents", items: (input.load.asks ?? []).map(askWaitingItem) },
    ...snapshots.map((s) => ({ source: s.plugin, sourceTitle: s.title, items: s.waiting })),
  ];
  const host = { source: "host", sourceTitle: "Paperclip", items: hostWaiting({ approvals: input.approvals, myIssues: input.myIssues, setupMissing, setupIssueId: input.setupIssueId }) };
  // An issue with a row of its own is not counted again among the unassigned ones.
  const unassigned = { source: "unassigned", sourceTitle: "Paperclip", items: unassignedWaiting(input.load.unassigned, shownIssueIds([...own, host])) };
  const waiting = mergeWaiting([...own, unassigned, host]);
  const agents = agentRows((input.agents ?? []).filter((a) => !INACTIVE.has(a.status)), { runs: input.runs, snapshots, since: new Date(input.now.getTime() - 7 * 86_400_000) });
  const activity = activityGroups({ snapshots, host: input.hostActivity, runs: input.runs, agents: input.agents, now: input.now, windowMs: input.windowMs });
  const health = worstOf(groups.map((g) => g.status));
  const problems = groups.reduce((sum, g) => sum + g.checks.filter((c) => c.status === "bad").length, 0);
  const flows = buildFlows({
    snapshots,
    modules: input.modules,
    installed: input.installed,
    setupStatuses: knownSetupStatuses(input.load, input.setupStatuses),
    cockpitSettingsSaved: typeof input.load.settingsSaved === "boolean" ? input.load.settingsSaved : null,
    roles: input.load.roles,
    agents: input.agents,
  });
  return {
    snapshots,
    today: todayLine({
      waiting: waiting.length,
      health,
      problems,
      agentAlerts: agents.filter((a) => a.alert).length,
      activeAgents: input.agents && input.agents.length > 0 ? agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length : null,
    }),
    health,
    waiting,
    kpis: groupKpis(snapshots),
    headline: headlineKpis(snapshots),
    activity,
    agents,
    healthGroups: groups,
    backup,
    problems,
    flows,
  };
}
