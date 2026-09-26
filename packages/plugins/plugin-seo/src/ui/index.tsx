import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DataTable,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { rememberOAuthStart, resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { clientScopeFromSearch, parseClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import {
  Activity,
  BarList,
  Button,
  CalendarCheck,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartLegend,
  CircleAlert,
  CircleCheck,
  ClientWorkspaceBar,
  DonutChart,
  EmptyState,
  Eye,
  Field,
  FileText,
  Gauge,
  HeartPulse,
  Info,
  Input,
  KpiCard,
  Lightbulb,
  ListChecks,
  Modal,
  NewTaskDialog,
  Page,
  PageFrame,
  PageMessage,
  Pill,
  Plug,
  ProgressBar,
  ProgressRing,
  Rocket,
  ScrollX,
  Search,
  Section,
  SectionCard,
  Select,
  Share2,
  StackedBar,
  StatusDot,
  Tabs,
  Target,
  TextArea,
  Toolbar,
  TrendChart,
  TriangleAlert,
  breakAnywhere,
  errorText,
  fluidColumns,
  formatCompact,
  tokens,
  tone,
  useIsNarrow,
  type LucideIcon,
  type TaskAssigneeOption,
} from "@partnersinbiz/pib-plugin-ui";
import { CHIP_LABEL, CHIP_TONE, backlinkSegments, dueOpen, changeText, chipState, healthTone, optimizationSegments, positionBuckets, positionTrendTone, severitySegments, statusTone, taskSegments, trafficSeries, type ChipState, type TrafficDay } from "./series.js";
import { scopeParamValue, sprintPagePath } from "../engine/scope.js";
import { ModuleOffBanner, useModuleEnabled } from "./module.js";
import { NeedsYouSection, SetupChecklist, SiteRepoSection, type NeedsYouView, type ProjectOption, type SetupItem, type SiteLink } from "./autonomy.js";

// ---------------------------------------------------------------------------
// Types (type aliases so DataTable accepts them as records)
// ---------------------------------------------------------------------------

type TaskCounts = { open: number; due: number; done: number; total: number; blocked: number; proposals: number };

type SprintSummary = {
  sprintId: string;
  siteName: string;
  siteUrl: string;
  /** `company:<id>` / `contact:<id>`; null = Partners in Biz's own site. */
  client: string | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
  legacyClientName?: string;
  status: string;
  legacy: boolean;
  startDate: string;
  day: number;
  week: number;
  phase: number;
  phaseName: string;
  autopilotMode: string;
  ownerUserId: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  health: { score?: number; signals?: Array<{ type: string; severity: string }> };
  lastDailyOn: string | null;
  notes: string | null;
  site?: SiteLink;
  tasks?: TaskCounts;
};

type LoadResult = {
  today: string;
  timezone: string;
  userId: string | null;
  settings: {
    saved: boolean;
    publicBaseUrl: string | null;
    redirectUri: string | null;
    googleClientId: boolean;
    googleClientSecret: boolean;
    encryptionKey: boolean;
    pagespeedApiKey: boolean;
    bingApiKey: boolean;
    serviceAccountEmail: string | null;
    serviceAccountError: string | null;
    defaultAutopilotMode: string;
    dailyHourLocal: number;
  };
  agent: { id: string; status: string } | null;
  /** The SEO agent's hire state; own page only (null in a client workspace). */
  hire: HireView | null;
  /** Company-level setup checklist (own page only). */
  setup: SetupItem[];
  /** The page's scope: null = Partners in Biz's own sites. */
  scope: string | null;
  client: ScopeClient | null;
  clientError: string | null;
  sprints: SprintSummary[];
};

type ScopeClient = { kind: "company" | "contact"; id: string; name: string; domain: string | null; email: string | null; known: boolean };

type HireAgent = { id: string; name: string; title: string | null; role: string | null; status: string; icon: string | null; createdAt: string | null };
type HireRecord = {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  status: "open" | "linked" | "cancelled";
};
type HireView = {
  agent: HireAgent | null;
  linkedBy: "auto" | "manual" | "managed" | null;
  hire: (HireRecord & { issueStatus: string | null; assigneeName: string | null }) | null;
  candidates: HireAgent[];
};
type HireOptions = {
  draft: { title: string; description: string };
  agents: HireAgent[];
  defaultAssigneeAgentId: string | null;
  status: { agent: HireAgent | null; linkedBy: HireView["linkedBy"]; hire: HireRecord | null; candidates: HireAgent[] };
};
type WireSummary = { title: string; steps: string[]; instructions: string[] };

type Task = {
  id: string;
  title: string;
  week: number;
  phase: number;
  dueDay: number | null;
  focus: string;
  taskType: string;
  owner: string;
  autopilotEligible: boolean;
  status: string;
  source: string;
  issueId: string | null;
  issueIdentifier: string | null;
  blockerReason: string | null;
  humanAsk: string | null;
  completedAt: string | null;
};

type Keyword = {
  id: string;
  phrase: string;
  intent: string | null;
  isPriority: boolean;
  targetUrl: string | null;
  rankingUrl: string | null;
  currentPosition: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  status: string;
  retiredAt: string | null;
  difficultyDr: number | null;
  history: Array<{ on: string | null; position: number | null; source: string }>;
};

type Backlink = { id: string; source: string; domain: string; url: string | null; type: string; dr: number | null; status: string; notes: string | null; submittedAt: string | null; liveAt: string | null };
type Content = { id: string; title: string; type: string; status: string; targetUrl: string | null; publishedOn: string | null; impressions: number | null; clicks: number | null; position: number | null; linksToPillarIds: string[]; socialPostIds: string[] };
type Snapshot = { id: string; day: number; kind: string; capturedOn: string | null; source: string; traffic: Record<string, unknown>; rankings: Record<string, unknown>; authority: Record<string, unknown>; content: Record<string, unknown>; notes: string | null };
type Finding = { id: string; finding: string; severity: string; category: string | null; url: string | null; source: string | null };
type Optimization = { id: string; status: string; signalType: string; severity: string; hypothesis: string; hypothesisType: string; proposedAction: string; evidence: Record<string, unknown>; proposedTasks: Array<{ title: string }>; detectedOn: string | null; measureOn: string | null; result: string | null; outcome: { reasons?: string[] } | null; rejectedReason: string | null };
type Integration = { provider: string; status: string; propertyUrl: string | null; lastPullAt: string | null; lastError: string | null; connected: boolean; auth?: "service_account" | "oauth" | null; stats: Record<string, unknown> };
type PageHealth = { url: string; strategy: string; performance: number | null; seo: number | null; lcpMs: number | null; cls: number | null; inpMs: number | null; source: string; pulledOn: string | null };

type SprintBundle = {
  sprint: SprintSummary;
  prefix: string | null;
  scoreboard: Record<string, { wins: number; losses: number; noChange: number; inconclusive?: number }>;
  today: Record<string, unknown>;
  tasks: Task[];
  keywords: Keyword[];
  backlinks: Backlink[];
  content: Content[];
  snapshots: Snapshot[];
  findings: Finding[];
  optimizations: Optimization[];
  integrations: Integration[];
  pageHealth: PageHealth[];
  /** Search Console impressions/clicks of tracked keywords per day (worker 0.6.3+). */
  traffic?: TrafficDay[];
  needsYou: NeedsYouView | null;
  setup: SetupItem[];
  projects: ProjectOption[];
};

type TabId = "plan" | "keywords" | "backlinks" | "content" | "audits" | "optimizations" | "integrations";
const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "keywords", label: "Keywords", icon: Target },
  { id: "backlinks", label: "Backlinks", icon: Share2 },
  { id: "content", label: "Content", icon: FileText },
  { id: "audits", label: "Audits", icon: HeartPulse },
  { id: "optimizations", label: "Optimizations", icon: Lightbulb },
  { id: "integrations", label: "Integrations", icon: Plug },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Badge({ status, label, dot = true }: { status: string; label?: string; dot?: boolean }) {
  return <Pill tone={statusTone(status)} dot={dot}>{(label ?? status).replace(/_/g, " ")}</Pill>;
}

/** Cards in a row share its height; keep their content at the top. */
const top = { alignContent: "start" } as const;
const grid = (min: number, gap = 16) => ({ display: "grid", gap, gridTemplateColumns: fluidColumns(min), minWidth: 0 }) as const;

function fmt(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function useSearch(): URLSearchParams {
  const location = useHostLocation();
  return useMemo(() => new URLSearchParams(location.search), [location.search]);
}

/** `?client=company:<id>` / `contact:<id>` opens a client's workspace; no param is PiB's own sites. */
function useScope(): ClientScope {
  const location = useHostLocation();
  return useMemo(() => clientScopeFromSearch(location.search), [location.search]);
}

function siteUrlFromDomain(domain: string | null): string {
  if (!domain) return "";
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

/** A client's workspace: the shared client bar replaces the page header. */
function ClientPage({ header, message, children }: { header: ReactNode; message?: string; children: ReactNode }) {
  return (
    <PageFrame accent="seo">
      {header}
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span style={{ color: tokens.muted, fontSize: 12 }}>—</span>;
  const width = 90;
  const height = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // Lower position is better: draw position 1 at the top.
  const points = values.map((v, i) => `${(i / (values.length - 1)) * width},${((v - min) / span) * (height - 4) + 2}`).join(" ");
  const trend = positionTrendTone(values);
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return (
    <svg width={width} height={height} aria-label={`Position ${fmt(first)} → ${fmt(last)}`} role="img">
      <polyline points={points} fill="none" stroke={trend === "neutral" ? tone("accent").solid : tone(trend).solid} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Banner({ tone: t, children }: { tone: "warn" | "info" | "bad"; children: ReactNode }) {
  const colors = tone(t);
  const glyph = t === "bad" ? CircleAlert : t === "warn" ? TriangleAlert : Info;
  return (
    <div
      role="status"
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.solid}`,
        background: `linear-gradient(90deg, ${colors.soft}, transparent 70%), ${tokens.card}`,
        display: "grid",
        gridTemplateColumns: `18px minmax(0, 1fr)`,
        columnGap: 8,
        minWidth: 0,
      }}
    >
      <Glyph icon={glyph} color={colors.solid} />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Glyph({ icon: I, color }: { icon: LucideIcon; color: string }) {
  return <I size={15} color={color} aria-hidden="true" style={{ marginTop: 2 }} />;
}

function IssueLink({ id, identifier, label }: { id: string | null; identifier?: string | null; label?: string }) {
  const nav = useHostNavigation();
  if (!id) return <span style={{ color: tokens.muted }}>—</span>;
  const to = `/issues/${identifier ?? id}`;
  return (
    <a {...nav.linkProps(to)} style={{ color: tokens.fg, fontWeight: 500 }}>
      {label ?? identifier ?? "Open issue"}
    </a>
  );
}

const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };

// ---------------------------------------------------------------------------
// SEO agent: hired through a normal Paperclip task, then linked and wired
// ---------------------------------------------------------------------------

/** The local-board sentinel is not a real member, so it cannot be assigned. */
const LOCAL_BOARD_USER_ID = "local-board";
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

function words(value: string): string {
  return value.replace(/_/g, " ");
}

function agentDetail(agent: HireAgent): string | null {
  return agent.title && agent.title !== agent.name ? agent.title : agent.role ? words(agent.role) : null;
}

function WireResultNote({ result, onClose }: { result: WireSummary; onClose: () => void }) {
  return (
    <Banner tone="info">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <strong style={{ minWidth: 0 }}>{result.title}</strong>
        <button type="button" onClick={onClose} aria-label="Dismiss" style={{ appearance: "none", border: "none", background: "transparent", color: tokens.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, minWidth: 32, flexShrink: 0 }}>×</button>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {result.steps.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {result.instructions.length > 0 ? (
        <>
          <span style={{ fontWeight: 600 }}>Next:</span>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {result.instructions.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </>
      ) : null}
    </Banner>
  );
}

function LinkAgentModal({ options, currentAgentId, canUnlink, busy, onClose, onLink, onUnlink }: {
  options: HireOptions;
  currentAgentId: string | null;
  canUnlink: boolean;
  busy: boolean;
  onClose: () => void;
  onLink: (agentId: string) => void;
  onUnlink: () => void;
}) {
  const candidates = options.status.candidates;
  const candidateIds = new Set(candidates.map((c) => c.id));
  const others = options.agents.filter((a) => !candidateIds.has(a.id));
  const [agentId, setAgentId] = useState(candidates[0]?.id ?? "");
  const label = (a: HireAgent) => `${a.name}${agentDetail(a) ? ` · ${agentDetail(a)}` : ""}${a.status === "paused" ? " (paused)" : ""}${a.id === currentAgentId ? " (linked now)" : ""}`;
  return (
    <Modal
      open
      title={currentAgentId ? "Change SEO agent" : "Link SEO agent"}
      description="Pick the agent that does SEO work. The plugin gives it SEO tool access, assigns the SEO routines to it, points every sprint at it and hands it waiting SEO tasks. The agent's own settings are not changed."
      onClose={onClose}
      footer={
        <>
          {canUnlink ? <Button type="button" variant="secondary" disabled={busy} onClick={onUnlink}>Unlink</Button> : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!agentId || agentId === currentAgentId || busy} onClick={() => onLink(agentId)}>{busy ? "Linking…" : "Link agent"}</Button>
        </>
      }
    >
      <Field label="Agent">
        <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="">Choose an agent…</option>
          {candidates.length > 0 ? (
            <optgroup label="Looks like the new SEO agent">
              {candidates.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
            </optgroup>
          ) : null}
          {others.length > 0 ? (
            <optgroup label={candidates.length > 0 ? "Other agents" : "Agents"}>
              {others.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
            </optgroup>
          ) : null}
        </Select>
      </Field>
      {options.agents.length === 0 ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>This company has no agents yet. Open a hire task instead.</p> : null}
      <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>
        The agent needs the <code>pib-seo-sprint</code> skill attached (Agents → agent → Skills). The plugin keeps the skill up to date and tells you if it is missing.
      </p>
    </Modal>
  );
}

/**
 * State and UI for the SEO agent on the own SEO page: open a hire task, show
 * the open hire, link an agent by hand, re-sync the linked agent.
 */
function useSeoAgent({ hire, refresh, onMessage }: { hire: HireView | null; refresh: () => Promise<void>; onMessage: (message: string) => void }) {
  const host = useHostContext();
  const loadOptions = usePluginAction("seo.hire-options");
  const startHire = usePluginAction("seo.start-hire");
  const linkAgent = usePluginAction("seo.link-agent");
  const unlinkAgent = usePluginAction("seo.unlink-agent");
  const resync = usePluginAction("seo.activate-agent");
  const [busy, setBusy] = useState<"" | "hire" | "link" | "resync">("");
  const [hireOptions, setHireOptions] = useState<HireOptions | null>(null);
  const [linkOptions, setLinkOptions] = useState<HireOptions | null>(null);
  const [result, setResult] = useState<WireSummary | null>(null);
  const [createdIssueId, setCreatedIssueId] = useState<string | null>(null);

  async function run(kind: "hire" | "link" | "resync", fn: () => Promise<void>) {
    setBusy(kind);
    onMessage("");
    try {
      await fn();
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  const openHire = () => run("hire", async () => setHireOptions((await loadOptions({})) as HireOptions));
  const openLink = () => run("link", async () => setLinkOptions((await loadOptions({})) as HireOptions));
  const doResync = () =>
    run("resync", async () => {
      const r = (await resync({})) as { agent: { name: string }; steps: string[]; instructions: string[] };
      setResult({ title: `Re-synced ${r.agent.name}`, steps: r.steps, instructions: r.instructions });
      await refresh();
    });

  async function link(agentId: string) {
    await run("link", async () => {
      const r = (await linkAgent({ agentId })) as { agent: HireAgent; steps: string[]; instructions: string[] };
      setLinkOptions(null);
      setResult({ title: `Linked ${r.agent.name} as the SEO agent`, steps: r.steps, instructions: r.instructions });
      await refresh();
    });
  }

  async function unlink() {
    await run("link", async () => {
      await unlinkAgent({});
      setLinkOptions(null);
      setResult(null);
      onMessage("The SEO agent was unlinked. The agent itself, its routines and its tasks were not changed.");
      await refresh();
    });
  }

  const agent = hire?.agent ?? null;
  const openRequest = !agent && hire?.hire?.status === "open" ? hire.hire : null;
  const requestClosed = Boolean(openRequest && CLOSED_ISSUE_STATUSES.includes(openRequest.issueStatus ?? ""));
  const candidates = hire?.candidates ?? [];

  const me = host.userId && host.userId !== LOCAL_BOARD_USER_ID ? host.userId : null;
  const assignees: TaskAssigneeOption[] = [
    ...(me ? [{ kind: "user" as const, id: me, name: "Me" }] : []),
    ...(hireOptions?.agents ?? []).map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, detail: agentDetail(a), status: a.status })),
  ];

  const headerAction = hire && !agent && !openRequest ? (
    <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void openHire()}>
      {busy === "hire" ? "Opening…" : "Activate SEO agent"}
    </Button>
  ) : null;

  const actions = (buttons: ReactNode) => <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>{buttons}</div>;

  let banner: ReactNode = null;
  if (hire && agent) {
    const how = hire.linkedBy === "auto" ? "linked from the hire task" : hire.linkedBy === "manual" ? "linked by hand" : hire.linkedBy === "managed" ? "set up before hiring moved to tasks" : null;
    banner = (
      <Banner tone={agent.status === "paused" || agent.status === "pending_approval" ? "warn" : "info"}>
        <span>
          <strong>SEO agent: {agent.name}</strong> ({words(agent.status || "unknown")}){how ? <span style={{ color: tokens.muted }}> · {how}</span> : null}
        </span>
        {agent.status === "pending_approval" ? <span>Approve the hire in Approvals, then check its adapter has a working model key and click Resume on the agent.</span> : null}
        {agent.status === "paused" ? <span>Open Agents → {agent.name}, check its adapter has a working model key, then click Resume. It does not pick up SEO work while paused.</span> : null}
        {actions(
          <>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void doResync()}>{busy === "resync" ? "Re-syncing…" : "Re-sync"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>{busy === "link" ? "Loading…" : "Change agent"}</Button>
          </>,
        )}
      </Banner>
    );
  } else if (hire && openRequest) {
    const taskLink = <IssueLink id={openRequest.issueId} identifier={openRequest.identifier} label={openRequest.identifier ?? "the hire task"} />;
    const assigned = openRequest.assigneeName ? `assigned to ${openRequest.assigneeName}` : "not assigned yet, so it waits in Backlog";
    banner = (
      <Banner tone={requestClosed ? "warn" : "info"}>
        {requestClosed ? (
          <span><strong>Hire request {taskLink} is {words(openRequest.issueStatus ?? "closed")}, but no SEO agent was linked.</strong> If the agent exists, link it; otherwise open a new hire task.</span>
        ) : (
          <span>
            <strong>{createdIssueId === openRequest.issueId ? <>Hire task {taskLink} created</> : <>Hire request {taskLink} is open</>}</strong> ({assigned}). The plugin links the new agent automatically when it appears.
          </span>
        )}
        {!requestClosed && candidates.length > 1 ? (
          <span>More than one new agent looks like the SEO agent ({candidates.map((c) => c.name).join(", ")}). Pick the right one with Link agent.</span>
        ) : null}
        {actions(
          <>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>{busy === "link" ? "Loading…" : "Link agent"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openHire()}>{busy === "hire" ? "Opening…" : "Open a new hire task"}</Button>
          </>,
        )}
      </Banner>
    );
  } else if (hire) {
    banner = (
      <Banner tone="info">
        <span>
          <strong>No SEO agent yet.</strong> Activate SEO agent opens a hire task with the agent's spec for whoever hires for this company (usually the CEO agent). When the new agent appears, the plugin links it and sets it up.
        </span>
        {actions(
          <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>{busy === "link" ? "Loading…" : "Link an existing agent"}</Button>,
        )}
      </Banner>
    );
  }

  const panel = (
    <>
      {banner}
      {result ? <WireResultNote result={result} onClose={() => setResult(null)} /> : null}
      <NewTaskDialog
        open={!!hireOptions}
        prefix={host.companyPrefix}
        initialTitle={hireOptions?.draft.title ?? ""}
        initialDescription={hireOptions?.draft.description ?? ""}
        assignees={assignees}
        defaultAssignee={hireOptions?.defaultAssigneeAgentId ? `agent:${hireOptions.defaultAssigneeAgentId}` : undefined}
        note="Give it to the agent that hires for this company (usually the CEO), or to yourself. When the new agent appears, the SEO plugin links it, grants its tools and assigns the SEO routines."
        onClose={() => setHireOptions(null)}
        onCreate={async (task) => {
          const r = (await startHire(task)) as { hire: HireRecord };
          setHireOptions(null);
          setCreatedIssueId(r.hire.issueId);
          setResult(null);
          await refresh();
        }}
      />
      {linkOptions ? (
        <LinkAgentModal
          options={linkOptions}
          currentAgentId={agent?.id ?? null}
          canUnlink={Boolean(agent && (hire?.linkedBy === "auto" || hire?.linkedBy === "manual"))}
          busy={busy === "link"}
          onClose={() => setLinkOptions(null)}
          onLink={(id) => void link(id)}
          onUnlink={() => void unlink()}
        />
      ) : null}
    </>
  );

  return { headerAction, panel };
}


// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SeoPage({ context }: PluginPageProps) {
  const load = usePluginAction("seo.load");
  const nav = useHostNavigation();
  const search = useSearch();
  const scope = useScope();
  const scopeKey = scopeParamValue(scope) ?? "own";
  const sprintId = search.get("sprint");
  const [data, setData] = useState<LoadResult | null>(null);
  const [message, setMessage] = useState("");
  const request = useRef(0);
  // Switched off in Setup: show the banner instead of loading (null = still checking, load as usual).
  const enabled = useModuleEnabled(context.companyId);
  const off = enabled === false;

  const refresh = useCallback(async () => {
    const mine = ++request.current;
    const result = (await load({ uiBase: await resolvePluginUiBase("partnersinbiz.seo", import.meta.url), client: scopeParamValue(scope) })) as LoadResult;
    // A slower load for a scope the page has left must not overwrite the current one.
    if (mine === request.current) setData(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, scopeKey]);

  useEffect(() => {
    if (!context.companyId || off) return;
    setData(null);
    refresh().catch((error: unknown) => setMessage(errorText(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.companyId, scopeKey, off]);

  useEffect(() => {
    if (search.get("connected") === "gsc") setMessage(search.get("pick") ? "Google Search Console connected. Pick the property for this sprint below." : "Google Search Console connected.");
  }, [search]);

  // Every link keeps the page in its scope (own sites or this client).
  const goTo = (id: string | null, tab?: TabId) => nav.navigate(sprintPagePath("/seo", id, scope, tab ? { tab } : {}));

  // A sprint opened from the wrong workspace reopens in the one it belongs to.
  const reopenIn = (id: string, client: string | null, clientName: string | null) => {
    const tab = search.get("tab");
    setMessage(client ? `This sprint belongs to ${clientName ?? "a client"}, so it is shown in that client's workspace.` : "This sprint is one of Partners in Biz's own sites, so it is shown under own SEO.");
    nav.navigate(sprintPagePath("/seo", id, parseClientParam(client), tab ? { tab } : {}), { replace: true });
  };

  // The agent banner and hire flow live on the own page only; client workspaces do not show them.
  const seoAgent = useSeoAgent({ hire: scope ? null : data?.hire ?? null, refresh, onMessage: setMessage });

  const settings = data?.settings;
  const client = scope ? data?.client ?? null : null;
  const body = off ? <ModuleOffBanner /> : (
    <>
      {settings && !settings.saved ? (
        <Banner tone="warn">
          <strong>SEO settings are not saved for this company.</strong>
          <span>Open Settings → Plugins → SEO and click Save once. Until then the daily and weekly SEO jobs skip this company.</span>
        </Banner>
      ) : null}
      {!scope && !sprintId && data?.setup?.length ? <SetupChecklist title="Setup (once)" items={data.setup} /> : null}
      {!scope && settings?.redirectUri && settings.googleClientId ? (
        <Banner tone="info">
          <span>
            OAuth fallback — redirect URI to register in Google Cloud (Credentials → your Web client → Authorized redirect URIs): <code style={breakAnywhere}>{settings.redirectUri}</code>
          </span>
        </Banner>
      ) : null}
      {!scope ? seoAgent.panel : null}
      {scope && data?.clientError ? (
        <Banner tone="warn">
          <strong>Client not found in the CRM list.</strong>
          <span>{data.clientError}</span>
        </Banner>
      ) : null}

      {!data ? (
        <p style={{ color: tokens.muted, fontSize: 13 }}>Loading…</p>
      ) : sprintId ? (
        <SprintCockpit
          key={sprintId}
          companyId={context.companyId ?? ""}
          sprintId={sprintId}
          scope={scope}
          load={data}
          initialTab={(search.get("tab") as TabId | null) ?? "plan"}
          onTab={(tab) => goTo(sprintId, tab)}
          onBack={() => goTo(null)}
          onRedirect={(target, name) => reopenIn(sprintId, target, name)}
          onMessage={setMessage}
          onChanged={refresh}
        />
      ) : (
        <SprintList data={data} client={client} onOpen={(id) => goTo(id)} onMessage={setMessage} onChanged={refresh} />
      )}
    </>
  );

  if (scope) {
    const header = client ? (
      <ClientWorkspaceBar
        client={{ kind: client.kind, id: client.id, name: client.name, detail: client.domain ?? client.email }}
        active="seo"
        linkProps={nav.linkProps}
        ownPath="/seo"
      />
    ) : off ? (
      <ClientWorkspaceBar client={{ kind: scope.kind, id: scope.id, name: "Client", detail: null }} active="seo" linkProps={nav.linkProps} ownPath="/seo" />
    ) : null;
    return <ClientPage header={header} message={message}>{body}</ClientPage>;
  }

  return (
    <Page
      title="SEO"
      description="90-day SEO sprints for Partners in Biz's own sites. Client sprints live in each client's workspace: open the client in the CRM, then SEO. The SEO agent works every task (code changes through the site repo); what only a person can do is batched in one weekly Needs you issue per sprint."
      message={message}
      accent="seo"
      actions={off ? undefined : seoAgent.headerAction}
    >
      {body}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Sprint list + create
// ---------------------------------------------------------------------------

function SprintList({ data, client, onOpen, onMessage, onChanged }: { data: LoadResult; client: ScopeClient | null; onOpen: (id: string) => void; onMessage: (m: string) => void; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const upgrade = usePluginAction("seo.upgrade-legacy");
  const q = query.trim().toLowerCase();
  const rows = data.sprints.filter((s) => !q || `${s.siteName} ${s.legacyClientName ?? ""} ${s.siteUrl}`.toLowerCase().includes(q));
  const active = data.sprints.filter((s) => ["pre_launch", "active", "compounding"].includes(s.status) && !s.legacy);
  const dueCount = active.reduce((n, s) => n + (s.tasks?.due ?? 0), 0);
  const blockedCount = active.reduce((n, s) => n + (s.tasks?.blocked ?? 0), 0);
  const proposalCount = active.reduce((n, s) => n + (s.tasks?.proposals ?? 0), 0);
  const scored = active.map((s) => s.health?.score).filter((v): v is number => typeof v === "number");
  const avgHealth = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  // A client workspace can only start sprints for a client the CRM list knows.
  const canCreate = !client || client.known;
  const newButton = <Button type="button" disabled={!canCreate} onClick={() => setCreating(true)}>+ Sprint</Button>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Active sprints" value={active.length} icon={Rocket} hint={`${data.sprints.length} in total`} />
        <KpiCard label="Due tasks" value={dueCount} icon={CalendarCheck} tone={dueCount ? "warn" : undefined} hint={dueCount ? "Open in the sprint's plan" : "Nothing due"} />
        <KpiCard label="Blocked" value={blockedCount} icon={CircleAlert} tone={blockedCount ? "bad" : undefined} hint={blockedCount ? "Needs a person" : "Nothing blocked"} />
        <KpiCard label="Proposals" value={proposalCount} icon={Lightbulb} tone={proposalCount ? "warn" : undefined} hint={proposalCount ? "Waiting for approval" : "None waiting"} />
        <KpiCard label="Average health" value={avgHealth == null ? "—" : avgHealth} icon={HeartPulse} tone={avgHealth != null && healthTone(avgHealth) !== "ok" ? healthTone(avgHealth) : undefined} hint="Across active sprints" />
      </div>
      <Toolbar search={query} onSearchChange={setQuery} searchPlaceholder="Search sprints…">
        {newButton}
      </Toolbar>
      {data.sprints.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title={client ? `No SEO sprint for ${client.name} yet` : "No SEO sprints for PiB's own sites yet"}
          description={
            client
              ? "A sprint is one site on the Outrank-90 plan: 42 tasks over 13 weeks, then compounding."
              : "A sprint is one site on the Outrank-90 plan: 42 tasks over 13 weeks, then compounding. Client sprints live in each client's workspace (CRM → client → SEO)."
          }
          action={newButton}
        />
      ) : (
        <DataTable
          columns={[
            {
              key: "siteName",
              header: "Site",
              render: (_v, row) => (
                <button type="button" onClick={() => onOpen(String(row.sprintId))} style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2, minWidth: 0, maxWidth: "100%" }}>
                  <strong style={{ fontSize: 13, ...breakAnywhere }}>{String(row.siteName)}</strong>
                  <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{String(row.siteUrl)}</span>
                  {row.legacyClientName ? (
                    <span style={{ fontSize: 12, color: tokens.muted }}>Names client “{String(row.legacyClientName)}” but is not linked to the CRM</span>
                  ) : null}
                </button>
              ),
            },
            {
              key: "day",
              header: "Day",
              render: (_v, row) => (row.legacy ? "—" : (
                <span style={{ display: "grid", gap: 4, minWidth: 70 }}>
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{Math.min(Math.max(Number(row.day), 0), 90)}/90</span>
                  <ProgressBar value={Math.min(Math.max(Number(row.day), 0), 90) / 90} size="xs" ariaLabel={`Day ${Math.max(Number(row.day), 0)} of 90`} />
                </span>
              )),
            },
            { key: "phaseName", header: "Phase", render: (v, row) => (row.legacy ? "—" : String(v)) },
            { key: "status", header: "Status", render: (v, row) => (row.legacy ? <Badge status="paused" label="legacy" /> : <Badge status={String(v)} />) },
            { key: "health", header: "Health", render: (v) => { const score = (v as { score?: number })?.score ?? null; return score == null ? "—" : <Pill tone={healthTone(score)} variant="soft">{fmt(score, 0)}</Pill>; } },
            { key: "tasks", header: "Due / open issues", render: (v) => { const c = v as TaskCounts | undefined; return c ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><Pill tone={c.due ? "warn" : "neutral"} size="sm">{c.due} due</Pill>{c.blocked ? <Pill tone="bad" size="sm">{c.blocked} blocked</Pill> : null}<span style={{ fontSize: 12, color: tokens.muted }}>{c.open} open</span></span> : "—"; } },
            {
              key: "sprintId",
              header: "",
              width: "150px",
              render: (_v, row) =>
                row.legacy ? (
                  <Button
                    type="button"
                    variant="secondary"
                    style={small}
                    onClick={() =>
                      void upgrade({ sprintId: row.sprintId })
                        .then(() => onChanged())
                        .then(() => onMessage("90-day plan added. The next daily run opens the due tasks."))
                        .catch((error: unknown) => onMessage(errorText(error)))
                    }
                  >
                    Start 90-day plan
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" style={small} onClick={() => onOpen(String(row.sprintId))}>Open</Button>
                ),
            },
          ]}
          rows={rows.map((row) => ({ ...row, id: row.sprintId }))}
          emptyMessage="No sprints match."
        />
      )}
      <CreateSprintModal open={creating} data={data} client={client} onClose={() => setCreating(false)} onCreated={async (id, note) => { setCreating(false); await onChanged(); onMessage(note); onOpen(id); }} onError={onMessage} />
    </div>
  );
}

/**
 * In a client's workspace the sprint is locked to that client (name and
 * domain prefilled). On the own page it is a Partners in Biz site: no client.
 */
function CreateSprintModal({ open, data, client, onClose, onCreated, onError }: { open: boolean; data: LoadResult; client: ScopeClient | null; onClose: () => void; onCreated: (id: string, note: string) => Promise<void>; onError: (m: string) => void }) {
  const create = usePluginAction("seo.create-sprint");
  const [siteUrl, setSiteUrl] = useState(siteUrlFromDomain(client?.domain ?? null));
  const [siteName, setSiteName] = useState(client?.name ?? "");
  const [startDate, setStartDate] = useState(data.today);
  const [owner, setOwner] = useState<"me" | "none">("me");
  const [mode, setMode] = useState(data.settings.defaultAutopilotMode);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const result = (await create({
        client: client ? `${client.kind}:${client.id}` : null,
        siteUrl,
        siteName: siteName || undefined,
        startDate,
        owner,
        autopilotMode: mode,
        notes: notes || undefined,
      })) as { sprintId: string; issuesOpened: number; warnings: string[] };
      await onCreated(result.sprintId, `Sprint created: ${result.issuesOpened} task issue(s) opened.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`);
    } catch (e) {
      setError(errorText(e));
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={client ? `New SEO sprint for ${client.name}` : "New SEO sprint for a PiB site"}
      description="Seeds the 42 Outrank-90 tasks and 15 directory backlinks, creates the sprint root issue, and opens the tasks that are due."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={saving || !siteUrl.trim() || (client ? !client.known : false)} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create sprint"}
          </Button>
        </>
      )}
    >
      {client ? (
        <Field label="Client">
          <span style={{ fontSize: 13 }}>
            {client.name} <span style={{ color: tokens.muted }}>· CRM {client.kind}{client.domain ? ` · ${client.domain}` : ""}</span>
          </span>
        </Field>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>For one of Partners in Biz's own sites. To start a sprint for a client, open the client in the CRM, then SEO.</p>
      )}
      <Field label="Site URL"><Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.co.za" required /></Field>
      <Field label="Site name"><Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder={client ? client.name : "Default: the domain"} /></Field>
      <Field label="Start date (day 0, launch day)"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
      <Field label="Owner (receives human tasks and sign-offs)">
        <Select value={owner} onChange={(e) => setOwner(e.target.value as "me" | "none")}>
          <option value="me">Me</option>
          <option value="none">No owner</option>
        </Select>
      </Field>
      <Field label="Autopilot">
        <Select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="safe">Safe — agent works; publishing needs sign-off</option>
          <option value="full">Full — agent finishes its tasks</option>
          <option value="off">Off — every task goes to the owner</option>
        </Select>
      </Field>
      <Field label="Notes for the agent (site access, who deploys)"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. WordPress admin access via 1Password 'Client site'; developer deploys code changes" /></Field>
      {error ? <p style={{ margin: 0, color: tokens.destructive, fontSize: 13 }}>{error}</p> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cockpit
// ---------------------------------------------------------------------------

function SprintCockpit({
  companyId,
  sprintId,
  scope,
  load,
  initialTab,
  onTab,
  onBack,
  onRedirect,
  onMessage,
  onChanged,
}: {
  companyId: string;
  sprintId: string;
  scope: ClientScope;
  load: LoadResult;
  initialTab: TabId;
  onTab: (tab: TabId) => void;
  onBack: () => void;
  /** The sprint belongs to another scope (a client, or PiB's own sites). */
  onRedirect: (client: string | null, clientName: string | null) => void;
  onMessage: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const fetchSprint = usePluginAction("seo.sprint");
  const callAction = usePluginAction("seo.call");
  const runDaily = usePluginAction("seo.run-daily");
  const runWeekly = usePluginAction("seo.run-weekly");
  const [bundle, setBundle] = useState<SprintBundle | null>(null);
  const [tab, setTab] = useState<TabId>(TABS.some((t) => t.id === initialTab) ? initialTab : "plan");
  const [working, setWorking] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const client = scopeParamValue(scope);

  const reload = useCallback(async () => {
    const result = (await fetchSprint({ sprintId, client })) as SprintBundle | { redirect: { client: string | null; clientName: string | null } };
    if ("redirect" in result) {
      onRedirect(result.redirect.client, result.redirect.clientName);
      return;
    }
    setBundle(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSprint, sprintId, client]);

  useEffect(() => {
    reload().catch((error: unknown) => onMessage(errorText(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprintId]);

  const call = useCallback(
    async (tool: string, params: Record<string, unknown>, success?: string) => {
      setWorking(tool);
      try {
        const result = await callAction({ tool, params });
        await reload();
        if (success) onMessage(success);
        return result;
      } catch (error) {
        onMessage(errorText(error));
        return null;
      } finally {
        setWorking(null);
      }
    },
    [callAction, reload, onMessage],
  );

  async function run(label: string, fn: () => Promise<unknown>, success: (r: unknown) => string) {
    setWorking(label);
    try {
      const result = await fn();
      await reload();
      await onChanged();
      onMessage(success(result));
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setWorking(null);
    }
  }

  if (!bundle) return <p style={{ color: tokens.muted, fontSize: 13 }}>Loading sprint…</p>;
  const s = bundle.sprint;
  const selectTab = (id: TabId) => {
    setTab(id);
    onTab(id);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 280px" }}>
          <button type="button" onClick={onBack} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: tokens.muted, minHeight: 24 }}>← {scope ? "This client's sprints" : "All PiB sprints"}</button>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 650, ...breakAnywhere }}>{s.siteName}</h2>
          <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>
            {s.siteUrl} · start {s.startDate} · root issue <IssueLink id={s.rootIssueId} identifier={s.rootIssueIdentifier} />
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
          <Select
            aria-label="Autopilot"
            value={s.autopilotMode}
            style={{ width: 150, minWidth: 0 }}
            onChange={(e) => void call("set-autopilot", { sprintId, mode: e.target.value }, `Autopilot set to ${e.target.value}.`).then(() => onChanged())}
          >
            <option value="off">Autopilot: off</option>
            <option value="safe">Autopilot: safe</option>
            <option value="full">Autopilot: full</option>
          </Select>
          <Button type="button" variant="secondary" disabled={!!working || s.legacy} onClick={() => void run("daily", () => runDaily({ sprintId }), (r) => { const x = r as { issuesOpened: number; warnings: string[] }; return `Daily run done: ${x.issuesOpened} issue(s) opened.${x.warnings.length ? ` ${x.warnings.join(" · ")}` : ""}`; })}>
            {working === "daily" ? "Running…" : "Run daily now"}
          </Button>
          <Button type="button" variant="secondary" disabled={!!working || s.legacy} onClick={() => void run("weekly", () => runWeekly({ sprintId }), (r) => { const x = r as { signals: unknown[]; proposalsCreated: unknown[] }; return `Weekly review: ${x.signals.length} signal(s), ${x.proposalsCreated.length} new proposal(s).`; })}>
            {working === "weekly" ? "Reviewing…" : "Run weekly review"}
          </Button>
          {s.status === "paused" || s.status === "archived" ? (
            <Button type="button" variant="secondary" onClick={() => void call("resume-sprint", { sprintId }, "Sprint resumed.").then(() => onChanged())}>Resume</Button>
          ) : (
            <Button type="button" variant="secondary" onClick={() => void call("pause-sprint", { sprintId }, "Sprint paused.").then(() => onChanged())}>Pause</Button>
          )}
          {s.status !== "archived" ? (
            <Button type="button" variant="secondary" onClick={() => { if (window.confirm("Archive this sprint? Nothing runs for it afterwards.")) void call("archive-sprint", { sprintId }, "Sprint archived.").then(() => onChanged()); }}>Archive</Button>
          ) : null}
        </div>
      </div>
      {!scope && s.legacyClientName ? (
        <Banner tone="warn">
          <strong>This sprint names a client (“{s.legacyClientName}”) but is not linked to a CRM record, so it shows under PiB's own sites.</strong>
          <span>Link it to the client's CRM company or contact to move it into that client's workspace.</span>
          <span><Button type="button" variant="secondary" style={small} onClick={() => setLinking(true)}>Link to CRM client</Button></span>
        </Banner>
      ) : null}
      <LinkClientModal open={linking} sprint={s} onClose={() => setLinking(false)} call={call} />
      <Tabs tabs={TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, ...tabCount(t.id, bundle) }))} active={tab} onChange={(id) => selectTab(id as TabId)} />
      {tab === "plan" ? <SprintOverview bundle={bundle} today={load.today} /> : null}
      {tab === "plan" ? <PlanTab bundle={bundle} call={call} /> : null}
      {tab === "keywords" ? <KeywordsTab bundle={bundle} call={call} working={working} /> : null}
      {tab === "backlinks" ? <BacklinksTab bundle={bundle} call={call} /> : null}
      {tab === "content" ? <ContentTab bundle={bundle} call={call} /> : null}
      {tab === "audits" ? <AuditsTab bundle={bundle} call={call} working={working} /> : null}
      {tab === "optimizations" ? <OptimizationsTab bundle={bundle} call={call} /> : null}
      {tab === "integrations" ? <IntegrationsTab companyId={companyId} bundle={bundle} load={load} call={call} reload={reload} onMessage={onMessage} working={working} /> : null}
    </div>
  );
}

type CallFn = (tool: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;

/** Count and tone on each sprint tab: what needs action is amber or red. */
function tabCount(id: TabId, bundle: SprintBundle): { count?: number | null; countTone?: "ok" | "warn" | "bad" | "info" } {
  const day = bundle.sprint.day;
  switch (id) {
    case "plan": {
      const blocked = bundle.tasks.filter((t) => t.status === "blocked").length;
      const due = dueOpen(bundle.tasks, day);
      return blocked ? { count: blocked, countTone: "bad" } : due ? { count: due, countTone: "warn" } : {};
    }
    case "keywords": return { count: bundle.keywords.filter((k) => !k.retiredAt).length || null };
    case "backlinks": { const live = bundle.backlinks.filter((b) => b.status === "live").length; return { count: live || null, countTone: live ? "ok" : undefined }; }
    case "content": return { count: bundle.content.length || null };
    case "audits": {
      const serious = bundle.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
      return serious ? { count: serious, countTone: "bad" } : { count: bundle.findings.length || null, countTone: bundle.findings.length ? "warn" : undefined };
    }
    case "optimizations": { const p = bundle.optimizations.filter((o) => o.status === "proposed").length; return { count: p || null, countTone: p ? "warn" : undefined }; }
    case "integrations": {
      const broken = bundle.integrations.filter((i) => statusTone(i.status) === "bad" || i.lastError).length;
      const needs = bundle.needsYou?.open.length ?? 0;
      return broken ? { count: broken, countTone: "bad" } : needs ? { count: needs, countTone: "warn" } : {};
    }
    default: return {};
  }
}

/** The sprint at a glance: day X/90, health, tasks by state, and Search Console traffic. */
function SprintOverview({ bundle, today }: { bundle: SprintBundle; today: string }) {
  const s = bundle.sprint;
  const day = Math.min(Math.max(s.day, 0), 90);
  const segments = taskSegments(bundle.tasks.filter((t) => t.source === "template" || t.week <= 13), s.day);
  const done = bundle.tasks.filter((t) => t.status === "done").length;
  const score = s.health?.score ?? null;
  const hTone = healthTone(score);
  const signals = s.health?.signals ?? [];
  const traffic = trafficSeries(bundle.traffic, today, 28);
  const tracked = bundle.keywords.filter((k) => !k.retiredAt);
  const top10 = tracked.filter((k) => (k.currentPosition ?? 999) <= 10).length;
  const due = dueOpen(bundle.tasks, s.day);
  const blocked = bundle.tasks.filter((t) => t.status === "blocked").length;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={grid(300)}>
        <SectionCard style={top} title="Sprint progress" subtitle={s.legacy ? "Legacy sprint without the 90-day plan" : `Week ${s.week} · ${s.phaseName}`} icon={Rocket} actions={<Badge status={s.status} />}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <ProgressRing value={s.legacy ? 0 : day / 90} size={96} label={`Day ${day} of 90`}>
              <span style={{ display: "grid", placeItems: "center", lineHeight: 1.1 }}>
                <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{s.legacy ? "—" : day}</strong>
                <span style={{ fontSize: 11, color: tokens.muted }}>of 90 days</span>
              </span>
            </ProgressRing>
            <div style={{ display: "grid", gap: 8, flex: "1 1 180px", minWidth: 0 }}>
              <ProgressBar done={done} total={bundle.tasks.length} label="Tasks done" size="sm" />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {due ? <Pill tone="warn" size="sm" dot>{due} due</Pill> : <Pill tone="ok" size="sm" dot>nothing due</Pill>}
                {blocked ? <Pill tone="bad" size="sm" dot>{blocked} blocked</Pill> : null}
              </div>
            </div>
          </div>
          <StackedBar title="Plan tasks by state" segments={segments} height={10} />
        </SectionCard>
        <SectionCard style={top} title="Health" subtitle={signals.length ? `${signals.length} signal${signals.length === 1 ? "" : "s"} from the weekly review` : "No signals this week"} icon={HeartPulse} tone={score == null ? undefined : hTone} strip={hTone === "bad"}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <ProgressRing value={score == null ? 0 : score / 100} size={96} tone={score == null ? "neutral" : hTone} label={`Health score ${score ?? "not measured"}`}>
              <span style={{ display: "grid", placeItems: "center", lineHeight: 1.1 }}>
                <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: score == null ? tokens.muted : tone(hTone).fg }}>{score == null ? "—" : Math.round(score)}</strong>
                <span style={{ fontSize: 11, color: tokens.muted }}>score</span>
              </span>
            </ProgressRing>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 160px", minWidth: 0 }}>
              {signals.length ? signals.slice(0, 8).map((sig, i) => <Pill key={`${sig.type}-${i}`} tone={statusTone(sig.severity)} size="sm">{sig.type.replace(/_/g, " ")}</Pill>) : <span style={{ fontSize: 12.5, color: tokens.muted }}>The weekly review scores traffic, rankings, links and content against the plan.</span>}
            </div>
          </div>
        </SectionCard>
      </div>
      <div style={grid(150, 10)}>
        <KpiCard label="Clicks (28 days)" value={formatCompact(traffic.totals.clicks)} icon={Eye} delta={changeText(traffic.totals.clicks, traffic.previous.clicks, "the 28 days before")} sparkline={traffic.hasData ? traffic.clicks : undefined} hint={traffic.hasData ? "Tracked keywords, Search Console" : "No Search Console data yet"} />
        <KpiCard label="Impressions (28 days)" value={formatCompact(traffic.totals.impressions)} icon={ChartLine} delta={changeText(traffic.totals.impressions, traffic.previous.impressions, "the 28 days before")} sparkline={traffic.hasData ? traffic.impressions : undefined} />
        <KpiCard label="Top 10 keywords" value={`${top10} / ${tracked.length}`} icon={Target} tone={tracked.length && !top10 && s.day > 45 ? "warn" : undefined} hint={tracked.length ? "Tracked keywords on page 1" : "No keywords yet"} />
        <KpiCard label="Live backlinks" value={bundle.backlinks.filter((b) => b.status === "live").length} icon={Share2} hint={`${bundle.backlinks.filter((b) => b.status === "submitted").length} submitted`} />
      </div>
      {traffic.hasData ? (
        <SectionCard title="Search Console" subtitle={`Tracked keywords, 28 days to ${traffic.end}: ${formatCompact(traffic.totals.impressions)} impressions, ${formatCompact(traffic.totals.clicks)} clicks`} icon={ChartLine}>
          <TrendChart
            labels={traffic.labels}
            series={[
              { key: "impressions", label: "Impressions", values: traffic.impressions },
              { key: "clicks", label: "Clicks", values: traffic.clicks, tone: "info" },
            ]}
            title="Search Console impressions and clicks"
            height={130}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}

type CrmClientOption = { client: string; kind: "company" | "contact"; id: string; name: string; detail: string | null };

/** People only: move an own sprint that names a client into that client's workspace. */
function LinkClientModal({ open, sprint, onClose, call }: { open: boolean; sprint: SprintSummary; onClose: () => void; call: CallFn }) {
  const listClients = usePluginAction("seo.clients");
  const [clients, setClients] = useState<CrmClientOption[] | null>(null);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || clients) return;
    listClients({})
      .then((result) => {
        const list = (result as { clients: CrmClientOption[] }).clients;
        setClients(list);
        const legacy = sprint.legacyClientName?.trim().toLowerCase();
        const match = legacy ? list.find((c) => c.name.trim().toLowerCase() === legacy) : undefined;
        if (match) setChoice(match.client);
      })
      .catch((e: unknown) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      title="Link sprint to a CRM client"
      description="The sprint, its issues and its data move into the client's workspace. New task issues start with the client's name."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!choice} onClick={() => void call("update-sprint", { sprintId: sprint.sprintId, client: choice }, "Sprint linked to the CRM client.").then(onClose)}>Link</Button>
        </>
      )}
    >
      <Field label="CRM client">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{clients ? (clients.length === 0 ? "No CRM clients yet (run CRM resync)" : "Choose a company or contact") : "Loading…"}</option>
          {(clients ?? []).map((c) => (
            <option key={c.client} value={c.client}>{c.name} · {c.kind}{c.detail ? ` · ${c.detail}` : ""}</option>
          ))}
        </Select>
      </Field>
      {error ? <p style={{ margin: 0, color: tokens.destructive, fontSize: 13 }}>{error}</p> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function PlanTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const [selected, setSelected] = useState<Task | null>(null);
  const narrow = useIsNarrow();
  const weekColumns = `${narrow ? 56 : 72}px minmax(0, 1fr)`;
  const day = bundle.sprint.day;
  const open = bundle.tasks.filter((t) => ["not_started", "in_progress", "blocked"].includes(t.status));
  const due = open.filter((t) => t.dueDay == null || t.dueDay <= day);
  const weeks = Array.from({ length: 14 }, (_, w) => w);
  const extra = bundle.tasks.filter((t) => t.week > 13 || t.source !== "template");
  const todayInfo = bundle.today as { next?: string[]; warnings?: string[]; asOf?: string };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SectionCard title={`Today: ${due.length} due`} subtitle="What the daily run opened, and who it waits on" icon={CalendarCheck} tone={due.some((t) => t.status === "blocked") ? "bad" : due.length ? "warn" : "ok"}>
        {todayInfo.next && todayInfo.next.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.muted }}>
            {todayInfo.next.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
        {todayInfo.warnings && todayInfo.warnings.length > 0 ? (
          <Banner tone="bad"><span>Last daily run: {todayInfo.warnings.join(" · ")}</span></Banner>
        ) : null}
        {due.length === 0 ? (
          <EmptyState compact icon={CircleCheck} tone="ok" title="Nothing due right now" description="The next daily run opens the tasks that come due." />
        ) : (
          <DataTable
            columns={[
              { key: "title", header: "Task", render: (v, row) => <span>{String(v)} <span style={{ color: tokens.muted, fontSize: 12 }}>· W{String(row.week)}</span></span> },
              { key: "owner", header: "Owner", render: (v) => <Pill size="sm" tone={v === "human" ? "warn" : "neutral"} variant="outline">{v === "human" ? "Person" : "Agent"}</Pill> },
              { key: "status", header: "Status", render: (v) => <Badge status={String(v)} /> },
              { key: "issueId", header: "Issue", render: (v, row) => (v ? <IssueLink id={String(v)} identifier={row.issueIdentifier as string | null} /> : <span style={{ color: tokens.muted, fontSize: 12 }}>next daily run</span>) },
              { key: "humanAsk", header: "Waiting on", render: (v, row) => (v ? String(v) : row.blockerReason ? String(row.blockerReason) : "") },
            ]}
            rows={due}
          />
        )}
      </SectionCard>
      <SectionCard title="13-week plan" subtitle={`${bundle.tasks.filter((t) => t.status === "done").length} of ${bundle.tasks.length} tasks done · tap a task for details`} icon={ListChecks}>
        <ChartLegend items={(Object.keys(CHIP_LABEL) as ChipState[]).map((k) => ({ label: CHIP_LABEL[k], tone: CHIP_TONE[k], value: bundle.tasks.filter((t) => chipState(t, day) === k).length }))} />
        <ScrollX label="13-week plan">
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          {weeks.map((w) => {
            const items = bundle.tasks.filter((t) => t.week === w && t.source === "template");
            if (items.length === 0) return null;
            const current = bundle.sprint.week === w;
            return (
              <div key={w} style={{ display: "grid", gridTemplateColumns: weekColumns, gap: narrow ? 8 : 10, alignItems: "start" }}>
                <div style={{ fontSize: 12, fontWeight: current ? 700 : 500, color: current ? tone("accent").fg : tokens.muted, paddingTop: 5, display: "flex", alignItems: "center", gap: 5 }}>
                  {current ? <StatusDot tone="accent" pulse label="This week" /> : null}Week {w}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {items.map((t) => <TaskChip key={t.id} task={t} state={chipState(t, day)} onClick={() => setSelected(t)} />)}
                </div>
              </div>
            );
          })}
          {extra.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: weekColumns, gap: narrow ? 8 : 10 }}>
              <div style={{ fontSize: 12, color: tokens.muted, paddingTop: 5 }}>Added</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {extra.map((t) => <TaskChip key={t.id} task={t} state={chipState(t, day)} onClick={() => setSelected(t)} />)}
              </div>
            </div>
          ) : null}
        </div>
        </ScrollX>
      </SectionCard>
      <TaskSheet task={selected} onClose={() => setSelected(null)} call={call} />
    </div>
  );
}

function TaskChip({ task, state, onClick }: { task: Task; state: ChipState; onClick: () => void }) {
  const colors = tone(CHIP_TONE[state]);
  const future = state === "future" || state === "skipped";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${task.title} — ${task.status.replace(/_/g, " ")}${task.owner === "human" ? " (person)" : ""}`}
      style={{
        appearance: "none",
        border: `1px solid ${future ? tokens.border : colors.border}`,
        borderLeft: `3px solid ${colors.solid}`,
        background: future ? "transparent" : colors.soft,
        color: future ? tokens.muted : tokens.fg,
        borderRadius: 8,
        padding: "4px 8px",
        fontSize: 12,
        maxWidth: "min(280px, 100%)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "pointer",
        textDecoration: state === "skipped" ? "line-through" : "none",
        fontFamily: "inherit",
      }}
    >
      {task.owner === "human" ? "👤 " : ""}{task.title}
    </button>
  );
}

function TaskSheet({ task, onClose, call }: { task: Task | null; onClose: () => void; call: CallFn }) {
  const [note, setNote] = useState("");
  if (!task) return null;
  const openStatus = ["not_started", "in_progress", "blocked"].includes(task.status);
  return (
    <Modal open title={task.title} description={`Week ${task.week} · ${task.focus} · ${task.taskType} · ${task.owner === "human" ? "person" : "agent"}${task.autopilotEligible ? "" : " · needs sign-off in safe mode"}`} onClose={onClose}
      footer={openStatus ? (
        <>
          <Button type="button" variant="secondary" onClick={() => { if (!note.trim()) return; void call("skip-task", { taskId: task.id, reason: note }, "Task skipped.").then(onClose); }}>Skip (reason below)</Button>
          <Button type="button" onClick={() => { void call("complete-task", { taskId: task.id, summary: note.trim() || "Marked done from the SEO page." }, "Task done.").then(onClose); }}>Mark done</Button>
        </>
      ) : undefined}
    >
      <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
        <div>Status: <Badge status={task.status} /></div>
        <div>Issue: <IssueLink id={task.issueId} identifier={task.issueIdentifier} /></div>
        {task.humanAsk ? <div><strong>Waiting on:</strong> {task.humanAsk}</div> : null}
        {task.blockerReason ? <div><strong>Reason:</strong> {task.blockerReason}</div> : null}
        {task.completedAt ? <div style={{ color: tokens.muted }}>Completed {task.completedAt.slice(0, 10)}</div> : null}
      </div>
      {openStatus ? <Field label="Summary or skip reason"><TextArea value={note} onChange={(e) => setNote(e.target.value)} /></Field> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

function KeywordsTab({ bundle, call, working }: { bundle: SprintBundle; call: CallFn; working: string | null }) {
  const [adding, setAdding] = useState(false);
  const [lines, setLines] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const keywords = bundle.keywords.filter((k) => showRetired || !k.retiredAt);
  const top10 = keywords.filter((k) => !k.retiredAt && (k.currentPosition ?? 999) <= 10).length;
  const impressions = keywords.filter((k) => !k.retiredAt).reduce((n, k) => n + (k.impressions ?? 0), 0);
  const trends = bundle.keywords.filter((k) => !k.retiredAt).map((k) => positionTrendTone(k.history.map((h) => h.position).filter((p): p is number => p != null)));
  const improved = trends.filter((t) => t === "ok").length;
  const declined = trends.filter((t) => t === "bad").length;
  const steady = trends.length - improved - declined;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Tracked" value={bundle.keywords.filter((k) => !k.retiredAt).length} icon={Target} />
        <KpiCard label="Top 10" value={top10} icon={CircleCheck} tone={top10 ? "ok" : undefined} hint={improved || declined ? `${improved} up · ${declined} down` : undefined} />
        <KpiCard label="Impressions (8 days)" value={formatCompact(impressions)} icon={Eye} />
        <KpiCard label="Priority" value={bundle.keywords.filter((k) => k.isPriority && !k.retiredAt).length} icon={Rocket} />
      </div>
      {bundle.keywords.some((k) => !k.retiredAt) ? (
        <div style={grid(320)}>
          <SectionCard style={top} title="Positions" subtitle="Tracked keywords by where they rank in Google" icon={ChartColumn}>
            <BarList bare title="Keywords by position" items={positionBuckets(bundle.keywords)} formatValue={(v) => String(v)} />
          </SectionCard>
          <SectionCard style={top} title="Movement" subtitle="First to latest position in the tracked history" icon={Activity}>
            <StackedBar title="Keyword movement" segments={[{ label: "Moved up", value: improved, tone: "ok" }, { label: "Steady", value: steady, tone: "neutral" }, { label: "Moved down", value: declined, tone: "bad" }]} height={12} />
          </SectionCard>
        </div>
      ) : null}
      <Toolbar>
        <label style={{ fontSize: 12, color: tokens.muted, display: "inline-flex", gap: 6, alignItems: "center", minHeight: 36 }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
        </label>
        <Button type="button" onClick={() => setAdding(true)}>+ Keywords</Button>
      </Toolbar>
      {keywords.length === 0 ? (
        <EmptyState icon={Target} title="No keywords yet" description="Week 2 of the plan picks 20–30 winnable keywords. Positions arrive daily from Search Console." />
      ) : (
        <DataTable
          columns={[
            { key: "phrase", header: "Keyword", render: (v, row) => <span>{row.isPriority ? "★ " : ""}{String(v)}{row.retiredAt ? <span style={{ color: tokens.muted }}> (retired)</span> : null}</span> },
            {
              key: "intent",
              header: "Intent",
              render: (v, row) => (
                <Select value={String(v ?? "")} style={{ height: 28, fontSize: 12, width: 110, minWidth: 0 }} onChange={(e) => void call("update-keyword", { keywordId: row.id, intent: e.target.value })}>
                  <option value="">—</option>
                  <option value="problem">problem</option>
                  <option value="solution">solution</option>
                  <option value="brand">brand</option>
                </Select>
              ),
            },
            { key: "currentPosition", header: "Position", render: (v) => { const p = v as number | null; return p == null ? "—" : <Pill size="sm" tone={p <= 3 ? "ok" : p <= 10 ? "info" : p <= 20 ? "warn" : "neutral"}>{fmt(p)}</Pill>; } },
            { key: "history", header: "Trend", render: (v) => <Sparkline values={((v as Keyword["history"]) ?? []).map((h) => h.position).filter((p): p is number => p != null)} /> },
            { key: "impressions", header: "Impr.", render: (v) => fmt(v as number | null, 0) },
            { key: "clicks", header: "Clicks", render: (v) => fmt(v as number | null, 0) },
            { key: "ctr", header: "CTR", render: (v) => pct(v as number | null) },
            { key: "status", header: "Status", render: (v) => <Badge status={String(v)} /> },
            { key: "targetUrl", header: "Target", render: (v, row) => <span style={{ fontSize: 12, color: tokens.muted, wordBreak: "break-all" }}>{String(v ?? row.rankingUrl ?? "—")}</span> },
            {
              key: "id",
              header: "",
              width: "150px",
              render: (_v, row) => row.retiredAt ? null : (
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  <Button type="button" variant="secondary" style={small} onClick={() => void call("update-keyword", { keywordId: row.id, priority: !row.isPriority })}>{row.isPriority ? "Unstar" : "Star"}</Button>
                  <Button type="button" variant="secondary" style={small} onClick={() => void call("retire-keyword", { keywordId: row.id }, "Keyword retired.")}>Retire</Button>
                </span>
              ),
            },
          ]}
          rows={keywords}
        />
      )}
      <Modal open={adding} title="Add keywords" description="One per line. Optional: add | intent (problem, solution, brand)." onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={working === "add-keywords" || !lines.trim()} onClick={() => {
              const keywords = lines.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
                const [phrase, intent] = l.split("|").map((p) => p.trim());
                return intent && ["problem", "solution", "brand"].includes(intent) ? { phrase, intent } : { phrase };
              });
              void call("add-keywords", { sprintId: bundle.sprint.sprintId, keywords }, `${keywords.length} keyword(s) submitted.`).then(() => { setLines(""); setAdding(false); });
            }}>Add</Button>
          </>
        )}
      >
        <TextArea value={lines} onChange={(e) => setLines(e.target.value)} style={{ minHeight: 160 }} placeholder={"accounting firm durban | solution\nhow to register a company in south africa | problem"} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

function BacklinksTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const [editing, setEditing] = useState<{ link: Backlink; status: string } | null>(null);
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ domain: "", type: "directory", dr: "", url: "", notes: "" });
  const counts = bundle.backlinks.reduce<Record<string, number>>((acc, b) => { acc[b.status] = (acc[b.status] ?? 0) + 1; return acc; }, {});
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Live" value={counts.live ?? 0} icon={CircleCheck} tone={counts.live ? "ok" : undefined} />
        <KpiCard label="Submitted" value={counts.submitted ?? 0} icon={Activity} tone={counts.submitted ? "warn" : undefined} hint="Waiting for the site" />
        <KpiCard label="Not started" value={counts.not_started ?? 0} icon={ListChecks} />
        <KpiCard label="Rejected / lost" value={(counts.rejected ?? 0) + (counts.lost ?? 0)} icon={CircleAlert} tone={(counts.rejected ?? 0) + (counts.lost ?? 0) ? "bad" : undefined} />
      </div>
      {bundle.backlinks.length ? (
        <SectionCard title="Backlinks by status" subtitle={`${bundle.backlinks.length} in the plan`} icon={Share2}>
          <StackedBar title="Backlinks by status" segments={backlinkSegments(bundle.backlinks)} height={12} />
        </SectionCard>
      ) : null}
      <Toolbar><Button type="button" onClick={() => setAdding(true)}>+ Backlink</Button></Toolbar>
      <DataTable
        columns={[
          { key: "source", header: "Source", render: (v, row) => <span>{String(v)}{row.url ? <><br /><span style={{ fontSize: 12, color: tokens.muted, wordBreak: "break-all" }}>{String(row.url)}</span></> : null}</span> },
          { key: "type", header: "Type", render: (v) => String(v).replace(/_/g, " ") },
          { key: "dr", header: "DR", render: (v) => fmt(v as number | null, 0) },
          {
            key: "status",
            header: "Status",
            render: (v, row) => (
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <StatusDot tone={statusTone(String(v))} label={String(v).replace(/_/g, " ")} />
              <Select value={String(v)} style={{ height: 28, fontSize: 12, width: 130, minWidth: 0 }} onChange={(e) => { setNotes(""); setUrl(String(row.url ?? "")); setEditing({ link: row as unknown as Backlink, status: e.target.value }); }}>
                {["not_started", "in_progress", "submitted", "live", "rejected", "lost"].map((st) => <option key={st} value={st}>{st.replace(/_/g, " ")}</option>)}
              </Select>
              </span>
            ),
          },
          { key: "notes", header: "Notes", render: (v) => <span style={{ fontSize: 12, color: tokens.muted, whiteSpace: "pre-wrap" }}>{String(v ?? "")}</span> },
        ]}
        rows={bundle.backlinks}
        emptyMessage="No backlinks."
      />
      <Modal open={!!editing} title={editing ? `${editing.link.source}: ${editing.status.replace(/_/g, " ")}` : ""} description="Submitted, rejected and lost need notes; live needs the listing URL." onClose={() => setEditing(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="button" onClick={() => {
              if (!editing) return;
              void call("update-backlink", { backlinkId: editing.link.id, status: editing.status, notes: notes || undefined, url: url || undefined }, "Backlink updated.").then(() => setEditing(null));
            }}>Save</Button>
          </>
        )}
      >
        <Field label="Listing / linking URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Notes (where, when, account used, or why)"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </Modal>
      <Modal open={adding} title="Add backlink" onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={!form.domain.trim()} onClick={() => void call("add-backlink", { sprintId: bundle.sprint.sprintId, domain: form.domain, type: form.type, dr: form.dr ? Number(form.dr) : undefined, url: form.url || undefined, notes: form.notes || undefined }, "Backlink added.").then(() => { setAdding(false); setForm({ domain: "", type: "directory", dr: "", url: "", notes: "" }); })}>Add</Button>
          </>
        )}
      >
        <Field label="Domain"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="yellowpages.co.za" /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {["directory", "citation", "community", "guest_post", "link_trade", "organic", "other"].map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </Select>
        </Field>
        <Field label="DR (if known)"><Input value={form.dr} onChange={(e) => setForm({ ...form, dr: e.target.value })} inputMode="numeric" /></Field>
        <Field label="URL"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
        <Field label="Notes"><TextArea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function ContentTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", type: "post", targetKeywordId: "", targetUrl: "" });
  const [liveFor, setLiveFor] = useState<Content | null>(null);
  const [liveUrl, setLiveUrl] = useState("");
  const pillars = bundle.content.filter((c) => c.type === "pillar");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {bundle.content.length ? (
        <div style={grid(150, 10)}>
          <KpiCard label="Live" value={bundle.content.filter((c) => c.status === "live").length} icon={CircleCheck} tone={bundle.content.some((c) => c.status === "live") ? "ok" : undefined} />
          <KpiCard label="In the works" value={bundle.content.filter((c) => ["idea", "drafting", "scheduled"].includes(c.status)).length} icon={FileText} />
          <KpiCard label="In review" value={bundle.content.filter((c) => c.status === "review").length} icon={Eye} tone={bundle.content.some((c) => c.status === "review") ? "warn" : undefined} />
          <KpiCard label="Clicks" value={formatCompact(bundle.content.reduce((n, c) => n + (c.clicks ?? 0), 0))} icon={ChartLine} hint="Live content, Search Console" />
        </div>
      ) : null}
      <Toolbar><Button type="button" onClick={() => setAdding(true)}>+ Content</Button></Toolbar>
      <DataTable
        columns={[
          { key: "title", header: "Title", render: (v, row) => <span>{String(v)}{row.targetUrl ? <><br /><span style={{ fontSize: 12, color: tokens.muted, wordBreak: "break-all" }}>{String(row.targetUrl)}</span></> : null}</span> },
          { key: "type", header: "Type" },
          {
            key: "status",
            header: "Status",
            render: (v, row) => (
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <StatusDot tone={statusTone(String(v))} label={String(v)} />
              <Select value={String(v)} style={{ height: 28, fontSize: 12, width: 120, minWidth: 0 }} onChange={(e) => {
                if (e.target.value === "live" && !row.targetUrl) { setLiveUrl(""); setLiveFor(row as unknown as Content); return; }
                void call("update-content", { contentId: row.id, status: e.target.value });
              }}>
                {["idea", "drafting", "review", "scheduled", "live", "archived"].map((st) => <option key={st} value={st}>{st}</option>)}
              </Select>
              </span>
            ),
          },
          { key: "impressions", header: "Impr.", render: (v) => fmt(v as number | null, 0) },
          { key: "clicks", header: "Clicks", render: (v) => fmt(v as number | null, 0) },
          { key: "position", header: "Pos.", render: (v) => fmt(v as number | null) },
          {
            key: "linksToPillarIds",
            header: "Links to pillar",
            render: (v, row) => row.type === "pillar" || pillars.length === 0 ? "—" : (
              <Select value={((v as string[]) ?? [])[0] ?? ""} style={{ height: 28, fontSize: 12, width: 150, minWidth: 0 }} onChange={(e) => void call("update-content", { contentId: row.id, linksToPillarIds: e.target.value ? [e.target.value] : [] })}>
                <option value="">No</option>
                {pillars.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
            ),
          },
        ]}
        rows={bundle.content}
        emptyMessage="No content yet. Core pages, posts, the pillar and cluster posts land here."
      />
      <Modal open={adding} title="Add content" onClose={() => setAdding(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="button" disabled={!form.title.trim()} onClick={() => void call("add-content", { sprintId: bundle.sprint.sprintId, title: form.title, type: form.type, targetKeywordId: form.targetKeywordId || undefined, targetUrl: form.targetUrl || undefined }, "Content added.").then(() => { setAdding(false); setForm({ title: "", type: "post", targetKeywordId: "", targetUrl: "" }); })}>Add</Button>
          </>
        )}
      >
        <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {["post", "page", "comparison", "alternative", "use-case", "pillar", "cluster", "how-to", "feature"].map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Target keyword">
          <Select value={form.targetKeywordId} onChange={(e) => setForm({ ...form, targetKeywordId: e.target.value })}>
            <option value="">None</option>
            {bundle.keywords.filter((k) => !k.retiredAt).map((k) => <option key={k.id} value={k.id}>{k.phrase}</option>)}
          </Select>
        </Field>
        <Field label="URL (when it exists)"><Input value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} /></Field>
      </Modal>
      <Modal open={!!liveFor} title="Mark live" description="Live content needs its URL (GSC impressions attach to it)." onClose={() => setLiveFor(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setLiveFor(null)}>Cancel</Button>
            <Button type="button" disabled={!liveUrl.trim()} onClick={() => { if (!liveFor) return; void call("update-content", { contentId: liveFor.id, status: "live", targetUrl: liveUrl }, "Marked live.").then(() => setLiveFor(null)); }}>Save</Button>
          </>
        )}
      >
        <Field label="Live URL"><Input value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

function AuditsTab({ bundle, call, working }: { bundle: SprintBundle; call: CallFn; working: string | null }) {
  const bySeverity = bundle.findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {});
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SectionCard title="Snapshots" subtitle="Day 0, 30, 60 and 90, then monthly" icon={Gauge} actions={<Button type="button" variant="secondary" style={small} disabled={working === "run-audit-snapshot"} onClick={() => void call("run-audit-snapshot", { sprintId: bundle.sprint.sprintId }, "Snapshot recorded.")}>Take snapshot now</Button>}>
        {bundle.snapshots.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>The daily run records snapshots on days 0, 30, 60 and 90, then monthly.</p>
        ) : (
          <DataTable
            columns={[
              { key: "day", header: "Day", render: (v, row) => `${String(v)}${row.kind === "manual" ? " (manual)" : ""}` },
              { key: "capturedOn", header: "Captured" },
              { key: "traffic", header: "Impressions", render: (v) => fmt((v as { impressions?: number }).impressions ?? null, 0) },
              { key: "id", header: "Clicks", render: (_v, row) => fmt(((row.traffic as { clicks?: number }) ?? {}).clicks ?? null, 0) },
              { key: "rankings", header: "Top 10 / tracked", render: (v) => { const r = v as { top10?: number; tracked?: number }; return `${r.top10 ?? 0} / ${r.tracked ?? 0}`; } },
              { key: "authority", header: "Live links (domains)", render: (v) => { const a = v as { liveBacklinks?: number; referringDomains?: number }; return `${a.liveBacklinks ?? 0} (${a.referringDomains ?? 0})`; } },
              { key: "content", header: "Live content", render: (v) => fmt((v as { live?: number }).live ?? 0, 0) },
              { key: "source", header: "Source" },
            ]}
            rows={bundle.snapshots}
          />
        )}
      </SectionCard>
      <SectionCard title={`Open findings (${bundle.findings.length})`} subtitle="From the site checks; resolved when a re-run no longer reports them" icon={HeartPulse} tone={(bySeverity.critical ?? 0) + (bySeverity.high ?? 0) ? "bad" : bundle.findings.length ? "warn" : "ok"} strip={(bySeverity.critical ?? 0) > 0}>
        {bundle.findings.length ? <StackedBar title="Open findings by severity" segments={severitySegments(bundle.findings)} height={10} /> : null}
        {bundle.findings.length === 0 ? (
          <EmptyState compact tone="ok" icon={CircleCheck} title="No open findings" description="Site checks with a sprint record findings here and resolve them when a re-run no longer reports them." />
        ) : (
          <DataTable
            columns={[
              { key: "severity", header: "Severity", render: (v) => <Badge status={String(v)} /> },
              { key: "category", header: "Area" },
              { key: "finding", header: "Finding" },
              { key: "url", header: "URL", render: (v) => <span style={{ fontSize: 12, color: tokens.muted, wordBreak: "break-all" }}>{String(v || "—")}</span> },
              { key: "id", header: "", width: "100px", render: (v) => <Button type="button" variant="secondary" style={small} onClick={() => void call("resolve-finding", { findingId: v }, "Finding resolved.")}>Resolve</Button> },
            ]}
            rows={bundle.findings}
          />
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Optimizations
// ---------------------------------------------------------------------------

function OptimizationsTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const [rejecting, setRejecting] = useState<Optimization | null>(null);
  const [reason, setReason] = useState("");
  const proposed = bundle.optimizations.filter((o) => o.status === "proposed");
  const others = bundle.optimizations.filter((o) => o.status !== "proposed");
  const board = Object.entries(bundle.scoreboard ?? {});
  const results = optimizationSegments(bundle.scoreboard, bundle.optimizations);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {results.some((r) => r.value > 0) ? (
        <div style={grid(320)}>
          <SectionCard style={top} title="Results" subtitle="Approved changes measured after 14 days" icon={ChartPie}>
            <DonutChart title="Optimization results" segments={results} centerValue={results.reduce((n, r) => n + r.value, 0)} centerLabel="measured" />
          </SectionCard>
          <SectionCard style={top} title="Win rate by type" subtitle="Wins out of measured changes, per hypothesis type" icon={ChartColumn}>
            <BarList bare title="Win rate by hypothesis type" items={board.map(([type, e]) => { const n = e.wins + e.losses + e.noChange + (e.inconclusive ?? 0); return { label: type.replace(/_/g, " "), value: n ? Math.round((e.wins / n) * 100) : 0, tone: e.wins > e.losses ? "ok" as const : e.losses > e.wins ? "bad" as const : "neutral" as const }; })} formatValue={(v) => `${v}%`} />
          </SectionCard>
        </div>
      ) : null}
      <SectionCard title={`Proposals (${proposed.length})`} subtitle="Changes the weekly review suggests" icon={Lightbulb} tone={proposed.length ? "warn" : undefined}>
        {proposed.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No proposals. The weekly review (Mondays) proposes at most 2 per week in the first 4 weeks.</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {proposed.map((o) => (
              <div key={o.id} style={{ border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(statusTone(o.severity)).solid}`, borderRadius: 12, padding: 12, display: "grid", gap: 6, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14, minWidth: 0 }}>{o.hypothesis}</strong>
                  <span style={{ display: "inline-flex", gap: 6 }}><Badge status={o.severity} label={o.signalType} /></span>
                </div>
                <span style={{ fontSize: 13 }}>{o.proposedAction}</span>
                <span style={{ fontSize: 12, color: tokens.muted }}>Tasks: {o.proposedTasks.map((t) => t.title).join("; ")}</span>
                <code style={{ fontSize: 11, color: tokens.muted, wordBreak: "break-all" }}>{JSON.stringify(o.evidence)}</code>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button type="button" style={small} onClick={() => void call("approve-optimization", { optimizationId: o.id }, "Approved: tasks created for this week, measured in 14 days.")}>Approve</Button>
                  <Button type="button" variant="secondary" style={small} onClick={() => { setReason(""); setRejecting(o); }}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="History" icon={Activity}>
        <DataTable
          columns={[
            { key: "hypothesis", header: "Hypothesis" },
            { key: "status", header: "Status", render: (v) => <Badge status={String(v)} /> },
            { key: "measureOn", header: "Measure on", render: (v) => String(v ?? "—") },
            { key: "result", header: "Result", render: (v, row) => (v ? <span title={((row.outcome as { reasons?: string[] } | null)?.reasons ?? []).join(" ")}><Badge status={String(v)} /></span> : row.rejectedReason ? String(row.rejectedReason) : "—") },
          ]}
          rows={others}
          emptyMessage="Nothing approved or rejected yet."
        />
      </SectionCard>
      <SectionCard title="Scoreboard" icon={ListChecks}>
        {board.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Results appear after the first 14-day measurement.</p>
        ) : (
          <DataTable
            columns={[
              { key: "type", header: "Hypothesis type" },
              { key: "wins", header: "Wins" },
              { key: "losses", header: "Losses" },
              { key: "noChange", header: "No change" },
              { key: "inconclusive", header: "Inconclusive" },
            ]}
            rows={board.map(([type, e]) => ({ id: type, type, wins: e.wins, losses: e.losses, noChange: e.noChange, inconclusive: e.inconclusive ?? 0 }))}
          />
        )}
      </SectionCard>
      <Modal open={!!rejecting} title="Reject proposal" onClose={() => setRejecting(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button type="button" disabled={!reason.trim()} onClick={() => { if (!rejecting) return; void call("reject-optimization", { optimizationId: rejecting.id, reason }, "Rejected.").then(() => setRejecting(null)); }}>Reject</Button>
          </>
        )}
      >
        <Field label="Reason"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

function IntegrationsTab({ companyId, bundle, load, call, reload, onMessage, working }: { companyId: string; bundle: SprintBundle; load: LoadResult; call: CallFn; reload: () => Promise<void>; onMessage: (m: string) => void; working: string | null }) {
  const start = usePluginAction("seo.gsc-start");
  const disconnect = usePluginAction("seo.gsc-disconnect");
  const setIntegration = usePluginAction("seo.integration");
  const [properties, setProperties] = useState<Array<{ propertyUrl: string; usable: boolean }> | null>(null);
  const [bingUrl, setBingUrl] = useState("");
  const gsc = bundle.integrations.find((i) => i.provider === "gsc");
  const pagespeed = bundle.integrations.find((i) => i.provider === "pagespeed");
  const bing = bundle.integrations.find((i) => i.provider === "bing");
  const sprintId = bundle.sprint.sprintId;

  useEffect(() => {
    setBingUrl(bing?.propertyUrl ?? bundle.sprint.siteUrl);
  }, [bing?.propertyUrl, bundle.sprint.siteUrl]);

  async function connect() {
    try {
      // Back to this sprint in its own scope (a client's workspace keeps its client).
      const returnTo = sprintPagePath(window.location.pathname, sprintId, parseClientParam(bundle.sprint.client), { tab: "integrations" });
      const result = (await start({ sprintId, returnTo })) as { authorizeUrl: string; state: string };
      rememberOAuthStart(result.state, {
        companyId,
        completeUrl: "/api/plugins/partnersinbiz.seo/api/oauth/complete",
        returnTo,
        label: "Google Search Console",
      });
      window.location.assign(result.authorizeUrl);
    } catch (error) {
      onMessage(errorText(error));
    }
  }

  async function loadProperties() {
    const result = (await call("gsc-properties", { sprintId })) as { properties: Array<{ propertyUrl: string; usable: boolean }>; suggested: string | null } | null;
    if (result) setProperties(result.properties);
  }

  async function toggle(provider: "pagespeed" | "bing", enabled: boolean) {
    try {
      await setIntegration({ sprintId, provider, enabled, propertyUrl: provider === "bing" ? bingUrl : undefined });
      await reload();
      onMessage(`${provider === "bing" ? "Bing" : "PageSpeed"} ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      onMessage(errorText(error));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <NeedsYouSection
        sprintId={sprintId}
        view={bundle.needsYou}
        call={call}
        issueLink={bundle.needsYou?.issueId ? <IssueLink id={bundle.needsYou.issueId} identifier={bundle.needsYou.issueIdentifier} /> : null}
      />
      {bundle.sprint.site ? <SiteRepoSection sprintId={sprintId} site={bundle.sprint.site} projects={bundle.projects ?? []} prefix={bundle.prefix} call={call} /> : null}
      <SetupChecklist title="Setup for this sprint" items={bundle.setup ?? []} />
      <Section title="Google Search Console" icon={Search} actions={gsc ? <Badge status={gsc.status} label={gsc.auth === "service_account" ? `${gsc.status} · service account` : gsc.auth === "oauth" ? `${gsc.status} · OAuth` : gsc.status} /> : null}>
        <div style={{ fontSize: 13, display: "grid", gap: 4 }}>
          <span style={{ color: tokens.muted }}>
            {load.settings.serviceAccountEmail
              ? <>Service account: <code style={breakAnywhere}>{load.settings.serviceAccountEmail}</code> — the agent verifies our own sites with it; clients add it as a Search Console user.</>
              : load.settings.serviceAccountError ?? "No service account key yet (see Setup). The OAuth connection below is the fallback."}
          </span>
          <span style={breakAnywhere}>Property: {gsc?.propertyUrl ?? <em style={{ color: tokens.muted }}>none selected</em>}</span>
          <span style={{ color: tokens.muted }}>Last pull: {gsc?.lastPullAt ? gsc.lastPullAt.slice(0, 16).replace("T", " ") : "never"}</span>
          {gsc?.lastError ? <span style={{ color: tone("bad").fg }}>{gsc.lastError}</span> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {load.settings.serviceAccountEmail ? (
            <Button type="button" variant="secondary" disabled={working === "gsc-check-access"} onClick={() => void call("gsc-check-access", { sprintId }, "Service account access checked.")}>
              {working === "gsc-check-access" ? "Checking…" : "Check service account access"}
            </Button>
          ) : null}
          {load.settings.googleClientId ? (
            <Button type="button" variant="secondary" onClick={() => void connect()}>{gsc?.auth === "oauth" && gsc.status === "connected" ? "Reconnect with Google (fallback)" : "Connect with Google (fallback)"}</Button>
          ) : null}
          {gsc?.status === "connected" ? (
            <>
              <Button type="button" variant="secondary" onClick={() => void loadProperties()}>Choose property</Button>
              <Button type="button" variant="secondary" disabled={working === "gsc-pull" || !gsc.propertyUrl} onClick={() => void call("gsc-pull", { sprintId }, "Search Console data pulled.")}>{working === "gsc-pull" ? "Pulling…" : "Pull now"}</Button>
              <Button type="button" variant="secondary" disabled={working === "gsc-submit-sitemap" || !gsc.propertyUrl} onClick={() => void call("gsc-submit-sitemap", { sprintId }, "Sitemap submitted.")}>Submit sitemap</Button>
              {gsc.auth === "oauth" ? <Button type="button" variant="secondary" onClick={() => { if (window.confirm("Disconnect the OAuth Search Console connection for this sprint?")) void disconnect({ sprintId }).then(() => reload()).catch((e: unknown) => onMessage(errorText(e))); }}>Disconnect OAuth</Button> : null}
            </>
          ) : null}
        </div>
        {properties ? (
          <div style={{ display: "grid", gap: 6 }}>
            {properties.length === 0 ? <span style={{ fontSize: 13, color: tokens.muted }}>This Google account has no Search Console properties.</span> : null}
            {properties.map((p) => (
              <div key={p.propertyUrl} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ fontSize: 12, minWidth: 0, ...breakAnywhere }}>{p.propertyUrl}</code>
                <Button type="button" variant="secondary" style={small} disabled={!p.usable || p.propertyUrl === gsc?.propertyUrl} onClick={() => void call("gsc-set-property", { sprintId, propertyUrl: p.propertyUrl }, "Property selected.").then(() => setProperties(null))}>
                  {p.propertyUrl === gsc?.propertyUrl ? "Selected" : p.usable ? "Use" : "Unverified"}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </Section>
      <Section title="PageSpeed Insights" icon={Gauge} actions={pagespeed ? <Badge status={pagespeed.status} /> : null}>
        <span style={{ fontSize: 13, color: tokens.muted }}>Daily: home page plus up to 3 rotating target pages (mobile). {load.settings.pagespeedApiKey ? "API key set." : "No API key set — Google may rate-limit."}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" onClick={() => void toggle("pagespeed", pagespeed?.status !== "enabled")}>{pagespeed?.status === "enabled" ? "Disable" : "Enable"}</Button>
          <Button type="button" variant="secondary" disabled={working === "run-pagespeed"} onClick={() => void call("run-pagespeed", { sprintId }, "PageSpeed run saved.")}>{working === "run-pagespeed" ? "Running (up to 25 s)…" : "Run for home page now"}</Button>
        </div>
        {bundle.pageHealth.length > 0 ? (
          <DataTable
            columns={[
              { key: "url", header: "URL", render: (v) => <span style={{ fontSize: 12, wordBreak: "break-all" }}>{String(v)}</span> },
              { key: "strategy", header: "Device" },
              { key: "performance", header: "Perf.", render: (v) => scorePill(v as number | null) },
              { key: "seo", header: "SEO", render: (v) => scorePill(v as number | null) },
              { key: "lcpMs", header: "LCP", render: (v) => (v == null ? "—" : `${(Number(v) / 1000).toFixed(1)} s`) },
              { key: "cls", header: "CLS", render: (v) => fmt(v as number | null, 2) },
              { key: "inpMs", header: "INP", render: (v) => (v == null ? "—" : `${Math.round(Number(v))} ms`) },
              { key: "source", header: "Data" },
              { key: "pulledOn", header: "Date" },
            ]}
            rows={bundle.pageHealth.map((h) => ({ ...h, id: `${h.url}-${h.strategy}` }))}
          />
        ) : null}
      </Section>
      <Section title="Bing Webmaster Tools" icon={Share2} actions={bing ? <Badge status={bing.status} /> : null}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          The agent adds and verifies the site through the Bing API (bing-add-site → BingSiteAuth.xml via the repo → bing-verify-site), then pulls inbound link counts daily. {load.settings.bingApiKey ? "API key set." : "Needs the Bing API key (see Setup)."}
          {typeof bing?.stats?.totalInboundLinks === "number" ? ` Inbound links: ${String(bing.stats.totalInboundLinks)}.` : ""}
        </span>
        {bing?.lastError ? <span style={{ color: tone("bad").fg, fontSize: 13 }}>{bing.lastError}</span> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input value={bingUrl} onChange={(e) => setBingUrl(e.target.value)} style={{ maxWidth: 320, flex: "1 1 220px", minWidth: 0 }} aria-label="Bing site URL" />
          <Button type="button" variant="secondary" onClick={() => void toggle("bing", bing?.status !== "enabled")}>{bing?.status === "enabled" ? "Disable" : "Enable"}</Button>
        </div>
      </Section>
    </div>
  );
}

/** Lighthouse-style score: 90+ green, 50+ amber, below red. */
function scorePill(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const score = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return <Pill size="sm" tone={score >= 90 ? "ok" : score >= 50 ? "warn" : "bad"}>{score}</Pill>;
}

export function SeoSidebar({ context }: PluginSidebarProps) {
  // Nothing when the company switched SEO off; shown while the check runs.
  if (useModuleEnabled(context.companyId) === false) return null;
  return (
    <SidebarNavLink to="/seo" label="SEO" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(to);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(to)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
