import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Modal, Page, Section, Select, Tabs, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { MODULES, SETUP_PLUGIN, setupProgress, type ModuleKey, type SetupItem } from "../kit-setup.js";
import { planCopy, previewValue, type CopyPlan } from "../copy.js";
import { finishSetupMissing } from "../finish-issue.js";
import { guidedOrder, overallProgress, PHASES, entryId, type GuideEntry } from "../guide.js";
import { crmHint, effectiveModules, ORDERED_MODULES, type ModuleChoice } from "../modules.js";
import { parseSetupStatus, PLUGINS_PAGE } from "../status.js";
import { fetchCompanies, fetchPluginConfig, runPluginAction, savePluginConfig, type CompanyLite, type PluginRecordLite } from "./api.js";
import { Card, Chip, ItemLink, ItemRow, ModuleCard, ProgressBar, type LinkPropsFor } from "./components.js";
import { useSetupData, type ModuleView, type SetupData } from "./data.js";

export { resolveModuleViews } from "./data.js";

type TabId = "modules" | "checklist";

function useLinkFor(): LinkPropsFor {
  const navigation = useHostNavigation();
  return (href: string) => navigation.linkProps(href);
}

function enabledViews(data: SetupData): ModuleView[] {
  return data.views.filter((view) => view.enabled);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SetupPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const data = useSetupData(companyId);
  const linkFor = useLinkFor();
  const saveModules = usePluginAction("setup.save-modules");
  const refreshIssue = usePluginAction("setup.refresh-issue");
  const [tab, setTab] = useState<TabId>("checklist");
  const [draft, setDraft] = useState<ModuleChoice | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [guided, setGuided] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const saved = data.load?.modules ?? null;
  const firstVisit = !!data.load && saved === null;
  useEffect(() => {
    if (!data.load) return;
    setDraft(effectiveModules(data.load.modules));
    if (data.load.modules === null) setTab("modules");
  }, [data.load?.updatedAt, companyId, data.load === null]);

  const views = enabledViews(data);
  const statuses = views.map((view) => view.status);
  const overall = overallProgress(statuses);
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
      setTab("checklist");
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
      await runPluginAction(item.action.plugin, item.action.key, companyId, item.action.params ?? {});
      const next = await data.recheck(pluginKey);
      const after = next?.items.find((candidate) => candidate.key === item.key);
      setMessage(after?.status === "done" ? `Done: ${item.title}.` : `Ran "${item.action.label}". ${after ? "The check still shows it as not done — open it for details." : ""}`.trim());
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
    return <Page title="Setup" description="Open a company first."><EmptyState title="No company selected" /></Page>;
  }

  const actions = (
    <>
      <Button type="button" onClick={() => setGuided(true)} disabled={!data.load || firstVisit}>Start guided setup</Button>
      <Button type="button" variant="secondary" onClick={() => setCopyOpen(true)} disabled={!data.load}>Copy from another company</Button>
    </>
  );

  return (
    <Page
      title="Setup"
      description="What this company uses, and what each module still needs before its agents can run on their own."
      message={message || data.error || undefined}
      actions={actions}
    >
      {data.load && !firstVisit ? (
        <Section title="Progress" actions={(
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {data.load.finishIssueId ? <a {...linkFor(`/issues/${data.load.finishIssueId}`)} style={{ fontSize: 13, color: tokens.primary, textDecoration: "none" }}>Finish setup issue →</a> : null}
            <Button type="button" variant="secondary" onClick={doRefreshIssue} disabled={busy === "issue"}>{busy === "issue" ? "Updating…" : "Update issue now"}</Button>
          </div>
        )}>
          <ProgressBar done={overall.done} total={overall.total} label="Required items" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {views.map((view) => {
              const progress = view.status ? setupProgress(view.status.items) : null;
              return (
                <Chip key={view.pluginKey} tone={progress ? (progress.missing.length === 0 ? "done" : "missing") : "neutral"}>
                  {MODULES[view.module].title}: {progress ? `${progress.done}/${progress.total}` : "checking…"}
                </Chip>
              );
            })}
          </div>
        </Section>
      ) : null}

      <Tabs
        tabs={[{ id: "modules", label: "1. Modules" }, { id: "checklist", label: "2. Checklist" }]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
      />

      {data.loading && !data.load ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p> : null}

      {tab === "modules" && draft ? (
        <ModulesStep
          draft={draft}
          installed={data.installed}
          firstVisit={firstVisit}
          dirty={dirty}
          busy={busy === "save"}
          onChange={setDraft}
          onSave={doSaveModules}
        />
      ) : null}

      {tab === "checklist" && data.load ? (
        firstVisit ? (
          <EmptyState
            title="Choose the modules first"
            description="Tell us what this company uses. The checklist then shows only what those modules need."
            action={<Button type="button" onClick={() => setTab("modules")}>Choose modules</Button>}
          />
        ) : (
          <Checklist data={data} linkFor={linkFor} busy={busy} onAction={doAction} />
        )
      ) : null}

      <GuidedSetup
        open={guided}
        data={data}
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
    </Page>
  );
}

function installedReport(installed: Record<string, PluginRecordLite> | null) {
  return installed ? Object.fromEntries(Object.values(installed).map((p) => [p.pluginKey, { id: p.id, status: p.status }])) : undefined;
}

// ---------------------------------------------------------------------------
// Step 1: modules
// ---------------------------------------------------------------------------

export function ModulesStep({ draft, installed, firstVisit, dirty, busy, onChange, onSave }: {
  draft: ModuleChoice;
  installed: Record<string, PluginRecordLite> | null;
  firstVisit: boolean;
  dirty: boolean;
  busy: boolean;
  onChange: (next: ModuleChoice) => void;
  onSave: () => void;
}) {
  const hint = crmHint(draft);
  return (
    <Section
      title="What does this company use?"
      actions={<Button type="button" onClick={onSave} disabled={busy || (!dirty && !firstVisit)}>{busy ? "Saving…" : firstVisit ? "Save and continue" : "Save modules"}</Button>}
    >
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>
        {firstVisit
          ? "Start here. Switch off what this company does not need: its menu entry, jobs and setup items go away. You can change this any time."
          : "Switched-off modules hide their menu entry, skip their jobs, and drop out of the checklist."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
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
            />
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Step 2: checklist
// ---------------------------------------------------------------------------

function Checklist({ data, linkFor, busy, onAction }: {
  data: SetupData;
  linkFor: LinkPropsFor;
  busy: string | null;
  onAction: (item: SetupItem, pluginKey: string) => void;
}) {
  const views = enabledViews(data);
  if (views.length === 0) {
    return <EmptyState title="No modules switched on" description="Switch on at least one module in step 1." />;
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {views.map((view) => (
        <ModuleChecklist
          key={view.pluginKey}
          view={view}
          checking={data.checking.has(view.pluginKey)}
          linkFor={linkFor}
          busy={busy}
          onRecheck={() => void data.recheck(view.pluginKey)}
          onAction={(item) => onAction(item, view.pluginKey)}
        />
      ))}
    </div>
  );
}

export function ModuleChecklist({ view, checking, linkFor, busy, onRecheck, onAction }: {
  view: ModuleView;
  checking: boolean;
  linkFor: LinkPropsFor;
  busy: string | null;
  onRecheck: () => void;
  onAction: (item: SetupItem) => void;
}) {
  const status = view.status;
  const progress = status ? setupProgress(status.items) : null;
  const items = status ? [...status.items].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || Number(b.required) - Number(a.required)) : [];
  const source = view.source === "live"
    ? "Checked just now"
    : view.source === "stored"
      ? `Last reported ${view.receivedAt ? new Date(view.receivedAt).toLocaleString() : "earlier"}${view.note ? ` · live check failed: ${view.note}` : ""}`
      : view.source === "stand-in" ? "No setup check available" : "Checking…";
  return (
    <Section
      title={`${MODULES[view.module].title}${progress ? ` · ${progress.done} of ${progress.total}` : ""}`}
      actions={<Button type="button" variant="secondary" onClick={onRecheck} disabled={checking}>{checking ? "Checking…" : "Check again"}</Button>}
    >
      {progress ? <ProgressBar done={progress.done} total={progress.total} size="sm" /> : null}
      <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>{source}</p>
      {items.length === 0 && status ? <p style={{ margin: 0, fontSize: 13 }}>Nothing to set up.</p> : null}
      <div>
        {items.map((item) => (
          <ItemRow
            key={item.key}
            item={item}
            linkFor={linkFor}
            busy={busy === entryId(view.pluginKey, item.key)}
            onAction={onAction}
          />
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Guided mode
// ---------------------------------------------------------------------------

function GuidedSetup({ open, data, linkFor, busy, onAction, onClose }: {
  open: boolean;
  data: SetupData;
  linkFor: LinkPropsFor;
  busy: string | null;
  onAction: (item: SetupItem, pluginKey: string) => void;
  onClose: () => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const views = enabledViews(data);
  const states = views.map((view) => ({ module: view.module, pluginKey: view.pluginKey, status: view.status }));
  const entries = guidedOrder(states, skipped);
  const overall = overallProgress(views.map((view) => view.status));
  const current: GuideEntry | undefined = entries[0];
  const checking = current ? data.checking.has(current.pluginKey) : false;

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
    <Modal open={open} title="Guided setup" description="One missing item at a time: settings, then keys and connections, then agents, then first data." onClose={onClose}>
      <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
        <ProgressBar done={overall.done} total={overall.total} label={`${entries.length} left${skipped.size ? ` · ${skipped.size} skipped` : ""}`} />
        {current ? (
          <GuideStep
            entry={current}
            linkFor={linkFor}
            busy={busy === current.id}
            checking={checking}
            note={note}
            onAction={() => onAction(current.item, current.pluginKey)}
            onCheck={() => void checkAgain()}
            onSkip={() => {
              setNote("");
              setSkipped(new Set([...skipped, current.id]));
            }}
          />
        ) : (
          <Card>
            <strong style={{ fontSize: 14 }}>{skipped.size ? "Only skipped items are left." : "Everything required is done."}</strong>
            <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
              {skipped.size ? "They stay on the checklist and on the weekly Finish setup issue." : "The agents can now run on their own for the modules you use."}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              {skipped.size ? <Button type="button" variant="secondary" onClick={() => setSkipped(new Set())}>Show skipped items</Button> : null}
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
    <Card highlight>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Chip>{entry.moduleTitle}</Chip>
        <Chip>{PHASES[entry.phase] ?? "Setup"}</Chip>
        {item.status === "blocked" ? <Chip tone="blocked">Waiting on another item</Chip> : null}
      </div>
      <strong style={{ fontSize: 16 }}>{item.title}</strong>
      {item.detail ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>{item.detail}</p> : null}
      {item.steps?.length ? (
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
          {item.steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      ) : null}
      {item.agentNext ? <p style={{ margin: 0, fontSize: 13 }}><span style={{ color: tokens.muted }}>Once done, the agent: </span>{item.agentNext}</p> : null}
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

  const candidates = useMemo(() => enabledViews(data).filter((view) => view.installed), [data.views]);

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
        {plan.added.map((entry) => <li key={entry.path}><code>{entry.path}</code> = {previewValue(entry.value)}</li>)}
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
  const data = useSetupData(context.companyId);
  const linkFor = useLinkFor();
  if (!context.companyId || !data.load) return null;
  return <SetupProgressCard data={data} linkFor={linkFor} />;
}

export function SetupProgressCard({ data, linkFor }: { data: Pick<SetupData, "load" | "views">; linkFor: LinkPropsFor }) {
  const load = data.load;
  if (!load) return null;
  const views = data.views.filter((view) => view.enabled);
  const overall = overallProgress(views.map((view) => view.status));
  const pending = views.some((view) => !view.status);
  if (load.modules !== null && !pending && overall.total > 0 && overall.done === overall.total) return null;
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, borderRadius: 14, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <strong style={{ fontSize: 14 }}>Setup progress</strong>
        <a {...linkFor("/setup")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>
          {load.modules === null ? "Start setup →" : "Continue setup →"}
        </a>
      </div>
      {load.modules === null ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Choose the modules this company uses, then work through what each still needs.</p>
      ) : (
        <>
          <ProgressBar done={overall.done} total={overall.total} />
          <div style={{ display: "grid", gap: 6 }}>
            {views.map((view) => {
              const progress = view.status ? setupProgress(view.status.items) : null;
              return (
                <div key={view.pluginKey} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span>{MODULES[view.module].title}</span>
                  <span style={{ color: progress && progress.missing.length === 0 ? tokens.muted : tokens.fg }}>
                    {progress ? (progress.missing.length === 0 ? "Done" : `${progress.done} of ${progress.total}`) : "Checking…"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function SetupSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const load = usePluginAction("setup.load");
  const [missing, setMissing] = useState<number | null>(null);
  useEffect(() => {
    if (!context.companyId) return;
    let live = true;
    load({})
      .then((raw) => {
        if (!live) return;
        const result = raw as { modules: Partial<Record<ModuleKey, boolean>> | null; statuses: Record<string, { status: unknown }>; installed: Record<string, { id: string }> | null };
        if (!result?.modules) return setMissing(null);
        const statuses = Object.fromEntries(Object.entries(result.statuses ?? {}).map(([key, row]) => [key, parseSetupStatus(row.status, key)]));
        setMissing(finishSetupMissing({ modules: result.modules, statuses, installed: result.installed ?? null, prefix: null }).missing.length);
      })
      .catch(() => setMissing(null));
    return () => {
      live = false;
    };
  }, [context.companyId]);
  const href = hostNavigation.resolveHref("/setup");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
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
      {missing ? (
        <span
          aria-label={`${missing} setup items left`}
          style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: tokens.secondary, color: tokens.secondaryFg }}
        >
          {missing}
        </span>
      ) : null}
    </a>
  );
}
