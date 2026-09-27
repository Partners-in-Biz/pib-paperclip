/**
 * The Cockpit's Memory tab: the facts agents learned, the briefs they got, a
 * preview of the brief for any task, and what needs cleaning up. Calls the
 * `memory.*` page actions; the pieces it shows are in memory-parts.tsx.
 *
 * Modals get stable `onClose` callbacks: the shared `Modal` refocuses its
 * first field whenever `onClose` changes, which would steal focus while typing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import {
  BookOpen,
  Button,
  EmptyState,
  Eye,
  Field,
  FileText,
  Input,
  Lightbulb,
  Modal,
  PageMessage,
  Pill,
  Select,
  TextArea,
  TriangleAlert,
  breakAnywhere,
  tokens,
  tone,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { Card, Muted, grid, type LinkPropsFor } from "./components.js";
import {
  DEFAULT_FILTERS,
  EMPTY_DRAFT,
  NEW_CLIENT,
  actionErrorText,
  addParams,
  areaLabel,
  attentionCount,
  briefTitle,
  clientLabel,
  clientOptions,
  editDraft,
  editParams,
  filtersActive,
  formatCount,
  isPinnable,
  kindLabel,
  kindTone,
  listParams,
  minExpiry,
  newClientRef,
  PAGE_SIZE,
  pageCount,
  plainMemoryMessage,
  textCheck,
  type AddDraft,
  type AddResult,
  type AgentRef,
  type BriefResult,
  type BriefRow,
  type EditDraft,
  type FactFilters,
  type FactList,
  type MemoryClient,
  type MemoryFact,
  type MemoryOverview,
  type MemoryReview,
} from "./memory-model.js";
import {
  AttentionList,
  BriefDetail,
  BriefsList,
  FactFiltersBar,
  FactsTable,
  IdDetails,
  MemoryHeader,
  Pager,
  PreviewResult,
  SmallButton,
  type AttentionHandlers,
  type FactHandlers,
  type MisfiledFactView,
} from "./memory-parts.js";

const FACTS_ID = "memory-facts";
const errorLine: CSSProperties = { margin: 0, fontSize: 12.5, color: tone("bad").fg, lineHeight: 1.45, overflowWrap: "anywhere" };

type NoteKind = "success" | "warn" | "error" | "info";

function useMemoryActions() {
  const overview = usePluginAction("memory.overview");
  const list = usePluginAction("memory.list");
  const brief = usePluginAction("memory.brief");
  const preview = usePluginAction("memory.preview");
  const add = usePluginAction("memory.add");
  const update = usePluginAction("memory.update");
  const review = usePluginAction("memory.review");
  const exportAll = usePluginAction("memory.export");
  const importAll = usePluginAction("memory.import");
  return useMemo(() => ({ overview, list, brief, preview, add, update, review, exportAll, importAll }), [overview, list, brief, preview, add, update, review, exportAll, importAll]);
}

/** Each client once (memory may know one under two refs), for the pickers. */
function sortedClients(clients: MemoryClient[]): MemoryClient[] {
  return clientOptions(clients).map((option) => ({ clientRef: option.value, clientName: option.label }));
}

interface BriefView {
  id: string;
  data: { brief: BriefRow; facts: MemoryFact[] } | null;
  error: string | null;
}

export function MemoryPanel({ agents, linkFor, settingsHref, refreshKey = 0 }: {
  /** The page's agents (names and links for briefs, facts and coverage). */
  agents: AgentRef[];
  linkFor: LinkPropsFor;
  /** Cockpit settings, where smart matching (optional) is switched on. */
  settingsHref: string;
  /** Bump to reload everything (the page's Refresh button). */
  refreshKey?: number;
}) {
  const actions = useMemoryActions();
  const toast = usePluginToast();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [review, setReview] = useState<MemoryReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FactFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [list, setList] = useState<FactList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: ToneInput } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemoryFact | null>(null);
  const [superseding, setSuperseding] = useState<MemoryFact | null>(null);
  const [briefView, setBriefView] = useState<BriefView | null>(null);
  const seq = useRef({ overview: 0, review: 0, list: 0 });
  // A client known under several refs is filtered on all of them.
  const clientsRef = useRef<MemoryClient[]>([]);
  clientsRef.current = overview?.clients ?? [];
  const importInput = useRef<HTMLInputElement | null>(null);
  const now = new Date();

  /** A toast for the result of a row action (the row may be far down the page); a status line when toasts are unavailable. */
  const notify = useCallback((title: string, kind: NoteKind, body?: string) => {
    let shown: string | null = null;
    try {
      shown = toast({ title, body, tone: kind, ttlMs: kind === "error" ? 9000 : 5000 });
    } catch {
      shown = null;
    }
    setNote(shown ? null : { text: body ? `${title}: ${body}` : title, tone: kind === "error" ? "bad" : kind === "success" ? "ok" : kind });
  }, [toast]);

  const loadOverview = useCallback(async () => {
    const mine = ++seq.current.overview;
    try {
      const data = (await actions.overview({})) as MemoryOverview;
      if (mine !== seq.current.overview) return;
      setOverview(data);
      setOverviewError(null);
    } catch (error) {
      if (mine === seq.current.overview) setOverviewError(actionErrorText(error));
    }
  }, [actions]);

  const loadReview = useCallback(async () => {
    const mine = ++seq.current.review;
    try {
      const data = (await actions.review({})) as MemoryReview;
      if (mine !== seq.current.review) return;
      setReview(data);
      setReviewError(null);
    } catch (error) {
      if (mine === seq.current.review) setReviewError(actionErrorText(error));
    }
  }, [actions]);

  const loadList = useCallback(async () => {
    const mine = ++seq.current.list;
    setListLoading(true);
    try {
      const data = (await actions.list(listParams(filters, page, PAGE_SIZE, clientsRef.current))) as FactList | null;
      if (mine !== seq.current.list) return;
      setList({ facts: Array.isArray(data?.facts) ? data.facts : [], total: Number(data?.total) || 0 });
      setListError(null);
    } catch (error) {
      if (mine === seq.current.list) setListError(actionErrorText(error));
    } finally {
      if (mine === seq.current.list) setListLoading(false);
    }
  }, [actions, filters, page]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadReview(), loadList()]);
  }, [loadOverview, loadReview, loadList]);

  useEffect(() => {
    void loadOverview();
    void loadReview();
  }, [loadOverview, loadReview, refreshKey]);

  useEffect(() => {
    void loadList();
  }, [loadList, refreshKey]);

  // A shorter list (after archiving the last row of the last page) moves back a page.
  useEffect(() => {
    if (list && page > 0 && page >= pageCount(list.total)) setPage(pageCount(list.total) - 1);
  }, [list, page]);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const q = search.trim();
    if (q === filters.q) return;
    const timer = setTimeout(() => {
      setFilters((f) => ({ ...f, q }));
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, filters.q]);

  const changeFilters = useCallback((patch: Partial<FactFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setSearch("");
    setPage(0);
  }, []);

  /** `memory.update`, then a toast with the action's message (or its error) and a reload. */
  const runUpdate = useCallback(async (key: string, params: Record<string, unknown>, done: string, failed: string) => {
    setBusy(key);
    try {
      const result = (await actions.update(params)) as { message?: unknown } | null;
      notify(done, "success", plainMemoryMessage(result?.message));
      await reloadAll();
    } catch (error) {
      notify(failed, "error", actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [actions, notify, reloadAll]);

  const factHandlers = useMemo<FactHandlers>(() => ({
    onEdit: (fact) => setEditing(fact),
    onPin: (fact, pinned) => void runUpdate(fact.id, { id: fact.id, pinned }, pinned ? "Pinned" : "Unpinned", pinned ? "Could not pin" : "Could not unpin"),
    onStatus: (fact, status) => void runUpdate(fact.id, { id: fact.id, status }, status === "archived" ? "Archived" : "Restored", status === "archived" ? "Could not archive" : "Could not restore"),
    onSupersede: (fact) => setSuperseding(fact),
  }), [runUpdate]);

  /** Saves a company-wide fact again for the client it names (the old one is superseded), then reloads. */
  const moveToClient = useCallback(async (fact: MisfiledFactView, key: string) => {
    setBusy(key);
    try {
      const result = (await actions.add({ text: fact.text, client: fact.clientRef, clientName: fact.clientName, area: fact.area, kind: fact.kind, supersedes: fact.id })) as AddResult;
      notify(`Moved to ${fact.clientName}`, "success", plainMemoryMessage(result?.message));
      await reloadAll();
    } catch (error) {
      notify("Could not move the fact", "error", actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [actions, notify, reloadAll]);

  const attentionHandlers = useMemo<AttentionHandlers>(() => ({
    onMove: (fact, key) => void moveToClient(fact, key),
    onKeep: (keepId, dropId, key) => void runUpdate(key, { id: dropId, status: "superseded", supersededBy: keepId }, "Kept the better wording", "Could not replace the other one"),
    onArchive: (id, key) => void runUpdate(key, { id, status: "archived" }, "Archived", "Could not archive"),
    onShowScope: (clientRef, area) => {
      setFilters({ ...DEFAULT_FILTERS, client: clientRef ?? "own", area });
      setSearch("");
      setPage(0);
      if (typeof document !== "undefined") document.getElementById(FACTS_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  }), [runUpdate, moveToClient]);

  const closeAdd = useCallback(() => setAdding(false), []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeSupersede = useCallback(() => setSuperseding(null), []);
  const closeBrief = useCallback(() => setBriefView(null), []);

  const addFact = useCallback(async (params: Record<string, unknown>) => {
    const result = (await actions.add(params)) as AddResult;
    void reloadAll();
    return result;
  }, [actions, reloadAll]);

  const replaceWithNew = useCallback(async (oldId: string, newId: string) => {
    const result = (await actions.update({ id: oldId, status: "superseded", supersededBy: newId })) as { message?: unknown } | null;
    void reloadAll();
    return plainMemoryMessage(result?.message) ?? "The old fact is replaced.";
  }, [actions, reloadAll]);

  const saveEdit = useCallback(async (params: Record<string, unknown>) => {
    const result = (await actions.update(params)) as { message?: unknown } | null;
    setEditing(null);
    notify("Saved", "success", plainMemoryMessage(result?.message));
    await reloadAll();
  }, [actions, notify, reloadAll]);

  const searchScope = useCallback(async (fact: MemoryFact, q: string) => {
    return (await actions.list({ status: "active", client: fact.clientRef ?? "own", limit: 12, ...(q ? { q } : {}) })) as FactList;
  }, [actions]);

  const confirmSupersede = useCallback(async (fact: MemoryFact, newId: string) => {
    const result = (await actions.update({ id: fact.id, status: "superseded", supersededBy: newId })) as { message?: unknown } | null;
    setSuperseding(null);
    notify("Replaced by the newer fact", "success", plainMemoryMessage(result?.message));
    await reloadAll();
  }, [actions, notify, reloadAll]);

  const openBrief = useCallback(async (id: string) => {
    setBriefView({ id, data: null, error: null });
    try {
      const data = (await actions.brief({ id })) as { brief: BriefRow; facts: MemoryFact[] };
      setBriefView((v) => (v && v.id === id ? { id, data, error: null } : v));
    } catch (error) {
      setBriefView((v) => (v && v.id === id ? { id, data: null, error: actionErrorText(error) } : v));
    }
  }, [actions]);

  const runPreview = useCallback(async (params: Record<string, unknown>) => (await actions.preview(params)) as BriefResult, [actions]);

  /** Downloads every fact as JSON (a backup that Import restores). */
  const downloadBackup = useCallback(async () => {
    setBusy("export");
    try {
      const data = await actions.exportAll({});
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `company-memory-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Memory exported", "success", "Keep the file somewhere safe; Import restores it.");
    } catch (error) {
      notify("Export failed", "error", actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [actions, notify]);

  const restoreBackup = useCallback(async (file: File) => {
    setBusy("import");
    try {
      const data = JSON.parse(await file.text()) as unknown;
      const result = (await actions.importAll({ data })) as { added: number; duplicates: number; skippedClient: number; skippedSuperseded: number; invalid: unknown[] };
      const parts = [`${result.added} added`, result.duplicates ? `${result.duplicates} already known` : null, result.skippedClient ? `${result.skippedClient} client facts skipped (another company's clients)` : null, result.invalid.length ? `${result.invalid.length} refused` : null].filter(Boolean);
      notify("Memory imported", result.invalid.length ? "warn" : "success", parts.join(", ") + ".");
      await reloadAll();
    } catch (error) {
      notify("Import failed", "error", error instanceof SyntaxError ? "That file is not valid JSON." : actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [actions, notify, reloadAll]);

  if (!overview) {
    if (overviewError) {
      return (
        <EmptyState
          tone="bad"
          icon={TriangleAlert}
          title="Memory could not load"
          description={overviewError}
          action={<Button type="button" variant="secondary" onClick={() => void reloadAll()}>Try again</Button>}
        />
      );
    }
    return <Muted>Loading memory…</Muted>;
  }

  const { stats } = overview;
  const everHadFacts = stats.facts.active + stats.facts.superseded + stats.facts.archived > 0;
  const attention = attentionCount(review);
  const briefSummary = briefView ? overview.briefs.find((b) => b.id === briefView.id) ?? null : null;
  const briefHeading = briefView?.data ? briefTitle(briefView.data.brief) : briefSummary ? briefTitle(briefSummary) : "Brief";
  const addButton = <Button type="button" onClick={() => setAdding(true)}>Add fact</Button>;
  const backupButtons = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {everHadFacts ? <SmallButton onClick={() => void downloadBackup()} disabled={busy === "export"}>{busy === "export" ? "Exporting…" : "Export"}</SmallButton> : null}
      <input ref={importInput} type="file" accept="application/json,.json" aria-label="Memory export file to import" style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void restoreBackup(file); }} />
      <SmallButton onClick={() => importInput.current?.click()} disabled={busy === "import"}>{busy === "import" ? "Importing…" : "Import"}</SmallButton>
      {everHadFacts ? addButton : null}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {note ? <PageMessage message={note.text} tone={note.tone} /> : null}
      <MemoryHeader overview={overview} agents={agents} linkFor={linkFor} settingsHref={settingsHref} />

      <Card
        title={attention ? `Needs attention (${attention})` : "Needs attention"}
        icon={TriangleAlert}
        tone={attention ? "warn" : review ? "ok" : undefined}
        strip={attention > 0}
        subtitle="Likely duplicates, facts that do not help, facts under the wrong client, and agents that skip memory."
      >
        {review ? (
          <AttentionList review={review} clients={overview.clients} agents={agents} linkFor={linkFor} limits={overview.limits} busyKey={busy} handlers={attentionHandlers} />
        ) : reviewError ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <p style={errorLine}>The review could not run: {reviewError}</p>
            <SmallButton onClick={() => void loadReview()}>Try again</SmallButton>
          </div>
        ) : (
          <Muted>Checking memory…</Muted>
        )}
      </Card>

      <Card id={FACTS_ID} title={list ? `Facts (${formatCount(list.total)})` : "Facts"} icon={BookOpen} subtitle="Pinned rules first, then the most recently changed. Export keeps a backup; Import restores one, or seeds a new company with company-wide lessons." actions={backupButtons}>
        {!everHadFacts && !filtersActive(filters) ? (
          <EmptyState
            compact
            icon={Lightbulb}
            title="No facts yet: agents add them as they learn"
            description="Agents end a closing comment with Learned: lines and each lesson is saved here automatically. You can add a fact yourself, or import a memory export."
            action={addButton}
          />
        ) : (
          <>
            <FactFiltersBar filters={filters} search={search} clients={overview.clients} areas={overview.areas} onSearch={setSearch} onChange={changeFilters} onClear={clearFilters} />
            {listError ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <p role="alert" style={errorLine}>Facts could not load: {listError}</p>
                <SmallButton onClick={() => void loadList()}>Try again</SmallButton>
              </div>
            ) : null}
            {list === null ? (
              listError ? null : <Muted>Loading facts…</Muted>
            ) : list.facts.length === 0 ? (
              <Muted>{filtersActive(filters) ? "No facts match these filters." : "No active facts right now. Pick Archived or Replaced above to see older ones."}</Muted>
            ) : (
              <FactsTable facts={list.facts} clients={overview.clients} agents={agents} linkFor={linkFor} busyId={busy} handlers={factHandlers} now={now} />
            )}
            {list && list.total > 0 ? <Pager total={list.total} page={page} loading={listLoading} onPage={setPage} /> : null}
          </>
        )}
      </Card>

      <Card title="Recent briefs" icon={FileText} subtitle="The last 20 briefs agents got. Open one to see the facts it held.">
        <BriefsList briefs={overview.briefs} agents={agents} linkFor={linkFor} onOpen={(id) => void openBrief(id)} now={now} />
      </Card>

      <PreviewCard overview={overview} linkFor={linkFor} onPreview={runPreview} />

      <AddFactModal open={adding} overview={overview} onClose={closeAdd} onAdd={addFact} onReplace={replaceWithNew} />
      <EditFactModal fact={editing} overview={overview} onClose={closeEdit} onSave={saveEdit} />
      <SupersedeModal fact={superseding} clients={overview.clients} onClose={closeSupersede} onSearch={searchScope} onConfirm={confirmSupersede} />
      <Modal open={briefView !== null} title={briefHeading} onClose={closeBrief}>
        {briefView?.error ? (
          <p role="alert" style={errorLine}>{briefView.error}</p>
        ) : briefView?.data ? (
          <BriefDetail brief={briefView.data.brief} facts={briefView.data.facts} clients={overview.clients} agents={agents} linkFor={linkFor} now={now} />
        ) : (
          <Muted>Loading the brief…</Muted>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function PreviewCard({ overview, linkFor, onPreview }: { overview: MemoryOverview; linkFor: LinkPropsFor; onPreview: (params: Record<string, unknown>) => Promise<BriefResult> }) {
  const [issue, setIssue] = useState("");
  const [query, setQuery] = useState("");
  const [client, setClient] = useState("");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BriefResult | null>(null);
  const clients = useMemo(() => sortedClients(overview.clients), [overview.clients]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const params: Record<string, unknown> = {};
    if (issue.trim()) params.issueId = issue.trim();
    if (query.trim()) params.query = query.trim();
    if (!params.issueId && !params.query) {
      setError("Enter an issue (e.g. PIB-23) or a question.");
      return;
    }
    if (client) params.client = client;
    if (area) params.area = area;
    setBusy(true);
    setError("");
    try {
      setResult(await onPreview(params));
    } catch (e) {
      setResult(null);
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Preview a brief" icon={Eye} subtitle="Exactly what an agent would get for a task. Nothing is logged or counted as use.">
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <div style={grid(200, 12)}>
          <Field label="Issue">
            <Input value={issue} onChange={(event) => setIssue(event.target.value)} placeholder="PIB-23" autoComplete="off" />
          </Field>
          <Field label="Question (the focus, with an issue)">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. tone for LinkedIn posts" autoComplete="off" />
          </Field>
          <Field label="Client">
            <Select value={client} onChange={(event) => setClient(event.target.value)}>
              <option value="">Detect from the task</option>
              <option value="own">Company-wide only</option>
              {clients.map((c) => <option key={c.clientRef} value={c.clientRef}>{c.clientName}</option>)}
            </Select>
          </Field>
          <Field label="Area">
            <Select value={area} onChange={(event) => setArea(event.target.value)}>
              <option value="">From the issue</option>
              {overview.areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
            </Select>
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <Button type="submit" disabled={busy}>{busy ? "Building the brief…" : "Preview brief"}</Button>
          {result && !busy ? <SmallButton onClick={() => setResult(null)}>Clear</SmallButton> : null}
          {error ? <span role="alert" style={{ ...errorLine, flex: "1 1 200px" }}>{error}</span> : null}
        </div>
      </form>
      {result ? <PreviewResult result={result} clients={overview.clients} linkFor={linkFor} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function CharCounter({ text, limits }: { text: string; limits: MemoryOverview["limits"] }) {
  const check = textCheck(text, limits);
  const colour = check.tone === "neutral" ? tokens.muted : tone(check.tone).fg;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5, lineHeight: 1.45, marginTop: -6, minWidth: 0 }}>
      <span style={{ color: check.ok ? tokens.muted : colour, minWidth: 0 }}>{check.note || "One fact, in plain words. Never secrets, passwords, card or ID numbers."}</span>
      <span aria-live="polite" style={{ color: colour, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{check.length}/{limits.factMaxChars}</span>
    </div>
  );
}

function AddFactModal({ open, overview, onClose, onAdd, onReplace }: {
  open: boolean;
  overview: MemoryOverview;
  onClose: () => void;
  onAdd: (params: Record<string, unknown>) => Promise<AddResult>;
  /** Marks `oldId` superseded by `newId`; returns the action's message. */
  onReplace: (oldId: string, newId: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AddResult | null>(null);
  const [replaced, setReplaced] = useState<Record<string, { ok: boolean; text: string }>>({});
  const busyRef = useRef(false);
  const clients = useMemo(() => sortedClients(overview.clients), [overview.clients]);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_DRAFT);
    setError("");
    setResult(null);
    setReplaced({});
    setBusy(false);
    busyRef.current = false;
  }, [open]);

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const set = (patch: Partial<AddDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const check = textCheck(draft.text, overview.limits);
  const badRef = draft.client === NEW_CLIENT && draft.newRef.trim() !== "" && !newClientRef(draft.newRef);

  async function submit() {
    const built = addParams(draft);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      setResult(await onAdd(built.params));
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function replace(oldId: string) {
    if (!result) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const text = await onReplace(oldId, result.fact.id);
      setReplaced((r) => ({ ...r, [oldId]: { ok: true, text } }));
    } catch (e) {
      setReplaced((r) => ({ ...r, [oldId]: { ok: false, text: actionErrorText(e) } }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const resultTone = tone(result?.status === "added" ? "ok" : "warn");
  const footer = result ? (
    <>
      {result.status === "added" ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setDraft((d) => ({ ...EMPTY_DRAFT, client: d.client, newRef: d.newRef, newName: d.newName, area: d.area, kind: d.kind })); setResult(null); setReplaced({}); }}>Add another</Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setResult(null)}>Change the text</Button>
      )}
      <Button type="button" disabled={busy} onClick={close}>Done</Button>
    </>
  ) : (
    <>
      <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
      <Button type="button" disabled={busy || !check.ok || badRef} onClick={() => void submit()}>{busy ? "Saving…" : "Save fact"}</Button>
    </>
  );

  return (
    <Modal
      open={open}
      title={result ? (result.status === "added" ? "Fact saved" : "Already known") : "Add a fact"}
      description={result ? undefined : "One lasting fact that will help the next task: a preference, a fact about a client's systems, a lesson or a warning."}
      onClose={close}
      footer={footer}
    >
      {result ? (
        <>
          <p role="status" style={{ margin: 0, padding: "10px 12px", borderRadius: 12, border: `1px solid ${resultTone.border}`, background: resultTone.soft, fontSize: 13, lineHeight: 1.5, ...breakAnywhere }}>{plainMemoryMessage(result.message) ?? (result.status === "added" ? "Saved." : "Memory already has this fact.")}</p>
          <div style={{ display: "grid", gap: 4, fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>
            <span>{result.fact.text}</span>
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              <Pill size="sm" variant="outline">{clientLabel(result.fact.clientRef, result.fact.clientName, overview.clients)}</Pill>
              <Pill size="sm">{areaLabel(result.fact.area)}</Pill>
              <Pill size="sm" tone={kindTone(result.fact.kind)}>{kindLabel(result.fact.kind)}</Pill>
              {result.fact.pinned ? <Pill size="sm" tone="accent" dot>Pinned</Pill> : null}
            </span>
          </div>
          {result.similar.length ? (
            <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 650 }}>Similar facts</h3>
              {result.similar.map((s) => {
                const done = replaced[s.id];
                return (
                  <div key={s.id} style={{ display: "grid", gap: 6, padding: "8px 10px", borderRadius: 10, border: `1px solid ${s.relation === "conflict" ? tone("warn").border : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
                    <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{s.text}</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <Pill size="sm" tone={s.relation === "conflict" ? "warn" : "neutral"} dot={s.relation === "conflict"}>{s.relation === "conflict" ? "May contradict" : s.relation === "same" ? "Same" : "Similar"}</Pill>
                      {result.status === "added" && !done?.ok ? <SmallButton disabled={busy} onClick={() => void replace(s.id)}>Replace it with the new fact</SmallButton> : null}
                      {done ? <span style={{ fontSize: 12, color: done.ok ? tone("ok").fg : tone("bad").fg, ...breakAnywhere }}>{done.ok ? `Replaced. ${done.text}` : done.text}</span> : null}
                    </div>
                  </div>
                );
              })}
            </section>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Fact">
            <TextArea rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} placeholder="e.g. Northwind wants blog posts in British English, without the Oxford comma." />
          </Field>
          <CharCounter text={draft.text} limits={overview.limits} />
          <div style={grid(170, 12)}>
            <Field label="Client">
              <Select value={draft.client} onChange={(event) => set({ client: event.target.value })}>
                <option value="own">Company-wide (every task)</option>
                {clients.length ? (
                  <optgroup label="Clients">
                    {clients.map((c) => <option key={c.clientRef} value={c.clientRef}>{c.clientName}</option>)}
                  </optgroup>
                ) : null}
                <option value={NEW_CLIENT}>Another client…</option>
              </Select>
            </Field>
            <Field label="Area">
              <Select value={draft.area} onChange={(event) => set({ area: event.target.value })}>
                {overview.areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value, pinned: isPinnable(event.target.value) ? draft.pinned : false })}>
                {overview.kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </Select>
            </Field>
          </div>
          {draft.client === NEW_CLIENT ? (
            <>
              <div style={grid(200, 12)}>
                <Field label="CRM reference">
                  <Input value={draft.newRef} onChange={(event) => set({ newRef: event.target.value })} placeholder="company:<CRM id>" autoComplete="off" />
                </Field>
                <Field label="Client name">
                  <Input value={draft.newName} onChange={(event) => set({ newName: event.target.value })} placeholder="Northwind Traders" autoComplete="off" />
                </Field>
              </div>
              <span style={{ fontSize: 12, lineHeight: 1.45, color: badRef ? tone("bad").fg : tokens.muted, marginTop: -6 }}>
                {badRef ? "Use company:<id> or contact:<id>, with the id from the CRM." : "The CRM company or contact, as in the client's workspace address (?client=company:…). Briefs use the name to recognise the client in task titles."}
              </span>
            </>
          ) : null}
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45, cursor: isPinnable(draft.kind) ? "pointer" : "not-allowed", color: isPinnable(draft.kind) ? tokens.fg : tokens.muted }}>
            <input type="checkbox" checked={draft.pinned} disabled={!isPinnable(draft.kind)} onChange={(event) => set({ pinned: event.target.checked })} style={{ marginTop: 3 }} />
            <span>
              <strong>Pin it</strong>
              <span style={{ display: "block", color: tokens.muted }}>Always in this client's and area's briefs. Rules and warnings only, at most {overview.limits.pinnedMaxPerScope} per client and area.</span>
            </span>
          </label>
          <Field label="Expires (optional)">
            <Input type="date" min={minExpiry(new Date())} value={draft.expires} onChange={(event) => set({ expires: event.target.value })} />
          </Field>
          <span style={{ fontSize: 12, color: tokens.muted, marginTop: -6 }}>It stops appearing in briefs from this date, e.g. a holiday closure.</span>
          {error ? <p role="alert" style={errorLine}>{error}</p> : null}
        </>
      )}
    </Modal>
  );
}

function EditFactModal({ fact, overview, onClose, onSave }: {
  fact: MemoryFact | null;
  overview: MemoryOverview;
  onClose: () => void;
  /** Throws with the action's error; the modal shows it. */
  onSave: (params: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    setDraft(fact ? editDraft(fact) : null);
    setError("");
    setBusy(false);
    busyRef.current = false;
  }, [fact]);

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const params = fact && draft ? editParams(fact, draft) : null;
  const textOk = draft ? textCheck(draft.text, overview.limits).ok : false;
  const canSave = Boolean(params) && !busy && (!params || !("text" in params) || textOk);

  async function save() {
    if (!fact || !draft) return;
    const changes = editParams(fact, draft);
    if (!changes) {
      onClose();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(changes);
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const description = fact ? [clientLabel(fact.clientRef, fact.clientName, overview.clients), fact.sourceIdentifier ? `from ${fact.sourceIdentifier}` : null].filter(Boolean).join(" · ") : undefined;

  return (
    <Modal
      open={fact !== null && draft !== null}
      title="Edit fact"
      description={description}
      onClose={close}
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button>
        </>
      )}
    >
      {fact && draft ? (
        <>
          <Field label="Fact">
            <TextArea rows={3} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          </Field>
          <CharCounter text={draft.text} limits={overview.limits} />
          <div style={grid(160, 12)}>
            <Field label="Kind">
              <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
                {overview.kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </Select>
            </Field>
            <Field label="Area">
              <Select value={draft.area} onChange={(event) => setDraft({ ...draft, area: event.target.value })}>
                {overview.areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
              </Select>
            </Field>
          </div>
          {fact.pinned && !isPinnable(draft.kind) ? <p style={{ margin: 0, fontSize: 12.5, color: tone("warn").fg }}>Only rules and warnings can be pinned, so saving unpins it.</p> : null}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", minWidth: 0 }}>
            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
              <Field label="Expires (optional)">
                <Input type="date" min={minExpiry(new Date())} value={draft.expires} onChange={(event) => setDraft({ ...draft, expires: event.target.value })} />
              </Field>
            </div>
            {draft.expires ? <SmallButton onClick={() => setDraft({ ...draft, expires: "" })} style={{ height: 36 }}>No expiry</SmallButton> : null}
          </div>
          <span style={{ fontSize: 12, color: tokens.muted, marginTop: -6 }}>It stops appearing in briefs from this date.</span>
          {error ? <p role="alert" style={errorLine}>{error}</p> : null}
          <IdDetails lines={[`Fact: ${fact.id}`, fact.supersededBy ? `Replaced by: ${fact.supersededBy}` : null, fact.supersedes ? `Replaces: ${fact.supersedes}` : null]} />
        </>
      ) : null}
    </Modal>
  );
}

function SupersedeModal({ fact, clients, onClose, onSearch, onConfirm }: {
  fact: MemoryFact | null;
  clients: MemoryClient[];
  onClose: () => void;
  /** Active facts in the fact's client scope matching `q`. */
  onSearch: (fact: MemoryFact, q: string) => Promise<FactList>;
  /** Throws with the action's error; the modal shows it. */
  onConfirm: (fact: MemoryFact, newId: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<MemoryFact[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    setQ("");
    setCandidates(null);
    setSearchError("");
    setPicked("");
    setTyped("");
    setError("");
    setBusy(false);
    busyRef.current = false;
  }, [fact]);

  useEffect(() => {
    if (!fact) return;
    const mine = ++seq.current;
    const query = q.trim();
    const timer = setTimeout(() => {
      onSearch(fact, query)
        .then((res) => {
          if (mine !== seq.current) return;
          setCandidates((Array.isArray(res?.facts) ? res.facts : []).filter((f) => f.id !== fact.id));
          setSearchError("");
        })
        .catch((e: unknown) => {
          if (mine === seq.current) setSearchError(actionErrorText(e));
        });
    }, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [fact, q, onSearch]);

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const target = typed.trim() || picked;

  async function confirm() {
    if (!fact || !target) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm(fact, target);
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const accent = tone("accent");
  return (
    <Modal
      open={fact !== null}
      title="Replaced by a newer fact"
      description="Pick the newer fact that replaces this one. The old fact stops appearing in briefs and stays in the list as replaced."
      onClose={close}
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
          <Button type="button" disabled={!target || busy} onClick={() => void confirm()}>{busy ? "Saving…" : "Mark superseded"}</Button>
        </>
      )}
    >
      {fact ? (
        <>
          <div style={{ padding: "10px 12px", borderRadius: 10, background: tokens.secondary, fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>
            {fact.text}
          </div>
          <Field label={`Find the newer fact (${clientLabel(fact.clientRef, fact.clientName, clients)})`}>
            <Input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search active facts" autoComplete="off" />
          </Field>
          {searchError ? (
            <p role="alert" style={errorLine}>{searchError}</p>
          ) : candidates === null ? (
            <Muted>Loading facts…</Muted>
          ) : candidates.length === 0 ? (
            <Muted>{q.trim() ? "No active fact matches." : "No other active facts for this client."} Add the newer fact first.</Muted>
          ) : (
            <div role="radiogroup" aria-label="Newer fact" style={{ display: "grid", gap: 6, maxHeight: 280, overflowY: "auto", overscrollBehavior: "contain", minWidth: 0 }}>
              {candidates.map((c) => {
                const selected = picked === c.id && !typed.trim();
                return (
                  <label key={c.id} style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", gap: 8, alignItems: "start", padding: "8px 10px", borderRadius: 10, border: `1px solid ${selected ? accent.border : tokens.border}`, background: selected ? accent.soft : tokens.bg, cursor: "pointer", minWidth: 0 }}>
                    <input type="radio" name="superseded-by" value={c.id} checked={selected} onChange={() => { setPicked(c.id); setTyped(""); }} style={{ marginTop: 3 }} />
                    <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
                      <span style={{ fontSize: 13, lineHeight: 1.45, ...breakAnywhere }}>{c.text}</span>
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        <Pill size="sm">{areaLabel(c.area)}</Pill>
                        <Pill size="sm" tone={kindTone(c.kind)}>{kindLabel(c.kind)}</Pill>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <details style={{ minWidth: 0 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: tokens.muted }}>Details: pick it by id</summary>
            <div style={{ marginTop: 8 }}>
              <Field label="The newer fact's id">
                <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="m…" autoComplete="off" />
              </Field>
            </div>
          </details>
          {error ? <p role="alert" style={errorLine}>{error}</p> : null}
        </>
      ) : null}
    </Modal>
  );
}
