import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { Activity, Bot, Button, EmptyState, Field, HeartPulse, Inbox, Lightbulb, NewTaskDialog, PageFrame, PageHeader, PageMessage, Select, Tabs, Users, errorText, tokens, tone, type TaskAssigneeOption } from "@partnersinbiz/pib-plugin-ui";
import { assignableUser, PLUGIN_KEY, type RoleKind } from "../constants.js";
import type { AgentLite, RunLite } from "../merge.js";
import type { CockpitView, LoadResult } from "../view.js";
import { fetchUsers, savePluginConfig, type UserLite } from "./api.js";
import { attachAgentSkills, missingAgentSkills, pluginSkillKey } from "@partnersinbiz/pib-plugin-kit/agent-client";
import { ActivityList, AgentsTable, Card, HealthList, HealthSummary, KpiGroup, Light, Muted, TodayCard, TodayHero, WaitingKinds, WaitingList, grid, type LinkPropsFor } from "./components.js";
import { uiBase, useCockpitData } from "./data.js";
import { MemoryPanel } from "./memory.js";
import { installationIdFromUiBase, settingsPath } from "./memory-model.js";

export { ClientsNav, FinanceNav, MarketingNav } from "./nav.js";

const ROLE_SKILL: Record<RoleKind, string> = {
  operator: pluginSkillKey("partnersinbiz.cockpit", "operator"),
  reviewer: pluginSkillKey("partnersinbiz.cockpit", "reviewer"),
};

export { buildView } from "../view.js";

function useLinkFor(): LinkPropsFor {
  const navigation = useHostNavigation();
  return (href: string) => navigation.linkProps(href);
}

function Shell({ children }: { children: ReactNode }) {
  return <PageFrame accent="cockpit">{children}</PageFrame>;
}

const TAB_IDS = ["overview", "team", "memory"] as const;
type TabId = (typeof TAB_IDS)[number];

/** `?tab=team` / `?tab=memory` opens that tab; anything else is the overview. */
export function tabFromSearch(search: string | null | undefined): TabId {
  const value = new URLSearchParams(search ?? "").get("tab");
  return (TAB_IDS as readonly string[]).includes(value ?? "") ? (value as TabId) : "overview";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CockpitPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const linkFor = useLinkFor();
  const [tab, setTab] = useState<TabId>(() => tabFromSearch(location.search));
  const [windowHours, setWindowHours] = useState(24);
  const data = useCockpitData(companyId, { windowHours });
  const [message, setMessage] = useState("");
  const [memoryTick, setMemoryTick] = useState(0);

  // Follow the address (a `/cockpit?tab=memory` link while the page is open).
  useEffect(() => {
    setTab(tabFromSearch(location.search));
  }, [location.search]);

  const selectTab = (id: TabId) => {
    setTab(id);
    navigation.navigate(id === "overview" ? "/cockpit" : `/cockpit?tab=${id}`, { replace: true });
  };

  if (!companyId) {
    return <Shell><PageHeader title="Cockpit" description="Open a company first." /><EmptyState title="No company selected" /></Shell>;
  }

  const view = data.view;
  const memoryTab = tab === "memory";
  const settingsHref = settingsPath(data.raw?.installed?.[PLUGIN_KEY]?.id ?? installationIdFromUiBase(uiBase()));
  return (
    <Shell>
      <PageHeader
        title="Cockpit"
        description="What waits on you, what the agents did, the numbers, agent cost and quality, company memory, and system health."
        actions={(
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {/* Setup leaves the sidebar once it is finished; it stays one click away here. */}
            <a
              {...linkFor("/setup")}
              style={{ display: "inline-flex", alignItems: "center", height: 34, padding: "0 12px", borderRadius: 8, border: `1px solid ${tokens.border}`, fontSize: 13, fontWeight: 600, color: tokens.fg, textDecoration: "none" }}
            >
              Setup
            </a>
            <Button
              type="button"
              variant="secondary"
              onClick={() => (memoryTab ? setMemoryTick((n) => n + 1) : void data.reload())}
              disabled={!memoryTab && data.loading}
            >
              {!memoryTab && data.loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        )}
      />
      <PageMessage message={message || data.error || undefined} tone={!message && data.error ? "bad" : undefined} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: Activity, count: view?.waiting.length || null, countTone: view?.waiting.some((w) => w.kind === "money" || w.kind === "legal") ? "bad" : "warn" },
          { id: "team", label: "Team", icon: Users },
          { id: "memory", label: "Memory", icon: Lightbulb },
        ]}
        active={tab}
        onChange={(id) => selectTab(id as TabId)}
      />
      {tab === "overview" ? (
        view ? <Overview view={view} load={data.raw!.load} runs={data.raw!.runs} linkFor={linkFor} windowHours={windowHours} onWindow={setWindowHours} onTeam={() => selectTab("team")} /> : <Muted>{data.loading ? "Loading the Cockpit…" : "Nothing to show yet."}</Muted>
      ) : memoryTab ? (
        <MemoryPanel key={companyId} agents={data.raw?.agents ?? []} linkFor={linkFor} settingsHref={settingsHref} refreshKey={memoryTick} />
      ) : data.raw ? (
        <TeamPanel companyId={companyId} load={data.raw.load} agents={data.raw.agents} onSaved={async (note) => { setMessage(note); await data.reload(); }} onMessage={setMessage} />
      ) : <Muted>Loading…</Muted>}
    </Shell>
  );
}

export function Overview({ view, load, runs, linkFor, windowHours, onWindow, onTeam, now = new Date() }: {
  view: CockpitView;
  load: LoadResult;
  /** Host heartbeat runs, for the runs-per-day chart. */
  runs?: RunLite[];
  linkFor: LinkPropsFor;
  windowHours: number;
  onWindow: (hours: number) => void;
  onTeam?: () => void;
  now?: Date;
}) {
  const accent = tone("accent");
  const toggle = (
    <div role="group" aria-label="Period" style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden" }}>
      {[{ h: 24, label: "24 hours" }, { h: 168, label: "7 days" }].map(({ h, label }) => (
        <button
          key={h}
          type="button"
          aria-pressed={windowHours === h}
          onClick={() => onWindow(h)}
          style={{ appearance: "none", border: "none", padding: "6px 12px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: windowHours === h ? accent.soft : "transparent", color: windowHours === h ? accent.fg : tokens.muted }}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const agentAlerts = view.agents.filter((a) => a.alert).length;
  const activeAgents = view.agents.length ? view.agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length : null;
  const failing = view.healthGroups.reduce((sum, g) => sum + g.checks.filter((c) => c.status !== "ok").length, 0);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <TodayHero health={view.health} today={view.today} waiting={view.waiting} problems={view.problems} agentAlerts={agentAlerts} activeAgents={activeAgents}>
        {!load.roles?.operatorAgentId ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 12, background: accent.soft, border: `1px solid ${accent.border}` }}>
            <Bot size={16} color={accent.solid} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: tokens.fg, lineHeight: 1.5, flex: "1 1 220px" }}>No Operator yet. The Operator checks all of this every morning and sends you one short brief.</span>
            {onTeam ? <Button type="button" variant="secondary" onClick={onTeam}>Set up the team</Button> : null}
          </div>
        ) : null}
      </TodayHero>

      <Card
        id="waiting"
        title={`Waiting on you${view.waiting.length ? ` (${view.waiting.length})` : ""}`}
        icon={Inbox}
        tone={view.waiting.some((w) => w.kind === "money" || w.kind === "legal") ? "bad" : view.waiting.length ? "warn" : "ok"}
        subtitle="Decisions only you can make, most urgent first."
        actions={<WaitingKinds items={view.waiting} />}
      >
        <WaitingList items={view.waiting} linkFor={linkFor} now={now} />
      </Card>

      <div style={grid(420, 16)}>
        {(["money", "pipeline", "marketing", "delivery"] as const).map((group) => <KpiGroup key={group} group={group} kpis={view.kpis[group]} linkFor={linkFor} />)}
      </div>

      <Card title="What the agents did" icon={Activity} subtitle={windowHours === 24 ? "The last 24 hours" : "The last 7 days"} actions={toggle}>
        <ActivityList groups={view.activity} linkFor={linkFor} now={now} runs={runs} />
      </Card>

      <Card
        title="Agents"
        icon={Bot}
        subtitle="Status, spend against budget, and quality this month."
        actions={<a {...linkFor("/costs")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Costs →</a>}
      >
        <AgentsTable rows={view.agents} linkFor={linkFor} now={now} />
      </Card>

      <Card
        title="System health"
        icon={HeartPulse}
        tone={view.health}
        strip={view.health !== "ok"}
        subtitle={failing ? `${failing} ${failing === 1 ? "check needs" : "checks need"} attention.` : "Every check passes."}
        actions={<Light status={view.health} />}
      >
        <HealthSummary groups={view.healthGroups} />
        {load.healthIssueId ? (
          <a {...linkFor(`/issues/${load.healthIssueId}`)} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Open the System health issue →</a>
        ) : null}
        <HealthList groups={view.healthGroups} linkFor={linkFor} now={now} backup={view.backup} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

interface HireOptions {
  draft: { title: string; description: string };
  agents: Array<{ id: string; name: string; title: string | null; role: string | null; status: string }>;
  defaultAssigneeAgentId: string | null;
}

const ROLE_TEXT: Record<RoleKind, { title: string; what: string }> = {
  operator: { title: "Operator", what: "Chief of staff. Reviews every module each morning, assigns and escalates work, keeps agents unblocked, and sends you one daily brief. Budget $30 a month." },
  reviewer: { title: "Reviewer", what: "Quality reviewer. Checks posts, campaign emails, invoice and quote emails, sequence emails and SEO pull requests before you approve them. Budget $20 a month." },
};

export function TeamPanel({ companyId, load, agents, onSaved, onMessage }: {
  companyId: string;
  load: LoadResult;
  agents: AgentLite[];
  onSaved: (note: string) => Promise<void>;
  onMessage: (note: string) => void;
}) {
  const host = useHostContext();
  const linkFor = useLinkFor();
  const saveTeam = usePluginAction("cockpit.save-team");
  const hireOptions = usePluginAction("cockpit.hire-options");
  const startHire = usePluginAction("cockpit.start-hire");
  const me = assignableUser(host.userId);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [operator, setOperator] = useState(load.roles?.operatorAgentId ?? "");
  const [reviewer, setReviewer] = useState(load.roles?.reviewerAgentId ?? "");
  const [owner, setOwner] = useState(load.roles?.ownerUserId ?? me ?? "");
  const [reviewOutward, setReviewOutward] = useState(load.roles?.reviewOutward ?? false);
  const [busy, setBusy] = useState<"" | "save" | RoleKind>("");
  const [dialog, setDialog] = useState<{ kind: RoleKind; options: HireOptions } | null>(null);
  const [steps, setSteps] = useState<string[]>([]);

  useEffect(() => {
    void fetchUsers(companyId).then(setUsers);
  }, [companyId]);
  useEffect(() => {
    setOperator(load.roles?.operatorAgentId ?? "");
    setReviewer(load.roles?.reviewerAgentId ?? "");
    setOwner(load.roles?.ownerUserId ?? me ?? "");
    setReviewOutward(load.roles?.reviewOutward ?? false);
  }, [load.roles?.updatedAt]);

  // Agents linked automatically (after a hire) may not have the role skill yet: attach it for the person viewing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const notes: string[] = [];
      for (const kind of ["operator", "reviewer"] as RoleKind[]) {
        const agent = load.team?.[kind]?.agent;
        if (!agent) continue;
        const missing = await missingAgentSkills(agent.id, companyId, [ROLE_SKILL[kind]]);
        if (missing.length === 0) continue;
        try {
          await attachAgentSkills(agent.id, companyId, missing);
          notes.push(`Attached the ${ROLE_TEXT[kind].title} skill to ${agent.name}.`);
        } catch {
          notes.push(`${agent.name} is missing the ${ROLE_TEXT[kind].title} skill. Add it in Agents → ${agent.name} → Skills.`);
        }
      }
      if (!cancelled && notes.length) setSteps((prev) => [...prev, ...notes]);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, load.team?.operator?.agent?.id, load.team?.reviewer?.agent?.id]);

  const agentOptions = useMemo(() => agents.filter((a) => !["terminated", "archived", "deleted"].includes(a.status)).sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  const userOptions = useMemo(() => {
    const list = [...users];
    if (me && !list.some((u) => u.id === me)) list.unshift({ id: me, name: "Me" });
    if (owner && !list.some((u) => u.id === owner)) list.push({ id: owner, name: owner });
    return list;
  }, [users, me, owner]);

  async function doSave() {
    setBusy("save");
    onMessage("");
    try {
      const result = (await saveTeam({ operatorAgentId: operator || null, reviewerAgentId: reviewer || null, ownerUserId: owner || null, reviewOutward })) as { steps: string[]; firstSave: boolean };
      let note = "Team saved. Every PiB plugin picks this up within a minute.";
      if (!load.settingsSaved) {
        try {
          await savePluginConfig(companyId, { healthIssue: true });
        } catch (error) {
          note += ` Cockpit settings could not be saved (${errorText(error)}). Save them once in Settings → Plugins → Cockpit, or the hourly health check cannot act for this company.`;
        }
      }
      const skillSteps: string[] = [];
      for (const [kind, agentId] of [["operator", operator], ["reviewer", reviewer]] as Array<[RoleKind, string]>) {
        if (!agentId) continue;
        const name = agentOptions.find((a) => a.id === agentId)?.name ?? "The agent";
        try {
          const added = await attachAgentSkills(agentId, companyId, [ROLE_SKILL[kind]]);
          skillSteps.push(added.length ? `Attached the ${kind === "operator" ? "pib-operator" : "pib-reviewer"} skill to ${name}, so it knows the ${ROLE_TEXT[kind].title} routine.` : `${name} already has the ${kind === "operator" ? "pib-operator" : "pib-reviewer"} skill.`);
        } catch (error) {
          skillSteps.push(`Could not attach the ${ROLE_TEXT[kind].title} skill to ${name} (${errorText(error)}). Add it in Agents → ${name} → Skills.`);
        }
      }
      setSteps([...(result.steps ?? []), ...skillSteps]);
      await onSaved(note);
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function openHire(kind: RoleKind) {
    setBusy(kind);
    onMessage("");
    try {
      setDialog({ kind, options: (await hireOptions({ role: kind })) as HireOptions });
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  const assignees: TaskAssigneeOption[] = [
    ...(me ? [{ kind: "user" as const, id: me, name: "Me" }] : []),
    ...(dialog?.options.agents ?? []).map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, detail: [a.title, a.role].filter(Boolean).join(" · ") || null, status: a.status })),
  ];

  const roleRow = (kind: RoleKind, value: string, onChange: (next: string) => void) => {
    const team = load.team?.[kind] ?? null;
    const pending = !team?.agent && team?.hire?.status === "open" ? team.hire : null;
    return (
      <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <strong style={{ fontSize: 14 }}>{ROLE_TEXT[kind].title}{kind === "reviewer" ? <span style={{ fontWeight: 500, color: tokens.muted }}> (optional)</span> : null}</strong>
          <Muted>{ROLE_TEXT[kind].what}</Muted>
        </div>
        <Field label="Agent">
          <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label={`${ROLE_TEXT[kind].title} agent`}>
            <option value="">No agent</option>
            {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ""}{a.status === "paused" ? " (paused)" : ""}</option>)}
          </Select>
        </Field>
        {pending ? (
          <Muted>
            Hire task <a {...linkFor(`/issues/${pending.identifier ?? pending.issueId}`)} style={{ color: tokens.primary }}>{pending.identifier ?? "open"}</a> is open. The Cockpit links the new agent automatically when it appears.
          </Muted>
        ) : null}
        {team?.agent ? (
          <Muted>
            Linked: <strong style={{ color: tokens.fg }}>{team.agent.name}</strong>{team.agent.status ? ` (${team.agent.status})` : ""}. Pick another agent above and save to change it.
          </Muted>
        ) : pending ? null : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void openHire(kind)}>
              {busy === kind ? "Opening…" : `Hire ${ROLE_TEXT[kind].title}`}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Card title="Team" icon={Users} subtitle="The Operator runs the day; the Reviewer checks outward-facing work.">
        <Muted>Pick an existing agent for each role, or hire one (opens a hire task for whoever hires for this company). Save sends the team to every PiB plugin.</Muted>
        <div style={grid(300, 12)}>
          {roleRow("operator", operator, setOperator)}
          {roleRow("reviewer", reviewer, setReviewer)}
        </div>
        <div style={grid(260, 12)}>
          <Field label="Owner (gets the daily brief and approvals)">
            <Select value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="Owner">
              <option value="">Nobody</option>
              {userOptions.map((u) => <option key={u.id} value={u.id}>{u.id === me ? `${u.name === "Me" ? "Me" : `${u.name} (me)`}` : u.name}</option>)}
            </Select>
          </Field>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45, cursor: "pointer", paddingTop: 20 }}>
            <input type="checkbox" checked={reviewOutward} onChange={(event) => setReviewOutward(event.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <strong>Review outward-facing work before I approve</strong>
              <span style={{ display: "block", color: tokens.muted }}>Posts, campaigns, invoices, quotes and sequence emails go to the Reviewer first. You still approve.</span>
            </span>
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" onClick={() => void doSave()} disabled={busy !== ""}>{busy === "save" ? "Saving…" : "Save team"}</Button>
        </div>
        {steps.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.6 }}>
            {steps.map((step, index) => <li key={index}>{step}</li>)}
          </ul>
        ) : null}
      </Card>
      <NewTaskDialog
        open={!!dialog}
        prefix={host.companyPrefix}
        initialTitle={dialog?.options.draft.title ?? ""}
        initialDescription={dialog?.options.draft.description ?? ""}
        assignees={assignees}
        defaultAssignee={dialog?.options.defaultAssigneeAgentId ? `agent:${dialog.options.defaultAssigneeAgentId}` : undefined}
        note="Give it to the agent that hires for this company (usually the CEO), or to yourself. When the new agent appears, the Cockpit links it, grants its tools and sets up its routines."
        onClose={() => setDialog(null)}
        onCreate={async (task) => {
          const kind = dialog!.kind;
          await startHire({ role: kind, ...task });
          setDialog(null);
          await onSaved(`Opened a hire task for the ${ROLE_TEXT[kind].title}.`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget and sidebar
// ---------------------------------------------------------------------------

export function CompanyTodayWidget({ context }: PluginWidgetProps) {
  const data = useCockpitData(context.companyId, { light: true });
  const linkFor = useLinkFor();
  if (!context.companyId || !data.view) return null;
  return <TodayCard waiting={data.view.waiting.length} health={data.view.health} today={data.view.today} headline={data.view.headline} linkFor={linkFor} />;
}

export function CockpitSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const data = useCockpitData(context.companyId, { light: true });
  const waiting = data.view?.waiting.length ?? 0;
  const health = data.view?.health ?? "ok";
  const href = hostNavigation.resolveHref("/cockpit");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps("/cockpit")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 12l4-4" />
          <path d="M12 7v1M7 12h1M16 12h1" />
        </svg>
        {health !== "ok" ? (
          <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: tone(health).solid }} />
        ) : null}
      </span>
      <span className="flex-1 truncate">Cockpit</span>
      {waiting ? (
        <span
          aria-label={`${waiting} waiting on you`}
          style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: tone("warn").soft, color: tone("warn").fg }}
        >
          {waiting}
        </span>
      ) : null}
    </a>
  );
}
