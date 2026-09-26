import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";
import { rememberOAuthStart, resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Section,
  Select,
  StatRow,
  Tabs,
  TextArea,
  Toolbar,
  errorText,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";

// ---------------------------------------------------------------------------
// Types (type aliases so DataTable accepts them as records)
// ---------------------------------------------------------------------------

type TaskCounts = { open: number; due: number; done: number; total: number; blocked: number; proposals: number };

type SprintSummary = {
  sprintId: string;
  siteName: string;
  siteUrl: string;
  clientRef: string | null;
  clientName: string | null;
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
    defaultAutopilotMode: string;
    dailyHourLocal: number;
  };
  agent: { id: string; status: string } | null;
  clients: Array<{ id: string; name: string; domain: string | null }>;
  sprints: SprintSummary[];
};

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
type Integration = { provider: string; status: string; propertyUrl: string | null; lastPullAt: string | null; lastError: string | null; connected: boolean; stats: Record<string, unknown> };
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
};

type TabId = "plan" | "keywords" | "backlinks" | "content" | "audits" | "optimizations" | "integrations";
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "keywords", label: "Keywords" },
  { id: "backlinks", label: "Backlinks" },
  { id: "content", label: "Content" },
  { id: "audits", label: "Audits" },
  { id: "optimizations", label: "Optimizations" },
  { id: "integrations", label: "Integrations" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function statusVariant(status: string): StatusBadgeVariant {
  if (["done", "live", "active", "connected", "enabled", "win", "top_3", "top_10", "measured"].includes(status)) return "ok";
  if (["blocked", "needs_reconnect", "error", "loss", "rejected", "lost", "critical", "high"].includes(status)) return "error";
  if (["in_progress", "submitted", "proposed", "approved", "pre_launch", "compounding", "review", "medium"].includes(status)) return "info";
  if (["paused", "not_started", "disconnected", "disabled", "low"].includes(status)) return "pending";
  return "warning";
}

function Badge({ status, label }: { status: string; label?: string }) {
  return <StatusBadge label={(label ?? status).replace(/_/g, " ")} status={statusVariant(status)} />;
}

const chipColors: Record<string, string> = {
  done: "#16a34a",
  in_progress: "#2563eb",
  blocked: "#dc2626",
  due: "#d97706",
  future: "#71717a",
  skipped: "#a1a1aa",
};

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

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span style={{ color: tokens.muted, fontSize: 12 }}>—</span>;
  const width = 90;
  const height = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // Lower position is better: draw position 1 at the top.
  const points = values.map((v, i) => `${(i / (values.length - 1)) * width},${((v - min) / span) * (height - 4) + 2}`).join(" ");
  return (
    <svg width={width} height={height} aria-label="Position trend" role="img">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: tokens.chart[0] }} />
    </svg>
  );
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${tone === "warn" ? "color-mix(in oklab, #d97706 45%, transparent)" : tokens.border}`,
        background: tone === "warn" ? "color-mix(in oklab, #d97706 10%, transparent)" : tokens.secondary,
        display: "grid",
        gap: 4,
      }}
    >
      {children}
    </div>
  );
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
// Page
// ---------------------------------------------------------------------------

export function SeoPage({ context }: PluginPageProps) {
  const load = usePluginAction("seo.load");
  const nav = useHostNavigation();
  const search = useSearch();
  const sprintId = search.get("sprint");
  const [data, setData] = useState<LoadResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [activation, setActivation] = useState<{ instructions: string[]; grant: string; agent: { status: string | null } } | null>(null);
  const activate = usePluginAction("seo.activate-agent");

  const refresh = useCallback(async () => {
    const result = (await load({ uiBase: await resolvePluginUiBase("partnersinbiz.seo", import.meta.url) })) as LoadResult;
    setData(result);
  }, [load]);

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.companyId]);

  useEffect(() => {
    if (search.get("connected") === "gsc") setMessage(search.get("pick") ? "Google Search Console connected. Pick the property for this sprint below." : "Google Search Console connected.");
  }, [search]);

  const goTo = (id: string | null, tab?: TabId) => nav.navigate(id ? `/seo?sprint=${encodeURIComponent(id)}${tab ? `&tab=${tab}` : ""}` : "/seo");

  async function activateAgent() {
    setBusy(true);
    setMessage("");
    try {
      const result = (await activate({})) as { instructions: string[]; grant: string; agent: { status: string | null } };
      setActivation(result);
      await refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const settings = data?.settings;
  return (
    <Page
      title="SEO"
      description="90-day SEO sprints per client site. Every due task is a Paperclip issue under the sprint's root issue; the SEO Specialist works agent tasks, people get the rest."
      message={message}
      actions={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void activateAgent()}>
            {busy ? "Activating…" : data?.agent ? "Re-sync SEO agent" : "Activate SEO agent"}
          </Button>
        </>
      }
    >
      {settings && !settings.saved ? (
        <Banner tone="warn">
          <strong>SEO settings are not saved for this company.</strong>
          <span>Open Settings → Plugins → SEO and click Save once. Until then the daily and weekly SEO jobs skip this company.</span>
        </Banner>
      ) : null}
      {settings && settings.saved && (!settings.publicBaseUrl || !settings.googleClientId || !settings.googleClientSecret || !settings.encryptionKey) ? (
        <Banner tone="info">
          <strong>Search Console connection is not configured yet.</strong>
          <span>
            Needed in the SEO settings: {[!settings.publicBaseUrl && "Public base URL", !settings.encryptionKey && "token encryption key", !settings.googleClientId && "Google client ID", !settings.googleClientSecret && "Google client secret"].filter(Boolean).join(", ")}.
          </span>
        </Banner>
      ) : null}
      {settings?.redirectUri ? (
        <Banner tone="info">
          <span>
            Google OAuth redirect URI to register in Google Cloud (Credentials → your Web client → Authorized redirect URIs): <code>{settings.redirectUri}</code>
          </span>
        </Banner>
      ) : null}
      {activation ? (
        <Banner tone="info">
          <strong>SEO agent: {activation.agent.status ?? "created"} · tool access {activation.grant.replace(/_/g, " ")}</strong>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {activation.instructions.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </Banner>
      ) : null}

      {!data ? (
        <p style={{ color: tokens.muted, fontSize: 13 }}>Loading…</p>
      ) : sprintId ? (
        <SprintCockpit
          key={sprintId}
          companyId={context.companyId ?? ""}
          sprintId={sprintId}
          load={data}
          initialTab={(search.get("tab") as TabId | null) ?? "plan"}
          onTab={(tab) => goTo(sprintId, tab)}
          onBack={() => goTo(null)}
          onMessage={setMessage}
          onChanged={refresh}
        />
      ) : (
        <SprintList data={data} onOpen={(id) => goTo(id)} onMessage={setMessage} onChanged={refresh} />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Sprint list + create
// ---------------------------------------------------------------------------

function SprintList({ data, onOpen, onMessage, onChanged }: { data: LoadResult; onOpen: (id: string) => void; onMessage: (m: string) => void; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const upgrade = usePluginAction("seo.upgrade-legacy");
  const q = query.trim().toLowerCase();
  const rows = data.sprints.filter((s) => !q || `${s.siteName} ${s.clientName ?? ""} ${s.siteUrl}`.toLowerCase().includes(q));
  const active = data.sprints.filter((s) => ["pre_launch", "active", "compounding"].includes(s.status) && !s.legacy);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <StatRow>
        <MetricCard label="Active sprints" value={active.length} />
        <MetricCard label="Due tasks" value={active.reduce((n, s) => n + (s.tasks?.due ?? 0), 0)} />
        <MetricCard label="Blocked" value={active.reduce((n, s) => n + (s.tasks?.blocked ?? 0), 0)} />
        <MetricCard label="Proposals" value={active.reduce((n, s) => n + (s.tasks?.proposals ?? 0), 0)} />
      </StatRow>
      <Toolbar search={query} onSearchChange={setQuery} searchPlaceholder="Search sprints…">
        <Button type="button" onClick={() => setCreating(true)}>+ Sprint</Button>
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState
          title="No SEO sprints yet"
          description="A sprint is one client site on the Outrank-90 plan: 42 tasks over 13 weeks, then compounding."
          action={<Button type="button" onClick={() => setCreating(true)}>+ Sprint</Button>}
        />
      ) : (
        <DataTable
          columns={[
            {
              key: "siteName",
              header: "Site",
              render: (_v, row) => (
                <button type="button" onClick={() => onOpen(String(row.sprintId))} style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2 }}>
                  <strong style={{ fontSize: 13 }}>{String(row.siteName)}</strong>
                  <span style={{ fontSize: 12, color: tokens.muted }}>{String(row.siteUrl)}</span>
                </button>
              ),
            },
            { key: "clientName", header: "Client", render: (v) => (v ? String(v) : <span style={{ color: tokens.muted }}>—</span>) },
            { key: "day", header: "Day", render: (_v, row) => (row.legacy ? "—" : `${Math.max(Number(row.day), 0)}/90`) },
            { key: "phaseName", header: "Phase", render: (v, row) => (row.legacy ? "—" : String(v)) },
            { key: "status", header: "Status", render: (v, row) => (row.legacy ? <Badge status="paused" label="legacy" /> : <Badge status={String(v)} />) },
            { key: "health", header: "Health", render: (v) => fmt((v as { score?: number })?.score ?? null, 0) },
            { key: "tasks", header: "Due / open issues", render: (v) => { const c = v as TaskCounts | undefined; return c ? `${c.due} / ${c.open}` : "—"; } },
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
      <CreateSprintModal open={creating} data={data} onClose={() => setCreating(false)} onCreated={async (id, note) => { setCreating(false); await onChanged(); onMessage(note); onOpen(id); }} onError={onMessage} />
    </div>
  );
}

function CreateSprintModal({ open, data, onClose, onCreated, onError }: { open: boolean; data: LoadResult; onClose: () => void; onCreated: (id: string, note: string) => Promise<void>; onError: (m: string) => void }) {
  const create = usePluginAction("seo.create-sprint");
  const [clientRef, setClientRef] = useState("");
  const [clientName, setClientName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [startDate, setStartDate] = useState(data.today);
  const [owner, setOwner] = useState<"me" | "none">("me");
  const [mode, setMode] = useState(data.settings.defaultAutopilotMode);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const client = data.clients.find((c) => c.id === clientRef);
    if (client) {
      if (!siteName) setSiteName(client.name);
      if (!siteUrl && client.domain) setSiteUrl(`https://${client.domain}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientRef]);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const result = (await create({
        clientRef: clientRef || undefined,
        clientName: clientRef ? undefined : clientName || undefined,
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
      title="New SEO sprint"
      description="Seeds the 42 Outrank-90 tasks and 15 directory backlinks, creates the sprint root issue, and opens the tasks that are due."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={saving || !siteUrl.trim() || (!clientRef && !clientName.trim() && !siteName.trim())} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create sprint"}
          </Button>
        </>
      )}
    >
      <Field label="Client (CRM company)">
        <Select value={clientRef} onChange={(e) => setClientRef(e.target.value)}>
          <option value="">No CRM company — type a name</option>
          {data.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      {!clientRef ? (
        <Field label="Client name">
          <Input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder={data.clients.length === 0 ? "No CRM companies yet (run CRM resync)" : "Client name"} />
        </Field>
      ) : null}
      <Field label="Site URL"><Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.co.za" required /></Field>
      <Field label="Site name"><Input value={siteName} onChange={(e) => setSiteName(e.target.value)} /></Field>
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
  load,
  initialTab,
  onTab,
  onBack,
  onMessage,
  onChanged,
}: {
  companyId: string;
  sprintId: string;
  load: LoadResult;
  initialTab: TabId;
  onTab: (tab: TabId) => void;
  onBack: () => void;
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

  const reload = useCallback(async () => {
    setBundle((await fetchSprint({ sprintId })) as SprintBundle);
  }, [fetchSprint, sprintId]);

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
        <div style={{ display: "grid", gap: 4 }}>
          <button type="button" onClick={onBack} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: tokens.muted }}>← All sprints</button>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>{s.siteName}{s.clientName && s.clientName !== s.siteName ? <span style={{ color: tokens.muted, fontWeight: 500 }}> · {s.clientName}</span> : null}</h2>
          <span style={{ fontSize: 12, color: tokens.muted }}>
            {s.siteUrl} · start {s.startDate} · root issue <IssueLink id={s.rootIssueId} identifier={s.rootIssueIdentifier} />
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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
      <StatRow>
        <MetricCard label="Day" value={s.legacy ? "—" : `${Math.max(s.day, 0)} / 90`} />
        <MetricCard label="Week · phase" value={`${s.week} · ${s.phaseName}`} />
        <MetricCard label="Status" value={s.status.replace(/_/g, " ")} />
        <MetricCard label="Health" value={s.health?.score != null ? s.health.score : "—"} />
        <MetricCard label="Tasks done" value={s.tasks ? `${s.tasks.done}/${s.tasks.total}` : "—"} />
      </StatRow>
      <Tabs tabs={TABS.map((t) => ({ id: t.id, label: t.id === "optimizations" && (s.tasks?.proposals ?? 0) > 0 ? `${t.label} (${s.tasks?.proposals})` : t.label }))} active={tab} onChange={(id) => selectTab(id as TabId)} />
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

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function chipState(task: Task, day: number): keyof typeof chipColors {
  if (task.status === "done") return "done";
  if (task.status === "skipped" || task.status === "na") return "skipped";
  if (task.status === "blocked") return "blocked";
  if (task.status === "in_progress") return "in_progress";
  return task.dueDay == null || task.dueDay <= day ? "due" : "future";
}

function PlanTab({ bundle, call }: { bundle: SprintBundle; call: CallFn }) {
  const [selected, setSelected] = useState<Task | null>(null);
  const day = bundle.sprint.day;
  const open = bundle.tasks.filter((t) => ["not_started", "in_progress", "blocked"].includes(t.status));
  const due = open.filter((t) => t.dueDay == null || t.dueDay <= day);
  const weeks = Array.from({ length: 14 }, (_, w) => w);
  const extra = bundle.tasks.filter((t) => t.week > 13 || t.source !== "template");
  const todayInfo = bundle.today as { next?: string[]; warnings?: string[]; asOf?: string };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section title={`Today — ${due.length} due`}>
        {todayInfo.next && todayInfo.next.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.muted }}>
            {todayInfo.next.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
        {todayInfo.warnings && todayInfo.warnings.length > 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: tokens.destructive }}>Last daily run: {todayInfo.warnings.join(" · ")}</p>
        ) : null}
        {due.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Nothing due right now.</p>
        ) : (
          <DataTable
            columns={[
              { key: "title", header: "Task", render: (v, row) => <span>{String(v)} <span style={{ color: tokens.muted, fontSize: 12 }}>· W{String(row.week)}</span></span> },
              { key: "owner", header: "Owner", render: (v) => (v === "human" ? "Person" : "Agent") },
              { key: "status", header: "Status", render: (v) => <Badge status={String(v)} /> },
              { key: "issueId", header: "Issue", render: (v, row) => (v ? <IssueLink id={String(v)} identifier={row.issueIdentifier as string | null} /> : <span style={{ color: tokens.muted, fontSize: 12 }}>next daily run</span>) },
              { key: "humanAsk", header: "Waiting on", render: (v, row) => (v ? String(v) : row.blockerReason ? String(row.blockerReason) : "") },
            ]}
            rows={due}
          />
        )}
      </Section>
      <Section title="13-week plan">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: tokens.muted }}>
          {Object.entries({ done: "Done", in_progress: "In progress", blocked: "Blocked", due: "Due", future: "Upcoming", skipped: "Skipped" }).map(([k, label]) => (
            <span key={k} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: chipColors[k] }} />
              {label}
            </span>
          ))}
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {weeks.map((w) => {
            const items = bundle.tasks.filter((t) => t.week === w && t.source === "template");
            if (items.length === 0) return null;
            const current = bundle.sprint.week === w;
            return (
              <div key={w} style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10, alignItems: "start" }}>
                <div style={{ fontSize: 12, fontWeight: current ? 700 : 500, color: current ? tokens.fg : tokens.muted, paddingTop: 5 }}>Week {w}{current ? " ◂" : ""}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {items.map((t) => <TaskChip key={t.id} task={t} state={chipState(t, day)} onClick={() => setSelected(t)} />)}
                </div>
              </div>
            );
          })}
          {extra.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10 }}>
              <div style={{ fontSize: 12, color: tokens.muted, paddingTop: 5 }}>Added</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {extra.map((t) => <TaskChip key={t.id} task={t} state={chipState(t, day)} onClick={() => setSelected(t)} />)}
              </div>
            </div>
          ) : null}
        </div>
      </Section>
      <TaskSheet task={selected} onClose={() => setSelected(null)} call={call} />
    </div>
  );
}

function TaskChip({ task, state, onClick }: { task: Task; state: keyof typeof chipColors; onClick: () => void }) {
  const color = chipColors[state];
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${task.title} — ${task.status.replace(/_/g, " ")}${task.owner === "human" ? " (person)" : ""}`}
      style={{
        appearance: "none",
        border: `1px solid color-mix(in oklab, ${color} 45%, transparent)`,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        color: tokens.fg,
        borderRadius: 8,
        padding: "4px 8px",
        fontSize: 12,
        maxWidth: 280,
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
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <StatRow>
        <MetricCard label="Tracked" value={bundle.keywords.filter((k) => !k.retiredAt).length} />
        <MetricCard label="Top 10" value={top10} />
        <MetricCard label="Impressions (8 days)" value={impressions} />
        <MetricCard label="Priority" value={bundle.keywords.filter((k) => k.isPriority && !k.retiredAt).length} />
      </StatRow>
      <Toolbar>
        <label style={{ fontSize: 12, color: tokens.muted, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
        </label>
        <Button type="button" onClick={() => setAdding(true)}>+ Keywords</Button>
      </Toolbar>
      {keywords.length === 0 ? (
        <EmptyState title="No keywords yet" description="Week 2 of the plan picks 20–30 winnable keywords. Positions arrive daily from Search Console." />
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
            { key: "currentPosition", header: "Position", render: (v) => fmt(v as number | null) },
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
                <span style={{ display: "inline-flex", gap: 6 }}>
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
      <StatRow>
        <MetricCard label="Live" value={counts.live ?? 0} />
        <MetricCard label="Submitted" value={counts.submitted ?? 0} />
        <MetricCard label="Not started" value={counts.not_started ?? 0} />
        <MetricCard label="Rejected / lost" value={(counts.rejected ?? 0) + (counts.lost ?? 0)} />
      </StatRow>
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
              <Select value={String(v)} style={{ height: 28, fontSize: 12, width: 130, minWidth: 0 }} onChange={(e) => { setNotes(""); setUrl(String(row.url ?? "")); setEditing({ link: row as unknown as Backlink, status: e.target.value }); }}>
                {["not_started", "in_progress", "submitted", "live", "rejected", "lost"].map((st) => <option key={st} value={st}>{st.replace(/_/g, " ")}</option>)}
              </Select>
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
      <Toolbar><Button type="button" onClick={() => setAdding(true)}>+ Content</Button></Toolbar>
      <DataTable
        columns={[
          { key: "title", header: "Title", render: (v, row) => <span>{String(v)}{row.targetUrl ? <><br /><span style={{ fontSize: 12, color: tokens.muted, wordBreak: "break-all" }}>{String(row.targetUrl)}</span></> : null}</span> },
          { key: "type", header: "Type" },
          {
            key: "status",
            header: "Status",
            render: (v, row) => (
              <Select value={String(v)} style={{ height: 28, fontSize: 12, width: 120, minWidth: 0 }} onChange={(e) => {
                if (e.target.value === "live" && !row.targetUrl) { setLiveUrl(""); setLiveFor(row as unknown as Content); return; }
                void call("update-content", { contentId: row.id, status: e.target.value });
              }}>
                {["idea", "drafting", "review", "scheduled", "live", "archived"].map((st) => <option key={st} value={st}>{st}</option>)}
              </Select>
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
      <Section title="Snapshots" actions={<Button type="button" variant="secondary" style={small} disabled={working === "run-audit-snapshot"} onClick={() => void call("run-audit-snapshot", { sprintId: bundle.sprint.sprintId }, "Snapshot recorded.")}>Take snapshot now</Button>}>
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
      </Section>
      <Section title={`Open findings (${bundle.findings.length})`}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["critical", "high", "medium", "low"].map((sev) => <Badge key={sev} status={sev} label={`${sev}: ${bySeverity[sev] ?? 0}`} />)}
        </div>
        {bundle.findings.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No open findings. Site checks with a sprint record findings here and resolve them when a re-run no longer reports them.</p>
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
      </Section>
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
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section title={`Proposals (${proposed.length})`}>
        {proposed.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No proposals. The weekly review (Mondays) proposes at most 2 per week in the first 4 weeks.</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {proposed.map((o) => (
              <div key={o.id} style={{ border: `1px solid ${tokens.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14 }}>{o.hypothesis}</strong>
                  <span style={{ display: "inline-flex", gap: 6 }}><Badge status={o.severity} label={o.signalType} /></span>
                </div>
                <span style={{ fontSize: 13 }}>{o.proposedAction}</span>
                <span style={{ fontSize: 12, color: tokens.muted }}>Tasks: {o.proposedTasks.map((t) => t.title).join("; ")}</span>
                <code style={{ fontSize: 11, color: tokens.muted, wordBreak: "break-all" }}>{JSON.stringify(o.evidence)}</code>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button type="button" style={small} onClick={() => void call("approve-optimization", { optimizationId: o.id }, "Approved: tasks created for this week, measured in 14 days.")}>Approve</Button>
                  <Button type="button" variant="secondary" style={small} onClick={() => { setReason(""); setRejecting(o); }}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="History">
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
      </Section>
      <Section title="Scoreboard">
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
      </Section>
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
      const returnTo = `${window.location.pathname}?sprint=${encodeURIComponent(sprintId)}&tab=integrations`;
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
      <Section title="Google Search Console" actions={gsc ? <Badge status={gsc.status} /> : null}>
        <div style={{ fontSize: 13, display: "grid", gap: 4 }}>
          <span>Property: {gsc?.propertyUrl ?? <em style={{ color: tokens.muted }}>none selected</em>}</span>
          <span style={{ color: tokens.muted }}>Last pull: {gsc?.lastPullAt ? gsc.lastPullAt.slice(0, 16).replace("T", " ") : "never"}</span>
          {gsc?.lastError ? <span style={{ color: tokens.destructive }}>{gsc.lastError}</span> : null}
          {load.settings.redirectUri ? <span style={{ color: tokens.muted, fontSize: 12 }}>Redirect URI: <code>{load.settings.redirectUri}</code></span> : <span style={{ color: tokens.destructive, fontSize: 12 }}>Set the Public base URL in the SEO settings first.</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" onClick={() => void connect()}>{gsc?.status === "connected" ? "Reconnect Google Search Console" : "Connect Google Search Console"}</Button>
          {gsc?.status === "connected" ? (
            <>
              <Button type="button" variant="secondary" onClick={() => void loadProperties()}>Choose property</Button>
              <Button type="button" variant="secondary" disabled={working === "gsc-pull" || !gsc.propertyUrl} onClick={() => void call("gsc-pull", { sprintId }, "Search Console data pulled.")}>{working === "gsc-pull" ? "Pulling…" : "Pull now"}</Button>
              <Button type="button" variant="secondary" disabled={working === "gsc-submit-sitemap" || !gsc.propertyUrl} onClick={() => void call("gsc-submit-sitemap", { sprintId }, "Sitemap submitted.")}>Submit sitemap</Button>
              <Button type="button" variant="secondary" onClick={() => { if (window.confirm("Disconnect Search Console for this sprint?")) void disconnect({ sprintId }).then(() => reload()).catch((e: unknown) => onMessage(errorText(e))); }}>Disconnect</Button>
            </>
          ) : null}
        </div>
        {properties ? (
          <div style={{ display: "grid", gap: 6 }}>
            {properties.length === 0 ? <span style={{ fontSize: 13, color: tokens.muted }}>This Google account has no Search Console properties.</span> : null}
            {properties.map((p) => (
              <div key={p.propertyUrl} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code style={{ fontSize: 12 }}>{p.propertyUrl}</code>
                <Button type="button" variant="secondary" style={small} disabled={!p.usable || p.propertyUrl === gsc?.propertyUrl} onClick={() => void call("gsc-set-property", { sprintId, propertyUrl: p.propertyUrl }, "Property selected.").then(() => setProperties(null))}>
                  {p.propertyUrl === gsc?.propertyUrl ? "Selected" : p.usable ? "Use" : "Unverified"}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </Section>
      <Section title="PageSpeed Insights" actions={pagespeed ? <Badge status={pagespeed.status} /> : null}>
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
              { key: "performance", header: "Perf." },
              { key: "seo", header: "SEO" },
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
      <Section title="Bing Webmaster Tools" actions={bing ? <Badge status={bing.status} /> : null}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Inbound link counts from Bing (GetLinkCounts). Verify the site in Bing first. {load.settings.bingApiKey ? "API key set." : "Add the Bing API key in the SEO settings."}
          {typeof bing?.stats?.totalInboundLinks === "number" ? ` Inbound links: ${String(bing.stats.totalInboundLinks)}.` : ""}
        </span>
        {bing?.lastError ? <span style={{ color: tokens.destructive, fontSize: 13 }}>{bing.lastError}</span> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input value={bingUrl} onChange={(e) => setBingUrl(e.target.value)} style={{ maxWidth: 320 }} aria-label="Bing site URL" />
          <Button type="button" variant="secondary" onClick={() => void toggle("bing", bing?.status !== "enabled")}>{bing?.status === "enabled" ? "Disable" : "Enable"}</Button>
        </div>
      </Section>
    </div>
  );
}

export function SeoSidebar(_props: PluginSidebarProps) {
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
