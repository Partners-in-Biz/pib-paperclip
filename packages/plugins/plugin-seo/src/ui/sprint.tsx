/**
 * One sprint: where it is, what needs a person, and its tabs. Navigation is
 * the client workspace bar (its back link) plus one breadcrumb; secondary and
 * destructive actions live in the ⋯ menu.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DataTable, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import {
  BookOpen,
  Button,
  CalendarCheck,
  ChartLegend,
  ChartLine,
  CompactRows,
  EmptyState,
  Eye,
  Field,
  FileText,
  HeartPulse,
  Info,
  Input,
  KpiCard,
  Lightbulb,
  ListChecks,
  Modal,
  Plug,
  ProgressBar,
  ProgressRing,
  Rocket,
  ScrollX,
  SectionCard,
  Select,
  Share2,
  StackedBar,
  StatusDot,
  Tabs,
  Target,
  TextArea,
  TrendChart,
  breakAnywhere,
  errorText,
  fluidColumns,
  formatCompact,
  formatDate,
  formatShortDate,
  tokens,
  tone,
  useIsNarrow,
  type LucideIcon,
} from "@partnersinbiz/pib-plugin-ui";
import { agentCanWork, agentTrouble, daysLate, dueDateOf, projectFixPath, RUNS_FIX, RUNS_TROUBLE, tallyTasks, taskState, type TaskState } from "../engine/due.js";
import { fixPlurals, lowerFirst, plainError, plainTerms, plainWarning, plural } from "../engine/plain.js";
import { PHASE_NAMES, type SprintPhase } from "../templates/outrank-90.js";
import { PLANS, type BusinessType } from "../templates/plans.js";
import { BusinessTypeField } from "./home.js";
import { MoreMenu, type MenuItem } from "./menu.js";
import { Banner, Breadcrumb, IssueLink, StatePill, StuckBanner, linkButton, shortUrl, small, top, type Crumb } from "./parts.js";
import { PlaybookTab } from "./playbook.js";
import { BacklinksTab, ContentTab, KeywordsTab, AuditsTab, OptimizationsTab } from "./lists.js";
import { IntegrationsTab } from "./integrations.js";
import { TEAM_SETUP_HREF } from "./role-skills.js";
import { CHIP_LABEL, CHIP_ORDER, CHIP_TONE, changeText, healthTone, statusTone, taskSegments, trafficSeries } from "./series.js";
import type { AgentState, CallFn, LoadResult, SprintBundle, SprintSummary, TabId, Task } from "./types.js";
import { STATE_LABEL, STATE_ORDER, STATE_SHORT, STATE_TONE, sprintStatusText, tabsForPhone } from "./words.js";

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "keywords", label: "Keywords", icon: Target },
  { id: "backlinks", label: "Backlinks", icon: Share2 },
  { id: "content", label: "Content", icon: FileText },
  { id: "audits", label: "Audits", icon: HeartPulse },
  { id: "optimizations", label: "Optimizations", icon: Lightbulb },
  { id: "playbook", label: "Playbook", icon: BookOpen },
  { id: "integrations", label: "Integrations", icon: Plug },
];

export const SPRINT_TAB_IDS: TabId[] = TABS.map((t) => t.id);

const grid = (min: number, gap = 16) => ({ display: "grid", gap, gridTemplateColumns: fluidColumns(min), minWidth: 0 }) as const;

const AUTOPILOT: Record<string, { label: string; text: string }> = {
  safe: { label: "Safe", text: "The agent works its tasks; anything that publishes, sends or changes the live site waits for your sign-off." },
  full: { label: "Full", text: "The agent finishes its tasks without sign-off." },
  off: { label: "Off", text: "Every task goes to the sprint owner." },
};

/** Projects whose workspace check stops these tasks' runs (their Codebase needs a checkout of the site repo). */
function runsProjectIds(tasks: Task[]): string[] {
  return [...new Set(tasks.filter((task) => task.runsFailing && task.issueProjectId).map((task) => task.issueProjectId!))];
}

/** Integrations a person has to fix (not ones that clear on their own, like the free PageSpeed limit). */
function integrationProblems(bundle: SprintBundle): number {
  return bundle.integrations.filter((i) => i.status === "needs_reconnect" || Boolean(plainError(i.lastError, i.provider === "gsc" || i.provider === "bing" || i.provider === "pagespeed" ? i.provider : null)?.needsPerson)).length;
}

/** Badges: amber or red only for what needs you; plain counts stay grey. */
function tabCount(id: TabId, bundle: SprintBundle, canWork: boolean): { count?: number | null; countTone?: "ok" | "warn" | "bad" | "info" } {
  const day = bundle.sprint.day;
  const full = bundle.sprint.autopilotMode === "full";
  switch (id) {
    case "plan": {
      const tally = tallyTasks(bundle.tasks, day, canWork);
      if (tally.stuck) return { count: tally.stuck, countTone: "bad" };
      return tally.due ? { count: tally.due } : {};
    }
    case "keywords": return { count: bundle.keywords.filter((k) => !k.retiredAt).length || null };
    case "backlinks": return { count: bundle.backlinks.filter((b) => b.status === "live").length || null };
    case "content": return { count: bundle.content.length || null };
    case "audits": return { count: bundle.findings.length || null };
    case "optimizations": {
      const proposed = bundle.optimizations.filter((o) => o.status === "proposed").length;
      return proposed ? { count: proposed, countTone: full ? undefined : "warn" } : {};
    }
    case "playbook": {
      const pending = bundle.playbook?.pending ?? 0;
      return pending ? { count: pending, countTone: full ? undefined : "warn" } : {};
    }
    case "integrations": {
      const broken = integrationProblems(bundle);
      const needs = bundle.needsYou?.open.filter((i) => !i.optional).length ?? 0;
      return broken ? { count: broken + needs, countTone: "bad" } : needs ? { count: needs, countTone: "warn" } : {};
    }
    default:
      return {};
  }
}

export function SprintCockpit({
  companyId,
  sprintId,
  scope,
  load,
  initialTab,
  onTab,
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
  /** The sprint belongs to another scope (a client, or PiB's own sites). */
  onRedirect: (client: string | null, clientName: string | null) => void;
  onMessage: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const nav = useHostNavigation();
  const narrow = useIsNarrow();
  const fetchSprint = usePluginAction("seo.sprint");
  const callAction = usePluginAction("seo.call");
  const runDaily = usePluginAction("seo.run-daily");
  const runWeekly = usePluginAction("seo.run-weekly");
  const [bundle, setBundle] = useState<SprintBundle | null>(null);
  const [tab, setTab] = useState<TabId>(SPRINT_TAB_IDS.includes(initialTab) ? initialTab : "plan");
  const [working, setWorking] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"link" | "autopilot" | "plan" | "archive" | "start" | "through" | null>(null);
  const client = scope ? `${scope.kind}:${scope.id}` : null;

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

  const call: CallFn = useCallback(
    async (tool, params, success) => {
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
  const canWork = agentCanWork(load.agent) || !["pre_launch", "active", "compounding"].includes(s.status);
  const tally = tallyTasks(bundle.tasks, s.day, canWork);
  const selectTab = (id: TabId) => {
    setTab(id);
    onTab(id);
  };
  const scopeParam = s.client ? encodeURIComponent(s.client) : null;
  const crumbs: Crumb[] = s.client
    ? [
        { label: s.clientName ?? "Client", link: nav.linkProps(`/crm?client=${scopeParam}`) },
        { label: "SEO", link: nav.linkProps(`/seo?client=${scopeParam}`) },
        { label: s.siteName },
      ]
    : [{ label: "SEO", link: nav.linkProps("/seo") }, { label: s.siteName }];
  const paused = s.status === "paused" || s.status === "archived";
  const manual = s.pacing === "manual";
  const autoSignoff = s.clientSignoff === "auto";
  const items: MenuItem[] = [
    { key: "daily", label: working === "daily" ? "Running today's work…" : "Run today's work now", hint: "The daily run: opens due tasks and pulls data", disabled: Boolean(working) || s.legacy, onSelect: () => void run("daily", () => runDaily({ sprintId }), (r) => {
      const x = r as { issuesOpened: number; warnings: string[] };
      const warnings = x.warnings.map((w) => plainWarning(w)).map((w) => `${w.area}: ${w.text}`).join(" ");
      return `Today's work ran: ${plural(x.issuesOpened, "task")} opened.${warnings ? ` ${warnings}` : ""}`;
    }) },
    { key: "weekly", label: working === "weekly" ? "Reviewing…" : "Run the weekly review now", hint: "Finds problems and proposes changes", disabled: Boolean(working) || s.legacy, onSelect: () => void run("weekly", () => runWeekly({ sprintId }), (r) => {
      const x = r as { signals: unknown[]; proposalsCreated: unknown[] };
      return `Weekly review done: ${plural(x.signals.length, "signal")}, ${plural(x.proposalsCreated.length, "new proposal")}.`;
    }) },
    { key: "pacing", label: manual ? "Switch to automatic pacing" : "Switch to manual pacing", hint: manual ? "Tasks open by the calendar again" : "Nothing opens until you start each week", disabled: s.legacy || s.status === "archived", onSelect: () => void call("set-pacing", { sprintId, pacing: manual ? "auto" : "manual" }, manual ? "Pacing is automatic: tasks open by the calendar." : "Pacing is manual: press Start on a week to open its tasks.").then(() => onChanged()) },
    ...(s.site?.siteAccess === "wordpress" && s.site?.changePolicy === "pr_only"
      ? [{ key: "signoff", label: autoSignoff ? "Client sign-off: switch to manual" : "Client sign-off: switch to automatic", hint: autoSignoff ? "You carry the preview links and press Apply" : "Approval email drafted in Gmail, approved changes applied by the agent", disabled: s.legacy || s.status === "archived", onSelect: () => void call("set-signoff-mode", { sprintId, mode: autoSignoff ? "manual" : "auto" }, autoSignoff ? "Client sign-off is manual." : "Client sign-off is automatic: passed previews are drafted as one email in Gmail, and what the client approves is applied.").then(() => onChanged()) }]
      : []),
    { key: "through", label: "Run the plan by itself…", hint: s.releaseThrough != null ? `Now: through week ${s.releaseThrough}` : "Now: you start each week", disabled: s.legacy || paused, onSelect: () => setDialog("through") },
    { key: "autopilot", label: "Change autopilot…", hint: `Now: ${AUTOPILOT[s.autopilotMode]?.label ?? s.autopilotMode}`, disabled: s.status === "archived", onSelect: () => setDialog("autopilot") },
    { key: "plan", label: "Change plan type…", hint: `Now: ${s.plan}`, disabled: s.legacy || s.status === "archived", onSelect: () => setDialog("plan") },
    ...(s.rootIssueId ? [{ kind: "link" as const, key: "issue", label: "Open the sprint issue", hint: s.rootIssueIdentifier ?? undefined, link: nav.linkProps(`/issues/${s.rootIssueIdentifier ?? s.rootIssueId}`) }] : []),
    { kind: "separator", key: "sep" },
    paused
      ? { key: "resume", label: "Resume sprint", onSelect: () => void call("resume-sprint", { sprintId }, "Sprint resumed.").then(() => onChanged()) }
      : { key: "pause", label: "Pause sprint", hint: "Stops the daily run and new task issues", onSelect: () => void call("pause-sprint", { sprintId }, "Sprint paused.").then(() => onChanged()) },
    ...(s.status !== "archived" ? [{ key: "archive", label: "Archive sprint…", danger: true, onSelect: () => setDialog("archive") }] : []),
  ];
  const tabs = tabsForPhone(TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, ...tabCount(t.id, bundle, canWork) })), narrow);
  const autopilot = AUTOPILOT[s.autopilotMode]?.label ?? s.autopilotMode;
  const facts = s.legacy ? ["No 90-day plan yet"] : [`${s.plan} plan`, sprintStatusText(s), `Autopilot: ${autopilot.toLowerCase()}`, ...(manual ? ["Manual pacing"] : []), ...(autoSignoff ? ["Client sign-off automatic"] : []), ...(s.releaseThrough != null ? [`Runs through week ${s.releaseThrough}`] : [])];

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <Breadcrumb items={crumbs} />
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", minWidth: 0 }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 auto" }}>
          <h2 style={{ margin: 0, fontSize: narrow ? 19 : 21, fontWeight: 650, letterSpacing: "-0.01em", ...breakAnywhere }}>{s.siteName}</h2>
          <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.5, ...breakAnywhere }}>
            <a href={s.siteUrl} target="_blank" rel="noreferrer" style={{ color: tokens.muted }}>{shortUrl(s.siteUrl)}</a>
            {" · "}{facts.join(" · ")}
            {s.startDate ? ` · started ${formatShortDate(s.startDate)}` : ""}
          </span>
        </div>
        <MoreMenu items={items} label="Sprint actions" />
      </div>
      <StuckBanner stuck={tally.stuck} stuckRuns={tally.stuckRuns} runsProjectIds={runsProjectIds(bundle.tasks)} agent={load.agent} />
      {!scope && s.legacyClientName ? (
        <Banner tone="warn" action={<Button type="button" variant="secondary" style={small} onClick={() => setDialog("link")}>Link to CRM client</Button>}>
          <span>This sprint names a client (“{s.legacyClientName}”) but is not linked to a CRM record, so it shows under our own sites.</span>
        </Banner>
      ) : null}
      <Tabs tabs={tabs} active={tab} onChange={(id) => selectTab(id as TabId)} />
      {tab === "plan" && s.legacy ? (
        <EmptyState
          icon={Rocket}
          title="No 90-day plan yet"
          description="Nothing runs for this sprint until it has a plan. Pick the kind of business: it decides the tasks, directories and profiles."
          action={<Button type="button" onClick={() => setDialog("start")}>Start the 90-day plan</Button>}
        />
      ) : null}
      {tab === "plan" && !s.legacy ? <PlanTab bundle={bundle} today={load.today} agent={load.agent} canWork={canWork} call={call} onTab={selectTab} /> : null}
      {tab === "keywords" ? <KeywordsTab bundle={bundle} call={call} working={working} /> : null}
      {tab === "backlinks" ? <BacklinksTab bundle={bundle} call={call} /> : null}
      {tab === "content" ? <ContentTab bundle={bundle} call={call} /> : null}
      {tab === "audits" ? <AuditsTab bundle={bundle} call={call} working={working} /> : null}
      {tab === "optimizations" ? <OptimizationsTab bundle={bundle} call={call} /> : null}
      {tab === "playbook" ? <PlaybookTab sprintId={sprintId} onChanged={reload} onMessage={onMessage} /> : null}
      {tab === "integrations" ? <IntegrationsTab companyId={companyId} bundle={bundle} load={load} call={call} reload={reload} onMessage={onMessage} working={working} /> : null}
      {dialog === "link" ? <LinkClientModal sprint={s} onClose={() => setDialog(null)} call={call} /> : null}
      {dialog === "through" ? <RunThroughModal sprint={s} onClose={() => setDialog(null)} call={call} onChanged={onChanged} /> : null}
      {dialog === "autopilot" ? <AutopilotModal sprint={s} onClose={() => setDialog(null)} call={call} onChanged={onChanged} /> : null}
      {dialog === "plan" ? <ChangePlanModal sprint={s} onClose={() => setDialog(null)} call={call} onChanged={onChanged} onMessage={onMessage} /> : null}
      {dialog === "archive" ? (
        <Modal
          open
          title="Archive this sprint?"
          description="Nothing runs for it afterwards: no daily run, no new task issues. You can resume it later from this menu."
          onClose={() => setDialog(null)}
          footer={(
            <>
              <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Keep it</Button>
              <Button type="button" onClick={() => void call("archive-sprint", { sprintId }, "Sprint archived.").then(() => onChanged()).finally(() => setDialog(null))}>Archive sprint</Button>
            </>
          )}
        >
          <span style={{ fontSize: 13 }}>{s.siteName}</span>
        </Modal>
      ) : null}
      {dialog === "start" ? <StartPlanInline sprint={s} onClose={() => setDialog(null)} onDone={async (note) => { setDialog(null); await reload(); await onChanged(); onMessage(note); }} onError={onMessage} /> : null}
    </div>
  );
}

function StartPlanInline({ sprint, onClose, onDone, onError }: { sprint: SprintSummary; onClose: () => void; onDone: (note: string) => Promise<void>; onError: (m: string) => void }) {
  const upgrade = usePluginAction("seo.upgrade-legacy");
  const [type, setType] = useState<BusinessType | "">(sprint.client ? "local" : "");
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      open
      title="Start the 90-day plan"
      description={`${sprint.siteName} has no plan yet. The kind of business decides its tasks, directories and profiles.`}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={!type || saving}
            onClick={() => {
              if (!type) return;
              setSaving(true);
              void upgrade({ sprintId: sprint.sprintId, businessType: type })
                .then((r) => onDone(`The ${lowerFirst(PLANS[type].label)} plan is set: ${plural((r as { seededTasks: number }).seededTasks, "task")} added. The next daily run opens the ones that are due.`))
                .catch((e: unknown) => onError(errorText(e)))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Starting…" : "Start the plan"}
          </Button>
        </>
      )}
    >
      <BusinessTypeField value={type} onChange={setType} required hint={sprint.client ? "Most clients are local service businesses." : undefined} />
    </Modal>
  );
}

function RunThroughModal({ sprint, onClose, call, onChanged }: { sprint: SprintSummary; onClose: () => void; call: CallFn; onChanged: () => Promise<void> }) {
  const [week, setWeek] = useState<string>(sprint.releaseThrough != null ? String(sprint.releaseThrough) : "");
  const current = sprint.releaseThrough != null ? String(sprint.releaseThrough) : "";
  return (
    <Modal
      open
      title="Run the plan by itself"
      description="The SEO agent works the plan week by week up to the week you pick. A week starts when nothing of an earlier week is waiting for the agent: work waiting on you or on the client's approval does not hold it back. Past that week, nothing starts until you start it."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={week === current} onClick={() => void call("set-release-through", { sprintId: sprint.sprintId, ...(week === "" ? {} : { week: Number(week) }) }, week === "" ? "Stopped: you start each week." : `The plan runs by itself through week ${week}.`).then(() => onChanged()).finally(onClose)}>Save</Button>
        </>
      )}
    >
      <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
        Run through
        <Select aria-label="Run through week" value={week} onChange={(e) => setWeek(e.target.value)}>
          <option value="">Stop: I start each week myself</option>
          {Array.from({ length: 14 }, (_, w) => (
            <option key={w} value={String(w)}>{`Week ${w}`}</option>
          ))}
        </Select>
      </label>
    </Modal>
  );
}

function AutopilotModal({ sprint, onClose, call, onChanged }: { sprint: SprintSummary; onClose: () => void; call: CallFn; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState(sprint.autopilotMode);
  return (
    <Modal
      open
      title="Autopilot"
      description="How much the SEO agent may finish without you."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={mode === sprint.autopilotMode} onClick={() => void call("set-autopilot", { sprintId: sprint.sprintId, mode }, `Autopilot set to ${AUTOPILOT[mode]?.label.toLowerCase() ?? mode}.`).then(() => onChanged()).finally(onClose)}>Save</Button>
        </>
      )}
    >
      <div role="radiogroup" aria-label="Autopilot" style={{ display: "grid", gap: 8 }}>
        {(["safe", "full", "off"] as const).map((key) => (
          <label key={key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, borderRadius: 10, border: `1px solid ${mode === key ? tokens.ring : tokens.border}`, cursor: "pointer", minHeight: 40 }}>
            <input type="radio" name="autopilot" checked={mode === key} onChange={() => setMode(key)} style={{ marginTop: 3 }} />
            <span style={{ display: "grid", gap: 2 }}>
              <strong style={{ fontSize: 13 }}>{AUTOPILOT[key]!.label}{key === "safe" ? " (recommended)" : ""}</strong>
              <span style={{ fontSize: 12.5, color: tokens.muted }}>{AUTOPILOT[key]!.text}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ChangePlanModal({ sprint, onClose, call, onChanged, onMessage }: { sprint: SprintSummary; onClose: () => void; call: CallFn; onChanged: () => Promise<void>; onMessage: (m: string) => void }) {
  const [type, setType] = useState<BusinessType | "">(sprint.businessType);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const changed = Boolean(type) && type !== sprint.businessType;
  async function save() {
    if (!type || !changed) return;
    setSaving(true);
    const result = (await call("change-plan", { sprintId: sprint.sprintId, businessType: type, reason: reason.trim() || undefined })) as { plan: string; tasksAdded: number; tasksNotNeeded: string[]; tasksStillOpen: unknown[] } | null;
    setSaving(false);
    if (!result) return;
    await onChanged();
    onMessage(`Plan changed to ${lowerFirst(result.plan)}: ${plural(result.tasksAdded, "task")} added, ${plural(result.tasksNotNeeded.length, "task")} not needed any more${result.tasksStillOpen.length ? `, ${plural(result.tasksStillOpen.length, "started task")} kept for the agent to finish or skip` : ""}.`);
    onClose();
  }
  return (
    <Modal
      open
      title="Change the plan type"
      description={`${sprint.siteName} follows the ${lowerFirst(sprint.plan)} plan.`}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!changed || saving} onClick={() => void save()}>{saving ? "Changing…" : "Change plan"}</Button>
        </>
      )}
    >
      <BusinessTypeField value={type} onChange={setType} />
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5, display: "grid", gap: 2, listStyle: "disc" }}>
        <li>Adds the new plan's tasks, directories and profiles; the ones already due open now.</li>
        <li>Tasks of the old plan that nobody started are marked not needed.</li>
        <li>Work already started stays open for the agent to finish or skip. Nothing done is lost.</li>
      </ul>
      <Field label="Why (optional, noted on the sprint issue)"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Northwind is a guest house, not software" /></Field>
    </Modal>
  );
}

type CrmClientOption = { client: string; kind: "company" | "contact"; id: string; name: string; detail: string | null };

/** People only: move an own sprint that names a client into that client's workspace. */
function LinkClientModal({ sprint, onClose, call }: { sprint: SprintSummary; onClose: () => void; call: CallFn }) {
  const listClients = usePluginAction("seo.clients");
  const [clients, setClients] = useState<CrmClientOption[] | null>(null);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
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
  }, []);

  return (
    <Modal
      open
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
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} style={{ width: "100%" }}>
          <option value="">{clients ? (clients.length === 0 ? "No CRM clients yet (run CRM resync)" : "Choose a company or contact") : "Loading…"}</option>
          {(clients ?? []).map((c) => <option key={c.client} value={c.client}>{c.name} · {c.kind}{c.detail ? ` · ${c.detail}` : ""}</option>)}
        </Select>
      </Field>
      {error ? <p style={{ margin: 0, color: tokens.destructive, fontSize: 13 }}>{error}</p> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function stateOf(task: Task, day: number, canWork: boolean): TaskState {
  return taskState(task, day, canWork);
}

/** What needs a person on this sprint, in one line: Needs you items, proposals, playbook changes. */
function needsYouParts(bundle: SprintBundle, short: boolean): Array<{ text: string; tab: TabId }> {
  const full = bundle.sprint.autopilotMode === "full";
  const parts: Array<{ text: string; tab: TabId }> = [];
  const needs = bundle.needsYou?.open.filter((i) => !i.optional) ?? [];
  const titles = short ? "" : ` (${needs.slice(0, 2).map((i) => i.title).join("; ")}${needs.length > 2 ? "…" : ""})`;
  if (needs.length) parts.push({ text: `${needs.length === 1 ? "1 thing to do" : `${needs.length} things to do`}${titles}`, tab: "integrations" });
  const proposals = full ? 0 : bundle.optimizations.filter((o) => o.status === "proposed").length;
  if (proposals) parts.push({ text: `${plural(proposals, "change")} to approve`, tab: "optimizations" });
  const pending = full ? 0 : bundle.playbook?.pending ?? 0;
  if (pending) parts.push({ text: `${plural(pending, "playbook rule")} to keep or discard`, tab: "playbook" });
  return parts;
}

/** Ask for a redesign of one page: the Senior Developer designs it and shows it as a client preview. Not part of the plan unless asked. */
function RedesignRequest({ sprintId, call }: { sprintId: string; call: CallFn }) {
  const [open, setOpen] = useState(false);
  const [pageUrl, setPageUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await call("add-redesign", { sprintId, pageUrl, goal }, "Redesign started. The Senior Developer designs it; it comes back as a preview the Reviewer checks.");
      setOpen(false);
      setPageUrl("");
      setGoal("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: tokens.muted }}>
        <Button type="button" variant="secondary" style={small} onClick={() => setOpen(true)}>Ask for a redesign</Button>
        <span>A page looks dated or off-brand? The Senior Developer designs a better one; nothing changes until the client signs off.</span>
      </div>
      <Modal
        open={open}
        title="Ask for a redesign"
        description="One page. The Senior Developer designs it and shows it as a client preview, checked by the Reviewer on desktop and phone."
        onClose={() => setOpen(false)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" disabled={busy || !pageUrl.trim() || !goal.trim()} onClick={() => void submit()}>Start the redesign</Button>
          </>
        )}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Field label="Page"><Input value={pageUrl} placeholder="/ or https://client.co.za/about" onChange={(e) => setPageUrl(e.target.value)} /></Field>
          <Field label="What is wrong, and what should it feel like?"><TextArea value={goal} rows={5} placeholder="e.g. The home page is dense and dated. Keep the dark theme and the auction listings, but make the first screen clearer and the intro look designed." onChange={(e) => setGoal(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}

function PlanTab({ bundle, today, agent, canWork, call, onTab }: { bundle: SprintBundle; today: string; agent: AgentState; canWork: boolean; call: CallFn; onTab: (tab: TabId) => void }) {
  const narrow = useIsNarrow();
  const [selected, setSelected] = useState<Task | null>(null);
  const [showAll, setShowAll] = useState(false);
  const day = bundle.sprint.day;
  const tally = tallyTasks(bundle.tasks, day, canWork);
  const rank = (t: Task) => STATE_ORDER.indexOf(stateOf(t, day, canWork));
  const now = bundle.tasks
    .filter((t) => !["done", "skipped", "upcoming"].includes(stateOf(t, day, canWork)))
    .sort((a, b) => rank(a) - rank(b) || (a.dueDay ?? 0) - (b.dueDay ?? 0) || a.week - b.week);
  const visible = showAll ? now : now.slice(0, narrow ? 5 : 6);
  const more = now.length > visible.length ? <Button type="button" variant="secondary" style={{ ...small, width: "fit-content" }} onClick={() => setShowAll(true)}>Show all {now.length}</Button> : null;
  const needs = needsYouParts(bundle, narrow);
  const warnings = (bundle.today.warnings ?? []).map(plainWarning);
  const nextSteps = (bundle.today.next ?? []).map((line) => plainTerms(fixPlurals(line)));
  const dueText = (t: Task) => {
    const date = dueDateOf(bundle.sprint.startDate, t.dueDay);
    return date ? formatShortDate(date) : "";
  };
  const subtitle = [
    tally.overdue ? `${tally.overdue} overdue` : "none overdue",
    tally.stuck ? `${tally.stuck} stuck` : null,
    tally.waiting ? `${tally.waiting} waiting on you` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {bundle.sprint.status !== "archived" ? <RedesignRequest sprintId={bundle.sprint.sprintId} call={call} /> : null}
      {needs.length ? (
        <Banner tone="warn" action={<Button type="button" variant="secondary" style={{ ...small, minHeight: 40 }} onClick={() => onTab(needs[0]!.tab)}>Open</Button>}>
          <span><strong>Needs you:</strong> {needs.map((n) => n.text).join(" · ")}</span>
        </Banner>
      ) : null}
      <SectionCard
        title={tally.due ? `Due now: ${tally.due}` : "Nothing due now"}
        subtitle={tally.due || tally.waiting ? subtitle : "The daily run opens tasks on their day."}
        icon={CalendarCheck}
        tone={tally.stuck ? "bad" : tally.overdue || tally.waiting ? "warn" : "ok"}
      >
        {now.length === 0 ? (
          <EmptyState compact icon={CalendarCheck} tone="ok" title="Nothing due right now" description="The next daily run opens the tasks that come due." />
        ) : narrow ? (
          <div style={{ display: "grid", gap: 6 }}>
            <CompactRows
              rows={visible}
              rowKey={(t) => t.id}
              title={(t) => t.title}
              meta={(t) => {
                const state = stateOf(t, day, canWork);
                return [STATE_SHORT[state], dueText(t) ? `due ${dueText(t)}` : null, `Week ${t.week}`].filter(Boolean).join(" · ");
              }}
              trailing={(t) => {
                const state = stateOf(t, day, canWork);
                return <StatusDot tone={STATE_TONE[state]} label={STATE_LABEL[state]} />;
              }}
              onOpen={setSelected}
              label="Tasks due now"
            />
            {more}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
          <DataTable
            columns={[
              {
                key: "title",
                header: "Task",
                render: (_v, row) => {
                  const t = row as unknown as Task;
                  return (
                    <button type="button" onClick={() => setSelected(t)} style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 13, ...breakAnywhere }}>{t.title}</span>
                      <span style={{ fontSize: 12, color: tokens.muted }}>Week {t.week}</span>
                    </button>
                  );
                },
              },
              {
                key: "status",
                header: "Status",
                width: "240px",
                render: (_v, row) => {
                  const t = row as unknown as Task;
                  const state = stateOf(t, day, canWork);
                  return (
                    <span style={{ display: "grid", gap: 3, justifyItems: "start" }}>
                      <StatePill label={STATE_LABEL[state]} tone={STATE_TONE[state]} />
                      {state === "waiting" && (t.humanAsk || t.blockerReason) ? <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{t.humanAsk ?? t.blockerReason}</span> : null}
                    </span>
                  );
                },
              },
              { key: "dueDay", header: "Due", width: "90px", render: (_v, row) => <span style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{dueText(row as unknown as Task) || "—"}</span> },
              { key: "issueId", header: "Issue", width: "110px", render: (v, row) => (v ? <IssueLink id={String(v)} identifier={(row as unknown as Task).issueIdentifier} /> : <span style={{ color: tokens.muted, fontSize: 12 }}>Opens on the next daily run</span>) },
            ]}
            rows={visible}
          />
          {more}
          </div>
        )}
        {warnings.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Last daily run{bundle.today.asOf ? ` (${formatShortDate(bundle.today.asOf)})` : ""}</span>
            {warnings.map((w, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, minWidth: 0 }}>
                <Info size={14} aria-hidden="true" style={{ color: w.tone === "info" ? tokens.muted : tone(w.tone).solid, marginTop: 2, flexShrink: 0 }} />
                <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <span style={{ color: w.tone === "info" ? tokens.muted : tokens.fg }}><strong style={{ fontWeight: 600 }}>{w.area}:</strong> {w.text}</span>
                  {w.tab ? (
                    <button type="button" onClick={() => onTab("integrations")} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: tokens.fg, textDecoration: "underline", width: "fit-content" }}>Details on the Integrations tab</button>
                  ) : (
                    <details style={{ fontSize: 12 }}><summary style={{ cursor: "pointer", color: tokens.muted }}>Details</summary><code style={{ display: "block", marginTop: 4, whiteSpace: "pre-wrap", ...breakAnywhere }}>{w.raw}</code></details>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {nextSteps.length ? (
          <details style={{ fontSize: 12.5 }}>
            <summary style={{ cursor: "pointer", color: tokens.muted, minHeight: 24 }}>What the SEO agent does next</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: tokens.muted, lineHeight: 1.5, listStyle: "disc" }}>
              {nextSteps.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </details>
        ) : null}
      </SectionCard>
      <SprintOverview bundle={bundle} today={today} canWork={canWork} />
      <PlanGrid bundle={bundle} canWork={canWork} onSelect={setSelected} call={call} />
      <TaskSheet task={selected} bundle={bundle} agent={agent} canWork={canWork} onClose={() => setSelected(null)} call={call} />
    </div>
  );
}

/** The sprint at a glance: day X/90, health, tasks by state, and Search Console traffic. */
function SprintOverview({ bundle, today, canWork }: { bundle: SprintBundle; today: string; canWork: boolean }) {
  const s = bundle.sprint;
  const day = Math.min(Math.max(s.day, 0), 90);
  const segments = taskSegments(bundle.tasks.filter((t) => t.source === "template" || t.week <= 13), s.day, canWork);
  const tally = tallyTasks(bundle.tasks, s.day, canWork);
  const planned = bundle.tasks.length - tally.skipped;
  const score = s.health?.score ?? null;
  const hTone = healthTone(score);
  const signals = s.health?.signals ?? [];
  const traffic = trafficSeries(bundle.traffic, today, 28);
  const tracked = bundle.keywords.filter((k) => !k.retiredAt);
  const top10 = tracked.filter((k) => (k.currentPosition ?? 999) <= 10).length;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={grid(300)}>
        <SectionCard style={top} title="Progress" subtitle={s.legacy ? "No 90-day plan yet" : `Week ${s.week} · ${s.phaseName} · ${s.plan} plan`} icon={Rocket}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <ProgressRing value={s.legacy ? 0 : day / 90} size={88} label={`Day ${day} of 90`}>
              <span style={{ display: "grid", placeItems: "center", lineHeight: 1.1 }}>
                <strong style={{ fontSize: 19, fontVariantNumeric: "tabular-nums" }}>{s.legacy ? "—" : day}</strong>
                <span style={{ fontSize: 11, color: tokens.muted }}>of 90 days</span>
              </span>
            </ProgressRing>
            <div style={{ display: "grid", gap: 8, flex: "1 1 180px", minWidth: 0 }}>
              <ProgressBar done={tally.done} total={planned} label="Tasks done" size="sm" />
              {tally.skipped ? <span style={{ fontSize: 12.5, color: tokens.muted }}>{plural(tally.skipped, "task")} not needed for this site</span> : null}
            </div>
          </div>
          <StackedBar title="Plan tasks by state" segments={segments.filter((seg) => seg.value > 0)} height={10} />
        </SectionCard>
        <SectionCard style={top} title="Health" subtitle={signals.length ? `${plural(signals.length, "signal")} from the weekly review` : "No problems found this week"} icon={HeartPulse} tone={score == null ? undefined : hTone} strip={hTone === "bad"}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <ProgressRing value={score == null ? 0 : score / 100} size={88} tone={score == null ? "neutral" : hTone} label={`Health score ${score ?? "not measured"}`}>
              <span style={{ display: "grid", placeItems: "center", lineHeight: 1.1 }}>
                <strong style={{ fontSize: 19, fontVariantNumeric: "tabular-nums", color: score == null ? tokens.muted : tone(hTone).fg }}>{score == null ? "—" : Math.round(score)}</strong>
                <span style={{ fontSize: 11, color: tokens.muted }}>score</span>
              </span>
            </ProgressRing>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 160px", minWidth: 0 }}>
              {signals.length ? signals.slice(0, 8).map((sig, i) => <StatePill key={`${sig.type}-${i}`} tone={statusTone(sig.severity)} label={sig.type.replace(/_/g, " ")} />) : <span style={{ fontSize: 12.5, color: tokens.muted }}>The weekly review (Mondays) scores traffic, rankings, links and content against the plan.</span>}
            </div>
          </div>
        </SectionCard>
      </div>
      <div style={grid(150, 10)}>
        <KpiCard label="Clicks (28 days)" value={formatCompact(traffic.totals.clicks)} icon={Eye} delta={changeText(traffic.totals.clicks, traffic.previous.clicks, "the 28 days before")} sparkline={traffic.hasData ? traffic.clicks : undefined} hint={traffic.hasData ? "Tracked keywords, Google Search Console" : "No Google Search Console data yet"} />
        <KpiCard label="Impressions (28 days)" value={formatCompact(traffic.totals.impressions)} icon={ChartLine} delta={changeText(traffic.totals.impressions, traffic.previous.impressions, "the 28 days before")} sparkline={traffic.hasData ? traffic.impressions : undefined} hint="Times the site showed in Google" />
        <KpiCard label="On Google's first page" value={`${top10} of ${tracked.length}`} icon={Target} tone={tracked.length && !top10 && s.day > 45 ? "warn" : undefined} hint={tracked.length ? "Tracked keywords in the top 10" : "No keywords yet"} />
        <KpiCard label="Live backlinks" value={bundle.backlinks.filter((b) => b.status === "live").length} icon={Share2} hint={`${bundle.backlinks.filter((b) => b.status === "submitted").length} submitted`} />
      </div>
      {traffic.hasData ? (
        <SectionCard title="Google Search Console" subtitle={`Tracked keywords, 28 days to ${traffic.end}: ${formatCompact(traffic.totals.impressions)} impressions, ${formatCompact(traffic.totals.clicks)} clicks`} icon={ChartLine}>
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

/** The 13-week plan as chips, coloured by state (engine/due.ts). */
function PlanGrid({ bundle, canWork, onSelect, call }: { bundle: SprintBundle; canWork: boolean; onSelect: (t: Task) => void; call: CallFn }) {
  const narrow = useIsNarrow();
  const day = bundle.sprint.day;
  const weekColumns = `${narrow ? 58 : 72}px minmax(0, 1fr)`;
  const weeks = Array.from({ length: 14 }, (_, w) => w);
  const extra = bundle.tasks.filter((t) => t.week > 13 || t.source !== "template");
  const counts = Object.fromEntries(CHIP_ORDER.map((k) => [k, bundle.tasks.filter((t) => stateOf(t, day, canWork) === k).length]));
  const done = bundle.tasks.filter((t) => t.status === "done").length;
  return (
    <SectionCard title="The 13-week plan" subtitle={`${done} of ${bundle.tasks.length} tasks done · tap a task for details`} icon={ListChecks}>
      <ChartLegend items={CHIP_ORDER.filter((k) => counts[k]).map((k) => ({ label: CHIP_LABEL[k], tone: CHIP_TONE[k], value: counts[k]! }))} />
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
                  {upcomingCount(items, day) > 0 && bundle.sprint.status !== "paused" ? (
                    <button
                      type="button"
                      title={bundle.sprint.pacing === "manual" ? `Start week ${w}: open its ${upcomingCount(items, day)} waiting task${upcomingCount(items, day) === 1 ? "" : "s"} for the agent, one after another` : `Open the ${upcomingCount(items, day)} upcoming task${upcomingCount(items, day) === 1 ? "" : "s"} of week ${w} now instead of on their day`}
                      onClick={() => void call("start-tasks-now", { sprintId: bundle.sprint.sprintId, week: w }, `Week ${w} started. The agent picks the tasks up in its next runs.`)}
                      style={{ appearance: "none", border: `1px solid ${tokens.border}`, background: "transparent", color: tokens.muted, borderRadius: 6, padding: "1px 6px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
                    >
                      Start
                    </button>
                  ) : null}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {items.map((t) => <TaskChip key={t.id} task={t} state={stateOf(t, day, canWork)} onClick={() => onSelect(t)} />)}
                </div>
              </div>
            );
          })}
          {extra.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: weekColumns, gap: narrow ? 8 : 10 }}>
              <div style={{ fontSize: 12, color: tokens.muted, paddingTop: 5 }}>Added</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {extra.map((t) => <TaskChip key={t.id} task={t} state={stateOf(t, day, canWork)} onClick={() => onSelect(t)} />)}
              </div>
            </div>
          ) : null}
        </div>
      </ScrollX>
    </SectionCard>
  );
}

/** Tasks of a plan week that have not started and whose day has not come yet (or, on manual pacing, whose week nobody started). */
function upcomingCount(items: Task[], day: number): number {
  return items.filter((t) => t.status === "not_started" && (t.held || (t.dueDay != null && t.dueDay > day))).length;
}

function TaskChip({ task, state, onClick }: { task: Task; state: TaskState; onClick: () => void }) {
  const colors = tone(STATE_TONE[state]);
  const quiet = state === "upcoming" || state === "skipped";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${task.title}: ${STATE_LABEL[state]}`}
      style={{
        appearance: "none",
        border: `1px solid ${quiet ? tokens.border : colors.border}`,
        borderLeft: `3px solid ${colors.solid}`,
        background: quiet ? "transparent" : colors.soft,
        color: quiet ? tokens.muted : tokens.fg,
        borderRadius: 8,
        padding: "5px 8px",
        minHeight: 30,
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
      {task.title}
    </button>
  );
}

function stateDetail(task: Task, bundle: SprintBundle, state: TaskState, agent: AgentState): ReactNode {
  const date = dueDateOf(bundle.sprint.startDate, task.dueDay);
  switch (state) {
    case "stuck":
      // The agent's trouble comes first (nothing runs until it is fixed); otherwise its runs stop at the workspace check.
      return !agentCanWork(agent) || !task.runsFailing
        ? `${agentTrouble(agent)}, so nobody works on this task until that is fixed.`
        : `Its runs stop before they start: ${RUNS_TROUBLE}. ${RUNS_FIX}`;
    case "waiting":
      return task.humanAsk ? `Waiting on you: ${task.humanAsk}` : task.issueStatus === "in_review" ? "Ready for your sign-off on its issue." : "Waiting on a person: see Needs you on the Integrations tab.";
    case "overdue":
      return `Due ${date ? formatDate(date) : "at the start"}: ${plural(daysLate(task, bundle.sprint.day), "day")} ago.`;
    case "done":
      return `Done${task.completedAt ? ` ${formatDate(task.completedAt)}` : ""}.`;
    case "skipped":
      return `Not needed${task.blockerReason ? `: ${task.blockerReason}` : "."}`;
    default:
      if (task.held) return `Waits for you to start week ${task.week}. Manual pacing: nothing opens until you do.`;
      return date ? `Due ${formatDate(date)}.` : "Due now.";
  }
}

function TaskSheet({ task, bundle, agent, canWork, onClose, call }: { task: Task | null; bundle: SprintBundle; agent: AgentState; canWork: boolean; onClose: () => void; call: CallFn }) {
  const nav = useHostNavigation();
  const [note, setNote] = useState("");
  if (!task) return null;
  const state = taskState(task, bundle.sprint.day, canWork);
  const open = ["not_started", "in_progress", "blocked"].includes(task.status);
  const phase = PHASE_NAMES[Math.min(Math.max(task.phase, 0), 4) as SprintPhase];
  const groups = (bundle.pageGroups ?? []).find((g) => g.taskId === task.id) ?? null;
  return (
    <Modal
      open
      title={task.title}
      description={[`Week ${task.week}`, phase, task.focus && task.focus !== phase ? task.focus : null, task.owner === "human" ? "A person's task" : "The SEO agent's task", task.autopilotEligible ? null : "needs your sign-off in safe mode"].filter(Boolean).join(" · ")}
      onClose={onClose}
      footer={open ? (
        <>
          {state === "upcoming" && task.status === "not_started" ? (
            <Button type="button" variant="secondary" onClick={() => void call("start-tasks-now", { sprintId: bundle.sprint.sprintId, taskId: task.id }, "Started. The agent picks it up in its next run.").then(onClose)}>Start now</Button>
          ) : null}
          <Button type="button" variant="secondary" disabled={!note.trim()} onClick={() => void call("skip-task", { taskId: task.id, reason: note }, "Task skipped.").then(onClose)}>Skip (reason below)</Button>
          <Button type="button" onClick={() => void call("complete-task", { taskId: task.id, summary: note.trim() || "Marked done from the SEO page." }, "Task done.").then(onClose)}>Mark done</Button>
        </>
      ) : undefined}
    >
      <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
        <div><StatePill label={STATE_LABEL[state]} tone={STATE_TONE[state]} size="md" /></div>
        <span style={{ lineHeight: 1.5, ...breakAnywhere }}>{stateDetail(task, bundle, state, agent)}</span>
        {state === "stuck" ? (
          agentCanWork(agent) && task.runsFailing
            ? <a {...nav.linkProps(projectFixPath(task.issueProjectId ? [task.issueProjectId] : []))} style={{ ...linkButton, width: "fit-content" }}>Open the project</a>
            : <a {...nav.linkProps(TEAM_SETUP_HREF)} style={{ ...linkButton, width: "fit-content" }}>Fix in Setup → Team</a>
        ) : null}
        <span>Issue: <IssueLink id={task.issueId} identifier={task.issueIdentifier} /></span>
        {groups ? (
          <span style={{ color: tokens.muted }}>
            <strong>Page groups:</strong> {groups.done} of {groups.total} done
            {groups.openIssue ? <> · open now: group {groups.openIssue.seq} (<IssueLink id={groups.openIssue.issueId} identifier={groups.openIssue.identifier} />)</> : null}. This site has more pages than one run can do well, so the task is split; it is completed after the last group.
          </span>
        ) : null}
        {task.blockerReason && state !== "skipped" ? <span style={{ color: tokens.muted }}><strong>Why:</strong> {task.blockerReason}</span> : null}
      </div>
      {open ? <Field label="Summary, or why it is skipped"><TextArea value={note} onChange={(e) => setNote(e.target.value)} /></Field> : null}
    </Modal>
  );
}

