/**
 * The company graph on the Cockpit (pure, no node imports; the page and the
 * Operator's brief share it). Every flow in kit `FLOWS`, stage by stage, in
 * order, with:
 * - the stage's live numbers, from the plugin that owns it (`CockpitSnapshot.flows`);
 * - who it waits on: the role's agent (by name), a person, the customer or the system;
 * - whether it is switched off, why, and where to fix it;
 * - what is stuck, worst first.
 */
import { roleAgentUsable, type TeamMemberReport } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { FLOW_STAGES, FLOWS, type FlowKey, type FlowStage, type FlowStageReport, type FlowWaitingOn } from "@partnersinbiz/pib-plugin-kit/flows";
import type { ModuleKey } from "@partnersinbiz/pib-plugin-kit/setup";
import { TEAM_ROLES, teamSetupPath, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";
import { PLUGIN_KEY } from "./constants.js";

export type { FlowKey, FlowStageReport, FlowWaitingOn };

// ---------------------------------------------------------------------------
// Parsing a plugin's `flows`
// ---------------------------------------------------------------------------

const REASON_MAX = 160;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function knownStage(value: unknown): string | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FLOW_STAGES, value) ? value : null;
}

/**
 * A plugin's `flows` from its snapshot (a route body, an event, or the stored
 * copy): only known stages that plugin owns, once each, with sane numbers.
 * Anything else is dropped, so an older plugin (no `flows`) or a bad row
 * never breaks the page.
 */
export function parseFlowReports(value: unknown, pluginKey: string): FlowStageReport[] {
  if (!Array.isArray(value)) return [];
  const out: FlowStageReport[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const stage = knownStage(row.stage);
    if (!stage || FLOW_STAGES[stage]!.plugin !== pluginKey || out.some((r) => r.stage === stage)) continue;
    const counted = finite(row.count);
    if (counted === null) continue;
    const count = Math.max(0, Math.round(counted));
    const stuck = Math.max(0, Math.min(Math.round(finite(row.stuck) ?? 0), count));
    const reason = typeof row.stuckReason === "string" ? row.stuckReason.replace(/\s+/g, " ").trim() : "";
    const amount = finite(row.amountMinor);
    const currency = typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency.trim()) ? row.currency.trim().toUpperCase() : null;
    const oldest = finite(row.oldestDays);
    out.push({
      stage,
      count,
      stuck,
      stuckReason: stuck > 0 && reason ? (reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason) : null,
      amountMinor: amount === null ? null : Math.round(amount),
      currency: amount === null ? null : currency ?? "ZAR",
      oldestDays: oldest === null || oldest < 0 ? null : Math.floor(oldest),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who holds each role
// ---------------------------------------------------------------------------

export interface RoleHolder {
  agentId: string | null;
  name: string | null;
  /** Paperclip agent status; null when unknown (counts as running, like kit `routeWork`). */
  status: string | null;
}

export type FlowTeam = Partial<Record<TeamRoleKey, RoleHolder>>;

export interface AgentLike {
  id: string;
  name: string;
  status: string;
}

/**
 * The agent in each role, the way `roles.updated` shares it: each plugin's
 * snapshot `team`, with the Cockpit's own Operator and Reviewer. The agents
 * list (when loaded) gives the current name and status; an agent missing
 * from a loaded list was removed.
 */
export function flowTeam(input: {
  snapshots: Array<{ team?: TeamMemberReport[] | null }>;
  roles?: { operatorAgentId?: string | null; reviewerAgentId?: string | null } | null;
  agents?: AgentLike[] | null;
}): FlowTeam {
  const agents = input.agents ?? [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const holder = (agentId: string | null | undefined, reported: string | null | undefined): RoleHolder => {
    if (!agentId) return { agentId: null, name: null, status: null };
    const agent = byId.get(agentId);
    return { agentId, name: agent?.name ?? null, status: agent ? agent.status : agents.length > 0 ? "terminated" : reported ?? null };
  };
  const team: FlowTeam = {};
  for (const snapshot of input.snapshots) {
    for (const member of snapshot.team ?? []) {
      if (!team[member.role]) team[member.role] = holder(member.agentId, member.status);
    }
  }
  // The Cockpit's own roles are the source for the Operator and the Reviewer.
  for (const [role, id] of [["operator", input.roles?.operatorAgentId], ["reviewer", input.roles?.reviewerAgentId]] as const) {
    if (id) team[role] = holder(id, team[role]?.agentId === id ? team[role]!.status : null);
  }
  return team;
}

// ---------------------------------------------------------------------------
// Switched off
// ---------------------------------------------------------------------------

/** Short module names for plain sentences ("Mailbox settings are not saved"). */
export const MODULE_NAME: Record<ModuleKey, string> = {
  cockpit: "Cockpit",
  memory: "Company wiki",
  crm: "CRM",
  mailbox: "Mailbox",
  social: "Social",
  seo: "SEO",
  campaigns: "Campaigns",
  billing: "Billing",
  accounting: "Accounting",
  payroll: "Payroll",
  partners: "Partners",
};

/** Setup's checklist, opened at one module. */
export function setupModuleHref(module: ModuleKey): string {
  return `/setup?section=checklist#module-${module}`;
}

export const SETUP_MODULES_HREF = "/setup?section=modules";

export type OffKind = "role" | "settings" | "installed" | "module";

export interface StageOff {
  kind: OffKind;
  /** Stages with the same key share one fix. */
  key: string;
  /** One line for the stage: "No Account Manager yet". */
  reason: string;
  /** The same, for the sentence at the top: "no Account Manager". */
  phrase: string;
  /** Where to fix it (Setup; no company prefix). */
  href: string;
}

export interface OffInput {
  modules?: Partial<Record<ModuleKey, boolean>> | null;
  /** Installed plugins by key; null when unknown. */
  installed?: Record<string, { status?: string | null }> | null;
  /** Stored setup statuses by plugin; null when unknown (the settings check is skipped). */
  setupStatuses?: Record<string, unknown> | null;
  /** The Cockpit's own settings; null when unknown. */
  cockpitSettingsSaved?: boolean | null;
  team: FlowTeam;
}

const GONE = new Set(["terminated", "archived", "deleted"]);

function roleTitle(role: TeamRoleKey): string {
  return TEAM_ROLES.find((r) => r.key === role)?.title ?? role;
}

/** The plugin's `settings` item: true done, false not done, null when its status does not say. */
/** Settings saved, going by a plugin's setup status: it reports one once they are saved, and its "settings" item is not open. */
export function settingsSavedIn(status: unknown): boolean {
  return Boolean(status) && settingsDone(status) !== false;
}

export function settingsDone(status: unknown): boolean | null {
  if (!status || typeof status !== "object") return null;
  const items = (status as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const item = items.find((i) => !!i && typeof i === "object" && (i as { key?: unknown }).key === "settings") as { status?: unknown } | undefined;
  return item ? item.status === "done" : null;
}

function roleOff(role: TeamRoleKey, input: OffInput): StageOff | null {
  const title = roleTitle(role);
  const module = TEAM_ROLES.find((r) => r.key === role)?.module;
  if (module && input.modules?.[module] === false) {
    return { kind: "role", key: `role-module:${role}`, reason: `No ${title}: ${MODULE_NAME[module]} is switched off`, phrase: `no ${title} (${MODULE_NAME[module]} is off)`, href: SETUP_MODULES_HREF };
  }
  const holder = input.team[role];
  const href = teamSetupPath(role);
  if (!holder?.agentId) return { kind: "role", key: `role:${role}:none`, reason: `No ${title} yet`, phrase: `no ${title}`, href };
  const status = holder.status;
  if (status && GONE.has(status)) return { kind: "role", key: `role:${role}:gone`, reason: `The ${title} agent was removed`, phrase: `${title} removed`, href };
  if (roleAgentUsable(status)) return null;
  const who = holder.name ? `${holder.name} (${title})` : `The ${title}`;
  if (status === "paused") return { kind: "role", key: `role:${role}:paused`, reason: `${who} is paused`, phrase: `${title} paused`, href };
  if (status === "error") return { kind: "role", key: `role:${role}:error`, reason: `${who} stopped with an error`, phrase: `${title} in error`, href };
  if (status === "pending_approval") return { kind: "role", key: `role:${role}:approval`, reason: `${who} waits for hire approval`, phrase: `${title} awaiting approval`, href };
  return { kind: "role", key: `role:${role}:${status}`, reason: `${who} is not running`, phrase: `${title} not running`, href };
}

/**
 * Why a stage is switched off, or null when it runs. First match wins:
 * its module is off (Setup modules), its plugin is not installed or not
 * running, its settings are not saved (the stored setup status's `settings`
 * item; the Cockpit's own saved flag), or its role has no running agent.
 */
export function stageOff(stage: Pick<FlowStage, "module" | "plugin" | "role">, input: OffInput): StageOff | null {
  const name = MODULE_NAME[stage.module] ?? stage.module;
  if (input.modules?.[stage.module] === false) {
    return { kind: "module", key: `module:${stage.module}`, reason: `${name} is switched off in Setup`, phrase: `${name} switched off`, href: SETUP_MODULES_HREF };
  }
  if (input.installed) {
    const entry = input.installed[stage.plugin];
    if (!entry) return { kind: "installed", key: `installed:${stage.plugin}`, reason: `The ${name} plugin is not installed`, phrase: `${name} not installed`, href: setupModuleHref(stage.module) };
    if (entry.status && entry.status !== "ready") return { kind: "installed", key: `ready:${stage.plugin}`, reason: `The ${name} plugin is not running`, phrase: `${name} not running`, href: setupModuleHref(stage.module) };
  }
  const settings = { kind: "settings" as const, key: `settings:${stage.plugin}`, reason: `${name} settings are not saved`, phrase: `${name} settings not saved`, href: setupModuleHref(stage.module) };
  if (stage.plugin === PLUGIN_KEY) {
    if (input.cockpitSettingsSaved === false) return settings;
  } else if (input.setupStatuses) {
    // A plugin reports its setup once its settings are saved, so no status at all means they are not.
    if (!settingsSavedIn(input.setupStatuses[stage.plugin])) return settings;
  }
  return stage.role ? roleOff(stage.role, input) : null;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface StageWaits {
  kind: FlowWaitingOn;
  /** "Ama (Account Manager)", "Account Manager", "You", "The customer", "Automatic". */
  label: string;
  /** The role's agent, when it has one. */
  name: string | null;
  role: string | null;
}

export interface FlowStageView {
  key: string;
  label: string;
  description: string;
  flow: FlowKey;
  flowTitle: string;
  module: ModuleKey;
  plugin: string;
  role: TeamRoleKey | null;
  waitingOn: FlowWaitingOn;
  href: string;
  /** Items at the stage now; null when its module does not report it (yet). */
  count: number | null;
  stuck: number;
  stuckReason: string | null;
  amountMinor: number | null;
  currency: string | null;
  oldestDays: number | null;
  /** When the numbers were reported. */
  at: string | null;
  off: StageOff | null;
  waits: StageWaits;
}

export interface FlowView {
  key: FlowKey;
  title: string;
  summary: string;
  stages: FlowStageView[];
  /** Stuck items across the flow. */
  stuck: number;
  stuckStages: number;
  offStages: number;
  /** No stage is switched off. */
  running: boolean;
  /** Stages with numbers. */
  reported: number;
  /** Items in the flow (reported stages only). */
  items: number;
}

export interface FixGroup {
  key: string;
  kind: OffKind;
  reason: string;
  phrase: string;
  href: string;
  stages: FlowStageView[];
}

export interface FlowsView {
  /** Flows with stuck work first (most stuck first), then the kit's order. */
  flows: FlowView[];
  total: number;
  running: number;
  stages: number;
  off: number;
  reported: number;
  /** Every stuck stage, worst first (`stuckOrder`). */
  stuck: FlowStageView[];
  stuckItems: number;
  /** Switched-off stages grouped by what fixes them, biggest first. */
  fixes: FixGroup[];
  /** "4 of 6 flows are running; 3 stages are switched off: …" */
  sentence: string;
}

export interface FlowsInput extends Omit<OffInput, "team"> {
  snapshots: Array<{ plugin: string; checkedAt?: string | null; flows?: FlowStageReport[] | null; team?: TeamMemberReport[] | null }>;
  roles?: { operatorAgentId?: string | null; reviewerAgentId?: string | null } | null;
  agents?: AgentLike[] | null;
}

const WAIT_RANK: Record<FlowWaitingOn, number> = { person: 0, agent: 1, customer: 2, system: 3 };
export const WAIT_ORDER: FlowWaitingOn[] = ["person", "agent", "customer", "system"];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(Object.keys(FLOW_STAGES).map((key, index) => [key, index]));
const OFF_RANK: Record<OffKind, number> = { role: 0, settings: 1, installed: 2, module: 3 };

/** Worst first: most stuck items, then waiting on a person, an agent, the customer, the system; then the oldest; then the graph's order. */
export function stuckOrder(a: Pick<FlowStageView, "key" | "stuck" | "waitingOn" | "oldestDays">, b: Pick<FlowStageView, "key" | "stuck" | "waitingOn" | "oldestDays">): number {
  return b.stuck - a.stuck
    || WAIT_RANK[a.waitingOn] - WAIT_RANK[b.waitingOn]
    || (b.oldestDays ?? -1) - (a.oldestDays ?? -1)
    || (STAGE_INDEX[a.key] ?? 0) - (STAGE_INDEX[b.key] ?? 0);
}

function waitsOf(stage: FlowStage, team: FlowTeam): StageWaits {
  if (stage.waitingOn === "person") return { kind: "person", label: "You", name: null, role: null };
  if (stage.waitingOn === "customer") return { kind: "customer", label: "The customer", name: null, role: null };
  if (stage.waitingOn === "system") return { kind: "system", label: "Automatic", name: null, role: null };
  const title = stage.role ? roleTitle(stage.role) : "An agent";
  const holder = stage.role ? team[stage.role] : undefined;
  const name = holder?.agentId && holder.name ? holder.name : null;
  return { kind: "agent", label: name ? `${name} (${title})` : title, name, role: stage.role ? title : null };
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The one sentence at the top of the Flows tab. */
export function flowsSentence(view: Pick<FlowsView, "running" | "total" | "off" | "fixes">): string {
  const flows = `${view.running} of ${view.total} ${view.total === 1 ? "flow" : "flows"} ${view.running === 1 ? "is" : "are"} running`;
  if (view.off === 0) return view.running === view.total ? `All ${view.total} flows are running.` : `${flows}.`;
  const stages = `${view.off} ${view.off === 1 ? "stage is" : "stages are"} switched off`;
  if (view.fixes.length === 1) return `${flows}; ${stages}: ${view.fixes[0]!.phrase}.`;
  const shown = view.fixes.slice(0, 3).map((fix) => `${fix.phrase} (${fix.stages.length})`);
  const rest = view.fixes.slice(3).reduce((sum, fix) => sum + fix.stages.length, 0);
  return `${flows}; ${stages}: ${rest > 0 ? `${shown.join(", ")} and ${rest} more` : joinAnd(shown)}.`;
}

/** The whole graph: every flow and stage with its numbers, who it waits on, what is off and what is stuck. */
export function buildFlows(input: FlowsInput): FlowsView {
  const reports = new Map<string, { report: FlowStageReport; at: string | null }>();
  for (const snapshot of input.snapshots) {
    for (const report of snapshot.flows ?? []) {
      // Only the plugin that owns a stage may report it.
      if (FLOW_STAGES[report.stage]?.plugin !== snapshot.plugin || reports.has(report.stage)) continue;
      reports.set(report.stage, { report, at: snapshot.checkedAt ?? null });
    }
  }
  const team = flowTeam({ snapshots: input.snapshots, roles: input.roles, agents: input.agents });
  const offInput: OffInput = { modules: input.modules, installed: input.installed, setupStatuses: input.setupStatuses, cockpitSettingsSaved: input.cockpitSettingsSaved, team };
  const flows: FlowView[] = FLOWS.map((flow) => {
    const stages = flow.stages.map((stage): FlowStageView => {
      const found = reports.get(stage.key);
      const report = found?.report;
      return {
        key: stage.key,
        label: stage.label,
        description: stage.description,
        flow: flow.key,
        flowTitle: flow.title,
        module: stage.module,
        plugin: stage.plugin,
        role: stage.role,
        waitingOn: stage.waitingOn,
        href: stage.href,
        count: report ? report.count : null,
        stuck: report?.stuck ?? 0,
        stuckReason: report?.stuckReason ?? null,
        amountMinor: report?.amountMinor ?? null,
        currency: report?.currency ?? null,
        oldestDays: report?.oldestDays ?? null,
        at: found?.at ?? null,
        off: stageOff(stage, offInput),
        waits: waitsOf(stage, team),
      };
    });
    const offStages = stages.filter((s) => s.off).length;
    return {
      key: flow.key,
      title: flow.title,
      summary: flow.summary,
      stages,
      stuck: stages.reduce((sum, s) => sum + s.stuck, 0),
      stuckStages: stages.filter((s) => s.stuck > 0).length,
      offStages,
      running: offStages === 0,
      reported: stages.filter((s) => s.count !== null).length,
      items: stages.reduce((sum, s) => sum + (s.count ?? 0), 0),
    };
  });
  const all = flows.flatMap((flow) => flow.stages);
  const groups = new Map<string, FixGroup>();
  for (const stage of all) {
    if (!stage.off) continue;
    const group = groups.get(stage.off.key) ?? { key: stage.off.key, kind: stage.off.kind, reason: stage.off.reason, phrase: stage.off.phrase, href: stage.off.href, stages: [] };
    group.stages.push(stage);
    groups.set(stage.off.key, group);
  }
  const fixes = [...groups.values()].sort((a, b) => b.stages.length - a.stages.length || OFF_RANK[a.kind] - OFF_RANK[b.kind] || a.reason.localeCompare(b.reason));
  const order = new Map(FLOWS.map((flow, index) => [flow.key, index]));
  const view = {
    flows: [...flows].sort((a, b) => b.stuck - a.stuck || order.get(a.key)! - order.get(b.key)!),
    total: flows.length,
    running: flows.filter((flow) => flow.running).length,
    stages: all.length,
    off: all.filter((s) => s.off).length,
    reported: all.filter((s) => s.count !== null).length,
    stuck: all.filter((s) => s.stuck > 0).sort(stuckOrder),
    stuckItems: all.reduce((sum, s) => sum + s.stuck, 0),
    fixes,
  };
  return { ...view, sentence: flowsSentence(view) };
}
