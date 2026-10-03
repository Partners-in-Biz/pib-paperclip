/**
 * Setup -> New company: one run that brings a company up (Q7-1, Q10-1), the team
 * template pack (Q7-5) and the memory starter pack (Q7-13).
 *
 * `NewCompanyView` and its pieces are presentational (tests render them);
 * `NewCompanySection` holds the state, calls the worker's actions and runs the
 * page's steps (`bootstrap-runner.ts` through `bootstrap-client.ts`).
 */
import { useEffect, useMemo, useState } from "react";
import { useHostContext, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CircleAlert, CircleCheck, CircleDot, Field, Hourglass, KeyRound, LoaderCircle, Modal, Package, Pill, Rocket, SectionCard, Select, Sparkles, breakAnywhere, errorText, tokens, tone, type LucideIcon, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import { BOOTSTRAP_STEPS, matureCompanyWarning, stepLabel, type BootstrapOptions, type OwnerGrant, type PlannedStep, type RunStatus, type StepStatus } from "../bootstrap.js";
import { runClientSteps } from "../bootstrap-runner.js";
import { hiringLine, type HiringPick } from "../hiring.js";
import { effectiveModules } from "../modules.js";
import { SETUP_PLUGIN, type ModuleKey, type SetupStatus } from "../kit-setup.js";
import type { starterPackView, loadNewCompany } from "../new-company.js";
import { runProfileText, assignableUser, type TeamAgent } from "../team.js";
import { loadPack, templateStaffing, type AgentLike, type AgentTemplate, type TemplateHireLike, type TemplateStaffing } from "../templates.js";
import { fetchCompanies, fetchCompanyInfo, fetchInstalledPlugins, savePluginConfig, type CompanyLite, type CompanyInfoLite, type PluginRecordLite } from "./api.js";
import { agentContext, buildRunnerEnv } from "./bootstrap-client.js";
import { Card, Md, type LinkPropsFor } from "./components.js";
import type { SetupData } from "./data.js";
import type { TeamController } from "./team.js";

export type NewCompanyState = Awaited<ReturnType<typeof loadNewCompany>>;
export type StarterPackView = Awaited<ReturnType<typeof starterPackView>>;

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 } as const;

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const STEP_TONE: Record<StepStatus, ToneInput> = { pending: "neutral", running: "info", done: "ok", skipped: "neutral", blocked: "warn", failed: "bad", needs_owner: "warn" };
const STEP_ICON: Record<StepStatus, LucideIcon> = { pending: CircleDot, running: LoaderCircle, done: CircleCheck, skipped: CircleDot, blocked: Hourglass, failed: CircleAlert, needs_owner: KeyRound };

export function StepRow({ step, busy, onRun }: { step: PlannedStep; busy?: boolean; onRun?: () => void }) {
  const canRun = step.where === "page" && !busy && (step.status === "failed" || step.status === "blocked" || step.status === "pending");
  return (
    <div data-step={step.id} data-status={step.status} style={{ display: "grid", gap: 6, padding: "10px 12px", borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={STEP_TONE[step.status]} icon={STEP_ICON[step.status]} size="sm">{busy ? "Running" : stepLabel(step.status)}</Pill>
        <strong style={{ fontSize: 13.5 }}>{step.title}</strong>
        <span style={{ flex: 1 }} />
        {canRun && onRun ? <Button type="button" variant="secondary" style={{ padding: "0 12px" }} onClick={onRun}>{step.status === "pending" ? "Run this step" : "Try again"}</Button> : null}
      </div>
      <span style={{ ...muted, ...breakAnywhere }}>{step.detail ?? step.summary}</span>
      {step.items && step.items.length ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>{step.items.length} {step.items.length === 1 ? "item" : "items"}</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, ...breakAnywhere }}>
            {step.items.map((item) => <li key={item.key}><strong>{item.label}</strong> · {stepLabel(item.status as StepStatus)}{item.detail ? `: ${item.detail}` : ""}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The one list of grants only a person can give, each with exact steps and a link. */
export function GrantList({ grants, linkFor }: { grants: OwnerGrant[]; linkFor: LinkPropsFor }) {
  if (grants.length === 0) return <p style={muted}>Nothing needs you yet. Run the setup and this list fills in.</p>;
  return (
    <ol data-testid="owner-grants" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 12 }}>
      {grants.map((grant) => (
        <li key={grant.id} style={{ fontSize: 13, lineHeight: 1.55, minWidth: 0 }}>
          <strong>{grant.title}</strong>{grant.decision ? <Pill size="sm" tone="info" style={{ marginLeft: 6 }}>a decision</Pill> : null}
          <div style={{ color: tokens.muted, ...breakAnywhere }}>{grant.why}</div>
          {grant.steps.length ? <ul style={{ margin: "4px 0 0", paddingLeft: 18, ...breakAnywhere }}>{grant.steps.map((step, index) => <li key={index}><Md text={step} linkFor={linkFor} /></li>)}</ul> : null}
          {grant.command ? <div style={{ marginTop: 4 }}><code style={{ fontSize: 12, ...breakAnywhere }}>{grant.command}</code></div> : null}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
            {grant.href ? <a {...(/^https?:/i.test(grant.href) ? { href: grant.href, target: "_blank", rel: "noreferrer" } : linkFor(grant.href))} style={{ fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>{grant.hrefLabel ?? "Open"}{/^https?:/i.test(grant.href) ? " ↗" : " →"}</a> : null}
            <span style={{ color: tokens.muted, ...breakAnywhere }}>Once done: {grant.after}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface TemplateRowState {
  state: TemplateStaffing;
  /** Who covers it: the agent that matches, or the agent that does the hiring (the CEO). */
  by: string | null;
}

/** The CEO template counts as staffed by the company's hiring agent even when that agent's title does not say CEO (a head agent such as Steve). */
export function templateRowState(template: AgentTemplate, input: { agents: readonly AgentLike[] | null; hires: readonly TemplateHireLike[]; hiring: HiringPick | null }): TemplateRowState {
  const staffing = templateStaffing(template, { agents: input.agents, hires: input.hires });
  if (staffing.state === "missing" && template.key === "ceo" && input.hiring?.agent) return { state: "staffed", by: input.hiring.agent.name };
  return { state: staffing.state, by: staffing.agent?.name ?? null };
}

const STAFFING_TONE: Record<TemplateStaffing, ToneInput> = { staffed: "ok", hiring: "info", missing: "neutral" };

export function TemplateList({ templates, rows, selected, onToggle, onPreview, busy }: {
  templates: AgentTemplate[];
  rows: Record<string, TemplateRowState>;
  selected: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
  onPreview: (key: string) => void;
  busy?: string | null;
}) {
  const byKey = new Map(templates.map((template) => [template.key, template]));
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {templates.map((template) => {
        const row = rows[template.key] ?? { state: "missing" as TemplateStaffing, by: null };
        const boss = template.reportsTo ? byKey.get(template.reportsTo)?.name ?? template.reportsTo : null;
        return (
          <div key={template.key} data-template={template.key} style={{ display: "grid", gap: 4, padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5, fontWeight: 600 }}>
                <input type="checkbox" checked={selected.has(template.key)} disabled={row.state !== "missing"} onChange={(event) => onToggle(template.key, event.target.checked)} />
                {template.name}
              </label>
              <Pill size="sm" tone={STAFFING_TONE[row.state]}>{row.state === "staffed" ? `Staffed${row.by ? `: ${row.by}` : ""}` : row.state === "hiring" ? "Hire task open" : "Not hired"}</Pill>
              <Pill size="sm">{template.group}</Pill>
              {template.provisioning !== "hire" ? <Pill size="sm" tone="info">{template.provisioning === "host" ? "built in" : "made by LLM Wiki"}</Pill> : null}
              <span style={{ flex: 1 }} />
              <Button type="button" variant="secondary" style={{ padding: "0 12px" }} disabled={busy === template.key} onClick={() => onPreview(template.key)}>{busy === template.key ? "Opening…" : "Preview hire task"}</Button>
            </div>
            <span style={{ ...muted, ...breakAnywhere }}>{template.title} · {boss ? `reports to ${boss}` : "head of the org chart"} · {runProfileText(template.runProfile)}</span>
            {template.notes.length ? (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Notes</summary>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5, ...breakAnywhere }}>{template.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function StarterPackCard({ pack, selected, onSelect, onApprove, busy, canApprove }: {
  pack: StarterPackView;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onApprove: () => void;
  busy?: boolean;
  canApprove: boolean;
}) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Memory starter pack</strong>
        <Pill size="sm" tone={pack.approved ? "ok" : "warn"}>{pack.approved ? "Approved by the owner" : "Needs owner OK"}</Pill>
        <Pill size="sm">version {pack.version}</Pill>
        {pack.importedAt ? <Pill size="sm" tone="ok">Seeded {pack.importedAt.slice(0, 10)}</Pill> : null}
      </div>
      <p style={muted}>
        {pack.facts.length} company-wide lessons about how the platform and its tools behave, taken from the live company's memory with every client, price, person and issue number left out. A new company's memory starts empty; this pack is off until the owner reads it and approves this exact version.
      </p>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Read the {pack.facts.length} facts</summary>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 6, fontSize: 12.5, lineHeight: 1.5 }}>
          {pack.facts.map((fact, index) => (
            <li key={index} style={breakAnywhere}>
              <Pill size="sm">{fact.area}</Pill> <Pill size="sm" tone={fact.pinned ? "info" : "neutral"}>{fact.pinned ? `${fact.kind}, pinned` : fact.kind}</Pill> {fact.text}
            </li>
          ))}
        </ul>
        <p style={{ ...muted, marginTop: 8 }}>{pack.excluded.length} other facts were reviewed and left out (company-specific, stale, or tied to one client). Review notes: {pack.reviewNotes.join(" ")}</p>
      </details>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button type="button" variant={pack.approved ? "secondary" : "primary"} disabled={busy || pack.approved || !canApprove} onClick={onApprove}>{pack.approved ? "Approved" : busy ? "Approving…" : "Approve this version"}</Button>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={selected} disabled={!pack.approved || !!pack.importedAt} onChange={(event) => onSelect(event.target.checked)} />
          Seed this company's memory with it
        </label>
      </div>
      {pack.approved ? <p style={muted}>Approved {pack.approvedAt ? pack.approvedAt.slice(0, 10) : ""}. The Cockpit imports company-wide facts only, skips duplicates and refuses anything that looks like a secret.</p> : <p style={muted}>The checkbox unlocks once the owner approves.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface NewCompanyViewProps {
  companyName: string;
  state: NewCompanyState | null;
  hiring: HiringPick | null;
  agents: readonly AgentLike[] | null;
  options: BootstrapOptions;
  onOptions: (next: BootstrapOptions) => void;
  sources: CompanyLite[] | null;
  running: boolean;
  busyStep: string | null;
  message: string;
  settingsSaved: boolean;
  grants: OwnerGrant[];
  linkFor: LinkPropsFor;
  onRun: () => void;
  onRunStep: (id: string) => void;
  onApprove: () => void;
  approving: boolean;
  onPreview: (key: string) => void;
  previewBusy: string | null;
  canApprove: boolean;
  onSaveSetup?: () => void;
  /** Shown before a first run on a company that already works (see `matureCompanyWarning`). */
  matureWarning?: string | null;
}

const RUN_TONE: Record<RunStatus, ToneInput> = { created: "neutral", running: "info", partial: "warn", complete: "ok" };
// "In progress" and not "Running": a run whose page was closed leaves steps unreported and says so until it is run again.
const RUN_LABEL: Record<RunStatus, string> = { created: "Not run yet", running: "In progress", partial: "Some steps need attention", complete: "Complete" };

export function NewCompanyView(props: NewCompanyViewProps) {
  const pack = loadPack();
  const { state, options } = props;
  const selected = useMemo(() => new Set(options.templates ?? pack.templates.filter((template) => template.defaultOn).map((template) => template.key)), [options.templates]);
  const rows = Object.fromEntries(pack.templates.map((template) => [template.key, templateRowState(template, { agents: props.agents, hires: state?.hires ?? [], hiring: props.hiring })]));
  const status: RunStatus = state?.status ?? "created";
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <SectionCard
        title={`Set up ${props.companyName}`}
        subtitle="One run: modules, settings, skills, hire tasks, the company wiki. It stops at what only a person can do and lists it once."
        icon={Rocket}
        accent="setup"
        actions={(
          <>
            <Pill tone={RUN_TONE[status]} dot>{RUN_LABEL[status]}</Pill>
            <Button type="button" onClick={props.onRun} disabled={props.running || !state}>{props.running ? "Running…" : status === "created" ? "Set up this company" : "Run again"}</Button>
          </>
        )}
      >
        {props.matureWarning ? (
          <div role="status" data-testid="mature-company-warning" style={{ display: "grid", gap: 4, padding: "10px 12px", borderRadius: 12, border: `1px solid ${tone("warn").border}`, background: tone("warn").soft }}>
            <strong style={{ fontSize: 13 }}>This company already works</strong>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}>{props.matureWarning}</span>
          </div>
        ) : null}
        {status === "running" && !props.running ? <p data-testid="run-interrupted" style={muted}>Some steps have not reported yet: the run is still going, or the page was closed before it finished. Press Run again to finish; it only does what is left.</p> : null}
        <p style={muted}>Safe to repeat: every step looks first and only does what is missing, so you can run it again after fixing something. Nothing here grants access, copies a secret or sends anything to a customer.</p>
        {props.message ? <p role="status" style={{ margin: 0, fontSize: 13 }}>{props.message}</p> : null}
        {!props.settingsSaved ? (
          <div role="status" data-testid="setup-settings-warning" style={{ display: "grid", gap: 6, padding: "10px 12px", borderRadius: 12, border: `1px solid ${tone("warn").border}`, background: tone("warn").soft }}>
            <strong style={{ fontSize: 13 }}>Setup's own settings are not saved for this company</strong>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}>Setup's hourly module re-send and its weekly Finish setup issue skip a company until they are saved (the host only lets a job act for a company with saved settings). The run saves them; you can also save them now.</span>
            {props.onSaveSetup ? <div><Button type="button" variant="secondary" onClick={props.onSaveSetup}>Save Setup's settings</Button></div> : null}
          </div>
        ) : null}
        {props.hiring ? (props.hiring.agent
          ? <span data-testid="hiring-line" style={muted}>{hiringLine(props.hiring)} Hire tasks go to it.</span>
          : <div role="status" data-testid="no-hiring-agent" style={{ display: "grid", gap: 4, padding: "10px 12px", borderRadius: 12, border: `1px solid ${tone("bad").border}`, background: tone("bad").soft }}>
            <strong style={{ fontSize: 13 }}>Nobody can do this company's hiring yet</strong>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}>{props.hiring.problem}</span>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}><strong>Fix:</strong> {props.hiring.fix}</span>
          </div>) : null}
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <Field label="Copy plugin settings from">
            <Select value={options.copyFromCompanyId ?? ""} onChange={(event) => props.onOptions({ ...options, copyFromCompanyId: event.target.value || null })}>
              <option value="">Nothing: use each plugin's defaults</option>
              {(props.sources ?? []).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </Select>
          </Field>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, alignSelf: "end", minHeight: 36 }}>
            <input type="checkbox" checked={options.includeOptionalRoles === true} onChange={(event) => props.onOptions({ ...options, includeOptionalRoles: event.target.checked })} />
            Also hire the optional roles (Reviewer, Payroll Clerk, sales roles)
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Steps" subtitle="What the run does, in order. A step that failed shows why and can be tried again on its own." icon={Sparkles} accent="setup">
        <div style={{ display: "grid", gap: 8 }}>
          {(state?.steps ?? BOOTSTRAP_STEPS.map((step) => ({ ...step, status: "pending" as StepStatus, detail: null, at: null, derived: false }))).map((step) => (
            <StepRow key={step.id} step={step} busy={props.busyStep === step.id} onRun={() => props.onRunStep(step.id)} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Needs you" subtitle="Everything an agent cannot do for this company, in one list. Do each once." icon={KeyRound} accent="setup" tone={props.grants.length ? "warn" : undefined}>
        <GrantList grants={props.grants} linkFor={props.linkFor} />
      </SectionCard>

      <SectionCard title="Team template pack" subtitle={`The dev team and the support agents that are not Team roles. Version ${pack.version}. Each one becomes a hire task for the CEO.`} icon={Package} accent="setup">
        <TemplateList
          templates={pack.templates}
          rows={rows}
          selected={selected}
          busy={props.previewBusy}
          onPreview={props.onPreview}
          onToggle={(key, on) => {
            const next = new Set(selected);
            if (on) next.add(key);
            else next.delete(key);
            props.onOptions({ ...options, templates: [...next] });
          }}
        />
      </SectionCard>

      {state ? <StarterPackCard pack={state.starterPack} selected={options.starterPack === true} onSelect={(on) => props.onOptions({ ...options, starterPack: on })} onApprove={props.onApprove} busy={props.approving} canApprove={props.canApprove} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section (state and calls)
// ---------------------------------------------------------------------------

export function NewCompanySection({ data, team, companyId, linkFor, onChanged }: {
  data: SetupData;
  team: TeamController;
  companyId: string;
  linkFor: LinkPropsFor;
  onChanged: () => Promise<void> | void;
}) {
  const host = useHostContext();
  const loadState = usePluginAction("setup.new-company");
  const bootstrap = usePluginAction("setup.bootstrap-company");
  const record = usePluginAction("setup.bootstrap-record");
  const startTemplateHire = usePluginAction("setup.start-template-hire");
  const templateDraft = usePluginAction("setup.template-draft");
  const starterImport = usePluginAction("setup.starter-pack-import");
  const approve = usePluginAction("setup.approve-starter-pack");
  const [state, setState] = useState<NewCompanyState | null>(null);
  const [options, setOptions] = useState<BootstrapOptions>({});
  const [sources, setSources] = useState<CompanyLite[] | null>(null);
  const [info, setInfo] = useState<CompanyInfoLite | null>(null);
  const [running, setRunning] = useState(false);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; description: string } | null>(null);
  const [message, setMessage] = useState("");
  const [confirmRun, setConfirmRun] = useState(false);

  const reload = async () => setState((await loadState({})) as NewCompanyState);
  useEffect(() => {
    setState(null);
    setMessage("");
    void reload().catch((error: unknown) => setMessage(errorText(error)));
    void fetchCompanies().then((list) => setSources(list.filter((company) => company.id !== companyId))).catch(() => setSources([]));
    void fetchCompanyInfo(companyId).then(setInfo);
  }, [companyId]);

  const me = assignableUser(host.userId);
  const modules = effectiveModules(data.load?.modules ?? null) as Record<ModuleKey, boolean>;
  const grantsNow = state?.run?.grants ?? [];
  const agentLikes: AgentLike[] | null = team.agents ? team.agents.map(toAgentLike) : null;
  const matureWarning = matureCompanyWarning({ agents: agentLikes, runStatus: state?.status ?? "created" });

  function envFor(fresh: NewCompanyState, runOptions: BootstrapOptions, installed: Record<string, PluginRecordLite> | null) {
    const statuses: Record<string, SetupStatus | null | undefined> = Object.fromEntries(data.views.filter((view) => view.status).map((view) => [view.pluginKey, view.status]));
    return buildRunnerEnv({
      companyId,
      company: { id: companyId, name: info?.name ?? host.companyPrefix ?? "this company", prefix: info?.prefix ?? host.companyPrefix ?? null },
      me,
      ownerName: null,
      modules,
      // Null when the list could not be read: the steps that need it then fail loudly instead of finding nothing to do.
      installed,
      options: { ...runOptions, ...(team.hiring?.agent ? { hiringAgentId: team.hiring.agent.id } : {}) },
      requireApproval: info?.requireApproval ?? null,
      statuses,
      starter: { approved: fresh.starterPack.approved, importedAt: fresh.starterPack.importedAt },
      hires: fresh.hires,
      actions: {
        record: (params) => record(params),
        startTemplateHire: (params) => startTemplateHire(params),
        templateDraft: (params) => templateDraft(params),
        starterPackImport: () => starterImport({}),
      },
    });
  }

  async function run(only?: string[]) {
    setRunning(!only);
    setBusyStep(only?.[0] ?? null);
    setMessage("");
    try {
      // Read the plugin list again for every run (a repeat after "could not be read" must be able to succeed); the page's own copy is the fallback.
      const installed = await fetchInstalledPlugins().catch(() => data.installed);
      const report = installed ? Object.fromEntries(Object.values(installed).map((p) => [p.pluginKey, { id: p.id, status: p.status }])) : undefined;
      if (!only) await bootstrap({ options, ...(report ? { installed: report } : {}) });
      const fresh = (await loadState({})) as NewCompanyState;
      const results = await runClientSteps(envFor(fresh, options, installed), only as never);
      await reload();
      await onChanged();
      const failed = results.filter((entry) => entry.outcome.status === "failed").length;
      const waiting = results.filter((entry) => entry.outcome.status === "blocked" || entry.outcome.status === "needs_owner").length;
      setMessage(failed ? `${failed} ${failed === 1 ? "step" : "steps"} failed: see the reason on each, fix it and run again.` : waiting ? "Done as far as an agent can go. The Needs you list is what is left." : "Done.");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setRunning(false);
      setBusyStep(null);
    }
  }

  // Setup's own jobs act only for a company whose Setup settings are saved (host rule): save them now, outside a full run.
  async function saveSetupSettings() {
    try {
      await savePluginConfig(SETUP_PLUGIN, companyId, { weeklyIssue: true });
      setMessage("Saved Setup's settings. Its hourly and weekly jobs now act for this company.");
      await onChanged();
    } catch (error) {
      setMessage(`Setup's settings could not be saved (${errorText(error)}). Save them in Settings -> Plugins -> Setup: it needs an instance admin.`);
    }
  }

  async function doApprove() {
    if (!state) return;
    setApproving(true);
    try {
      await approve({ hash: state.starterPack.hash });
      await reload();
      setMessage("Approved. Tick the box to seed this company's memory, then run again.");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setApproving(false);
    }
  }

  async function doPreview(key: string) {
    setPreviewBusy(key);
    try {
      // Only the fields matching needs: a team agent also carries its adapter settings, which must not travel in an action body.
      const draft = (await templateDraft({ key, ...agentContext(team.agents, team.hiring) })) as { title: string; description: string };
      setPreview({ title: draft.title, description: draft.description });
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setPreviewBusy(null);
    }
  }

  return (
    <>
      <NewCompanyView
        companyName={info?.name ?? "this company"}
        state={state}
        hiring={team.hiring}
        agents={agentLikes}
        options={options}
        onOptions={setOptions}
        sources={sources}
        running={running}
        busyStep={busyStep}
        message={message}
        settingsSaved={data.load?.settingsSaved ?? true}
        grants={grantsNow}
        linkFor={linkFor}
        onRun={() => (matureWarning ? setConfirmRun(true) : void run())}
        matureWarning={matureWarning}
        onRunStep={(id) => void run([id])}
        onApprove={() => void doApprove()}
        approving={approving}
        onPreview={(key) => void doPreview(key)}
        previewBusy={previewBusy}
        canApprove={!!me}
        onSaveSetup={() => void saveSetupSettings()}
      />
      <Modal
        open={confirmRun}
        title="Run the setup on a company that already works?"
        description={matureWarning ?? ""}
        onClose={() => setConfirmRun(false)}
        footer={(
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setConfirmRun(false)}>Cancel</Button>
            <Button type="button" onClick={() => { setConfirmRun(false); void run(); }}>Run it anyway</Button>
          </div>
        )}
      >
        <p style={muted}>Nothing is granted, copied or sent to a customer either way. Cancel to look at the steps first.</p>
      </Modal>
      <Modal open={!!preview} title={preview?.title ?? ""} description="This is the hire task the CEO would get. Read it; nothing is created from this view." onClose={() => setPreview(null)}>
        <pre style={{ margin: 0, maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, ...breakAnywhere }}>{preview?.description}</pre>
      </Modal>
    </>
  );
}

function toAgentLike(agent: TeamAgent): AgentLike {
  return { id: agent.id, name: agent.name, title: agent.title, role: agent.role, status: agent.status, reportsTo: agent.reportsTo ?? null, urlKey: agent.urlKey };
}
