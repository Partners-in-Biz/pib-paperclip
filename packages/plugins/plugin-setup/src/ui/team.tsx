/**
 * Setup → Team: one row per agent role (kit `TEAM_ROLES`) for the company's
 * switched-on modules. Hire (a prefilled hire task), pick an existing agent,
 * change or remove it, attach missing skills and re-sync; plus who gets the
 * daily brief and whether the Reviewer checks outward-facing work.
 *
 * `useTeam` holds the state and calls each role's plugin (team-client.ts).
 * The row, settings and guided-step components are presentational, so tests
 * render them. The dialogs render last on the page (`TeamDialogs`), so they
 * also open above guided setup.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  Field,
  Hourglass,
  InlineText,
  LoaderCircle,
  Modal,
  NewTaskDialog,
  Pill,
  SectionCard,
  Select,
  StatusDot,
  TriangleAlert,
  Users,
  breakAnywhere,
  errorText,
  tokens,
  tone,
  useIsNarrow,
  type LucideIcon,
  type TaskAssigneeOption,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { missingAgentSkills } from "@partnersinbiz/pib-plugin-kit/agent-client";
import type { ModuleKey } from "../kit-setup.js";
import { defaultHireAssignee, hiringLine, pickHiringAgent, teamAgentCandidate, type HiringPick } from "../hiring.js";
import {
  agentDetail,
  agentPath,
  anchorRole,
  assignableUser,
  attentionLines,
  cockpitConflict,
  cockpitRolePatch,
  COCKPIT_PLUGIN_KEY,
  dropSkillAsks,
  emptyRoleState,
  extrasToAttach,
  failedRoleState,
  hirePath,
  hireStale,
  isTeamPath,
  OWNER_ANCHOR,
  coverTitle,
  ownerChoices,
  ownerLabel,
  ownerPatch,
  pickChoices,
  pickLabel,
  pluginName,
  reviewPatch,
  roleHealth,
  roleLoadError,
  rowOpenByDefault,
  runProfileProblemsFor,
  runProfileText,
  skillLabel,
  skillNames,
  TEAM_ANCHOR,
  teamRolesFor,
  teamSummary,
  words,
  type BoardUser,
  type CockpitRoles,
  type CockpitTeam,
  type ExtraSkillState,
  type HireOptionsLite,
  type TeamAgent,
  type TeamRole,
  type TeamRoleKey,
  type TeamRoleState,
  type TeamRowHealth,
} from "../team.js";
import type { PluginRecordLite } from "./api.js";
import { Card, Switch, type LinkPropsFor } from "./components.js";
import {
  attachMissingSkills,
  attachRoleSkills,
  checkSkills,
  fetchCompanyAgents,
  fetchHireOptions,
  linkPluginRole,
  loadTeam,
  resyncRole,
  saveCockpitTeam,
  startHire,
  unlinkPluginRole,
  type HireTask,
} from "./team-client.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type NoteKey = TeamRoleKey | "settings";

export interface RowNote {
  tone: "ok" | "bad" | "info";
  title: string;
  lines?: string[];
  next?: string[];
}

export type TeamDialog =
  | { kind: "hire"; role: TeamRole; options: HireOptionsLite }
  | { kind: "pick"; role: TeamRole }
  | { kind: "remove"; role: TeamRole };

export interface TeamController {
  roles: TeamRole[];
  states: Partial<Record<TeamRoleKey, TeamRoleState>>;
  agents: TeamAgent[] | null;
  users: BoardUser[] | null;
  cockpit: CockpitTeam | null;
  /** Who does this company's hiring (CEO by role or title, else the head of the org chart); null until the agents are read (Q7-4). */
  hiring: HiringPick | null;
  /** The first load finished. */
  loaded: boolean;
  loading: boolean;
  /** The viewer, when they can be assigned or picked (not the local board placeholder). */
  me: string | null;
  prefix: string | null;
  busy: Partial<Record<NoteKey, string>>;
  notes: Partial<Record<NoteKey, RowNote>>;
  dialog: TeamDialog | null;
  reload(): Promise<void>;
  openHire(key: TeamRoleKey): Promise<void>;
  createHire(task: HireTask): Promise<void>;
  openPick(key: TeamRoleKey): Promise<void>;
  link(role: TeamRole, agentId: string): Promise<void>;
  openRemove(key: TeamRoleKey): void;
  unlink(role: TeamRole): Promise<void>;
  attachSkills(key: TeamRoleKey): Promise<void>;
  attachExtras(key: TeamRoleKey): Promise<void>;
  resync(key: TeamRoleKey): Promise<void>;
  saveOwner(userId: string): Promise<void>;
  saveReview(on: boolean): Promise<void>;
  closeDialog(): void;
  dismissNote(key: NoteKey): void;
}

const NO_ROLES: CockpitRoles = { operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false };

function installedKey(installed: Record<string, PluginRecordLite> | null): string {
  return installed ? Object.values(installed).map((p) => `${p.pluginKey}:${p.status}`).sort().join(",") : "?";
}

/** The Cockpit has no owner yet and someone can be picked: guided setup asks for one. */
export function ownerStepNeeded(team: Pick<TeamController, "roles" | "cockpit" | "users" | "me">): boolean {
  if (!team.cockpit || !team.roles.some((role) => role.cockpitRole)) return false;
  if (team.cockpit.roles?.ownerUserId) return false;
  return ownerChoices({ users: team.users, me: team.me, ownerUserId: null }).length > 0;
}

export function useTeam(input: {
  companyId: string | null | undefined;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  installed: Record<string, PluginRecordLite> | null;
  /** Load once Setup's own data is there. */
  ready: boolean;
  /** A role changed: refresh that plugin's checklist. */
  onChanged?: (pluginKey: string) => void;
}): TeamController {
  const host = useHostContext();
  const me = assignableUser(host.userId);
  const { companyId, installed, ready } = input;
  const modulesKey = JSON.stringify(input.modules ?? null);
  const installKey = installedKey(installed);
  const roles = useMemo(() => teamRolesFor({ modules: input.modules, installed }), [modulesKey, installKey]);
  const rolesKey = roles.map((role) => role.key).join(",");

  const [states, setStates] = useState<Partial<Record<TeamRoleKey, TeamRoleState>>>({});
  const [agents, setAgents] = useState<TeamAgent[] | null>(null);
  const [users, setUsers] = useState<BoardUser[] | null>(null);
  const [cockpit, setCockpit] = useState<CockpitTeam | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyMap] = useState<Partial<Record<NoteKey, string>>>({});
  const [notes, setNotes] = useState<Partial<Record<NoteKey, RowNote>>>({});
  const [dialog, setDialog] = useState<TeamDialog | null>(null);

  const token = useRef(0);
  const rolesRef = useRef(roles);
  rolesRef.current = roles;
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const onChanged = useRef(input.onChanged);
  onChanged.current = input.onChanged;
  const statesRef = useRef(states);
  statesRef.current = states;

  const setBusy = useCallback((key: NoteKey, value: string | null) => {
    setBusyMap((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);
  const setNote = useCallback((key: NoteKey, note: RowNote | null) => {
    setNotes((prev) => {
      const next = { ...prev };
      if (note) next[key] = note;
      else delete next[key];
      return next;
    });
  }, []);

  // A new company starts empty.
  useEffect(() => {
    token.current += 1;
    setStates({});
    setAgents(null);
    setUsers(null);
    setCockpit(null);
    setLoaded(false);
    setLoading(false);
    setBusyMap({});
    setNotes({});
    setDialog(null);
  }, [companyId]);

  const reload = useCallback(async () => {
    if (!companyId) return;
    const mine = ++token.current;
    if (rolesRef.current.length === 0) {
      // No module that needs an agent is on (or installed): nothing to ask.
      setStates({});
      setLoaded(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    let result: Awaited<ReturnType<typeof loadTeam>>;
    let skills: Awaited<ReturnType<typeof checkSkills>>;
    try {
      result = await loadTeam({ companyId, roles: rolesRef.current, installed: installedRef.current });
      skills = await checkSkills(companyId, Object.values(result.states).filter((state): state is TeamRoleState => !!state), installedRef.current);
    } catch (error) {
      // loadTeam handles each role itself; this only guards against the unexpected. Never break the page.
      if (mine !== token.current) return;
      setStates(Object.fromEntries(rolesRef.current.map((role) => [role.key, failedRoleState(role, roleLoadError(role, errorText(error)))])));
      setLoaded(true);
      setLoading(false);
      return;
    }
    if (mine !== token.current) return;
    const next: Partial<Record<TeamRoleKey, TeamRoleState>> = {};
    for (const [key, state] of Object.entries(result.states) as Array<[TeamRoleKey, TeamRoleState]>) {
      next[key] = state.agent ? { ...state, missingSkills: skills[key]?.missing ?? [], extras: skills[key]?.extras ?? null } : state;
    }
    setAgents(result.agents);
    setUsers(result.users);
    setCockpit(result.cockpit);
    setStates(next);
    setLoaded(true);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    if (!ready || !companyId) return;
    void reload();
  }, [ready, companyId, rolesKey, installKey, reload]);

  const changed = useCallback(async (role: TeamRole) => {
    await reload();
    onChanged.current?.(role.pluginKey);
  }, [reload]);

  const findRole = (key: TeamRoleKey) => rolesRef.current.find((role) => role.key === key) ?? null;
  const cockpitPluginId = installed?.[COCKPIT_PLUGIN_KEY]?.id ?? null;

  async function openHire(key: TeamRoleKey) {
    const role = findRole(key);
    if (!role || !companyId) return;
    setBusy(key, "hire");
    setNote(key, null);
    try {
      setDialog({ kind: "hire", role, options: await fetchHireOptions(companyId, role) });
    } catch (error) {
      setNote(key, { tone: "bad", title: `Could not open the ${role.title} hire`, lines: [errorText(error)] });
    } finally {
      setBusy(key, null);
    }
  }

  // Throws on failure: the hire dialog shows the error and stays open.
  async function createHire(task: HireTask) {
    if (dialog?.kind !== "hire" || !companyId) return;
    const { role, options } = dialog;
    const hire = await startHire(companyId, role, task);
    setDialog(null);
    const agentName = task.assigneeAgentId ? options.agents.find((agent) => agent.id === task.assigneeAgentId)?.name ?? "the agent" : null;
    const who = agentName ?? (task.assigneeUserId ? (task.assigneeUserId === me ? "you" : "a board member") : null);
    setNote(role.key, {
      tone: "ok",
      title: hire?.identifier ? `Opened hire task ${hire.identifier} for the ${role.title}` : `Opened a hire task for the ${role.title}`,
      lines: [
        who ? `Assigned to ${who}.` : "Nobody is assigned, so it waits in Backlog.",
        `When the new agent appears, the ${pluginName(role)} plugin links it and sets it up, then comments on the task.`,
      ],
    });
    await changed(role);
  }

  async function openPick(key: TeamRoleKey) {
    const role = findRole(key);
    if (!role || !companyId) return;
    setNote(key, null);
    if (!agents) {
      setBusy(key, "pick");
      const fresh = await fetchCompanyAgents(companyId);
      setBusy(key, null);
      if (!fresh) {
        setNote(key, { tone: "bad", title: "Could not list the company's agents", lines: ["Check your connection, then try again."] });
        return;
      }
      setAgents(fresh);
    }
    setDialog({ kind: "pick", role });
  }

  // Throws on failure: the pick dialog shows the error and stays open.
  async function link(role: TeamRole, agentId: string) {
    if (!companyId) return;
    const current = statesRef.current;
    const agent = agents?.find((candidate) => candidate.id === agentId) ?? current[role.key]?.candidates.find((candidate) => candidate.id === agentId) ?? null;
    const name = agent?.name ?? "The agent";
    let steps: string[] = [];
    let instructions: string[] = [];
    let settingsNote: string | null = null;
    if (role.cockpitRole) {
      const conflict = cockpitConflict({ kind: role.cockpitRole, agentId, operator: current.operator?.agent ?? null, reviewer: current.reviewer?.agent ?? null });
      if (conflict) throw new Error(conflict);
      const saved = await saveCockpitTeam({ companyId, patch: cockpitRolePatch(role.cockpitRole, agentId), settingsSaved: cockpit?.settingsSaved ?? true, cockpitPluginId });
      steps = saved.steps;
      settingsNote = saved.settingsNote;
    } else {
      ({ steps, instructions } = await linkPluginRole(companyId, role, agentId));
    }
    setDialog(null);
    // A plugin worker cannot change an agent's skills; the signed-in person can.
    const skill = await attachRoleSkills({ companyId, agentId, agentName: name, role, installed: installedRef.current });
    setNote(role.key, {
      tone: skill.ok && !settingsNote ? "ok" : "info",
      title: `${name} is now the ${role.title}`,
      lines: [...(skill.ok ? dropSkillAsks(steps, role.skills) : steps), skill.line, ...(settingsNote ? [settingsNote] : [])],
      next: skill.ok ? dropSkillAsks(instructions, role.skills) : instructions,
    });
    await changed(role);
  }

  function openRemove(key: TeamRoleKey) {
    const role = findRole(key);
    if (!role) return;
    setNote(key, null);
    setDialog({ kind: "remove", role });
  }

  // Throws on failure: the confirm dialog shows the error and stays open.
  async function unlink(role: TeamRole) {
    if (!companyId) return;
    const name = statesRef.current[role.key]?.agent?.name ?? "The agent";
    let extra: string[] = [];
    if (role.cockpitRole) {
      const saved = await saveCockpitTeam({ companyId, patch: cockpitRolePatch(role.cockpitRole, null), settingsSaved: cockpit?.settingsSaved ?? true, cockpitPluginId });
      extra = saved.settingsNote ? [saved.settingsNote] : [];
    } else {
      await unlinkPluginRole(companyId, role);
    }
    setDialog(null);
    setNote(role.key, {
      tone: "info",
      title: `Removed ${name} as the ${role.title}`,
      lines: ["The agent itself, its routines and its tasks were not changed.", ...extra],
    });
    await changed(role);
  }

  async function attachSkills(key: TeamRoleKey) {
    const state = statesRef.current[key];
    const agent = state?.agent;
    const missing = state?.missingSkills ?? [];
    if (!companyId || !state || !agent || missing.length === 0) return;
    setBusy(key, "skills");
    setNote(key, null);
    try {
      const added = await attachMissingSkills({ companyId, agentId: agent.id, agentName: agent.name, skills: missing });
      const left = await missingAgentSkills(agent.id, companyId, state.role.skills);
      setStates((prev) => {
        const current = prev[key];
        return current && current.agent?.id === agent.id ? { ...prev, [key]: { ...current, missingSkills: left } } : prev;
      });
      setNote(key, { tone: "ok", title: `Attached ${skillNames(added.length ? added : missing)} to ${agent.name}`, lines: [`${agent.name} now knows the ${state.role.title} procedure. Its other skills stay.`] });
    } catch (error) {
      setNote(key, {
        tone: "bad",
        title: `Could not attach ${skillNames(missing)} to ${agent.name}`,
        lines: [errorText(error), `Add ${missing.length === 1 ? "it" : "them"} in Agents → ${agent.name} → Skills.`],
      });
    } finally {
      setBusy(key, null);
    }
  }

  /** Attach the role's extra skills whose modules are installed (they are never counted as missing). */
  async function attachExtras(key: TeamRoleKey) {
    const state = statesRef.current[key];
    const agent = state?.agent;
    const keys = extrasToAttach(state?.extras);
    if (!companyId || !state || !agent || keys.length === 0) return;
    setBusy(key, "extras");
    setNote(key, null);
    try {
      await attachMissingSkills({ companyId, agentId: agent.id, agentName: agent.name, skills: keys });
      setStates((prev) => {
        const current = prev[key];
        if (!current || current.agent?.id !== agent.id) return prev;
        return { ...prev, [key]: { ...current, extras: (current.extras ?? []).map((extra) => (keys.includes(extra.key) ? { ...extra, attached: true } : extra)) } };
      });
      setNote(key, { tone: "ok", title: `Attached ${skillNames(keys)} to ${agent.name}`, lines: [`${agent.name} can now do that work in those modules too. Its other skills stay.`] });
    } catch (error) {
      setNote(key, { tone: "bad", title: `Could not attach ${skillNames(keys)} to ${agent.name}`, lines: [errorText(error), `Add ${keys.length === 1 ? "it" : "them"} in Agents → ${agent.name} → Skills.`] });
    } finally {
      setBusy(key, null);
    }
  }

  async function resync(key: TeamRoleKey) {
    const role = findRole(key);
    const agent = statesRef.current[key]?.agent;
    if (!role || !companyId) return;
    setBusy(key, "resync");
    setNote(key, null);
    try {
      const result = await resyncRole(companyId, role);
      setNote(key, { tone: "ok", title: `Re-synced ${agent?.name ?? `the ${role.title}`}`, lines: result.steps, next: result.instructions });
      await changed(role);
    } catch (error) {
      setNote(key, { tone: "bad", title: "Re-sync failed", lines: [errorText(error)] });
    } finally {
      setBusy(key, null);
    }
  }

  async function saveSettings(kind: "owner" | "review", patch: Parameters<typeof saveCockpitTeam>[0]["patch"], optimistic: Partial<CockpitRoles>, done: string) {
    if (!companyId || !cockpit) return;
    const previous = cockpit;
    setCockpit({ ...cockpit, roles: { ...(cockpit.roles ?? NO_ROLES), ...optimistic } });
    setBusy("settings", kind);
    setNote("settings", null);
    try {
      const saved = await saveCockpitTeam({ companyId, patch, settingsSaved: cockpit.settingsSaved, cockpitPluginId });
      setNote("settings", { tone: saved.settingsNote ? "info" : "ok", title: done, lines: saved.settingsNote ? [saved.settingsNote] : undefined });
      await reload();
      onChanged.current?.(COCKPIT_PLUGIN_KEY);
    } catch (error) {
      setCockpit(previous);
      setNote("settings", { tone: "bad", title: kind === "owner" ? "Could not save who gets the daily brief" : "Could not save the review setting", lines: [errorText(error)] });
    } finally {
      setBusy("settings", null);
    }
  }

  async function saveOwner(userId: string) {
    const choice = ownerChoices({ users, me, ownerUserId: cockpit?.roles?.ownerUserId ?? null }).find((user) => user.id === userId);
    const done = !userId ? "Nobody gets the daily brief now." : choice?.me ? "You get the daily brief." : `${choice?.name ?? "They"} gets the daily brief.`;
    await saveSettings("owner", ownerPatch(userId), { ownerUserId: userId || null }, done);
  }

  async function saveReview(on: boolean) {
    const done = on ? "The Reviewer now checks outward-facing work before you approve it." : "Outward-facing work now comes straight to you for approval.";
    await saveSettings("review", reviewPatch(on), { reviewOutward: on }, done);
  }

  const hiring = useMemo(() => (agents ? pickHiringAgent(agents.map(teamAgentCandidate)) : null), [agents]);

  return {
    roles,
    states,
    agents,
    users,
    cockpit,
    hiring,
    loaded,
    loading,
    me,
    prefix: host.companyPrefix ?? null,
    busy,
    notes,
    dialog,
    reload,
    openHire,
    createHire,
    openPick,
    link,
    openRemove,
    unlink,
    attachSkills,
    attachExtras,
    resync,
    saveOwner,
    saveReview,
    closeDialog: () => setDialog(null),
    dismissNote: (key) => setNote(key, null),
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 } as const;
/** Room for the host's sticky header when a link scrolls to a row (it is taller on phones). */
const SCROLL_MARGIN = 80;
const linkStyle = { color: tokens.primary, fontWeight: 600, textDecoration: "none" } as const;

/** A note line from a plugin: short markdown (**bold**, `code`, [links](/path)), never shown raw. */
function Inline({ text }: { text: string }) {
  return <InlineText text={text} />;
}

const HEALTH: Record<TeamRowHealth, { label: string; tone: ToneInput; icon: LucideIcon }> = {
  missing: { label: "Missing", tone: "bad", icon: CircleAlert },
  hiring: { label: "Hiring", tone: "info", icon: Hourglass },
  attention: { label: "Needs attention", tone: "warn", icon: TriangleAlert },
  ok: { label: "OK", tone: "ok", icon: CircleCheck },
  loading: { label: "Checking…", tone: "neutral", icon: LoaderCircle },
  unknown: { label: "Can't check", tone: "neutral", icon: CircleQuestionMark },
};

export function healthLabel(role: Pick<TeamRole, "required" | "coveredBy">, health: TeamRowHealth): { label: string; tone: ToneInput; icon: LucideIcon } {
  if (health === "missing" && !role.required) return { label: coverTitle(role) ? "Covered" : "Not hired", tone: "neutral", icon: CircleDot };
  return HEALTH[health];
}

export function HealthPill({ role, health }: { role: Pick<TeamRole, "required" | "coveredBy">; health: TeamRowHealth }) {
  const pill = healthLabel(role, health);
  return <Pill tone={pill.tone} icon={pill.icon}>{pill.label}</Pill>;
}

const STATUS_TONE: Record<string, ToneInput> = { active: "ok", running: "ok", idle: "ok", paused: "warn", pending_approval: "warn", error: "bad" };

function AgentName({ agent, linkFor }: { agent: TeamAgent; linkFor: LinkPropsFor }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 13, ...breakAnywhere }}>
      <StatusDot tone={STATUS_TONE[agent.status] ?? "neutral"} size={7} />
      <a {...linkFor(agentPath(agent))} style={linkStyle}>{agent.name}</a>
      <span style={{ color: tokens.muted }}>{words(agent.status) || "unknown"}</span>
    </span>
  );
}

export function TeamNote({ note, onDismiss }: { note: RowNote; onDismiss?: () => void }) {
  const t = tone(note.tone === "bad" ? "bad" : note.tone === "ok" ? "ok" : "info");
  return (
    <div role="status" style={{ display: "grid", gap: 6, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.soft, color: tokens.fg, fontSize: 12.5, lineHeight: 1.5, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <strong style={{ flex: 1, minWidth: 0, ...breakAnywhere }}>{note.title}</strong>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} aria-label="Dismiss" style={{ appearance: "none", border: "none", background: "transparent", color: tokens.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, minWidth: 32, minHeight: 24, flexShrink: 0 }}>×</button>
        ) : null}
      </div>
      {note.lines?.length ? (
        <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc outside", ...breakAnywhere }}>
          {note.lines.map((line, index) => <li key={index}><Inline text={line} /></li>)}
        </ul>
      ) : null}
      {note.next?.length ? (
        <>
          <span style={{ fontWeight: 600 }}>Next:</span>
          <ol style={{ margin: 0, paddingLeft: 20, listStyle: "decimal outside", ...breakAnywhere }}>
            {note.next.map((line, index) => <li key={index}><Inline text={line} /></li>)}
          </ol>
        </>
      ) : null}
    </div>
  );
}

const LINKED_BY: Record<string, string> = { auto: "linked from the hire task", manual: "picked by hand", managed: "set up before hiring moved to tasks" };

export interface TeamRoleRowProps {
  state: TeamRoleState;
  open: boolean;
  /** The address points at this row. */
  highlight?: boolean;
  /** What the row is doing: hire, pick, skills or resync. */
  busy?: string | null;
  note?: RowNote | null;
  linkFor: LinkPropsFor;
  now?: number;
  onToggle?: () => void;
  onHire?: () => void;
  onPick?: () => void;
  onRemove?: () => void;
  onAttach?: () => void;
  onAttachExtras?: () => void;
  onResync?: () => void;
  onRetry?: () => void;
  onDismissNote?: () => void;
}

const EXTRA_LABEL = (extra: ExtraSkillState): { text: string; tone: ToneInput } => {
  if (!extra.installed) return { text: "module not installed", tone: "neutral" };
  if (extra.attached === true) return { text: "attached", tone: "ok" };
  if (extra.exists === false) return { text: "not in this company yet", tone: "neutral" };
  if (extra.attached === false) return { text: "not attached", tone: "warn" };
  return { text: "not checked", tone: "neutral" };
};

/**
 * "Also works in": other modules' skills the role uses, by plain name
 * ("Billing: invoice drafting"). Never counted as missing. Only shown once an
 * agent holds the role (before that there is nothing to attach them to).
 */
export function ExtraSkills({ extras, role, busy, onAttach }: { extras: ExtraSkillState[]; role: Pick<TeamRole, "title">; busy?: boolean; onAttach?: () => void }) {
  if (extras.length === 0) return null;
  const toAttach = extrasToAttach(extras);
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Also works in</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
        {extras.map((extra) => {
          const label = EXTRA_LABEL(extra);
          return (
            <Pill key={extra.key} tone={label.tone} size="sm" dot={extra.installed && extra.exists !== false}>
              {skillLabel(extra.key)}
              <span style={{ opacity: 0.8 }}>{` · ${label.text}`}</span>
            </Pill>
          );
        })}
        {toAttach.length && onAttach ? (
          <Button type="button" variant="secondary" style={{ padding: "0 12px" }} disabled={busy} onClick={onAttach}>{busy ? "Attaching…" : `Attach ${toAttach.length === 1 ? "it" : `these ${toAttach.length}`}`}</Button>
        ) : null}
      </div>
      <span style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.45 }}>So the {role.title} can also do that work. These never count as missing.</span>
    </div>
  );
}

/** One role: a compact line when ok, the whole story and its actions when it needs something. */
export function TeamRoleRow({ state, open, highlight, busy, note, linkFor, now, onToggle, onHire, onPick, onRemove, onAttach, onAttachExtras, onResync, onRetry, onDismissNote }: TeamRoleRowProps) {
  const role = state.role;
  const health = roleHealth(state);
  const agent = state.agent;
  const hire = !agent && state.hire?.status === "open" ? state.hire : null;
  const working = !!busy;
  const bodyId = `team-${role.key}-body`;
  const t = tone(healthLabel(role, health).tone);

  let status: ReactNode;
  if (health === "loading") status = <span style={muted}>Checking…</span>;
  else if (health === "unknown") status = <span style={muted}>Could not check</span>;
  else if (agent) status = <AgentName agent={agent} linkFor={linkFor} />;
  else if (hire) status = <span style={{ fontSize: 13 }}>Hire task <a {...linkFor(hirePath(hire))} style={linkStyle}>{hire.identifier ?? "open"}</a> is open</span>;
  else status = <span style={muted}>{coverTitle(role) ? `The ${coverTitle(role)} covers it` : "No one yet"}</span>;

  // Full-height (36px) buttons: the page is used on phones.
  const small = { padding: "0 12px" } as const;
  const buttons: ReactNode[] = [];
  if (health === "unknown" && onRetry) buttons.push(<Button key="retry" type="button" variant="secondary" style={small} onClick={onRetry}>Check again</Button>);
  if (health === "missing") {
    buttons.push(<Button key="hire" type="button" style={small} disabled={working} onClick={onHire}>{busy === "hire" ? "Opening…" : `Hire ${role.title}`}</Button>);
    buttons.push(<Button key="pick" type="button" variant="secondary" style={small} disabled={working} onClick={onPick}>{busy === "pick" ? "Loading…" : "Pick existing"}</Button>);
  }
  if (health === "hiring") {
    buttons.push(<Button key="pick" type="button" variant="secondary" style={small} disabled={working} onClick={onPick}>{busy === "pick" ? "Loading…" : state.candidates.length ? "Pick the new agent" : "Pick existing"}</Button>);
    if (hireStale(state.hire, now)) buttons.push(<Button key="hire" type="button" variant="secondary" style={small} disabled={working} onClick={onHire}>{busy === "hire" ? "Opening…" : "Open a new hire task"}</Button>);
  }
  if (agent && (health === "attention" || health === "ok")) {
    if (state.missingSkills?.length) buttons.push(<Button key="skills" type="button" style={small} disabled={working} onClick={onAttach}>{busy === "skills" ? "Attaching…" : "Attach missing skills"}</Button>);
    if (role.actions.resync) buttons.push(<Button key="resync" type="button" variant="secondary" style={small} disabled={working} onClick={onResync}>{busy === "resync" ? "Re-syncing…" : "Re-sync"}</Button>);
    buttons.push(<Button key="change" type="button" variant="secondary" style={small} disabled={working} onClick={onPick}>{busy === "pick" ? "Loading…" : "Change"}</Button>);
    // An agent set up before hiring moved to tasks is found again after an unlink, so it cannot be removed here.
    if (state.linkedBy !== "managed") buttons.push(<Button key="remove" type="button" variant="secondary" style={small} disabled={working} onClick={onRemove}>Remove</Button>);
  }

  return (
    <div
      id={`team-${role.key}`}
      data-health={health}
      style={{
        display: "grid",
        gap: 10,
        padding: "12px 12px 12px 14px",
        borderRadius: 12,
        border: `1px solid ${highlight ? tokens.ring : tokens.border}`,
        boxShadow: highlight ? `0 0 0 2px color-mix(in oklab, ${tokens.ring} 35%, transparent)` : undefined,
        background: tokens.bg,
        position: "relative",
        minWidth: 0,
        scrollMarginTop: SCROLL_MARGIN,
      }}
    >
      <span aria-hidden="true" style={{ position: "absolute", left: -1, top: 10, bottom: 10, width: 3, borderRadius: 999, background: t.solid, opacity: health === "ok" ? 0.45 : health === "loading" || health === "unknown" ? 0.3 : 1 }} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
        <div style={{ display: "flex", gap: "6px 10px", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <HealthPill role={role} health={health} />
          <strong style={{ fontSize: 14 }}>{role.title}</strong>
          {role.required ? null : <Pill size="sm">optional</Pill>}
          <span style={{ minWidth: 0, display: "inline-flex" }}>{status}</span>
        </div>
        {health !== "loading" && onToggle ? (
          <Button type="button" variant="secondary" aria-expanded={open} aria-controls={bodyId} style={small} onClick={onToggle}>
            {open ? "Hide" : health === "ok" ? "Manage" : health === "missing" ? "Set up" : "Open"}
          </Button>
        ) : null}
      </div>
      {open && health !== "loading" ? (
        <div id={bodyId} style={{ display: "grid", gap: 10, minWidth: 0 }}>
          <p style={muted}>{role.summary}</p>
          {health === "unknown" ? <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, ...breakAnywhere }}>{state.error}</p> : null}
          {health === "missing" ? (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              {coverTitle(role) ? `Until you hire one, the ${coverTitle(role)} does this work. ` : ""}Hire opens a ready-made hire task for whoever hires here (usually the CEO). The new agent is linked and set up for you. Already have one? Pick it.
            </p>
          ) : null}
          {hire ? (
            <div style={{ display: "grid", gap: 4, fontSize: 13, lineHeight: 1.5 }}>
              <span>
                Hire task <a {...linkFor(hirePath(hire))} style={linkStyle}>{hire.identifier ?? hire.title ?? "open"}</a> is open. The {pluginName(role)} plugin links the new agent automatically when it appears.
              </span>
              {hireStale(state.hire, now) ? <span style={{ color: tone("warn").fg }}>It has been open for more than a week. If nobody is working on it, open a new hire task.</span> : null}
              {state.candidates.length > 1 ? <span>More than one new agent looks like the {role.title} ({state.candidates.map((c) => c.name).join(", ")}), so none was linked. Pick the right one.</span> : null}
            </div>
          ) : null}
          {agent ? (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, ...breakAnywhere }}>
              <a {...linkFor(agentPath(agent))} style={linkStyle}>{agent.name}</a>
              {agentDetail(agent) && agentDetail(agent) !== role.title ? <span style={{ color: tokens.muted }}> · {agentDetail(agent)}</span> : null}
              {` is the ${role.title} (${words(agent.status) || "unknown"})`}
              {state.linkedBy && LINKED_BY[state.linkedBy] ? <span style={{ color: tokens.muted }}>, {LINKED_BY[state.linkedBy]}</span> : null}.
            </p>
          ) : null}
          {health === "attention" ? (
            <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc outside", fontSize: 13, lineHeight: 1.55, color: tone("warn").fg }}>
              {attentionLines(state).map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          <RunProfileLine state={state} />
          {buttons.length ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{buttons}</div> : null}
          {role.extraSkills?.length && agent && state.extras?.length ? (
            <ExtraSkills extras={state.extras} role={role} busy={busy === "extras"} onAttach={onAttachExtras} />
          ) : null}
        </div>
      ) : null}
      {note ? <TeamNote note={note} onDismiss={onDismissNote} /> : null}
    </div>
  );
}

/**
 * The run profile a role should have (model, run time, how many at once) and, for a
 * linked agent whose settings were read, what it lacks. A plugin cannot change an
 * agent's settings: the fix is the agent's Configuration (or the server's
 * new-company script), so the line says what to set and never claims it did.
 */
export function RunProfileLine({ state }: { state: TeamRoleState }) {
  const profile = state.role.runProfile;
  const problems = runProfileProblemsFor(state.agent);
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span style={muted}>Run profile: {runProfileText(profile)}.</span>
      {problems.length ? (
        <span style={{ fontSize: 12.5, lineHeight: 1.5, color: tone("warn").fg }}>
          {state.agent?.name ?? "The agent"} runs without it ({problems.join("; ")}). Open its Configuration and set the model, a run timeout and the turn cap above: a plugin cannot change agent settings.
        </span>
      ) : null}
    </div>
  );
}

export interface TeamSettingsProps {
  users: BoardUser[] | null;
  me: string | null;
  ownerUserId: string | null;
  reviewOutward: boolean;
  /** The Reviewer agent, when there is one (the switch only shows then). */
  reviewer: TeamAgent | null;
  busy?: string | null;
  note?: RowNote | null;
  /** Links (the invite link when nobody can get the brief yet). */
  linkFor?: LinkPropsFor;
  onOwner: (userId: string) => void;
  onReview: (on: boolean) => void;
  onDismissNote?: () => void;
}

/** Company settings → Members, on the invites tab. */
export const INVITE_PATH = "/company/settings/members?tab=invites";

/** "Who gets the daily brief" and "Reviewer checks outward-facing work before you approve". */
export function TeamSettings({ users, me, ownerUserId, reviewOutward, reviewer, busy, note, linkFor, onOwner, onReview, onDismissNote }: TeamSettingsProps) {
  const choices = ownerChoices({ users, me, ownerUserId });
  const label = "Reviewer checks outward-facing work before you approve";
  return (
    <div id={OWNER_ANCHOR} style={{ display: "grid", gap: 14, paddingTop: 14, borderTop: `1px solid ${tokens.border}`, minWidth: 0, scrollMarginTop: SCROLL_MARGIN }}>
      {choices.length ? (
        <div style={{ display: "grid", gap: 6, minWidth: 0, maxWidth: 480 }}>
          <Field label="Who gets the daily brief">
            <Select value={ownerUserId ?? ""} disabled={busy === "owner"} onChange={(event) => onOwner(event.target.value)}>
              <option value="">Nobody yet</option>
              {choices.map((choice) => <option key={choice.id} value={choice.id}>{ownerLabel(choice)}</option>)}
            </Select>
          </Field>
          <p style={muted}>The Operator sends this person one short brief each morning, and approvals go to them by default.</p>
        </div>
      ) : (
        <div role="note" style={{ display: "grid", gap: 6, padding: "10px 12px", borderRadius: 10, border: `1px solid ${tone("warn").border}`, background: tone("warn").soft, minWidth: 0, maxWidth: 560 }}>
          <strong style={{ fontSize: 13 }}>Nobody can get the daily brief yet</strong>
          <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            {users === null
              ? "The people in this company could not be read just now. Check again in a moment, or invite a person under Company settings → Members."
              : "It goes to a person who signs in to this company, and there is nobody to pick yet. Invite a person under Company settings → Members, then pick them here."}
          </span>
          {linkFor ? (
            <a {...linkFor(INVITE_PATH)} style={{ ...linkStyle, fontSize: 13, display: "inline-flex", alignItems: "center", minHeight: 32 }}>Invite a person →</a>
          ) : null}
        </div>
      )}
      {reviewer ? (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0 }}>
          <Switch checked={reviewOutward} onChange={onReview} label={label} disabled={busy === "review"} />
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <strong style={{ fontSize: 13 }}>{label}</strong>
            <span style={muted}>Posts, campaign emails, invoice and quote emails and SEO pull requests go to {reviewer.name} first. You still approve.</span>
          </div>
        </div>
      ) : null}
      {note ? <TeamNote note={note} onDismiss={onDismissNote} /> : null}
    </div>
  );
}

/**
 * Who does the hiring, and, when nobody can, the problem and the fix (Q7-4). Hire
 * tasks go to the agent that hires; without one they would sit unread.
 */
export function HiringNotice({ hiring }: { hiring: HiringPick | null }) {
  if (!hiring) return null;
  if (!hiring.agent) {
    return (
      <div role="status" data-testid="no-hiring-agent" style={{ display: "grid", gap: 6, padding: "10px 12px", borderRadius: 12, border: `1px solid ${tone("bad").border}`, background: tone("bad").soft, minWidth: 0 }}>
        <strong style={{ fontSize: 13.5 }}>Nobody can do this company's hiring yet</strong>
        <span style={{ fontSize: 13, lineHeight: 1.5 }}>{hiring.problem}</span>
        <span style={{ fontSize: 13, lineHeight: 1.5 }}><strong>Fix:</strong> {hiring.fix}</span>
      </div>
    );
  }
  return <span data-testid="hiring-agent" style={muted}>{hiringLine(hiring)} Hire tasks go to it by default.</span>;
}

/** The Team section at the top of the Setup page (`#team`, `?section=team`). */
export function TeamSection({ team, linkFor, focusAnchor, now }: { team: TeamController; linkFor: LinkPropsFor; focusAnchor?: string | null; now?: number }) {
  const [open, setOpen] = useState<Partial<Record<TeamRoleKey, boolean>>>({});
  const narrow = useIsNarrow();
  const focusRole = anchorRole(focusAnchor);
  // On a phone only the first role that needs you opens by itself; the rest stay one line.
  const firstOpen = team.roles.find((role) => rowOpenByDefault(role, roleHealth(team.states[role.key] ?? emptyRoleState(role))))?.key ?? null;
  useEffect(() => {
    if (focusRole) setOpen((prev) => ({ ...prev, [focusRole]: true }));
  }, [focusRole]);

  const summary = teamSummary(team.roles.map((role) => team.states[role.key]));
  const reviewer = team.states.reviewer?.agent ?? null;
  const pill = summary.loading && !team.loaded
    ? <Pill tone="neutral" icon={LoaderCircle}>Checking…</Pill>
    : summary.needYou
      ? <Pill tone="bad" dot>{summary.needYou} {summary.needYou === 1 ? "needs you" : "need you"}</Pill>
      : summary.hiring
        ? <Pill tone="info" dot>{summary.hiring} hiring</Pill>
        : <Pill tone="ok" dot>All staffed</Pill>;

  return (
    <SectionCard
      id={TEAM_ANCHOR}
      title="Team"
      subtitle="Hire the company's agents here and watch them in the Cockpit."
      icon={Users}
      accent="setup"
      strip={summary.needYou > 0}
      style={{ scrollMarginTop: SCROLL_MARGIN }}
      actions={(
        <>
          {pill}
          <Button type="button" variant="secondary" onClick={() => void team.reload()} disabled={team.loading}>{team.loading ? "Checking…" : "Check again"}</Button>
        </>
      )}
    >
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        <HiringNotice hiring={team.hiring} />
        {team.roles.map((role) => {
          const state = team.states[role.key] ?? emptyRoleState(role);
          const health = roleHealth(state);
          const isOpen = open[role.key] ?? (role.key === focusRole || (narrow ? role.key === firstOpen : rowOpenByDefault(role, health)));
          return (
            <TeamRoleRow
              key={role.key}
              state={state}
              open={isOpen}
              highlight={role.key === focusRole}
              busy={team.busy[role.key] ?? null}
              note={team.notes[role.key] ?? null}
              linkFor={linkFor}
              now={now}
              onToggle={() => setOpen((prev) => ({ ...prev, [role.key]: !isOpen }))}
              onHire={() => void team.openHire(role.key)}
              onPick={() => void team.openPick(role.key)}
              onRemove={() => team.openRemove(role.key)}
              onAttach={() => void team.attachSkills(role.key)}
              onAttachExtras={() => void team.attachExtras(role.key)}
              onResync={() => void team.resync(role.key)}
              onRetry={() => void team.reload()}
              onDismissNote={() => team.dismissNote(role.key)}
            />
          );
        })}
      </div>
      {team.cockpit && team.roles.some((role) => role.cockpitRole) ? (
        <TeamSettings
          users={team.users}
          me={team.me}
          ownerUserId={team.cockpit.roles?.ownerUserId ?? null}
          reviewOutward={team.cockpit.roles?.reviewOutward ?? false}
          reviewer={reviewer}
          busy={team.busy.settings ?? null}
          note={team.notes.settings ?? null}
          linkFor={linkFor}
          onOwner={(userId) => void team.saveOwner(userId)}
          onReview={(on) => void team.saveReview(on)}
          onDismissNote={() => team.dismissNote("settings")}
        />
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Guided setup: the team steps
// ---------------------------------------------------------------------------

function StepPills() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Pill tone="neutral" icon={Users}>Team</Pill>
      <Pill tone="info" size="md">Step 1 · Team</Pill>
    </div>
  );
}

export function GuideTeamStep({ state, busy, note, onHire, onPick, onSkip, onDismissNote }: {
  state: TeamRoleState;
  busy?: string | null;
  note?: RowNote | null;
  onHire: () => void;
  onPick: () => void;
  onSkip: () => void;
  onDismissNote?: () => void;
}) {
  const role = state.role;
  return (
    <Card highlight module={role.module}>
      <StepPills />
      <strong style={{ fontSize: 16 }}>Hire the {role.title}</strong>
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>{role.summary}</p>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Hire opens a prefilled hire task for whoever hires for this company (usually the CEO). When the new agent appears, the {pluginName(role)} plugin links it and sets it up. Already have an agent for this? Pick it instead.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button type="button" onClick={onHire} disabled={!!busy}>{busy === "hire" ? "Opening…" : `Hire ${role.title}`}</Button>
        <Button type="button" variant="secondary" onClick={onPick} disabled={!!busy}>{busy === "pick" ? "Loading…" : "Pick existing"}</Button>
        <Button type="button" variant="secondary" onClick={onSkip}>Skip for now</Button>
      </div>
      {note ? <TeamNote note={note} onDismiss={onDismissNote} /> : null}
    </Card>
  );
}

export function GuideOwnerStep({ users, me, ownerUserId, busy, note, onSave, onSkip, onDismissNote }: {
  users: BoardUser[] | null;
  me: string | null;
  ownerUserId: string | null;
  busy?: boolean;
  note?: RowNote | null;
  onSave: (userId: string) => void;
  onSkip: () => void;
  onDismissNote?: () => void;
}) {
  const choices = ownerChoices({ users, me, ownerUserId });
  const [value, setValue] = useState(ownerUserId ?? choices.find((choice) => choice.me)?.id ?? choices[0]?.id ?? "");
  return (
    <Card highlight module="cockpit">
      <StepPills />
      <strong style={{ fontSize: 16 }}>Who gets the daily brief?</strong>
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>The Operator sends this person one short brief each morning, and approvals go to them by default.</p>
      <Field label="Daily brief goes to">
        <Select value={value} onChange={(event) => setValue(event.target.value)}>
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{ownerLabel(choice)}</option>)}
        </Select>
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button type="button" onClick={() => onSave(value)} disabled={!value || busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="secondary" onClick={onSkip}>Skip for now</Button>
      </div>
      {note ? <TeamNote note={note} onDismiss={onDismissNote} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function PickAgentModal({ team, role }: { team: TeamController; role: TeamRole }) {
  const state = team.states[role.key];
  const choices = pickChoices({ role, agents: team.agents, states: team.states });
  const candidates = choices.filter((choice) => choice.candidate);
  const others = choices.filter((choice) => !choice.candidate);
  const [agentId, setAgentId] = useState(candidates.find((choice) => !choice.blocked)?.agent.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = state?.agent ?? null;
  const picked = choices.find((choice) => choice.agent.id === agentId) ?? null;

  async function submit() {
    if (!agentId) return;
    setBusy(true);
    setError("");
    try {
      await team.link(role, agentId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const option = (choice: (typeof choices)[number]) => (
    <option key={choice.agent.id} value={choice.agent.id} disabled={!!choice.blocked}>{pickLabel(choice)}</option>
  );
  return (
    <Modal
      open
      title={current ? `Change the ${role.title}` : `Pick the ${role.title}`}
      description={`Pick the agent that does this work. The ${pluginName(role)} plugin gives it the tools and work it needs. The agent's own settings are not changed.`}
      onClose={team.closeDialog}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={team.closeDialog} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => void submit()} disabled={!agentId || agentId === current?.id || !!picked?.blocked || busy}>
            {busy ? "Saving…" : current ? "Change" : "Use this agent"}
          </Button>
        </>
      )}
    >
      <Field label="Agent">
        <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="">Choose an agent…</option>
          {candidates.length ? <optgroup label={`Looks like the new ${role.title}`}>{candidates.map(option)}</optgroup> : null}
          {others.length ? <optgroup label={candidates.length ? "Other agents" : "Agents"}>{others.map(option)}</optgroup> : null}
        </Select>
      </Field>
      {choices.length === 0 ? <p style={muted}>This company has no agents yet. Hire one instead.</p> : null}
      {role.cockpitRole ? <p style={muted}>The Operator and the Reviewer must be different agents.</p> : null}
      <p style={muted}>Picking attaches {skillNames(role.skills)}{role.extraSkills?.length ? ", and the skills it uses in installed modules," : ""} to the agent for you (its other skills stay).</p>
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: tone("bad").fg, ...breakAnywhere }}>{error}</p> : null}
    </Modal>
  );
}

function RemoveAgentModal({ team, role }: { team: TeamController; role: TeamRole }) {
  const name = team.states[role.key]?.agent?.name ?? "the agent";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await team.unlink(role);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`Remove ${name} as the ${role.title}?`}
      description="The agent itself, its routines and its tasks are not changed."
      onClose={team.closeDialog}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={team.closeDialog} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>{busy ? "Removing…" : "Remove"}</Button>
        </>
      )}
    >
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>The {pluginName(role)} plugin stops giving {name} {role.title} work. You can hire or pick another {role.title} here any time.</p>
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: tone("bad").fg, ...breakAnywhere }}>{error}</p> : null}
    </Modal>
  );
}

/** Hire, pick and remove dialogs. Render after guided setup so they open above it. */
export function TeamDialogs({ team }: { team: TeamController }) {
  const dialog = team.dialog;
  const hire = dialog?.kind === "hire" ? dialog : null;
  // The agent that does the hiring is the default (Setup's rule: CEO by role or title, else the head of the org chart), even when the plugin's own default is someone else.
  const hiringAgent = team.hiring?.agent ?? null;
  const assignees: TaskAssigneeOption[] = hire
    ? [
      ...(team.me ? [{ kind: "user" as const, id: team.me, name: "Me" }] : []),
      ...hire.options.agents.map((agent) => ({ kind: "agent" as const, id: agent.id, name: agent.name, detail: agentDetail(agent), status: agent.status })),
      ...(hiringAgent && !hire.options.agents.some((agent) => agent.id === hiringAgent.id) ? [{ kind: "agent" as const, id: hiringAgent.id, name: hiringAgent.name, detail: hiringAgent.title ?? undefined, status: hiringAgent.status }] : []),
    ]
    : [];
  const defaultAssigneeId = defaultHireAssignee(team.hiring, hire?.options.defaultAssigneeAgentId);
  return (
    <>
      <NewTaskDialog
        open={!!hire}
        prefix={team.prefix}
        initialTitle={hire?.options.draft.title ?? ""}
        initialDescription={hire?.options.draft.description ?? ""}
        assignees={assignees}
        defaultAssignee={defaultAssigneeId ? `agent:${defaultAssigneeId}` : undefined}
        note={hire ? `Give it to the agent that hires for this company (usually the CEO), or to yourself. When the new agent appears, the ${pluginName(hire.role)} plugin links it, grants its tools and sets up its work.` : undefined}
        onClose={team.closeDialog}
        onCreate={team.createHire}
      />
      {dialog?.kind === "pick" ? <PickAgentModal key={`pick:${dialog.role.key}`} team={team} role={dialog.role} /> : null}
      {dialog?.kind === "remove" ? <RemoveAgentModal key={`remove:${dialog.role.key}`} team={team} role={dialog.role} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Links into the Team section
// ---------------------------------------------------------------------------

export function scrollToAnchor(anchor: string | null | undefined): void {
  if (!anchor || typeof document === "undefined") return;
  const go = () => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  else go();
}

/** The anchor a Setup → Team link points at (`/setup?section=team#team-bookkeeper` → `team-bookkeeper`). */
export function teamLinkAnchor(href: string): string | null {
  if (!isTeamPath(href)) return null;
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  return hash || TEAM_ANCHOR;
}

/**
 * Host links, plus: a link into Setup → Team also scrolls there (the address
 * may already be the same, so the page would not move by itself).
 */
export function withTeamScroll(linkFor: LinkPropsFor, after?: () => void): LinkPropsFor {
  return (href: string) => {
    const props = linkFor(href);
    const anchor = teamLinkAnchor(href);
    if (!anchor) return props;
    return {
      ...props,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        props.onClick?.(event);
        // The host routes plain clicks itself (preventDefault); new-tab clicks are left alone.
        if (!event.defaultPrevented) return;
        after?.();
        scrollToAnchor(anchor);
      },
    };
  };
}
