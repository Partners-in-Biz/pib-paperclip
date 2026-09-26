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
import { Button, EmptyState, Field, NewTaskDialog, PageHeader, Select, Tabs, errorText, tokens, type TaskAssigneeOption } from "@partnersinbiz/pib-plugin-ui";
import { assignableUser, type RoleKind } from "../constants.js";
import type { AgentLite } from "../merge.js";
import type { CockpitView, LoadResult } from "../view.js";
import { fetchUsers, savePluginConfig, type UserLite } from "./api.js";
import { ActivityList, AgentsTable, Card, HealthList, KpiGroup, Light, Muted, TodayCard, WaitingList, grid, type LinkPropsFor } from "./components.js";
import { useCockpitData } from "./data.js";

export { buildView } from "../view.js";

function useLinkFor(): LinkPropsFor {
  const navigation = useHostNavigation();
  return (href: string) => navigation.linkProps(href);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={{ fontFamily: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`, color: tokens.fg, padding: "clamp(14px, 4vw, 28px)", maxWidth: 1160, display: "grid", gap: 18, minWidth: 0, boxSizing: "border-box", width: "100%" }}>
      {children}
    </main>
  );
}

type TabId = "overview" | "team";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CockpitPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const location = useHostLocation();
  const linkFor = useLinkFor();
  const initialTab: TabId = new URLSearchParams(location.search ?? "").get("tab") === "team" ? "team" : "overview";
  const [tab, setTab] = useState<TabId>(initialTab);
  const [windowHours, setWindowHours] = useState(24);
  const data = useCockpitData(companyId, { windowHours });
  const [message, setMessage] = useState("");

  if (!companyId) {
    return <Shell><PageHeader title="Cockpit" description="Open a company first." /><EmptyState title="No company selected" /></Shell>;
  }

  const view = data.view;
  return (
    <Shell>
      <PageHeader
        title="Cockpit"
        description="What waits on you, what the agents did, the numbers, agent cost and quality, and system health."
        actions={<Button type="button" variant="secondary" onClick={() => void data.reload()} disabled={data.loading}>{data.loading ? "Loading…" : "Refresh"}</Button>}
      />
      {message || data.error ? (
        <p role="status" style={{ margin: 0, fontSize: 13, padding: "10px 14px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, lineHeight: 1.45 }}>
          {message || data.error}
        </p>
      ) : null}
      <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "team", label: "Team" }]} active={tab} onChange={(id) => setTab(id as TabId)} />
      {tab === "overview" ? (
        view ? <Overview view={view} load={data.raw!.load} linkFor={linkFor} windowHours={windowHours} onWindow={setWindowHours} onTeam={() => setTab("team")} /> : <Muted>{data.loading ? "Loading the Cockpit…" : "Nothing to show yet."}</Muted>
      ) : data.raw ? (
        <TeamPanel companyId={companyId} load={data.raw.load} agents={data.raw.agents} onSaved={async (note) => { setMessage(note); await data.reload(); }} onMessage={setMessage} />
      ) : <Muted>Loading…</Muted>}
    </Shell>
  );
}

export function Overview({ view, load, linkFor, windowHours, onWindow, onTeam, now = new Date() }: {
  view: CockpitView;
  load: LoadResult;
  linkFor: LinkPropsFor;
  windowHours: number;
  onWindow: (hours: number) => void;
  onTeam?: () => void;
  now?: Date;
}) {
  const toggle = (
    <div role="group" aria-label="Period" style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden" }}>
      {[{ h: 24, label: "24 hours" }, { h: 168, label: "7 days" }].map(({ h, label }) => (
        <button
          key={h}
          type="button"
          aria-pressed={windowHours === h}
          onClick={() => onWindow(h)}
          style={{ appearance: "none", border: "none", padding: "6px 12px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: windowHours === h ? tokens.secondary : "transparent", color: windowHours === h ? tokens.fg : tokens.muted }}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Card title="Today" actions={<Light status={view.health} />}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>{view.today}</p>
        {!load.roles?.operatorAgentId ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Muted>No Operator yet. The Operator checks all of this every morning and sends you one short brief.</Muted>
            {onTeam ? <Button type="button" variant="secondary" onClick={onTeam}>Set up the team</Button> : null}
          </div>
        ) : null}
      </Card>

      <Card title={`Waiting on you${view.waiting.length ? ` (${view.waiting.length})` : ""}`}>
        <WaitingList items={view.waiting} linkFor={linkFor} now={now} />
      </Card>

      <div style={grid(320, 16)}>
        {(["money", "pipeline", "marketing", "delivery"] as const).map((group) => <KpiGroup key={group} group={group} kpis={view.kpis[group]} linkFor={linkFor} />)}
      </div>

      <Card title="What the agents did" actions={toggle}>
        <ActivityList groups={view.activity} linkFor={linkFor} now={now} />
      </Card>

      <Card title="Agents" actions={<a {...linkFor("/costs")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Costs →</a>}>
        <AgentsTable rows={view.agents} linkFor={linkFor} now={now} />
      </Card>

      <Card title="System health" actions={<Light status={view.health} />}>
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
      setSteps(result.steps ?? []);
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void openHire(kind)}>
            {busy === kind ? "Opening…" : `Hire ${ROLE_TEXT[kind].title}`}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Card title="Team">
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
          <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: health === "bad" ? "var(--destructive)" : "var(--chart-4)" }} />
        ) : null}
      </span>
      <span className="flex-1 truncate">Cockpit</span>
      {waiting ? (
        <span
          aria-label={`${waiting} waiting on you`}
          style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: tokens.secondary, color: tokens.secondaryFg }}
        >
          {waiting}
        </span>
      ) : null}
    </a>
  );
}
