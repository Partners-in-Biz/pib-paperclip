import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { clientScopeFromSearch, parseClientParam, type ClientRef, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { ROLE_SKILL_PURPOSE, ROLE_SKILLS, TEAM_SETUP_HREF, agentProblem, stillMissing } from "./role-skills.js";
import { useRoleSkills } from "./use-role-skills.js";
import { Button, ClientWorkspaceBar, GetStarted, Page, PageFrame, PageMessage, errorText, tokens, useIsNarrow, usePluginSetupStatus } from "@partnersinbiz/pib-plugin-ui";
import { useGroupedNav } from "@partnersinbiz/pib-plugin-ui";
import { plural } from "../engine/plain.js";
import { agentTrouble } from "../engine/due.js";
import { scopeParamValue, sprintPagePath } from "../engine/scope.js";
import { ModuleOffBanner, useModuleEnabled } from "./module.js";
import { RoutinesSwitchOn, useRoutineReports } from "./routines.js";
import { CreateSprintModal, SprintHome, StartPlanModal } from "./home.js";
import { Banner, StuckBanner, compactLink, linkButton, small } from "./parts.js";
import { SPRINT_TAB_IDS, SprintCockpit } from "./sprint.js";
import type { HireView, LoadResult, SprintSummary, TabId } from "./types.js";

function useSearch(): URLSearchParams {
  const location = useHostLocation();
  return useMemo(() => new URLSearchParams(location.search), [location.search]);
}

/** `?client=company:<id>` / `contact:<id>` opens a client's workspace; no param is the SEO home. */
function useScope(): ClientScope {
  const location = useHostLocation();
  return useMemo(() => clientScopeFromSearch(location.search), [location.search]);
}

// ---------------------------------------------------------------------------
// SEO agent: staffed in Setup → Team; this page only shows what is wrong
// ---------------------------------------------------------------------------

/**
 * The SEO agent box (the SEO home only). Nothing while the agent is fine; one
 * line and "Fix in Setup" when there is no agent, a hire is open, the agent
 * is paused, in error or waiting for approval, or its skill is missing (then
 * Attach skills and Re-sync fix it here). Hiring, picking, changing and
 * removing the agent happen in Setup → Team.
 */
function SeoAgentBox({ hire, stuck, refresh, onMessage }: { hire: HireView | null; stuck: number; refresh: () => Promise<void>; onMessage: (message: string) => void }) {
  const host = useHostContext();
  const nav = useHostNavigation();
  const narrow = useIsNarrow();
  const resync = usePluginAction("seo.activate-agent");
  const [resyncing, setResyncing] = useState(false);
  const agent = hire?.agent ?? null;
  const skills = useRoleSkills({ companyId: host.companyId, agent, skills: ROLE_SKILLS, purpose: ROLE_SKILL_PURPOSE, onAttached: () => void refresh().catch(() => undefined) });
  if (!hire) return null;
  const problem = agentProblem({
    agent,
    hire: hire.hire,
    missingSkills: agent ? stillMissing({ checked: skills.checked, attached: Boolean(skills.note?.ok), attachFailed: skills.missing }) : [],
    candidates: hire.candidates.length,
  });
  if (!problem) return null;

  async function doResync() {
    setResyncing(true);
    onMessage("");
    try {
      const r = (await resync({})) as { agent: { name: string }; instructions: string[] };
      onMessage([`Re-synced ${r.agent.name}.`, ...r.instructions].join(" "));
      await refresh();
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setResyncing(false);
    }
  }

  async function doAttach() {
    onMessage("");
    const note = await skills.attach();
    if (note) onMessage(note.line);
  }

  const busy = resyncing || skills.busy;
  return (
    <Banner
      tone={problem.tone}
      action={(
        <>
          <a {...nav.linkProps(TEAM_SETUP_HREF)} style={narrow ? compactLink : linkButton}>{narrow ? "Fix" : "Fix in Setup → Team"}</a>
          {problem.skills ? (
            <>
              <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void doAttach()}>{skills.busy ? "Attaching…" : "Attach skills"}</Button>
              <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void doResync()}>{resyncing ? "Re-syncing…" : "Re-sync"}</Button>
            </>
          ) : null}
        </>
      )}
    >
      {narrow && stuck > 0 ? (
        <span><strong>{plural(stuck, "SEO task")} stuck:</strong> {agentTrouble(agent)}.</span>
      ) : (
        <span>
          {problem.text}
          {stuck > 0 ? <strong> {plural(stuck, "SEO task")} {stuck === 1 ? "is" : "are"} stuck.</strong> : null}
        </span>
      )}
    </Banner>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const RUNNING = ["pre_launch", "active", "compounding"];

export function SeoPage({ context }: PluginPageProps) {
  const load = usePluginAction("seo.load");
  const reportRoutine = usePluginAction("seo.routine-report");
  const nav = useHostNavigation();
  const search = useSearch();
  const scope = useScope();
  const scopeKey = scopeParamValue(scope) ?? "own";
  const sprintId = search.get("sprint");
  const [data, setData] = useState<LoadResult | null>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState<SprintSummary | null>(null);
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
    if (search.get("connected") === "gsc") setMessage(search.get("pick") ? "Google Search Console connected. Pick the site for this sprint below." : "Google Search Console connected.");
  }, [search]);

  /** A sprint opens in its own scope: a client's sprint in that client's workspace. */
  const openSprint = (id: string | null, target: ClientScope, tab?: TabId) => nav.navigate(sprintPagePath("/seo", id, target, tab ? { tab } : {}));
  const openSummary = (s: SprintSummary) => openSprint(s.sprintId, parseClientParam(s.client));

  // A sprint opened from the wrong workspace reopens in the one it belongs to.
  const reopenIn = (id: string, client: string | null, clientName: string | null) => {
    const tab = search.get("tab");
    setMessage(client ? `This sprint belongs to ${clientName ?? "a client"}, so it opens in that client's workspace.` : "This sprint is one of our own sites, so it opens under our own SEO.");
    nav.navigate(sprintPagePath("/seo", id, parseClientParam(client), tab ? { tab } : {}), { replace: true });
  };

  // The SEO home: "finish setting up" (the same checklist Setup shows) and the routines' real schedules.
  const [setupKey, setSetupKey] = useState(0);
  const setupStatus = usePluginSetupStatus("partnersinbiz.seo", !scope && !off ? context.companyId : null, setupKey);
  const routineRefs = !scope ? data?.routines ?? [] : [];
  const routineReports = useRoutineReports({ routines: routineRefs, report: (params) => reportRoutine(params), onReported: () => setSetupKey((k) => k + 1) });
  const wantsRoutinesOn = !scope && search.get("routines") === "on";
  const closeRoutinesPrompt = () => nav.navigate("/seo", { replace: true });

  const settings = data?.settings;
  const client = scope ? data?.client ?? null : null;
  const sprints = data?.sprints ?? [];
  // Stuck work: the agent cannot work (the agent box says why), or runs stop at the workspace check (its own banner).
  const running = sprints.filter((s) => !s.legacy && RUNNING.includes(s.status));
  const stuck = running.reduce((n, s) => n + (s.tasks?.stuck ?? 0), 0);
  const stuckRuns = running.reduce((n, s) => n + (s.tasks?.stuckRuns ?? 0), 0);
  const runsProjectIds = [...new Set(running.flatMap((s) => s.tasks?.runsProjectIds ?? []))];
  const hasSprints = sprints.length > 0;
  const newSprint = !sprintId && data && hasSprints ? (
    <Button type="button" disabled={Boolean(client && !client.known)} onClick={() => setCreating(true)}>+ New sprint</Button>
  ) : null;

  const body = off ? <ModuleOffBanner /> : (
    <>
      {/* What is wrong with the agent comes first: its work stops until it is fixed. */}
      {!scope && !sprintId ? <SeoAgentBox hire={data?.hire ?? null} stuck={stuck - stuckRuns} refresh={refresh} onMessage={setMessage} /> : null}
      {!scope && !sprintId ? <StuckBanner stuck={stuckRuns} stuckRuns={stuckRuns} runsProjectIds={runsProjectIds} agent={data?.agent ?? null} /> : null}
      {scope && !sprintId ? <StuckBanner stuck={stuck} stuckRuns={stuckRuns} runsProjectIds={runsProjectIds} agent={data?.agent ?? null} /> : null}
      {!scope && !sprintId ? <GetStarted status={setupStatus} linkFor={(href) => ({ ...nav.linkProps(href) })} moduleName="SEO" hasData={hasSprints} /> : null}
      {/* On the SEO home the setup card already lists this step. */}
      {settings && !settings.saved && (scope || sprintId || !setupStatus) ? (
        <Banner tone="warn" action={<a {...nav.linkProps("/company/settings/instance/plugins")} style={linkButton}>Open settings</a>}>
          <span><strong>SEO settings are not saved yet,</strong> so the daily and weekly SEO runs skip this company. Open Settings → Plugins → SEO and click Save once.</span>
        </Banner>
      ) : null}
      {wantsRoutinesOn && data ? (
        <RoutinesSwitchOn
          routines={routineRefs}
          infos={routineReports.infos}
          report={(params) => reportRoutine(params)}
          onClose={closeRoutinesPrompt}
          onSwitched={(infos) => {
            routineReports.setInfos(infos);
            setSetupKey((k) => k + 1);
            setMessage("SEO routines switched on: daily at 06:30 and Mondays at 07:00.");
            closeRoutinesPrompt();
            refresh().catch(() => undefined);
          }}
        />
      ) : null}
      {scope && data?.clientError ? (
        <Banner tone="warn">
          <strong>This client is not in the SEO list of CRM clients.</strong>
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
          initialTab={((search.get("tab") as TabId | null) && SPRINT_TAB_IDS.includes(search.get("tab") as TabId) ? search.get("tab") : "plan") as TabId}
          onTab={(tab) => openSprint(sprintId, scope, tab)}
          onRedirect={(target, name) => reopenIn(sprintId, target, name)}
          onMessage={setMessage}
          onChanged={refresh}
        />
      ) : (
        <SprintHome data={data} client={client} onOpen={openSummary} onCreate={() => setCreating(true)} onStartPlan={setStarting} onChanged={refresh} onMessage={setMessage} />
      )}
      {data ? (
        <CreateSprintModal
          open={creating}
          data={data}
          client={client}
          companyId={context.companyId ?? ""}
          onClose={() => setCreating(false)}
          onCreated={async (id: string, target: ClientRef | null, note: string) => {
            setCreating(false);
            await refresh();
            setMessage(note);
            openSprint(id, target);
          }}
          onError={setMessage}
        />
      ) : null}
      <StartPlanModal
        sprint={starting}
        onClose={() => setStarting(null)}
        onStarted={async (s, note) => {
          setStarting(null);
          await refresh();
          setMessage(note);
          openSummary(s);
        }}
        onError={setMessage}
      />
    </>
  );

  if (scope) {
    const header = client ? (
      <ClientWorkspaceBar
        client={{ kind: client.kind, id: client.id, name: client.name, detail: client.domain ?? client.email }}
        active="seo"
        linkProps={nav.linkProps}
        ownPath="/seo"
        actions={newSprint}
      />
    ) : off ? (
      <ClientWorkspaceBar client={{ kind: scope.kind, id: scope.id, name: "Client", detail: null }} active="seo" linkProps={nav.linkProps} ownPath="/seo" />
    ) : null;
    return (
      <PageFrame accent="seo">
        {header}
        <PageMessage message={message} />
        {body}
      </PageFrame>
    );
  }

  if (sprintId) {
    // A sprint of our own sites: the breadcrumb in the sprint header is the way back.
    return (
      <PageFrame accent="seo">
        <PageMessage message={message} />
        {body}
      </PageFrame>
    );
  }

  return (
    <Page
      title="SEO"
      description="90-day SEO plans for our sites and each client's, matched to the kind of business and worked by the SEO agent."
      message={message}
      accent="seo"
      actions={newSprint}
    >
      {body}
    </Page>
  );
}

export function SeoSidebar({ context }: PluginSidebarProps) {
  // Nothing when the company switched SEO off; shown while the check runs.
  const enabled = useModuleEnabled(context.companyId);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.seo");
  if (enabled === false || grouped !== false) return null;
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
