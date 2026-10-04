import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTable,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginToast,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { resolvePluginUiBase, rememberOAuthStart } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import {
  Activity,
  CircleAlert,
  Button,
  CompactRows,
  EmptyState,
  Field,
  GetStarted,
  Input,
  KpiCard,
  LayoutDashboard,
  Modal,
  Page,
  Pill,
  ProgressBar,
  SectionCard,
  Select,
  Tabs,
  TextArea,
  Timeline,
  TrendChart,
  errorText,
  fluidColumns,
  formatDateTime,
  formatShortDate,
  tokens,
  useGroupedNav,
  useIsNarrow,
  usePluginSetupStatus,
  useUrlTab,
  type TimelineItem,
} from "@partnersinbiz/pib-plugin-ui";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import { COMPLETE_ROUTE_PATH, PLUGIN_ID, OWN_SCOPE } from "../platforms.js";
import { ACTION_TEXT, BUDGET_STATE_TEXT, CONNECTION_TEXT, budgetToneOf, connectionTone, inputFromMinor, minorFromInput, spendSeries, statusTone } from "./series.js";
import type { AccountInfo, AuditEntry, BudgetInfo, ConnectionInfo, Overview, ProposalDetail, ProposalSummary, Summary, SummaryGroup } from "./types.js";

const ACTION_KEYS = [
  "ads.load",
  "ads.oauth-start",
  "ads.connect-token",
  "ads.connect-mock",
  "ads.disconnect",
  "ads.discover-accounts",
  "ads.register-account",
  "ads.remove-account",
  "ads.sync",
  "ads.performance",
  "ads.set-cap",
  "ads.set-allow-writes",
  "ads.set-signoffs",
  "ads.proposals",
  "ads.proposal",
  "ads.approve",
  "ads.cancel-proposal",
  "ads.mark-done",
  "ads.execute",
  "ads.ack-alert",
] as const;
type ActionKey = (typeof ACTION_KEYS)[number];
type Run = (key: ActionKey, params?: Record<string, unknown>, success?: string) => Promise<any>;

/** Calls that do not change anything: no reload afterwards. */
const READ_ONLY = new Set<ActionKey>(["ads.load", "ads.oauth-start", "ads.discover-accounts", "ads.performance", "ads.proposals", "ads.proposal"]);

const TAB_IDS = ["overview", "performance", "changes", "budgets", "accounts"] as const;
type TabId = (typeof TAB_IDS)[number];

const PERIODS: Array<[string, string]> = [["last_7d", "Last 7 days"], ["last_30d", "Last 30 days"], ["this_month", "This month"], ["last_month", "Last month"]];

function useAdsActions(): Record<ActionKey, (params?: Record<string, unknown>) => Promise<unknown>> {
  const fns = {} as Record<ActionKey, (params?: Record<string, unknown>) => Promise<unknown>>;
  // Fixed list, fixed order: the hooks run in the same order on every render.
  for (const key of ACTION_KEYS) fns[key] = usePluginAction(key) as (params?: Record<string, unknown>) => Promise<unknown>;
  return fns;
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(110px, auto) minmax(0, 1fr)", gap: "8px 14px", fontSize: 13 }}>
      {rows.map(([term, value]) => (
        <div key={term} style={{ display: "contents" }}>
          <dt style={{ color: tokens.muted }}>{term}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const money = (minor: number | null | undefined, currency: string): string => (minor === null || minor === undefined ? "none" : `${currency} ${inputFromMinor(minor)}`);

export function AdsPage({ context }: PluginPageProps) {
  const fns = useAdsActions();
  const fnsRef = useRef(fns);
  fnsRef.current = fns;
  const toast = usePluginToast();
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const [tab, setTab] = useUrlTab<TabId>(TAB_IDS, "overview", { path: "/ads", search: location.search, navigate: navigation.navigate });
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openProposal, setOpenProposal] = useState<string | null>(null);
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId);
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  const off = enabled === false;
  const loadSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    const next = (await fnsRef.current["ads.load"]({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Overview;
    if (seq !== loadSeq.current) return;
    setData(next);
    setLoadError("");
  }, []);

  const notify = useCallback((title: string, tone: "success" | "error" | "info", body?: string) => {
    toast({ title, body, tone, ttlMs: tone === "error" ? 9000 : 4000 });
  }, [toast]);

  const run: Run = useCallback(async (key, params = {}, success) => {
    setBusy(true);
    try {
      const result = await fnsRef.current[key](params);
      if (success) notify(success, "success");
      if (!READ_ONLY.has(key)) await refresh();
      return result;
    } catch (error) {
      notify("That did not work", "error", errorText(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }, [notify, refresh]);

  useEffect(() => {
    if (!context.companyId || off) return;
    refresh().catch((error: unknown) => setLoadError(errorText(error)));
  }, [context.companyId, refresh, off]);

  // Coming back from the OAuth bridge.
  useEffect(() => {
    const connected = new URLSearchParams(location.search).get("connected");
    if (connected) notify("Connected", "success", "Now add the ad accounts you want read.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const linkFor = (href: string) => navigation.linkProps(href) as unknown as Record<string, unknown>;
  const waiting = data?.proposals.filter((p) => p.status === "in_review" || p.status === "approved").length ?? 0;
  const openAlerts = data?.alerts.length ?? 0;

  return (
    <Page
      title="Paid ads"
      accent="campaigns"
      description="Meta and Google ads in one picture, with monthly budget caps. Reading is automatic; every change is proposed, checked and approved by a person first."
      message={loadError}
      messageTone="bad"
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard, count: openAlerts || null, countTone: "warn" },
          { id: "performance", label: "Performance", icon: Activity },
          { id: "changes", label: "Changes", icon: CircleAlert, count: waiting || null, countTone: "warn" },
          { id: "budgets", label: "Budgets" },
          { id: "accounts", label: "Accounts" },
        ]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
      />
      {tab === "overview" ? <GetStarted status={setupStatus} hasData={Boolean(data?.accounts.length)} moduleName="Paid ads" linkFor={linkFor} /> : null}
      {!data && !loadError && !off ? <Muted>Loading paid ads…</Muted> : null}
      {data && tab === "overview" ? <OverviewTab data={data} narrow={narrow} run={run} busy={busy} goTab={(id) => setTab(id)} openProposal={setOpenProposal} /> : null}
      {data && tab === "performance" ? <PerformanceTab data={data} run={run} /> : null}
      {data && tab === "changes" ? <ChangesTab data={data} run={run} narrow={narrow} openProposal={setOpenProposal} /> : null}
      {data && tab === "budgets" ? <BudgetsTab data={data} run={run} busy={busy} /> : null}
      {data && tab === "accounts" ? <AccountsTab data={data} run={run} busy={busy} companyId={context.companyId ?? ""} /> : null}
      <ProposalModal id={openProposal} data={data} run={run} busy={busy} onClose={() => setOpenProposal(null)} />
    </Page>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ data, narrow, run, busy, goTab, openProposal }: { data: Overview; narrow: boolean; run: Run; busy: boolean; goTab: (id: TabId) => void; openProposal: (id: string) => void }) {
  const series = useMemo(() => spendSeries(data.daily), [data.daily]);
  const worst = [...data.budgets].filter((b) => b.pctUsed !== null).sort((a, b) => (b.pctUsed ?? 0) - (a.pctUsed ?? 0))[0];
  const total = data.month.totals[0];
  const waiting = data.proposals.filter((p) => p.status === "in_review" || p.status === "approved");
  if (data.accounts.length === 0) {
    return (
      <EmptyState
        title="No ad accounts yet"
        icon={LayoutDashboard}
        description="Connect Meta or Google Ads on the Accounts tab and register the ad accounts to read. Reading is automatic and changes nothing; changes are proposed and approved by a person."
        action={<Button type="button" onClick={() => goTab("accounts")}>Open Accounts</Button>}
      />
    );
  }
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(160), gap: 10 }}>
        <KpiCard label="Spend this month" value={data.month.totals.length ? data.month.totals.map((t) => t.spend).join(" + ") : "0"} hint={worst ? `${Math.round(worst.pctUsed ?? 0)}% of the budget used (${worst.label})` : "No budget cap set yet"} tone={worst ? budgetToneOf(worst) : "neutral"} link={null} />
        <KpiCard label="Cost per result" value={total?.cpa ?? "n/a"} hint={total ? `${total.conversions} results this month${total.roas ? `, ${total.roas}x return` : ""}` : "No data yet"} />
        <KpiCard label="Changes waiting" value={waiting.length} tone={waiting.length ? "warn" : "neutral"} hint={waiting.length ? "Need the Reviewer or a person" : "Nothing waiting"} />
        <KpiCard label="Alerts" value={data.alerts.length} tone={data.alerts.some((a) => a.severity === "bad") ? "bad" : data.alerts.length ? "warn" : "ok"} hint={data.alerts.length ? "Open below" : "Nothing unusual"} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard title="Spend, last 30 days" subtitle={series.currency ? `Per day, in ${series.currency}${series.others ? ` (other currencies are not added in)` : ""}` : "Per day"}>
          <TrendChart labels={series.labels} series={[{ key: "spend", label: "Spend", values: series.values }]} height={150} unit={series.currency ?? undefined} emptyText="No spend recorded yet. The first read runs within three hours of registering an account." />
        </SectionCard>
        <SectionCard title="Budgets this month" subtitle="Against each scope's monthly cap">
          <div style={{ display: "grid", gap: 14 }}>
            {data.budgets.length === 0 ? <Muted>No scope has a budget yet.</Muted> : data.budgets.map((b) => (
              <div key={b.scopeKey} style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13 }}>{b.label}</strong>
                  <Pill tone={budgetToneOf(b)} dot>{BUDGET_STATE_TEXT[b.state]}</Pill>
                </div>
                {b.capMinor === null ? <Muted>No monthly cap. Set one on the Budgets tab.</Muted> : (
                  <>
                    <ProgressBar value={Math.min(1, (b.pctUsed ?? 0) / 100)} tone="budget" label={`${b.spent} of ${b.cap}`} valueText={`${Math.round(b.pctUsed ?? 0)}%`} />
                    <Muted>{b.daysLeft} days left. At the last days' pace the month ends near {b.projectedRunRate}.</Muted>
                  </>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
      {waiting.length > 0 ? (
        <SectionCard title="Waiting for a decision" subtitle="Nothing changes in an ad platform until a person approves" tone="warn" strip>
          <CompactRows
            label="Changes waiting"
            rows={waiting.slice(0, 5)}
            rowKey={(p) => p.proposalId}
            title={(p) => p.title}
            meta={(p) => `${p.kindLabel} · ${data.budgets.find((b) => b.scopeKey === p.scopeKey)?.label ?? p.scopeKey}`}
            trailing={(p) => <Pill tone={statusTone(p.status)} dot>{p.statusLabel}</Pill>}
            onOpen={(p) => openProposal(p.proposalId)}
          />
        </SectionCard>
      ) : null}
      {data.alerts.length > 0 ? (
        <SectionCard title="Alerts" subtitle="Spend spikes, no delivery, cost per result over target, numbers not updating" tone="warn" strip>
          <div style={{ display: "grid", gap: 10 }}>
            {data.alerts.slice(0, 8).map((a) => (
              <div key={a.alertId} style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone={a.severity === "bad" ? "bad" : a.severity === "warn" ? "warn" : "info"} dot>{a.severity === "bad" ? "Serious" : a.severity === "warn" ? "Look at" : "Information"}</Pill>
                    <strong style={{ fontSize: 13 }}>{a.title}</strong>
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{a.text}</p>
                </div>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void run("ads.ack-alert", { alertId: a.alertId, note: "Seen on the Ads page." }, "Alert acknowledged")}>Acknowledge</Button>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}
      {!narrow && data.audit.length > 0 ? (
        <SectionCard title="Recent" subtitle="Switches, approvals and changes (no secret is ever recorded here)">
          <Timeline items={auditItems(data.audit, data)} limit={8} empty="Nothing yet." />
        </SectionCard>
      ) : null}
    </div>
  );
}

function auditItems(entries: AuditEntry[], data: Overview): TimelineItem[] {
  return entries.map((e, i) => ({
    id: `${i}:${e.at}`,
    at: e.at,
    title: `${ACTION_TEXT[e.action] ?? e.action}${e.scope_key ? ` (${e.scope_key === OWN_SCOPE ? "PiB's own ads" : data.clients[e.scope_key] ?? e.scope_key})` : ""}`,
    detail: e.actor.startsWith("user:") ? "By a person" : e.actor.startsWith("agent:") ? "By the ads agent" : "By the plugin",
    tone: e.action === "write.failed" || e.action === "write.refused" ? "bad" : e.action.startsWith("proposal.approved") || e.action === "write.executed" ? "ok" : "neutral",
  }));
}

// ── Performance ─────────────────────────────────────────────────────────────

function PerformanceTab({ data, run }: { data: Overview; run: Run }) {
  const [period, setPeriod] = useState("last_30d");
  const [groupBy, setGroupBy] = useState("platform");
  const [client, setClient] = useState("all");
  const [state, setState] = useState<{ summary: Summary; campaigns: { campaigns: any[] }; ledger: { entries: any[] } } | null>(null);
  const [error, setError] = useState("");
  const scopes = useMemo(() => [...new Set(data.budgets.map((b) => b.scopeKey))], [data.budgets]);
  useEffect(() => {
    let live = true;
    setError("");
    run("ads.performance", { period, groupBy, ...(client === "all" ? {} : { client }) })
      .then((r) => live && setState(r))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, groupBy, client]);
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          {[["platform", "By platform"], ["campaign", "By campaign"], ["day", "By day"], ["account", "By ad account"], ["scope", "By client"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select aria-label="Whose ads" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="all">Everyone's ads</option>
          {scopes.map((s) => <option key={s} value={s}>{s === OWN_SCOPE ? "PiB's own ads" : data.clients[s] ?? s}</option>)}
        </Select>
      </div>
      {error ? <Muted>{error}</Muted> : null}
      {!state ? <Muted>Loading…</Muted> : !state.summary.hasData ? (
        <EmptyState title="No numbers in this period" description="Numbers appear after the first read of a registered ad account (within three hours), and only for days the platform reported." icon={Activity} />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
            {state.summary.totals.map((t) => (
              <KpiCard key={t.currency} label={`Spend (${t.currency})`} value={t.spend} hint={`${t.clicks} clicks, ${t.conversions} results`} />
            ))}
            {state.summary.totals.slice(0, 1).map((t) => (
              <div key="d" style={{ display: "contents" }}>
                <KpiCard label="Cost per click" value={t.cpc ?? "n/a"} />
                <KpiCard label="Cost per result" value={t.cpa ?? "n/a"} />
                <KpiCard label="Return on spend" value={t.roas === null ? "n/a" : `${t.roas}x`} />
              </div>
            ))}
          </div>
          <SectionCard title={`${state.summary.period.label}`} subtitle="Amounts in each row's own currency; currencies are never added together">
            <DataTable
              columns={[
                { key: "label", header: "Name" },
                { key: "spend", header: "Spend" },
                { key: "impressions", header: "Shown" },
                { key: "clicks", header: "Clicks" },
                { key: "conversions", header: "Results" },
                { key: "cpc", header: "Per click" },
                { key: "cpa", header: "Per result" },
                { key: "roas", header: "Return" },
              ]}
              rows={state.summary.groups.map((g: SummaryGroup) => ({ ...g, roas: g.roas === null ? "n/a" : `${g.roas}x`, cpc: g.cpc ?? "n/a", cpa: g.cpa ?? "n/a" })) as unknown as Record<string, unknown>[]}
              emptyMessage="No rows."
            />
          </SectionCard>
          <SectionCard title="Campaigns" subtitle="Last 7 days">
            <DataTable
              columns={[
                { key: "name", header: "Campaign" },
                { key: "platform", header: "Platform" },
                { key: "status", header: "Status" },
                { key: "dailyBudget", header: "Daily budget" },
                { key: "spend", header: "Spend" },
                { key: "conversions", header: "Results" },
                { key: "cpa", header: "Per result" },
              ]}
              rows={state.campaigns.campaigns.slice(0, 100).map((c) => ({ ...c, dailyBudget: c.dailyBudget ?? "none", cpa: c.cpa ?? "n/a" }))}
              emptyMessage="No campaigns yet."
            />
          </SectionCard>
          <SectionCard title="Spend ledger" subtitle="Every change to a day's spend, newest first (the platforms restate recent days)">
            <DataTable
              columns={[
                { key: "day", header: "Day" },
                { key: "delta", header: "Change" },
                { key: "totalMinor", header: "Day total (minor units)" },
                { key: "kind", header: "Kind" },
                { key: "campaignExternalId", header: "Campaign" },
              ]}
              rows={state.ledger.entries}
              emptyMessage="No ledger entries yet."
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────

function ChangesTab({ data, run, narrow, openProposal }: { data: Overview; run: Run; narrow: boolean; openProposal: (id: string) => void }) {
  const [filter, setFilter] = useState("open");
  const [rows, setRows] = useState<ProposalSummary[]>(data.proposals);
  useEffect(() => {
    let live = true;
    run("ads.proposals", { status: filter }).then((r: { proposals: ProposalSummary[] }) => live && setRows(r.proposals)).catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, data]);
  const label = (scope: string) => (scope === OWN_SCOPE ? "PiB's own ads" : data.clients[scope] ?? scope);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Muted>The ads agent proposes campaign and budget changes with the numbers. The Reviewer checks, a person approves (the client too where the scope asks), and only then can a change run, and only where changes are switched on. Nothing here ever runs by itself.</Muted>
      <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }}>
        {[["open", "Open"], ["executed", "Done"], ["cleared", "Copy cleared"], ["rejected", "Refused"], ["failed", "Failed"], ["cancelled", "Cancelled"], ["expired", "Expired"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {rows.length === 0 ? <EmptyState title="Nothing here" icon={CircleAlert} description={filter === "open" ? "No change is waiting. Agents propose changes when numbers call for one." : "No proposals in this state."} compact /> : narrow ? (
        <CompactRows label="Changes" rows={rows} rowKey={(p) => p.proposalId} title={(p) => p.title} meta={(p) => `${p.kindLabel} · ${label(p.scopeKey)}`} trailing={(p) => <Pill tone={statusTone(p.status)} dot>{p.statusLabel}</Pill>} onOpen={(p) => openProposal(p.proposalId)} />
      ) : (
        <DataTable
          columns={[
            { key: "title", header: "Change", render: (_v, row) => { const p = row as unknown as ProposalSummary; return <a href="#" onClick={(e) => { e.preventDefault(); openProposal(p.proposalId); }} style={{ color: tokens.primary, fontWeight: 600 }}>{p.title}</a>; } },
            { key: "kindLabel", header: "Kind" },
            { key: "scope", header: "Whose ads" },
            { key: "status", header: "Status", render: (_v, row) => { const p = row as unknown as ProposalSummary; return <Pill tone={statusTone(p.status)} dot>{p.statusLabel}</Pill>; } },
            { key: "created", header: "Asked" },
          ]}
          rows={rows.map((p) => ({ ...p, scope: label(p.scopeKey), created: formatShortDate(p.createdAt) })) as unknown as Record<string, unknown>[]}
          emptyMessage="Nothing here."
        />
      )}
    </div>
  );
}

function ProposalModal({ id, data, run, busy, onClose }: { id: string | null; data: Overview | null; run: Run; busy: boolean; onClose: () => void }) {
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [error, setError] = useState("");
  const [overCap, setOverCap] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(async (proposalId: string) => {
    try {
      setDetail((await run("ads.proposal", { proposalId })) as ProposalDetail);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [run]);
  useEffect(() => {
    setDetail(null);
    setOverCap(false);
    setEvidence("");
    setNote("");
    if (id) void load(id);
  }, [id, load]);
  if (!id) return null;
  const act = async (key: ActionKey, params: Record<string, unknown>, success: string) => {
    try {
      await run(key, { proposalId: id, ...params }, success);
      await load(id);
    } catch {
      // the toast already says why
    }
  };
  const d = detail;
  const scope = d ? data?.budgets.find((b) => b.scopeKey === d.scopeKey) : undefined;
  const open = d && ["needs_changes", "in_review", "approved"].includes(d.status);
  const ownerMissing = d?.signoffs.missing.includes("owner");
  const clientMissing = d?.signoffs.missing.includes("client");
  return (
    <Modal
      open
      title={d ? d.title : "Change"}
      description={d ? `${d.kindLabel} for ${d.scopeLabel}` : undefined}
      onClose={onClose}
      footer={d && open ? (
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { if (window.confirm("Cancel this proposal? Nothing has been changed.")) void act("ads.cancel-proposal", { reason: note || undefined }, "Cancelled"); }}>Cancel proposal</Button>
          {d.status === "in_review" && ownerMissing ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void act("ads.approve", { role: "owner", decision: "rejected", note: note || undefined }, "Refused")}>Refuse</Button> : null}
          {d.status === "in_review" && ownerMissing ? <Button type="button" disabled={busy || (d.capState === "exceeds" && !overCap)} onClick={() => void act("ads.approve", { role: "owner", decision: "approved", overCapAck: overCap, note: note || undefined }, "Approved")}>Approve these numbers</Button> : null}
          {d.status === "approved" ? <Button type="button" variant="secondary" disabled={busy} onClick={() => { if (window.confirm("Mark this as done? Only do this if you made the change in the ad platform yourself.")) void act("ads.mark-done", { note: note || undefined }, "Marked done"); }}>I made the change myself</Button> : null}
          {d.status === "approved" && data?.writesEnabled && scope?.allowWrites ? <Button type="button" disabled={busy} onClick={() => { if (window.confirm("Run this change in the ad platform now?")) void act("ads.execute", {}, "Ran the change"); }}>Run it now</Button> : null}
        </>
      ) : undefined}
    >
      {error ? <Muted>{error}</Muted> : !d ? <Muted>Loading…</Muted> : (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill tone={statusTone(d.status)} dot>{d.statusLabel}</Pill>
            {d.capState === "exceeds" ? <Pill tone="bad" dot>Goes over the cap</Pill> : null}
            {d.reviewState === "pending" ? <Pill tone="info" dot>Reviewer checking</Pill> : null}
            {d.reviewState === "pass" ? <Pill tone="ok" dot>Reviewer passed</Pill> : null}
            {d.reviewState === "changes" ? <Pill tone="warn" dot>Reviewer wants changes</Pill> : null}
          </div>
          <Muted>{d.summary}</Muted>
          <SectionCard title="The numbers" subtitle="An approval is for exactly these">
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13, lineHeight: 1.45 }}>{d.numbers.map((l, i) => <li key={i}>{l.replace(/\*\*/g, "")}</li>)}</ul>
          </SectionCard>
          {d.budget.length ? <SectionCard title="Budget"><ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13, lineHeight: 1.45 }}>{d.budget.map((l, i) => <li key={i}>{l.replace(/\*\*/g, "")}</li>)}</ul></SectionCard> : null}
          {d.precheck.findings?.length ? (
            <SectionCard title="Checks on the copy" subtitle="A machine check; the Reviewer reads it against the client's brand">
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 }}>{d.precheck.findings.map((f, i) => <li key={i}><strong>{f.level === "blocker" ? "Blocker" : "Warning"}</strong> ({f.where}): {f.text}</li>)}</ul>
            </SectionCard>
          ) : null}
          {d.reviewNotes ? <Facts rows={[["Reviewer", d.reviewNotes]]} /> : null}
          <Facts
            rows={[
              ["Sign-offs needed", d.signoffs.required.join(" and ")],
              ["Given", Object.keys(d.signoffs.given).length ? Object.entries(d.signoffs.given).map(([r, g]) => `${r}: ${g.by.replace("user:", "a person")}${g.note ? ` (${g.note})` : ""}`).join("; ") : "None yet"],
              ["Still needed", d.signoffs.missing.length ? d.signoffs.missing.join(", ") : "Nothing"],
              ...(d.signoffs.refused ? ([["Refused", `${d.signoffs.refused.by}${d.signoffs.refused.note ? `: ${d.signoffs.refused.note}` : ""}`]] as Array<[string, ReactNode]>) : []),
              ["Next", d.next],
            ]}
          />
          {d.execution?.results?.length ? <SectionCard title="What ran"><ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{d.execution.results.map((r, i) => <li key={i}>{r.ok ? "Done" : "Failed"}: {r.what}{r.error ? ` (${r.error})` : ""}</li>)}</ul></SectionCard> : null}
          {d.error ? <Muted>{d.error}</Muted> : null}
          {open && ownerMissing && d.status === "in_review" ? (
            <div style={{ display: "grid", gap: 10 }}>
              {d.capState === "exceeds" ? (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                  <input type="checkbox" checked={overCap} onChange={(e) => setOverCap(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>I accept that this goes over the month's budget cap.</span>
                </label>
              ) : null}
              <Field label="A note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or a condition" /></Field>
            </div>
          ) : null}
          {open && clientMissing && !ownerMissing ? (
            <div style={{ display: "grid", gap: 10 }}>
              <Muted>The client's yes is recorded from what they wrote back (the Account Manager asks them through the CRM). Write what they said and when.</Muted>
              {d.clientMessage ? <TextArea readOnly rows={5} value={d.clientMessage} style={{ fontSize: 12 }} /> : null}
              <Field label="What the client wrote, and when"><TextArea rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="E.g. Jo replied on 5 Oct: yes, go ahead with R150 a day." /></Field>
              <div><Button type="button" disabled={busy || evidence.trim().length < 8} onClick={() => void act("ads.approve", { role: "client", decision: "approved", note: evidence, evidenceRef: d.proposalId }, "The client's yes is recorded")}>Record the client's yes</Button></div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ── Budgets ─────────────────────────────────────────────────────────────────

function BudgetsTab({ data, run, busy }: { data: Overview; run: Run; busy: boolean }) {
  if (data.budgets.length === 0) {
    return <EmptyState title="No budgets yet" icon={LayoutDashboard} description="A scope (PiB's own ads, or a client) appears here once an ad account is registered under it." />;
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Muted>A cap is the most a scope may spend in a month. Only a person sets it. Without one, no change that adds spend can run. At the alert point the plugin asks a person to pause: it never pauses anything by itself.</Muted>
      {!data.writesEnabled ? <Pill tone="neutral" dot>Changes are off for the whole company (plugin settings, Changing ads). Everything below is read and propose only.</Pill> : null}
      {data.budgets.map((b) => <BudgetCard key={b.scopeKey} b={b} data={data} run={run} busy={busy} />)}
      <SectionCard title="Who changed what" subtitle="Switches, caps, approvals and every change to an ad platform">
        <Timeline items={auditItems(data.audit, data)} limit={20} empty="Nothing yet." />
      </SectionCard>
    </div>
  );
}

function BudgetCard({ b, data, run, busy }: { b: BudgetInfo; data: Overview; run: Run; busy: boolean }) {
  const [cap, setCap] = useState(inputFromMinor(b.capMinor));
  const [alertPct, setAlertPct] = useState(String(b.alertPct));
  const [month, setMonth] = useState("");
  useEffect(() => {
    setCap(inputFromMinor(b.capMinor));
    setAlertPct(String(b.alertPct));
  }, [b.capMinor, b.alertPct]);
  const save = () => {
    const minor = minorFromInput(cap);
    if (minor === null || minor <= 0) {
      window.alert("Enter the cap as an amount, e.g. 5000 or 5000.50.");
      return;
    }
    void run("ads.set-cap", { scopeKey: b.scopeKey, monthlyCapMinor: minor, alertPct: Number(alertPct), ...(month ? { month } : {}) }, month ? `Cap for ${month} saved` : "Cap saved").catch(() => undefined);
  };
  const isClient = b.scopeKey !== OWN_SCOPE;
  return (
    <SectionCard title={b.label} subtitle={`${b.month} · ${b.currency}`} tone={b.state === "over" ? "bad" : b.state === "alert" ? "warn" : undefined} strip={b.state === "over" || b.state === "alert"}>
      <div style={{ display: "grid", gap: 14 }}>
        <Facts rows={[
          ["Spent", `${b.spent} of ${b.cap}${b.pctUsed !== null ? ` (${Math.round(b.pctUsed)}%)` : ""}`],
          ["Pace", b.capMinor === null ? "No cap set" : `${BUDGET_STATE_TEXT[b.state]}; ${Math.round(b.expectedPctByNow)}% of the month has passed; ends near ${b.projectedRunRate}`],
          ["Target cost per result", b.targetCpaMinor === null ? "Not set (the agent sets it)" : money(b.targetCpaMinor, b.currency)],
          ["Open pause request", b.openPauseRequests.length ? `${b.openPauseRequests.length}, see Changes` : "None"],
          ...(b.overrides.length ? ([["Month caps", b.overrides.map((o) => `${o.month}: ${money(o.cap_minor, b.currency)}`).join(", ")]] as Array<[string, ReactNode]>) : []),
        ]} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label={`Monthly cap (${b.currency})`}><Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="e.g. 5000" style={{ maxWidth: 160 }} /></Field>
          <Field label="Alert at (%)"><Input inputMode="numeric" value={alertPct} onChange={(e) => setAlertPct(e.target.value)} style={{ maxWidth: 90 }} /></Field>
          <Field label="Only for month (optional, YYYY-MM)"><Input value={month} onChange={(e) => setMonth(e.target.value)} placeholder={b.month} style={{ maxWidth: 150 }} /></Field>
          <Button type="button" disabled={busy} onClick={save}>Save cap</Button>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <Pill tone={b.allowWrites ? "warn" : "neutral"} dot>{b.allowWrites ? "Approved changes may run" : "Changes are off (read and propose only)"}</Pill>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || (!b.allowWrites && (!data.writesEnabled || b.capMinor === null))}
            title={!data.writesEnabled ? "Switch changes on for the company in the plugin settings first" : b.capMinor === null ? "Set a cap first" : undefined}
            onClick={() => {
              if (!b.allowWrites && !window.confirm(`Let approved changes run for ${b.label}? Every change still needs a recorded approval and stays inside the cap.`)) return;
              void run("ads.set-allow-writes", { scopeKey: b.scopeKey, allow: !b.allowWrites }, b.allowWrites ? "Changes switched off" : "Changes switched on").catch(() => undefined);
            }}
          >
            {b.allowWrites ? "Switch changes off" : "Switch changes on"}
          </Button>
          {isClient ? (
            <Select aria-label="Who must sign" value={b.signoffs} onChange={(e) => void run("ads.set-signoffs", { scopeKey: b.scopeKey, signoffs: e.target.value }, "Saved").catch(() => undefined)} style={{ maxWidth: 280 }}>
              <option value="owner_client">Owner and the client must say yes</option>
              <option value="owner">Only the owner must say yes</option>
            </Select>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

function AccountsTab({ data, run, busy, companyId }: { data: Overview; run: Run; busy: boolean; companyId: string }) {
  const [browse, setBrowse] = useState<ConnectionInfo | null>(null);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SectionCard title="Platforms" subtitle="Each platform starts off. Do its steps on the Overview checklist, switch it on in the plugin settings, then connect here.">
        <div style={{ display: "grid", gap: 12 }}>
          {data.platforms.filter((p) => p.platform !== "mock" || p.switchedOn).map((p) => (
            <div key={p.platform} style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{p.label}</strong>
                <span style={{ fontSize: 12.5, color: tokens.muted }}>{p.enabled ? (p.requestWrite ? "On. Connections may be given the change permission." : "On. Connections are read-only.") : p.blocker ?? "Off"}</span>
              </div>
              <ConnectButtons p={p} run={run} busy={busy} companyId={companyId} />
            </div>
          ))}
          {data.redirectUri ? <Muted>Redirect address to register with Meta and Google: <code style={{ overflowWrap: "anywhere" }}>{data.redirectUri}</code></Muted> : <Muted>{data.publicBaseUrlError ?? "Save the public base URL in the plugin settings: the redirect address to register with Meta and Google then shows here."}</Muted>}
        </div>
      </SectionCard>
      <SectionCard title="Connections" subtitle="Signing in is a one-time grant only a person can give. No token is ever shown.">
        {data.connections.length === 0 ? <Muted>No connection yet.</Muted> : (
          <div style={{ display: "grid", gap: 10 }}>
            {data.connections.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><strong style={{ fontSize: 13 }}>{c.label}</strong><Pill tone={connectionTone(c.status)} dot>{CONNECTION_TEXT[c.status] ?? c.status}</Pill>{c.canWrite ? <Pill tone="warn">May change ads</Pill> : <Pill>Read-only</Pill>}</span>
                  <span style={{ fontSize: 12.5, color: tokens.muted }}>{c.statusDetail ?? (c.lastOkAt ? `Last worked ${formatDateTime(c.lastOkAt)}` : "Not used yet")}</span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button type="button" variant="secondary" disabled={busy || c.status === "needs_reconnect"} onClick={() => setBrowse(c)}>Add ad accounts</Button>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => { if (window.confirm(`Remove "${c.label}"? Its ad accounts stop updating until you connect again.`)) void run("ads.disconnect", { connectionId: c.id }, "Removed").catch(() => undefined); }}>Remove</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Ad accounts" subtitle="Each belongs to PiB's own ads or to one client" actions={<Button type="button" variant="secondary" disabled={busy || data.accounts.length === 0} onClick={() => void run("ads.sync", {}, "Read the numbers").catch(() => undefined)}>Read numbers now</Button>}>
        <DataTable
          columns={[
            { key: "name", header: "Account" },
            { key: "platformLabel", header: "Platform" },
            { key: "scopeLabel", header: "Whose" },
            { key: "currency", header: "Currency" },
            { key: "last", header: "Last read" },
            { key: "status", header: "Status", render: (_v, row) => { const a = row as unknown as AccountInfo & { last: string }; return a.lastSyncError ? <Pill tone="bad" dot>Not updating</Pill> : <Pill tone={a.status === "active" ? "ok" : "neutral"} dot>{a.status === "active" ? "Reading" : a.status}</Pill>; } },
            { key: "id", header: "", render: (_v, row) => { const a = row as unknown as AccountInfo; return <Button type="button" variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => { if (window.confirm(`Stop reading "${a.name}"? Its past numbers stay.`)) void run("ads.remove-account", { accountId: a.id }, "Removed").catch(() => undefined); }}>Remove</Button>; } },
          ]}
          rows={data.accounts.map((a) => ({ ...a, last: a.lastSyncOkAt ? formatDateTime(a.lastSyncOkAt) : "Not yet" })) as unknown as Record<string, unknown>[]}
          emptyMessage="No ad account registered yet."
        />
      </SectionCard>
      <BrowseModal conn={browse} data={data} run={run} busy={busy} onClose={() => setBrowse(null)} />
    </div>
  );
}

function ConnectButtons({ p, run, busy, companyId }: { p: Overview["platforms"][number]; run: Run; busy: boolean; companyId: string }) {
  const start = async () => {
    try {
      const res = (await run("ads.oauth-start", { platform: p.platform })) as { authorizeUrl?: string; state?: string; label?: string };
      if (!res?.authorizeUrl || !res.state) throw new Error("The connection could not start");
      rememberOAuthStart(res.state, { companyId, completeUrl: COMPLETE_ROUTE_PATH, returnTo: window.location.href, label: res.label ?? p.label });
      window.location.assign(res.authorizeUrl);
    } catch {
      // the toast says why
    }
  };
  if (!p.enabled) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {p.platform === "mock" ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void run("ads.connect-mock", {}, "Connected the test platform").catch(() => undefined)}>Connect test platform</Button> : null}
      {p.platform !== "mock" && p.signIn ? <Button type="button" disabled={busy} onClick={() => void start()}>Connect {p.platform === "meta" ? "Meta" : "Google Ads"}</Button> : null}
      {p.platform === "meta" && p.token ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void run("ads.connect-token", { platform: "meta" }, "Connected with the saved token").catch(() => undefined)}>Connect with the saved token</Button> : null}
    </div>
  );
}

function BrowseModal({ conn, data, run, busy, onClose }: { conn: ConnectionInfo | null; data: Overview; run: Run; busy: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ externalId: string; name: string; currency: string; status: string; business?: string | null; registeredAs: { id: string; scopeKey: string } | null }> | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<Record<string, string>>({});
  useEffect(() => {
    setRows(null);
    setError("");
    if (!conn) return;
    run("ads.discover-accounts", { connectionId: conn.id }).then((r: { accounts: any[] }) => setRows(r.accounts)).catch((e: unknown) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);
  const clientIds = useMemo(() => Object.entries(data.clients).sort((a, b) => a[1].localeCompare(b[1])), [data.clients]);
  if (!conn) return null;
  return (
    <Modal open title={`Ad accounts in ${conn.label}`} description="Choose whose ads each account belongs to. Reading changes nothing." onClose={onClose}>
      {error ? <Muted>{error}</Muted> : !rows ? <Muted>Asking the platform…</Muted> : rows.length === 0 ? <Muted>This sign-in can see no ad accounts.</Muted> : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.externalId} style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}><strong style={{ fontSize: 13 }}>{r.name}</strong><div style={{ fontSize: 12, color: tokens.muted }}>{r.currency}{r.business ? ` · ${r.business}` : ""}{r.status !== "active" ? ` · ${r.status}` : ""}</div></div>
              {r.registeredAs ? <Pill tone="ok" dot>Registered</Pill> : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Select aria-label="Whose ads" value={scope[r.externalId] ?? OWN_SCOPE} onChange={(e) => setScope({ ...scope, [r.externalId]: e.target.value })}>
                    <option value={OWN_SCOPE}>PiB's own ads</option>
                    {clientIds.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                  </Select>
                  <Button type="button" disabled={busy} onClick={() => void run("ads.register-account", { connectionId: conn.id, externalId: r.externalId, scopeKey: scope[r.externalId] ?? OWN_SCOPE }, "Registered").then(() => setRows(rows.map((x) => (x.externalId === r.externalId ? { ...x, registeredAs: { id: "", scopeKey: scope[r.externalId] ?? OWN_SCOPE } } : x)))).catch(() => undefined)}>Add</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

export function AdsSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched the module off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  // A Cockpit group draws this page when it lists it (pib-plugin-ui NAV_GROUPS); until then the plugin shows its own row.
  const grouped = useGroupedNav(PLUGIN_ID);
  const navigation = useHostNavigation();
  if (enabled === false || grouped !== false) return null;
  const href = navigation.resolveHref("/ads");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...navigation.linkProps("/ads")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 11 18-5v12L3 14v-3z" />
          <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
        </svg>
      </span>
      <span className="flex-1 truncate">Paid ads</span>
    </a>
  );
}

