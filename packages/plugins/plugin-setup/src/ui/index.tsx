import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { Blocks, Button, EmptyState, Field, ListChecks, Modal, Page, Pill, ProgressRing, SectionCard, Select, Tabs, Users, breakAnywhere, errorText, fluidColumns, formatDateTime, moduleAccent, tokens, tone, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { MODULES, SETUP_PLUGIN, setupLeftLabel, type ModuleKey, type SetupItem, type SetupSummary } from "../kit-setup.js";
import { planCopy, previewValue, type CopyPlan } from "../copy.js";
import { finishSetupSummary } from "../finish-issue.js";
import { guidedOrder, PHASES, entryId, type GuideEntry } from "../guide.js";
import { crmHint, effectiveModules, ORDERED_MODULES, type ModuleChoice } from "../modules.js";
import { isMemoryAction, memorySetupParams, WIKI_PLUGIN } from "../memory.js";
import { parseSetupStatus, PLUGINS_PAGE } from "../status.js";
import { guidedSteps, setupFocus, teamSummary, TEAM_ANCHOR, type TeamRoleState } from "../team.js";
import { fetchCompanies, fetchPluginConfig, runPluginAction, savePluginConfig, type CompanyLite, type PluginRecordLite } from "./api.js";
import { Card, Chip, ItemLink, Md, ModuleCard, ModuleGroup, ModuleProgressRow, ProgressBar, ProgressOverview, groupState, moduleCounts, optionalLabel, type LinkPropsFor } from "./components.js";
import { onSetupChanged, sharedRequest, useSetupData, viewsSummary, type LoadResult, type ModuleView, type SetupData } from "./data.js";
import { runMemorySetup } from "./memory-client.js";
import { GuideOwnerStep, GuideTeamStep, ownerStepNeeded, scrollToAnchor, TeamDialogs, TeamSection, useTeam, withTeamScroll, type TeamController } from "./team.js";

export { resolveModuleViews, viewsSummary } from "./data.js";
export { GuideOwnerStep, GuideTeamStep, TeamNote, TeamRoleRow, TeamSettings } from "./team.js";

type TabId = "team" | "checklist" | "modules";

function useLinkFor(): LinkPropsFor {
  const navigation = useHostNavigation();
  return (href: string) => navigation.linkProps(href);
}

function enabledViews(data: Pick<SetupData, "views">): ModuleView[] {
  return data.views.filter((view) => view.enabled);
}

/** `#module-seo` (a link to one module on the checklist) → `seo`. */
export function moduleAnchor(hash: string | null | undefined): ModuleKey | null {
  const raw = (hash ?? "").replace(/^#/, "");
  const key = raw.startsWith("module-") ? raw.slice("module-".length) : "";
  return key in MODULES ? (key as ModuleKey) : null;
}

/** The tabs the page shows, and the one it opens on: Team comes first once the modules are chosen. */
export function setupTabs(input: { firstVisit: boolean; showTeam: boolean; requested: string | null }): { ids: TabId[]; active: TabId } {
  const ids: TabId[] = input.firstVisit
    ? (input.showTeam ? ["modules", "team"] : ["modules"])
    : [...(input.showTeam ? (["team"] as TabId[]) : []), "checklist", "modules"];
  const requested = ids.find((id) => id === input.requested);
  return { ids, active: requested ?? ids[0]! };
}

/**
 * The page's count: the live checklist's summary, else (while a module is
 * still being checked) the stored one the sidebar shows.
 */
export function pageSummary(views: ModuleView[], load: Pick<LoadResult, "modules" | "summary"> | null): { summary: SetupSummary; checking: boolean } | null {
  if (!load) return null;
  const live = viewsSummary(views, load.modules);
  if (live) return { summary: live, checking: false };
  return load.summary ? { summary: load.summary, checking: true } : null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SetupPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const data = useSetupData(companyId);
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  // Links into Setup → Team also scroll there when the address does not change.
  const linkFor = withTeamScroll(useLinkFor());
  const saveModules = usePluginAction("setup.save-modules");
  const refreshIssue = usePluginAction("setup.refresh-issue");
  const [draft, setDraft] = useState<ModuleChoice | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [guided, setGuided] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Partial<Record<string, boolean>>>({});

  const saved = data.load?.modules ?? null;
  const firstVisit = !!data.load && saved === null;
  // `?section=team#team-<role>` (plugin pages link here when a role needs fixing), `?section=modules|checklist`, `#module-<key>`.
  const focus = setupFocus(location.search, location.hash);
  const focusModule = moduleAnchor(location.hash);
  // Team is step 1 once the modules are chosen; a link can open it before that.
  const teamWanted = !!data.load && (!firstVisit || focus.section === "team");
  const team = useTeam({
    companyId,
    modules: saved,
    installed: data.installed,
    ready: teamWanted,
    onChanged: (pluginKey) => void data.recheck(pluginKey),
  });
  const showTeam = teamWanted && team.roles.length > 0;
  const tabs = setupTabs({ firstVisit, showTeam, requested: focus.section ?? (focusModule ? "checklist" : null) });
  const tab = tabs.active;

  const selectTab = (id: TabId) => navigation.navigate(`/setup?section=${id}`, { replace: true });

  useEffect(() => {
    if (!data.load) return;
    setDraft(effectiveModules(data.load.modules));
  }, [data.load?.updatedAt, companyId, data.load === null]);

  // Scroll to the section or role the address names, once its rows have settled.
  const scrolledFor = useRef("");
  useEffect(() => {
    if (tab !== "team" || !showTeam || !focus.anchor) return;
    if (focus.anchor !== TEAM_ANCHOR && !team.loaded) return;
    const key = `${companyId}|${location.search}|${location.hash}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    scrollToAnchor(focus.anchor);
  }, [tab, showTeam, focus.anchor, team.loaded, location.search, location.hash, companyId]);

  // `#module-seo`: open that module on the checklist and scroll to it.
  useEffect(() => {
    if (tab !== "checklist" || !focusModule) return;
    const view = data.views.find((v) => v.module === focusModule);
    if (view) setOpenGroups((prev) => ({ ...prev, [view.pluginKey]: true }));
    scrollToAnchor(`module-${focusModule}`);
  }, [tab, focusModule, data.views.length]);

  const views = enabledViews(data);
  const counted = pageSummary(data.views, data.load);
  const teamCount = teamSummary(team.roles.map((role) => team.states[role.key]));
  const dirty = !!draft && !!data.load && JSON.stringify(draft) !== JSON.stringify(effectiveModules(saved));

  async function doSaveModules() {
    if (!draft || !companyId) return;
    setBusy("save");
    setMessage("");
    try {
      await saveModules({ modules: draft, installed: installedReport(data.installed) });
      let note = "Modules saved. The other plugins pick this up within a minute.";
      if (data.load && !data.load.settingsSaved) {
        try {
          await savePluginConfig(SETUP_PLUGIN, companyId, { weeklyIssue: true });
        } catch (error) {
          note += ` Setup settings could not be saved (${errorText(error)}). Save them once in Settings → Plugins → Setup, or the weekly Finish setup issue cannot open.`;
        }
      }
      await data.reload();
      // Team is the next step after choosing modules (the checklist when no module needs an agent).
      selectTab(firstVisit ? "team" : "checklist");
      setMessage(note);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  async function doAction(item: SetupItem, pluginKey: string) {
    if (!item.action || !companyId) return;
    const id = entryId(pluginKey, item.key);
    setBusy(id);
    setMessage("");
    try {
      let ran: string[] = [];
      if (isMemoryAction(item.action)) ran = await runMemorySetup(companyId, memorySetupParams(item.action.params));
      else await runPluginAction(item.action.plugin, item.action.key, companyId, item.action.params ?? {});
      const next = await data.recheck(pluginKey);
      const after = next?.items.find((candidate) => candidate.key === item.key);
      const summary = ran.length ? `${ran.join(". ")}. ` : "";
      setMessage(after?.status === "done" ? `${summary}Done: ${item.title}.` : `${summary}Ran "${item.action.label}". ${after ? "The check still shows it as not done — open it for details." : ""}`.trim());
    } catch (error) {
      setMessage(`${item.action.label}: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function doRefreshIssue() {
    setBusy("issue");
    try {
      const result = (await refreshIssue({ installed: installedReport(data.installed) })) as { action: string; missing?: number };
      await data.reload();
      setMessage(
        result.action === "created" ? "Opened the Finish setup issue."
          : result.action === "updated" ? "Updated the Finish setup issue."
            : result.action === "closed" ? "Everything required is done. Closed the Finish setup issue."
              : result.action === "unchanged" ? "The Finish setup issue is already up to date."
                : "Nothing required is missing, so there is no Finish setup issue.",
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  if (!companyId) {
    return <Page title="Setup" description="Open a company first." accent="setup"><EmptyState title="No company selected" /></Page>;
  }

  // One main action; copying and the weekly issue sit at the foot of the summary.
  const actions = <Button type="button" onClick={() => setGuided(true)} disabled={!data.load || firstVisit}>Start guided setup</Button>;

  const openModule = (pluginKey: string) => {
    const view = data.views.find((v) => v.pluginKey === pluginKey);
    setOpenGroups((prev) => ({ ...prev, [pluginKey]: true }));
    if (view) navigation.navigate(`/setup?section=checklist#module-${view.module}`, { replace: true });
  };

  return (
    <Page
      title="Setup"
      description="What each module still needs before its agents can run on their own."
      message={message || data.error || undefined}
      messageTone={!message && data.error ? "bad" : undefined}
      actions={actions}
      accent="setup"
    >
      {data.load && !firstVisit && counted ? (
        <SectionCard
          title="Progress"
          icon={ListChecks}
          subtitle="Required steps for the modules this company uses."
          strip={counted.summary.requiredLeft > 0}
          tone={counted.summary.requiredLeft > 0 ? "warn" : "ok"}
          footer={(
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {data.load.finishIssueId ? <a {...linkFor(`/issues/${data.load.finishIssueId}`)} style={{ display: "inline-flex", alignItems: "center", minHeight: 36, fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none", marginRight: 4 }}>Finish setup issue →</a> : null}
              <Button type="button" variant="secondary" onClick={doRefreshIssue} disabled={busy === "issue"}>{busy === "issue" ? "Updating…" : "Update issue now"}</Button>
              <Button type="button" variant="secondary" onClick={() => setCopyOpen(true)} disabled={!data.load}>Copy from another company</Button>
            </div>
          )}
        >
          <ProgressOverview
            summary={counted.summary}
            checking={counted.checking}
            compact={narrow}
            modules={views.map((view) => ({ key: view.pluginKey, module: view.module, ...moduleCounts(view.status) }))}
            onOpen={openModule}
          />
        </SectionCard>
      ) : null}

      {data.load ? (
        <Tabs
          tabs={tabs.ids.map((id) => id === "team"
            ? { id, label: "Team", icon: Users, count: teamCount.needYou || null, countTone: "bad" }
            : id === "checklist"
              ? { id, label: "Checklist", icon: ListChecks, count: counted?.summary.requiredLeft || null, countTone: "warn" }
              : { id, label: "Modules", icon: Blocks })}
          active={tab}
          onChange={(id) => selectTab(id as TabId)}
        />
      ) : null}

      {data.loading && !data.load ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p> : null}

      {tab === "team" && showTeam ? <TeamSection team={team} linkFor={linkFor} focusAnchor={focus.anchor} /> : null}

      {tab === "modules" && draft ? (
        <ModulesStep
          draft={draft}
          installed={data.installed}
          firstVisit={firstVisit}
          dirty={dirty}
          busy={busy === "save"}
          onChange={setDraft}
          onSave={doSaveModules}
          onCopy={firstVisit ? () => setCopyOpen(true) : undefined}
        />
      ) : null}

      {tab === "checklist" && data.load ? (
        firstVisit ? (
          <EmptyState
            title="Choose the modules first"
            description="Tell us what this company uses. The checklist then shows only what those modules need."
            action={<Button type="button" onClick={() => selectTab("modules")}>Choose modules</Button>}
          />
        ) : (
          <Checklist
            data={data}
            linkFor={linkFor}
            busy={busy}
            onAction={doAction}
            narrow={narrow}
            open={openGroups}
            onOpenChange={(pluginKey, open) => setOpenGroups((prev) => ({ ...prev, [pluginKey]: open }))}
            onSetAll={(open) => setOpenGroups(Object.fromEntries(views.map((view) => [view.pluginKey, open])))}
          />
        )
      ) : null}

      <GuidedSetup
        open={guided}
        data={data}
        team={team}
        linkFor={linkFor}
        busy={busy}
        onAction={doAction}
        onClose={() => setGuided(false)}
      />
      <CopySetup
        open={copyOpen}
        companyId={companyId}
        data={data}
        linkFor={linkFor}
        onClose={() => setCopyOpen(false)}
        onDone={async (text) => {
          setMessage(text);
          await data.reload();
        }}
      />
      {/* Last, so hiring from guided setup opens above it. */}
      <TeamDialogs team={team} />
    </Page>
  );
}

function installedReport(installed: Record<string, PluginRecordLite> | null) {
  return installed ? Object.fromEntries(Object.values(installed).map((p) => [p.pluginKey, { id: p.id, status: p.status }])) : undefined;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export function ModulesStep({ draft, installed, firstVisit, dirty, busy, onChange, onSave, onCopy }: {
  draft: ModuleChoice;
  installed: Record<string, PluginRecordLite> | null;
  firstVisit: boolean;
  dirty: boolean;
  busy: boolean;
  onChange: (next: ModuleChoice) => void;
  onSave: () => void;
  /** First visit only (later it sits under the summary): copy another company's setup instead. */
  onCopy?: () => void;
}) {
  const hint = crmHint(draft);
  return (
    <SectionCard
      title="What does this company use?"
      icon={Blocks}
      actions={(
        <>
          {onCopy ? <Button type="button" variant="secondary" onClick={onCopy}>Copy from another company</Button> : null}
          <Button type="button" onClick={onSave} disabled={busy || (!dirty && !firstVisit)}>{busy ? "Saving…" : firstVisit ? "Save and continue" : "Save modules"}</Button>
        </>
      )}
    >
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>
        {firstVisit
          ? "Start here. Switch off what this company does not need: its menu entry, jobs and setup items go away. You can change this any time."
          : "Switched-off modules hide their menu entry, skip their jobs, and drop out of the checklist."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(260, "auto-fill"), gap: 12 }}>
        {ORDERED_MODULES.map((key) => {
          const plugins = MODULES[key].plugins as readonly string[];
          const isInstalled = installed ? plugins.every((plugin) => !!installed[plugin]) : null;
          return (
            <ModuleCard
              key={key}
              title={MODULES[key].title}
              description={MODULES[key].description}
              installed={isInstalled}
              enabled={draft[key]}
              onToggle={(next) => onChange({ ...draft, [key]: next })}
              hint={key === "crm" && hint ? hint : null}
              module={key}
            />
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Checklist: one folded line per module, the ones with steps left first
// ---------------------------------------------------------------------------

/** Modules with required steps left first, then the ones with only optional steps, then the finished ones (page order within each). */
export function checklistOrder(views: ModuleView[]): ModuleView[] {
  const rank = (view: ModuleView) => {
    if (!view.status) return 1;
    const state = groupState(view.status.items);
    return state.left ? 0 : state.optional.length ? 2 : 3;
  };
  return views.map((view, index) => ({ view, index })).sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index).map(({ view }) => view);
}

/**
 * Which module opens by itself: on a wide screen, the first one with required
 * steps left (the next thing to do). Every other module, and all of them on a
 * phone, stay one line until opened.
 */
export function groupOpenByDefault(view: ModuleView, narrow: boolean, ordered: ModuleView[] = [view]): boolean {
  if (narrow || !view.status) return false;
  const next = ordered.find((candidate) => candidate.status && groupState(candidate.status.items).left > 0);
  return next?.pluginKey === view.pluginKey;
}

function Checklist({ data, linkFor, busy, onAction, narrow, open, onOpenChange, onSetAll }: {
  data: SetupData;
  linkFor: LinkPropsFor;
  busy: string | null;
  onAction: (item: SetupItem, pluginKey: string) => void;
  narrow: boolean;
  open: Partial<Record<string, boolean>>;
  onOpenChange: (pluginKey: string, open: boolean) => void;
  onSetAll: (open: boolean) => void;
}) {
  const views = checklistOrder(enabledViews(data));
  if (views.length === 0) {
    return <EmptyState title="No modules switched on" description="Switch on at least one module on the Modules tab." />;
  }
  const isOpen = (view: ModuleView) => open[view.pluginKey] ?? groupOpenByDefault(view, narrow, views);
  const anyOpen = views.some(isOpen);
  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: tokens.muted }}>Modules with steps left come first. Open one to see its steps.</span>
        <Button type="button" variant="secondary" onClick={() => onSetAll(!anyOpen)}>{anyOpen ? "Fold all" : "Open all"}</Button>
      </div>
      {views.map((view) => (
        <ModuleChecklist
          key={view.pluginKey}
          view={view}
          checking={data.checking.has(view.pluginKey)}
          linkFor={linkFor}
          busy={busy}
          open={isOpen(view)}
          onToggle={() => onOpenChange(view.pluginKey, !isOpen(view))}
          onRecheck={() => void data.recheck(view.pluginKey)}
          onAction={(item) => onAction(item, view.pluginKey)}
        />
      ))}
    </div>
  );
}

/** Where the module's status came from, in plain words. */
export function sourceLine(view: Pick<ModuleView, "source" | "receivedAt" | "note">): string {
  if (view.source === "live") return "Checked just now.";
  if (view.source === "stored") return `Last reported ${view.receivedAt ? formatDateTime(view.receivedAt) : "earlier"}${view.note ? "; the live check did not answer" : ""}.`;
  if (view.source === "stand-in") return "The plugin could not be checked.";
  return "Checking…";
}

export function ModuleChecklist({ view, checking, linkFor, busy, open = true, onToggle, onRecheck, onAction }: {
  view: ModuleView;
  checking: boolean;
  linkFor: LinkPropsFor;
  busy: string | null;
  open?: boolean;
  onToggle?: () => void;
  onRecheck: () => void;
  onAction: (item: SetupItem) => void;
}) {
  const status = view.status;
  const footer = (
    <>
      <span style={{ minWidth: 0, ...breakAnywhere }}>
        {sourceLine(view)}
        {view.note ? (
          <details style={{ display: "inline" }}>
            <summary style={{ display: "inline", cursor: "pointer", marginLeft: 6, fontWeight: 600 }}>Details</summary>
            <span style={{ display: "block", marginTop: 4 }}>{view.note}</span>
          </details>
        ) : null}
      </span>
      <Button type="button" variant="secondary" onClick={onRecheck} disabled={checking}>{checking ? "Checking…" : "Check again"}</Button>
    </>
  );
  if (!status) {
    return (
      <section id={`module-${view.module}`} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 52, padding: "8px 12px", borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card }}>
        <strong style={{ fontSize: 14, flex: "1 1 auto" }}>{MODULES[view.module].title}</strong>
        <span style={{ fontSize: 12.5, color: tokens.muted }}>Checking…</span>
      </section>
    );
  }
  return (
    <ModuleGroup
      module={view.module}
      items={status.items}
      open={open}
      onToggle={onToggle ?? (() => undefined)}
      linkFor={linkFor}
      onAction={onAction}
      busyKey={(item) => busy === entryId(view.pluginKey, item.key)}
      footer={footer}
    />
  );
}

// ---------------------------------------------------------------------------
// Guided mode
// ---------------------------------------------------------------------------

function GuidedSetup({ open, data, team, linkFor, busy, onAction, onClose }: {
  open: boolean;
  data: SetupData;
  team: TeamController;
  linkFor: LinkPropsFor;
  busy: string | null;
  onAction: (item: SetupItem, pluginKey: string) => void;
  onClose: () => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const views = enabledViews(data);
  const states = views.map((view) => ({ module: view.module, pluginKey: view.pluginKey, status: view.status }));
  // Step 1 is the team: missing required roles (and who gets the daily brief), then the checklist.
  const steps = guidedSteps({
    team: team.roles.map((role) => team.states[role.key]).filter((state): state is TeamRoleState => !!state),
    ownerNeeded: ownerStepNeeded(team),
    items: guidedOrder(states, skipped),
    skipped,
  });
  const teamPending = team.roles.length > 0 && !team.loaded;
  const counted = pageSummary(data.views, data.load);
  const summary = counted?.summary ?? { requiredDone: 0, requiredTotal: 0, requiredLeft: 0, optionalLeft: 0 };
  const step = teamPending ? undefined : steps[0];
  const current: GuideEntry | undefined = step?.kind === "item" ? step.entry : undefined;
  const checking = current ? data.checking.has(current.pluginKey) : false;
  // A link into Setup → Team closes the guide, so the Team row is in view.
  const guideLinkFor = withTeamScroll(linkFor, onClose);
  const skip = (id: string) => {
    setNote("");
    setSkipped(new Set([...skipped, id]));
  };

  useEffect(() => {
    if (open) {
      setSkipped(new Set());
      setNote("");
    }
  }, [open]);

  async function checkAgain() {
    if (!current) return;
    setNote("");
    const next = await data.recheck(current.pluginKey);
    const after = next?.items.find((item) => item.key === current.item.key);
    if (after && after.status !== "done") setNote("Still not done. Check the steps, or skip it for now.");
  }

  return (
    <Modal open={open} title="Guided setup" description="One step at a time: the team first, then settings, keys and connections, agents, and first data." onClose={onClose}>
      <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", minWidth: 0 }}>
          <ProgressRing done={summary.requiredDone} total={summary.requiredTotal} size={56} thickness={10} label="Required setup steps done" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <ProgressBar done={summary.requiredDone} total={summary.requiredTotal} label={`${teamPending ? "…" : setupLeftLabel(summary.requiredLeft)}${skipped.size ? ` · ${skipped.size} skipped` : ""}`} />
          </div>
        </div>
        {teamPending ? (
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Checking the team…</p>
          </Card>
        ) : step?.kind === "team" ? (
          <GuideTeamStep
            state={step.state}
            busy={team.busy[step.state.role.key] ?? null}
            note={team.notes[step.state.role.key] ?? null}
            onHire={() => void team.openHire(step.state.role.key)}
            onPick={() => void team.openPick(step.state.role.key)}
            onSkip={() => skip(step.id)}
            onDismissNote={() => team.dismissNote(step.state.role.key)}
          />
        ) : step?.kind === "owner" ? (
          <GuideOwnerStep
            users={team.users}
            me={team.me}
            ownerUserId={team.cockpit?.roles?.ownerUserId ?? null}
            busy={team.busy.settings === "owner"}
            note={team.notes.settings?.tone === "bad" ? team.notes.settings : null}
            onSave={(userId) => void team.saveOwner(userId)}
            onSkip={() => skip(step.id)}
            onDismissNote={() => team.dismissNote("settings")}
          />
        ) : current && step ? (
          <GuideStep
            entry={current}
            linkFor={guideLinkFor}
            busy={busy === current.id}
            checking={checking}
            note={note}
            onAction={() => onAction(current.item, current.pluginKey)}
            onCheck={() => void checkAgain()}
            onSkip={() => skip(step.id)}
          />
        ) : (
          <Card>
            <strong style={{ fontSize: 14 }}>{skipped.size ? "Only skipped steps are left." : "Everything required is done."}</strong>
            <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
              {skipped.size ? "They stay on the checklist and on the weekly Finish setup issue." : "The agents can now run on their own for the modules you use."}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {skipped.size ? <Button type="button" variant="secondary" onClick={() => setSkipped(new Set())}>Show skipped steps</Button> : null}
              <Button type="button" onClick={onClose}>Close</Button>
            </div>
          </Card>
        )}
      </div>
    </Modal>
  );
}

export function GuideStep({ entry, linkFor, busy, checking, note, onAction, onCheck, onSkip }: {
  entry: GuideEntry;
  linkFor: LinkPropsFor;
  busy: boolean;
  checking: boolean;
  note: string;
  onAction: () => void;
  onCheck: () => void;
  onSkip: () => void;
}) {
  const item = entry.item;
  const external = item.href ? /^https?:\/\//i.test(item.href) : false;
  return (
    <Card highlight module={entry.module}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill tone="neutral" icon={moduleAccent(entry.module).icon} style={{ color: moduleAccent(entry.module).fg, background: moduleAccent(entry.module).soft, borderColor: moduleAccent(entry.module).border }}>{entry.moduleTitle}</Pill>
        {/* Step 1 is the team; the checklist phases follow. */}
        <Pill tone="info" size="md">{`Step ${(entry.phase ?? 0) + 2} · ${PHASES[entry.phase] ?? "Setup"}`}</Pill>
        {item.status === "blocked" ? <Chip tone="blocked">Waiting on another step</Chip> : null}
      </div>
      <strong style={{ fontSize: 16 }}><Md text={item.title} /></strong>
      {item.detail ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}><Md text={item.detail} linkFor={linkFor} /></p> : null}
      {item.steps?.length ? (
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>
          {item.steps.map((step, index) => <li key={index}><Md text={step} linkFor={linkFor} /></li>)}
        </ol>
      ) : null}
      {item.agentNext ? <p style={{ margin: 0, fontSize: 13 }}><span style={{ color: tokens.muted }}>Once done, the agent: </span><Md text={item.agentNext} linkFor={linkFor} /></p> : null}
      {note ? <p role="status" style={{ margin: 0, fontSize: 13 }}>{note}</p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {item.href ? (
          <a
            {...(external ? { href: item.href, target: "_blank", rel: "noreferrer" } : linkFor(item.href))}
            style={{ display: "inline-flex", alignItems: "center", height: 36, padding: "0 14px", borderRadius: 9, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            {item.hrefLabel || "Open"}{external ? " ↗" : ""}
          </a>
        ) : null}
        {item.action ? <Button type="button" onClick={onAction} disabled={busy}>{busy ? "Working…" : item.action.label || "Do it for me"}</Button> : null}
        <Button type="button" variant="secondary" onClick={onCheck} disabled={checking}>{checking ? "Checking…" : "I did it — check again"}</Button>
        <Button type="button" variant="secondary" onClick={onSkip}>Skip for now</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Copy setup from another company
// ---------------------------------------------------------------------------

interface CopyRow {
  plugin: PluginRecordLite;
  module: ModuleKey;
  sourceSaved: boolean;
  plan: CopyPlan | null;
  error: string | null;
  include: boolean;
}

function CopySetup({ open, companyId, data, linkFor, onClose, onDone }: {
  open: boolean;
  companyId: string;
  data: SetupData;
  linkFor: LinkPropsFor;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [companies, setCompanies] = useState<CompanyLite[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [rows, setRows] = useState<CopyRow[] | null>(null);
  const [phase, setPhase] = useState<"pick" | "preview" | "saving" | "done">("pick");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Array<{ row: CopyRow; ok: boolean; error?: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setPhase("pick");
    setRows(null);
    setResults([]);
    setError("");
    fetchCompanies()
      .then((list) => setCompanies(list.filter((company) => company.id !== companyId)))
      .catch((err: unknown) => setError(errorText(err)));
  }, [open, companyId]);

  // Company wiki has no settings to copy: its folder, agent and routines belong to each company.
  const candidates = useMemo(() => enabledViews(data).filter((view) => view.installed && view.pluginKey !== WIKI_PLUGIN), [data.views]);

  async function preview() {
    if (!sourceId) return;
    setError("");
    const next: CopyRow[] = [];
    for (const view of candidates) {
      const plugin = view.installed!;
      try {
        const [source, target] = await Promise.all([fetchPluginConfig(plugin.id, sourceId), fetchPluginConfig(plugin.id, companyId)]);
        const plan = source.saved ? planCopy({ source: source.config, target: target.config, schema: plugin.schema }) : null;
        next.push({ plugin, module: view.module, sourceSaved: source.saved, plan, error: null, include: !!plan && plan.added.length > 0 });
      } catch (err) {
        next.push({ plugin, module: view.module, sourceSaved: false, plan: null, error: errorText(err), include: false });
      }
    }
    setRows(next);
    setPhase("preview");
  }

  async function save() {
    if (!rows) return;
    setPhase("saving");
    const out: Array<{ row: CopyRow; ok: boolean; error?: string }> = [];
    for (const row of rows) {
      if (!row.include || !row.plan) continue;
      try {
        await savePluginConfig(row.plugin.id, companyId, row.plan.merged);
        out.push({ row, ok: true });
      } catch (err) {
        out.push({ row, ok: false, error: errorText(err) });
      }
    }
    setResults(out);
    setPhase("done");
    const copied = out.filter((result) => result.ok).length;
    await onDone(copied ? `Copied settings for ${copied} ${copied === 1 ? "plugin" : "plugins"}. Re-pick the secrets listed in the copy dialog.` : "Nothing was copied.");
  }

  const sourceName = companies?.find((company) => company.id === sourceId)?.name ?? "the other company";
  const footer = phase === "pick"
    ? <Button type="button" onClick={() => void preview()} disabled={!sourceId}>Preview</Button>
    : phase === "preview"
      ? (
        <>
          <Button type="button" variant="secondary" onClick={() => setPhase("pick")}>Back</Button>
          <Button type="button" onClick={() => void save()} disabled={!rows?.some((row) => row.include)}>Copy settings</Button>
        </>
      )
      : phase === "saving" ? <Button type="button" disabled>Copying…</Button> : <Button type="button" onClick={onClose}>Close</Button>;

  return (
    <Modal
      open={open}
      title="Copy setup from another company"
      description="Copies plugin settings this company does not have yet. Nothing it already has is overwritten. Secrets and company-specific ids are never copied."
      onClose={onClose}
      footer={footer}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {error ? <p role="status" style={{ margin: 0, fontSize: 13 }}>{error}</p> : null}
        {phase === "pick" ? (
          <Field label="Copy from">
            <Select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">{companies ? (companies.length ? "Choose a company" : "No other companies") : "Loading…"}</option>
              {(companies ?? []).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {phase === "preview" && rows ? (
          rows.length === 0 ? <p style={{ margin: 0, fontSize: 13 }}>No installed modules are switched on.</p> : (
            <div style={{ display: "grid", gap: 10 }}>
              <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>From {sourceName}:</p>
              {rows.map((row, index) => (
                <CopyPreview
                  key={row.plugin.pluginKey}
                  row={row}
                  onToggle={(include) => setRows(rows.map((other, j) => (j === index ? { ...other, include } : other)))}
                />
              ))}
            </div>
          )
        ) : null}
        {phase === "done" ? (
          <div style={{ display: "grid", gap: 10 }}>
            {results.length === 0 ? <p style={{ margin: 0, fontSize: 13 }}>Nothing was selected.</p> : null}
            {results.map(({ row, ok, error: failed }) => (
              <Card key={row.plugin.pluginKey}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13.5 }}>{MODULES[row.module].title}</strong>
                  <Chip tone={ok ? "done" : "missing"}>{ok ? "Copied" : "Failed"}</Chip>
                  <span style={{ flex: 1 }} />
                  <ItemLink href={`${PLUGINS_PAGE}/${row.plugin.id}`} label="Open settings" linkFor={linkFor} />
                </div>
                {failed ? <p style={{ margin: 0, fontSize: 12.5 }}>{failed}</p> : null}
                {ok && row.plan?.secretsToPick.length ? (
                  <p style={{ margin: 0, fontSize: 12.5 }}>Pick these secrets for this company: {row.plan.secretsToPick.map((field) => field.title).join(", ")}.</p>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function CopyPreview({ row, onToggle }: { row: CopyRow; onToggle: (include: boolean) => void }) {
  const plan = row.plan;
  const secrets = plan?.removed.filter((entry) => entry.reason === "secret") ?? [];
  const ids = plan?.removed.filter((entry) => entry.reason === "company-id") ?? [];
  let body: ReactNode;
  if (row.error) body = <p style={{ margin: 0, fontSize: 12.5 }}>{row.error}</p>;
  else if (!row.sourceSaved || !plan) body = <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>No saved settings there.</p>;
  else if (plan.added.length === 0) body = <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Nothing new: this company already has these settings.</p>;
  else {
    body = (
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
        {plan.added.map((entry) => <li key={entry.path} style={breakAnywhere}><code>{entry.path}</code> = {previewValue(entry.value)}</li>)}
      </ul>
    );
  }
  return (
    <Card highlight={row.include}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, fontWeight: 600 }}>
        <input type="checkbox" checked={row.include} disabled={!plan || plan.added.length === 0} onChange={(event) => onToggle(event.target.checked)} />
        {MODULES[row.module].title}
        {plan && plan.added.length ? <Chip>{plan.added.length} to copy</Chip> : null}
      </label>
      {body}
      {secrets.length ? <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Not copied (secrets): {secrets.map((entry) => entry.path).join(", ")}</p> : null}
      {ids.length ? <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Not copied (ids from the other company): {ids.map((entry) => entry.path).join(", ")}</p> : null}
      {plan?.secretsToPick.length ? <p style={{ margin: 0, fontSize: 12 }}>Pick afterwards: {plan.secretsToPick.map((field) => field.title).join(", ")}</p> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

export function SetupProgressWidget({ context }: PluginWidgetProps) {
  // The stored statuses (no live checks on the dashboard): the same count as the sidebar.
  const data = useSetupData(context.companyId, { live: false });
  const linkFor = useLinkFor();
  if (!context.companyId || !data.load) return null;
  return <SetupProgressCard data={data} linkFor={linkFor} />;
}

export function SetupProgressCard({ data, linkFor }: { data: Pick<SetupData, "load" | "views">; linkFor: LinkPropsFor }) {
  const load = data.load;
  if (!load) return null;
  const views = data.views.filter((view) => view.enabled);
  const counted = pageSummary(data.views, load);
  const summary = counted?.summary ?? null;
  if (load.modules !== null && summary && summary.requiredLeft === 0) return null;
  const accent = moduleAccent("setup");
  const unfinished = views.filter((view) => view.status && groupState(view.status.items).left > 0);
  const optional = summary ? optionalLabel(summary.optionalLeft) : null;
  return (
    <div style={{ position: "relative", display: "grid", gap: 12, padding: 16, borderRadius: 14, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg, minWidth: 0 }}>
      <span aria-hidden="true" style={{ position: "absolute", top: -1, left: -1, right: -1, height: 3, borderRadius: "14px 14px 0 0", background: accent.solid }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, display: "inline-grid", placeItems: "center", background: accent.soft, boxShadow: `inset 0 0 0 1px ${accent.border}` }}>
            <ListChecks size={15} color={accent.solid} strokeWidth={2} />
          </span>
          <strong style={{ fontSize: 14 }}>Setup progress</strong>
        </span>
        <a {...linkFor("/setup")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>
          {load.modules === null ? "Start setup →" : "Continue setup →"}
        </a>
      </div>
      {load.modules === null || !summary ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Choose the modules this company uses, then work through what each still needs.</p>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <ProgressRing done={summary.requiredDone} total={summary.requiredTotal} size={64} thickness={10} label="Required setup steps done" color={summary.requiredLeft === 0 ? tone("ok").solid : accent.solid} />
          <div style={{ display: "grid", gap: 8, flex: "1 1 200px", minWidth: 0 }}>
            <span style={{ fontSize: 13 }}>
              <strong>{setupLeftLabel(summary.requiredLeft)}</strong>
              <span style={{ color: tokens.muted }}> · {summary.requiredDone} of {summary.requiredTotal} required done{optional ? ` · ${optional}` : ""}</span>
            </span>
            {unfinished.slice(0, 4).map((view) => <ModuleProgressRow key={view.pluginKey} module={view.module} {...moduleCounts(view.status)} />)}
            {unfinished.length > 4 ? <span style={{ fontSize: 12, color: tokens.muted }}>And {unfinished.length - 4} more modules.</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** The badge's number: the worker's count, or the same count worked out from what `setup.load` returned (older workers). */
export function sidebarLeft(result: Partial<LoadResult> | null | undefined): number | null {
  if (!result?.modules) return null;
  if (result.summary && typeof result.summary.requiredLeft === "number") return result.summary.requiredLeft;
  const statuses = Object.fromEntries(Object.entries(result.statuses ?? {}).map(([key, row]) => [key, parseSetupStatus((row as { status?: unknown })?.status, key)]));
  return finishSetupSummary({ modules: result.modules, statuses, installed: result.installed ?? null }).requiredLeft;
}

export function SetupSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const load = usePluginAction("setup.load");
  const [left, setLeft] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // The page reports what it checked; the badge follows at once.
  useEffect(() => onSetupChanged(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    if (!context.companyId) return;
    let live = true;
    sharedRequest(`sidebar|${context.companyId}|${tick}`, () => load({}))
      .then((raw) => {
        if (live) setLeft(sidebarLeft(raw as Partial<LoadResult>));
      })
      .catch(() => {
        if (live) setLeft(null);
      });
    return () => {
      live = false;
    };
  }, [context.companyId, tick]);
  const href = hostNavigation.resolveHref("/setup");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  // Once everything required is done, Setup leaves the sidebar (it stays one click away in the Cockpit header).
  if (left === 0 && !isActive) return null;
  const label = left ? setupLeftLabel(left) : null;
  return (
    <a
      {...hostNavigation.linkProps("/setup")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </span>
      <span className="flex-1 truncate">Setup</span>
      {label ? (
        <span
          aria-label={`Setup: ${label}`}
          style={{ minWidth: 18, height: 18, padding: "0 6px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: tokens.secondary, color: tokens.secondaryFg, whiteSpace: "nowrap" }}
        >
          {label}
        </span>
      ) : null}
    </a>
  );
}
