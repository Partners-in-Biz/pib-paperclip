import { useEffect, useRef, useState, type ReactNode } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, Field, Input, Modal, Pill, RefreshCw, Section, Select, Sheet, formatDate, formatMonth, formatMoney, formatShortDate, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { readableDates } from "../domain/dates.js";
import type { LoadResult } from "./overview.js";
import {
  AccountSelect,
  Banner,
  centsToInput,
  Details,
  IssueLink,
  KIND_LABELS,
  kindLabel,
  memoText,
  Muted,
  Row,
  small,
  sourceName,
  StatusPill,
  Table,
  TAX_OPTIONS,
  taxLabel,
  Td,
  toCents,
  today,
  useRunner,
  words,
} from "./shared.js";

interface JLine {
  accountId: string;
  accountCode: string;
  accountName?: string | null;
  debitMinor: number;
  creditMinor: number;
  memo?: string | null;
  taxCode?: string | null;
  taxBaseMinor?: number | null;
  dimensions?: Record<string, string> | null;
  originalDebitMinor?: number | null;
  originalCreditMinor?: number | null;
}

interface Journal {
  id: string;
  number: string;
  date: string;
  memo: string;
  kind: string;
  currency: string;
  fxRate: number | null;
  totalMinor: number;
  lines: JLine[];
  sourceKey: string;
  source: { plugin: string; kind: string; id: string };
  status: string;
  reversesId: string | null;
  reversedById: string | null;
  hash: string;
  prevHash: string;
}

interface Draft {
  id: string;
  date: string;
  memo: string;
  currency: string;
  lines: Array<Record<string, unknown>>;
  status: string;
  approvalIssueId: string | null;
  error: string | null;
  createdBy: { kind?: string };
}

interface Rejection {
  key: string;
  event: string;
  source: { plugin?: string; kind?: string; id?: string };
  payload: { date?: string; memo?: string };
  error: string;
  attempts: number;
  lastAt: string | null;
}

interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export type JournalsSection = "journals" | "drafts" | "rejected" | "periods";

type EditLine = { accountCode: string; debit: string; credit: string; memo: string; taxCode: string };
const emptyLine = (): EditLine => ({ accountCode: "", debit: "", credit: "", memo: "", taxCode: "" });

const PAGE_SIZE = 50;

/** Where a journal came from, in words: "From Billing" for a posting another module sent, else its kind ("Manual", "Bank"…). */
function journalOrigin(j: Pick<Journal, "kind" | "source">): string {
  return j.kind === "event" ? `From ${sourceName(j.source?.plugin)}` : kindLabel(j.kind);
}
const KIND_FILTER = ["event", "manual", "reversal", "bank", "opening", "depreciation", "disposal", "fx_revaluation"];

/** Journals, drafts, rejected postings and periods: the sections of the Journals tab. */
export function JournalsTab({ data, section, onMessage, onOpen }: { data: LoadResult; section: JournalsSection; onMessage: (m: string) => void; onOpen: (view: string) => void }) {
  const accounts = data.accounts;
  if (section === "drafts") return <Drafts accounts={accounts} onMessage={onMessage} />;
  if (section === "rejected") return <Rejected onMessage={onMessage} onOpen={onOpen} />;
  if (section === "periods") return <Periods onMessage={onMessage} />;
  return <JournalList accounts={accounts} onMessage={onMessage} asOf={data.overview.asOf} />;
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

type Filters = { from: string; to: string; kind: string; search: string; accountCode: string };
const NO_FILTERS: Filters = { from: "", to: "", kind: "", search: "", accountCode: "" };

/** The filters in one row that wraps: search, From, To, kind, account and refresh; two neat columns on a phone. */
function JournalFilters({ filters, onChange, accounts, onRefresh, busy }: { filters: Filters; onChange: (next: Filters) => void; accounts: LoadResult["accounts"]; onRefresh: () => void; busy: boolean }) {
  const narrow = useIsNarrow();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const search = (
    <Field label="Search">
      <Input type="search" value={filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Number, memo or source" />
    </Field>
  );
  const from = <Field label="From"><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} /></Field>;
  const to = <Field label="To"><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} /></Field>;
  const kind = (
    <Field label="Kind">
      <Select value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
        <option value="">All kinds</option>
        {KIND_FILTER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
      </Select>
    </Field>
  );
  const account = (
    <Field label="Account">
      <AccountSelect accounts={accounts} value={filters.accountCode} onChange={(code) => set({ accountCode: code })} placeholder="Any account" fullWidth />
    </Field>
  );
  const refresh = (
    <Button type="button" variant="secondary" aria-label="Refresh" title="Refresh" disabled={busy} onClick={onRefresh} style={{ width: narrow ? 40 : 36, padding: 0, display: "inline-grid", placeItems: "center", flexShrink: 0 }}>
      <RefreshCw size={15} aria-hidden="true" />
    </Button>
  );
  if (narrow) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8, alignItems: "end" }}>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>{search}</div>
          {refresh}
        </div>
        {from}
        {to}
        {kind}
        {account}
      </div>
    );
  }
  const cell = (child: ReactNode, basis: number, grow = 1) => <div style={{ flex: `${grow} 1 ${basis}px`, minWidth: 0 }}>{child}</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
      {cell(search, 200, 2)}
      {cell(from, 140)}
      {cell(to, 140)}
      {cell(kind, 150)}
      {cell(account, 190, 2)}
      {refresh}
    </div>
  );
}

/** A journal dated after `asOf` counts in no figure until then (the Overview flags it too). */
function AfterToday({ date, asOf }: { date: string; asOf: string }) {
  return date > asOf ? <Pill tone="warn" size="sm">After today</Pill> : null;
}

function JournalList({ accounts, onMessage, asOf = new Date().toISOString().slice(0, 10) }: { accounts: LoadResult["accounts"]; onMessage: (m: string) => void; asOf?: string }) {
  const narrow = useIsNarrow();
  const list = usePluginAction("accounting.journals");
  const reverse = usePluginAction("accounting.reverse-journal");
  const verify = usePluginAction("accounting.verify-chain");
  const { busy, run } = useRunner(onMessage);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [rows, setRows] = useState<Journal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Journal | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; problem: string | null } | null>(null);
  const [reverseDate, setReverseDate] = useState("");
  const latest = useRef(0);

  async function refresh(p = page, f = filters) {
    const call = ++latest.current;
    const accountId = accounts.find((a) => a.code === f.accountCode)?.id;
    const r = (await list({ ...f, accountId, limit: PAGE_SIZE, offset: p * PAGE_SIZE })) as { journals: Journal[]; total: number };
    if (call !== latest.current) return; // a newer filter already answered
    setRows(r.journals);
    setTotal(r.total);
    setLoaded(true);
  }

  // Filters apply by themselves (typing pauses briefly first).
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(0);
      void run("load", () => refresh(0, filters));
    }, 300);
    return () => clearTimeout(timer);
  }, [filters.from, filters.to, filters.kind, filters.search, filters.accountCode]);

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const empty = filtered ? "No journals match these filters." : "No journals yet. Billing and Payroll post here by themselves.";
  const openJournal = (j: Journal) => {
    setOpen(j);
    setReverseDate("");
  };
  const goTo = (p: number) => {
    setPage(p);
    void run("load", () => refresh(p));
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <JournalFilters filters={filters} onChange={setFilters} accounts={accounts} busy={busy !== ""} onRefresh={() => void run("load", () => refresh())} />
      {filtered ? (
        <div>
          <button type="button" onClick={() => setFilters(NO_FILTERS)} style={{ border: "none", background: "transparent", padding: 0, color: tokens.primary, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minHeight: 28 }}>
            Clear filters
          </button>
        </div>
      ) : null}
      {narrow ? (
        <>
          <CompactRows
            rows={rows}
            label="Journals"
            loading={!loaded}
            empty={empty}
            title={(j) => memoText(j.memo, kindLabel(j.kind))}
            meta={(j) => [j.number, formatShortDate(j.date), j.date > asOf ? "dated after today" : null, j.status === "reversed" ? "Reversed" : journalOrigin(j)].filter(Boolean).join(" · ")}
            trailing={(j) => formatMoney(j.totalMinor)}
            onOpen={openJournal}
          />
          {total > PAGE_SIZE ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: tokens.muted }}>
              <Button type="button" variant="secondary" disabled={page === 0 || busy !== ""} onClick={() => goTo(page - 1)}>Newer</Button>
              <span>Page {page + 1} of {pages}</span>
              <Button type="button" variant="secondary" disabled={page + 1 >= pages || busy !== ""} onClick={() => goTo(page + 1)}>Older</Button>
            </div>
          ) : null}
        </>
      ) : (
        <DataTable
          columns={[
            { key: "number", header: "Number", width: "110px" },
            { key: "date", header: "Date", width: "120px", render: (v) => <div style={{ display: "grid", gap: 3, justifyItems: "start" }}><span style={{ whiteSpace: "nowrap" }}>{formatDate(String(v))}</span><AfterToday date={String(v)} asOf={asOf} /></div> },
            { key: "memo", header: "Memo", render: (_v, row) => memoText((row as unknown as Journal).memo, kindLabel((row as unknown as Journal).kind)) },
            { key: "kind", header: "Kind", width: "150px", render: (_v, row) => journalOrigin(row as unknown as Journal) },
            { key: "total", header: "Amount", width: "130px" },
            { key: "status", header: "Status", width: "110px", render: (v) => <StatusPill status={String(v)} label={String(v) === "posted" ? "Posted" : String(v) === "reversed" ? "Reversed" : undefined} /> },
            { key: "id", header: "", width: "76px", render: (_v, row) => <Button type="button" variant="secondary" style={small} onClick={() => openJournal(row as unknown as Journal)}>Open</Button> },
          ]}
          rows={rows.map((j) => ({ ...j, total: formatMoney(j.totalMinor) }))}
          loading={!loaded}
          totalCount={total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={goTo}
          emptyMessage={empty}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Button type="button" variant="secondary" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("verify", async () => setChain((await verify({})) as { ok: boolean; checked: number; problem: string | null }))}>
          {busy === "verify" ? "Checking…" : "Check audit chain"}
        </Button>
        <Muted>Confirms no posted journal was changed or removed.</Muted>
      </div>
      {chain ? (
        <Banner tone={chain.ok ? "ok" : "warn"}>
          <span>{chain.ok ? `Audit chain intact: ${chain.checked} journals checked, none changed or removed.` : `Audit chain broken: ${readableDates(chain.problem)}`}</span>
        </Banner>
      ) : null}

      <Sheet open={!!open} title={open ? `${open.number} · ${formatDate(open.date)}` : "Journal"} onClose={() => setOpen(null)}>
        {open ? <JournalDetail journal={open} busy={busy} reverseDate={reverseDate} setReverseDate={setReverseDate} onReverse={() => void run("reverse", async () => {
          const r = (await reverse({ journalId: open.id, date: reverseDate || null })) as { journal: Journal };
          setOpen(null);
          await refresh();
          return r;
        }, (r) => `Reversed by ${r.journal.number}.`)} /> : null}
      </Sheet>
    </div>
  );
}

function JournalDetail({ journal: j, busy, reverseDate, setReverseDate, onReverse }: { journal: Journal; busy: string; reverseDate: string; setReverseDate: (v: string) => void; onReverse: () => void }) {
  const foreign = j.currency && j.currency !== "ZAR";
  return (
    <div style={{ display: "grid", gap: 12, fontSize: 13, minWidth: 0 }}>
      <strong style={{ fontSize: 14, overflowWrap: "anywhere" }}>{memoText(j.memo, kindLabel(j.kind))}</strong>
      <span style={{ color: tokens.muted }}>
        {journalOrigin(j)}{j.kind === "event" ? "" : ` · from ${sourceName(j.source.plugin)}`}{foreign ? ` · in ${j.currency}${j.fxRate ? `, converted at ${j.fxRate}` : ""}` : ""}
        {j.status === "reversed" ? " · reversed" : ""}
      </span>
      <Table head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]}>
        {j.lines.map((l, i) => (
          <tr key={i}>
            <Td>
              <div style={{ display: "grid", minWidth: 0 }}>
                <span>{l.accountCode} {l.accountName ?? ""}</span>
                {l.memo && memoText(l.memo, "") ? <span style={{ fontSize: 12, color: tokens.muted }}>{memoText(l.memo, "")}</span> : null}
                {l.taxCode ? <span style={{ fontSize: 12, color: tokens.muted }}>VAT: {taxLabel(l.taxCode)}{l.taxBaseMinor != null ? ` on ${formatMoney(l.taxBaseMinor)}` : ""}</span> : null}
              </div>
            </Td>
            <Td right>{l.debitMinor ? formatMoney(l.debitMinor) : ""}</Td>
            <Td right>{l.creditMinor ? formatMoney(l.creditMinor) : ""}</Td>
          </tr>
        ))}
      </Table>
      {j.status === "posted" && !j.reversesId ? (
        <div style={{ display: "grid", gap: 8 }}>
          <strong>Reverse this journal</strong>
          <Muted>Posted journals are never edited. A reversal posts the same lines with debit and credit swapped.</Muted>
          <Field label="Reversal date"><Input type="date" value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} /></Field>
          <Muted>Leave it empty to use the journal's own date when its month is still open, otherwise today.</Muted>
          <div>
            <Button type="button" variant="secondary" disabled={busy !== ""} onClick={onReverse}>{busy === "reverse" ? "Reversing…" : "Post reversal"}</Button>
          </div>
        </div>
      ) : j.status === "reversed" ? <Muted>This journal has been reversed.</Muted> : null}
      <Details>
        <span>Source: {sourceName(j.source.plugin)}, {words(j.source.kind) || "manual"}</span>
        <span>Reference: <code>{j.sourceKey}</code></span>
        <span>Audit fingerprint: <code>{j.hash.slice(0, 16)}…</code></span>
      </Details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drafts (manual journals)
// ---------------------------------------------------------------------------

function draftTotal(d: Draft): number {
  return d.lines.reduce((s, l) => s + Number(l.debitMinor ?? 0), 0);
}

function Drafts({ accounts, onMessage }: { accounts: LoadResult["accounts"]; onMessage: (m: string) => void }) {
  const narrow = useIsNarrow();
  const list = usePluginAction("accounting.drafts");
  const save = usePluginAction("accounting.save-draft");
  const request = usePluginAction("accounting.request-draft-approval");
  const approve = usePluginAction("accounting.approve-draft");
  const cancel = usePluginAction("accounting.cancel-draft");
  const { busy, run } = useRunner(onMessage);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; date: string; memo: string; lines: EditLine[] } | null>(null);

  async function refresh() {
    setDrafts(((await list({})) as { drafts: Draft[] }).drafts);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  const debit = editor ? editor.lines.reduce((s, l) => s + (safeCents(l.debit) ?? 0), 0) : 0;
  const credit = editor ? editor.lines.reduce((s, l) => s + (safeCents(l.credit) ?? 0), 0) : 0;

  function toPayload() {
    if (!editor) return null;
    return {
      id: editor.id,
      date: editor.date,
      memo: editor.memo,
      lines: editor.lines
        .filter((l) => l.accountCode)
        .map((l) => ({ accountCode: l.accountCode, debitMinor: toCents(l.debit) ?? 0, creditMinor: toCents(l.credit) ?? 0, memo: l.memo || null, taxCode: l.taxCode || null })),
    };
  }

  const startNew = () => setEditor({ id: null, date: today(), memo: "", lines: [emptyLine(), emptyLine()] });
  const edit = (d: Draft) => setEditor({
    id: d.id,
    date: d.date,
    memo: d.memo,
    lines: d.lines.map((l) => ({ accountCode: String(l.accountCode ?? ""), debit: centsToInput(Number(l.debitMinor) || null), credit: centsToInput(Number(l.creditMinor) || null), memo: String(l.memo ?? ""), taxCode: String(l.taxCode ?? "") })),
  });

  function actions(d: Draft) {
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {d.status === "draft" ? (
          <>
            <Button type="button" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("request", async () => { await request({ draftId: d.id }); await refresh(); }, "Approval issue opened.")}>Request approval</Button>
            <Button type="button" variant="secondary" style={narrow ? undefined : small} onClick={() => edit(d)}>Edit</Button>
          </>
        ) : null}
        {d.status === "pending_approval" ? (
          <Button type="button" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("approve", async () => {
            const r = (await approve({ draftId: d.id })) as { journal: { number: string } | null };
            await refresh();
            return r;
          }, (r) => `Approved and posted as ${r.journal?.number ?? "a journal"}.`)}>Approve and post</Button>
        ) : null}
        <Button type="button" variant="secondary" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("cancel", async () => { await cancel({ draftId: d.id }); await refresh(); }, "Cancelled.")}>Cancel</Button>
      </div>
    );
  }

  const statusLabel = (status: string) => (status === "pending_approval" ? "Waiting for approval" : status === "draft" ? "Draft" : undefined);

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Row>
        <Button type="button" onClick={startNew}>+ New manual journal</Button>
      </Row>
      <Muted>A manual journal posts only after a person approves it: here, or by marking its approval issue done.</Muted>
      {drafts === null ? (
        <Muted>Loading…</Muted>
      ) : drafts.length === 0 ? (
        <Muted>No manual journals waiting.</Muted>
      ) : narrow ? (
        <div style={{ display: "grid", gap: 8 }}>
          {drafts.map((d) => (
            <div key={d.id} style={{ display: "grid", gap: 6, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.card, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "baseline" }}>
                <strong style={{ fontSize: 14, minWidth: 0, overflowWrap: "anywhere" }}>{memoText(d.memo, "Manual journal")}</strong>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{formatMoney(draftTotal(d))}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: tokens.muted }}>
                <StatusPill status={d.status} label={statusLabel(d.status)} />
                <span>{formatDate(d.date)}</span>
                {d.createdBy?.kind === "agent" ? <span>Prepared by an agent</span> : null}
                {d.approvalIssueId ? <IssueLink id={d.approvalIssueId} label="Approval issue" /> : null}
              </div>
              {d.error ? <span style={{ fontSize: 12.5, color: tokens.destructive }}>{readableDates(d.error)}</span> : null}
              {actions(d)}
            </div>
          ))}
        </div>
      ) : (
        <Table head={["Date", "Memo", { label: "Amount", right: true }, "Status", "Approval", ""]}>
          {drafts.map((d) => (
            <tr key={d.id}>
              <Td>{formatDate(d.date)}</Td>
              <Td>
                {memoText(d.memo, "Manual journal")}
                {d.error ? <div style={{ fontSize: 12, color: tokens.destructive }}>{readableDates(d.error)}</div> : null}
                {d.createdBy?.kind === "agent" ? <div style={{ fontSize: 12, color: tokens.muted }}>Prepared by an agent</div> : null}
              </Td>
              <Td right>{formatMoney(draftTotal(d))}</Td>
              <Td><StatusPill status={d.status} label={statusLabel(d.status)} /></Td>
              <Td>{d.approvalIssueId ? <IssueLink id={d.approvalIssueId} label="Open issue" /> : "—"}</Td>
              <Td>{actions(d)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal
        open={!!editor}
        title={editor?.id ? "Edit manual journal" : "New manual journal"}
        description="Debits must equal credits. Amounts in rand."
        onClose={() => setEditor(null)}
        footer={
          <>
            <span style={{ fontSize: 12, color: debit === credit && debit > 0 ? tokens.muted : tokens.destructive, marginRight: "auto" }}>
              Debits {formatMoney(debit)} · Credits {formatMoney(credit)}
            </span>
            <Button type="button" disabled={busy !== "" || debit !== credit || debit === 0} onClick={() => void run("save", async () => {
              await save(toPayload()!);
              setEditor(null);
              await refresh();
            }, "Draft saved. Request approval to post it.")}>Save draft</Button>
          </>
        }
      >
        {editor ? (
          <div style={{ display: "grid", gap: 10 }}>
            <Row>
              <Field label="Date"><Input type="date" value={editor.date} onChange={(e) => setEditor({ ...editor, date: e.target.value })} /></Field>
              <Field label="Memo"><Input value={editor.memo} onChange={(e) => setEditor({ ...editor, memo: e.target.value })} placeholder="Why this journal is needed" /></Field>
            </Row>
            {editor.lines.map((l, i) => (
              <div key={i} style={{ display: "grid", gap: 6, paddingTop: 8, borderTop: `1px solid ${tokens.border}` }}>
                <AccountSelect accounts={accounts} value={l.accountCode} label={`Line ${i + 1} account`} fullWidth onChange={(code) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, accountCode: code } : x)) })} />
                <Row>
                  <Input placeholder="Debit" aria-label={`Line ${i + 1} debit`} value={l.debit} inputMode="decimal" style={{ minWidth: 90, width: 110 }} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, debit: e.target.value, credit: e.target.value ? "" : x.credit } : x)) })} />
                  <Input placeholder="Credit" aria-label={`Line ${i + 1} credit`} value={l.credit} inputMode="decimal" style={{ minWidth: 90, width: 110 }} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, credit: e.target.value, debit: e.target.value ? "" : x.debit } : x)) })} />
                  <Select aria-label={`Line ${i + 1} VAT`} value={l.taxCode} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, taxCode: e.target.value } : x)) })}>
                    {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </Select>
                </Row>
                <Row>
                  <Input placeholder="Line memo" aria-label={`Line ${i + 1} memo`} value={l.memo} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, memo: e.target.value } : x)) })} />
                  {editor.lines.length > 2 ? <Button type="button" variant="secondary" style={small} onClick={() => setEditor({ ...editor, lines: editor.lines.filter((_, k) => k !== i) })}>Remove</Button> : null}
                </Row>
              </div>
            ))}
            <div><Button type="button" variant="secondary" style={small} onClick={() => setEditor({ ...editor, lines: [...editor.lines, emptyLine()] })}>+ Line</Button></div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function safeCents(v: string): number | null {
  try {
    return toCents(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rejected postings
// ---------------------------------------------------------------------------

function Rejected({ onMessage, onOpen }: { onMessage: (m: string) => void; onOpen: (view: string) => void }) {
  const narrow = useIsNarrow();
  const list = usePluginAction("accounting.rejections");
  const retry = usePluginAction("accounting.retry-rejection");
  const dismiss = usePluginAction("accounting.dismiss-rejection");
  const { busy, run } = useRunner(onMessage);
  const [rows, setRows] = useState<Rejection[] | null>(null);
  async function refresh() {
    setRows(((await list({})) as { rejections: Rejection[] }).rejections);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);
  if (rows === null) return <Muted>Loading…</Muted>;
  if (rows.length === 0) return <Muted>Nothing was rejected. Everything Billing and Payroll sent is in the books.</Muted>;

  const buttons = (r: Rejection) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <Button type="button" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("retry", async () => {
        const res = (await retry({ key: r.key })) as { journalNumber?: string | null };
        await refresh();
        return res;
      }, (res) => `Posted as ${res.journalNumber ?? "a journal"}.`)}>Retry</Button>
      <Button type="button" variant="secondary" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("dismiss", async () => { await dismiss({ key: r.key }); await refresh(); }, "Dismissed.")}>Dismiss</Button>
    </div>
  );
  const meta = (r: Rejection) => [sourceName(r.source.plugin), r.payload.date ? formatDate(r.payload.date) : null, r.attempts > 1 ? `${r.attempts} tries` : null].filter(Boolean).join(" · ");
  const key = (r: Rejection) => <Details><span>Posting key: <code>{r.key}</code></span></Details>;

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <Muted>
        Fix the cause first: map the role under{" "}
        <button type="button" onClick={() => onOpen("chart")} style={{ border: "none", background: "transparent", padding: 0, color: tokens.primary, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>Chart &amp; roles</button>,
        reopen the month under Periods, or correct the document in Billing or Payroll. Then click Retry; it also tells the sending module the result.
      </Muted>
      {narrow ? (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.key} style={{ display: "grid", gap: 6, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.card, minWidth: 0 }}>
              <strong style={{ fontSize: 14, overflowWrap: "anywhere" }}>{memoText(r.payload.memo, "Posting")}</strong>
              <span style={{ fontSize: 12.5, color: tokens.muted }}>{meta(r)}</span>
              <span style={{ fontSize: 13, color: tokens.destructive, overflowWrap: "anywhere" }}>{readableDates(r.error)}</span>
              {buttons(r)}
              {key(r)}
            </div>
          ))}
        </div>
      ) : (
        <Table head={["Posting", "Why it was rejected", ""]}>
          {rows.map((r) => (
            <tr key={r.key}>
              <Td>
                <div style={{ display: "grid", gap: 2 }}>
                  <span>{memoText(r.payload.memo, "Posting")}</span>
                  <span style={{ fontSize: 12, color: tokens.muted }}>{meta(r)}</span>
                  {key(r)}
                </div>
              </Td>
              <Td>{readableDates(r.error)}</Td>
              <Td>{buttons(r)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Periods (months open, soft-closed or closed)
// ---------------------------------------------------------------------------

function Periods({ onMessage }: { onMessage: (m: string) => void }) {
  const narrow = useIsNarrow();
  const list = usePluginAction("accounting.periods");
  const setPeriod = usePluginAction("accounting.set-period");
  const checklist = usePluginAction("accounting.close-checklist");
  const { busy, run } = useRunner(onMessage);
  const [periods, setPeriods] = useState<Array<{ period: string; status: string }> | null>(null);
  const [check, setCheck] = useState<{ month: string; items: ChecklistItem[]; ready: boolean } | null>(null);
  async function refresh() {
    setPeriods(((await list({})) as { periods: Array<{ period: string; status: string }> }).periods);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  const statusSelect = (p: { period: string; status: string }) => (
    <Select aria-label={`Status of ${formatMonth(p.period)}`} value={p.status} disabled={busy !== ""} onChange={(e) => void run("period", async () => { await setPeriod({ period: p.period, status: e.target.value }); await refresh(); }, `${formatMonth(p.period)} is now ${e.target.value === "soft_closed" ? "soft-closed" : e.target.value}.`)}>
      <option value="open">Open</option>
      <option value="soft_closed">Soft-closed</option>
      <option value="closed">Closed</option>
    </Select>
  );
  const checkButton = (p: { period: string }) => (
    <Button type="button" variant="secondary" style={narrow ? undefined : small} disabled={busy !== ""} onClick={() => void run("check", async () => setCheck((await checklist({ month: p.period })) as { month: string; items: ChecklistItem[]; ready: boolean }))}>Close checklist</Button>
  );

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Muted>Open: everything posts. Soft-closed: only approved manual journals and reversals post. Closed: nothing posts, and postings from Billing or Payroll are rejected until you reopen the month.</Muted>
      {periods === null ? <Muted>Loading…</Muted> : narrow ? (
        <div style={{ display: "grid", borderTop: `1px solid ${tokens.border}` }}>
          {periods.map((p) => (
            <div key={p.period} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 2px", borderBottom: `1px solid ${tokens.border}` }}>
              <strong style={{ fontSize: 14, flex: "1 1 80px" }}>{formatMonth(p.period)}</strong>
              {statusSelect(p)}
              {checkButton(p)}
            </div>
          ))}
        </div>
      ) : (
        <Table head={["Month", "Status", ""]}>
          {periods.map((p) => (
            <tr key={p.period}>
              <Td>{formatMonth(p.period)}</Td>
              <Td>{statusSelect(p)}</Td>
              <Td>{checkButton(p)}</Td>
            </tr>
          ))}
        </Table>
      )}
      {check ? (
        <Section title={`Close checklist for ${formatMonth(check.month)}`}>
          <div style={{ display: "grid", gap: 8 }}>
            {check.items.map((i) => (
              <div key={i.key} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 13, minWidth: 0 }}>
                <StatusPill status={i.ok ? "ok" : "to_do"} label={i.ok ? "Done" : "To do"} />
                <span style={{ flex: "1 1 220px", minWidth: 0 }}>{readableDates(i.label)}</span>
                <span style={{ color: tokens.muted, minWidth: 0 }}>{readableDates(i.detail)}</span>
              </div>
            ))}
          </div>
          <Muted>{check.ready ? "Everything is done. Close the month above." : "Finish the open items before closing the month."}</Muted>
        </Section>
      ) : null}
    </div>
  );
}
