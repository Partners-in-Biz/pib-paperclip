import { useEffect, useState } from "react";
import { DataTable, StatusBadge, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, Section, Select, Sheet, Tabs, Toolbar, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import {
  AccountSelect,
  Banner,
  centsToInput,
  IssueLink,
  Muted,
  rand,
  Row,
  small,
  statusTone,
  Table,
  TAX_OPTIONS,
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

type Sub = "journals" | "drafts" | "rejected" | "periods";

type EditLine = { accountCode: string; debit: string; credit: string; memo: string; taxCode: string };
const emptyLine = (): EditLine => ({ accountCode: "", debit: "", credit: "", memo: "", taxCode: "" });

export function JournalsTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const [sub, setSub] = useState<Sub>("journals");
  const accounts = data.accounts;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Tabs
        tabs={[
          { id: "journals", label: "Journals" },
          { id: "drafts", label: "Drafts" },
          { id: "rejected", label: `Rejected${data.overview.rejectedPostings ? ` (${data.overview.rejectedPostings})` : ""}` },
          { id: "periods", label: "Periods" },
        ]}
        active={sub}
        onChange={(id) => setSub(id as Sub)}
      />
      {sub === "journals" ? <JournalList accounts={accounts} onMessage={onMessage} /> : null}
      {sub === "drafts" ? <Drafts accounts={accounts} onMessage={onMessage} /> : null}
      {sub === "rejected" ? <Rejected onMessage={onMessage} /> : null}
      {sub === "periods" ? <Periods onMessage={onMessage} /> : null}
    </div>
  );
}

function JournalList({ accounts, onMessage }: { accounts: LoadResult["accounts"]; onMessage: (m: string) => void }) {
  const list = usePluginAction("accounting.journals");
  const reverse = usePluginAction("accounting.reverse-journal");
  const verify = usePluginAction("accounting.verify-chain");
  const { busy, run } = useRunner(onMessage);
  const [filters, setFilters] = useState({ from: "", to: "", kind: "", search: "", accountCode: "" });
  const [rows, setRows] = useState<Journal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Journal | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; problem: string | null } | null>(null);
  const [reverseDate, setReverseDate] = useState("");

  async function refresh(p = page) {
    const accountId = accounts.find((a) => a.code === filters.accountCode)?.id;
    const r = (await list({ ...filters, accountId, limit: 50, offset: p * 50 })) as { journals: Journal[]; total: number };
    setRows(r.journals);
    setTotal(r.total);
  }

  useEffect(() => {
    void run("load", () => refresh(0));
  }, []);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={filters.search} onSearchChange={(v) => setFilters({ ...filters, search: v })} searchPlaceholder="Number, memo or source…">
        <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From" />
        <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To" />
        <Select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
          <option value="">All kinds</option>
          {["event", "manual", "reversal", "bank", "opening", "depreciation", "disposal", "fx_revaluation"].map((k) => <option key={k} value={k}>{words(k)}</option>)}
        </Select>
        <AccountSelect accounts={accounts} value={filters.accountCode} onChange={(code) => setFilters({ ...filters, accountCode: code })} placeholder="Any account" />
        <Button type="button" variant="secondary" onClick={() => { setPage(0); void run("load", () => refresh(0)); }}>Filter</Button>
        <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("verify", async () => setChain((await verify({})) as { ok: boolean; checked: number; problem: string | null }))}>{busy === "verify" ? "Checking…" : "Check audit chain"}</Button>
      </Toolbar>
      {chain ? (
        <Banner tone={chain.ok ? "ok" : "warn"}>
          <span>{chain.ok ? `Audit chain intact: ${chain.checked} journals checked, none changed or removed.` : `Audit chain broken: ${chain.problem}`}</span>
        </Banner>
      ) : null}
      <DataTable
        columns={[
          { key: "number", header: "Number", width: "110px" },
          { key: "date", header: "Date", width: "100px" },
          { key: "memo", header: "Memo" },
          { key: "kind", header: "Kind", width: "110px", render: (v) => words(String(v)) },
          { key: "total", header: "Amount", width: "120px" },
          { key: "status", header: "Status", width: "100px", render: (v) => <StatusBadge label={String(v)} status={v === "reversed" ? "warning" : "ok"} /> },
          { key: "id", header: "", width: "70px", render: (_v, row) => <Button type="button" variant="secondary" style={small} onClick={() => { setOpen(row as unknown as Journal); setReverseDate(""); }}>Open</Button> },
        ]}
        rows={rows.map((j) => ({ ...j, total: rand(j.totalMinor) }))}
        totalCount={total}
        page={page}
        pageSize={50}
        onPageChange={(p) => { setPage(p); void run("load", () => refresh(p)); }}
        emptyMessage="No journals yet. Billing and Payroll post here automatically."
      />
      <Sheet open={!!open} title={open ? `${open.number} · ${open.date}` : "Journal"} onClose={() => setOpen(null)}>
        {open ? (
          <div style={{ display: "grid", gap: 12, fontSize: 13 }}>
            <span>{open.memo}</span>
            <span style={{ color: tokens.muted }}>
              {words(open.kind)} · from {open.source.plugin || "Accounting"} ({words(open.source.kind)}) · {open.currency}{open.fxRate ? ` at ${open.fxRate}` : ""}
            </span>
            <Table head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]}>
              {open.lines.map((l, i) => (
                <tr key={i}>
                  <Td>
                    <div style={{ display: "grid" }}>
                      <span>{l.accountCode} {l.accountName ?? ""}</span>
                      {l.memo ? <span style={{ fontSize: 12, color: tokens.muted }}>{l.memo}</span> : null}
                      {l.taxCode ? <span style={{ fontSize: 12, color: tokens.muted }}>{TAX_OPTIONS.find((t) => t.value === l.taxCode)?.label ?? l.taxCode}{l.taxBaseMinor != null ? ` on ${rand(l.taxBaseMinor)}` : ""}</span> : null}
                    </div>
                  </Td>
                  <Td right>{l.debitMinor ? rand(l.debitMinor) : ""}</Td>
                  <Td right>{l.creditMinor ? rand(l.creditMinor) : ""}</Td>
                </tr>
              ))}
            </Table>
            <Muted>Source key {open.sourceKey}. Hash {open.hash.slice(0, 16)}…</Muted>
            {open.status === "posted" && !open.reversesId ? (
              <div style={{ display: "grid", gap: 8 }}>
                <strong>Reverse</strong>
                <Field label="Reversal date (empty: same date if its period is open, else today)"><Input type="date" value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} /></Field>
                <div>
                  <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("reverse", async () => {
                    const r = (await reverse({ journalId: open.id, date: reverseDate || null })) as { journal: Journal };
                    setOpen(null);
                    await refresh();
                    return r;
                  }, (r) => `Reversed by ${r.journal.number}.`)}>Post reversal</Button>
                </div>
                <Muted>Posted journals are never edited. A reversal posts the same lines with debit and credit swapped.</Muted>
              </div>
            ) : open.status === "reversed" ? <Muted>This journal has been reversed.</Muted> : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

function Drafts({ accounts, onMessage }: { accounts: LoadResult["accounts"]; onMessage: (m: string) => void }) {
  const list = usePluginAction("accounting.drafts");
  const save = usePluginAction("accounting.save-draft");
  const request = usePluginAction("accounting.request-draft-approval");
  const approve = usePluginAction("accounting.approve-draft");
  const cancel = usePluginAction("accounting.cancel-draft");
  const { busy, run } = useRunner(onMessage);
  const [drafts, setDrafts] = useState<Draft[]>([]);
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

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Row>
        <Button type="button" onClick={() => setEditor({ id: null, date: today(), memo: "", lines: [emptyLine(), emptyLine()] })}>+ New manual journal</Button>
      </Row>
      <Muted>Manual journals need an approval issue. A board user approves here (or marks the issue done); only then does the journal post.</Muted>
      {drafts.length === 0 ? (
        <Muted>No drafts.</Muted>
      ) : (
        <Table head={["Date", "Memo", { label: "Amount", right: true }, "Status", "Approval", ""]}>
          {drafts.map((d) => (
            <tr key={d.id}>
              <Td>{d.date}</Td>
              <Td>
                {d.memo}
                {d.error ? <div style={{ fontSize: 12, color: tokens.destructive }}>{d.error}</div> : null}
                {d.createdBy?.kind === "agent" ? <div style={{ fontSize: 12, color: tokens.muted }}>Prepared by an agent</div> : null}
              </Td>
              <Td right>{rand(d.lines.reduce((s, l) => s + Number(l.debitMinor ?? 0), 0))}</Td>
              <Td><StatusBadge label={words(d.status)} status={statusTone(d.status)} /></Td>
              <Td>{d.approvalIssueId ? <IssueLink id={d.approvalIssueId} /> : "—"}</Td>
              <Td>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {d.status === "draft" ? (
                    <>
                      <Button type="button" variant="secondary" style={small} onClick={() => setEditor({
                        id: d.id,
                        date: d.date,
                        memo: d.memo,
                        lines: d.lines.map((l) => ({ accountCode: String(l.accountCode ?? ""), debit: centsToInput(Number(l.debitMinor) || null), credit: centsToInput(Number(l.creditMinor) || null), memo: String(l.memo ?? ""), taxCode: String(l.taxCode ?? "") })),
                      })}>Edit</Button>
                      <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("request", async () => { await request({ draftId: d.id }); await refresh(); }, "Approval issue opened.")}>Request approval</Button>
                    </>
                  ) : null}
                  {d.status === "pending_approval" ? (
                    <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("approve", async () => {
                      const r = (await approve({ draftId: d.id })) as { journal: { number: string } | null };
                      await refresh();
                      return r;
                    }, (r) => `Approved and posted as ${r.journal?.number ?? "a journal"}.`)}>Approve and post</Button>
                  ) : null}
                  <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("cancel", async () => { await cancel({ draftId: d.id }); await refresh(); }, "Cancelled.")}>Cancel</Button>
                </div>
              </Td>
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
              Debits {rand(debit)} · Credits {rand(credit)}
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
                <AccountSelect accounts={accounts} value={l.accountCode} onChange={(code) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, accountCode: code } : x)) })} />
                <Row>
                  <Input placeholder="Debit" value={l.debit} inputMode="decimal" style={{ minWidth: 90, width: 110 }} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, debit: e.target.value, credit: e.target.value ? "" : x.credit } : x)) })} />
                  <Input placeholder="Credit" value={l.credit} inputMode="decimal" style={{ minWidth: 90, width: 110 }} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, credit: e.target.value, debit: e.target.value ? "" : x.debit } : x)) })} />
                  <Select value={l.taxCode} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, taxCode: e.target.value } : x)) })}>
                    {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </Select>
                </Row>
                <Row>
                  <Input placeholder="Line memo" value={l.memo} onChange={(e) => setEditor({ ...editor, lines: editor.lines.map((x, k) => (k === i ? { ...x, memo: e.target.value } : x)) })} />
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

function Rejected({ onMessage }: { onMessage: (m: string) => void }) {
  const list = usePluginAction("accounting.rejections");
  const retry = usePluginAction("accounting.retry-rejection");
  const dismiss = usePluginAction("accounting.dismiss-rejection");
  const { busy, run } = useRunner(onMessage);
  const [rows, setRows] = useState<Rejection[]>([]);
  async function refresh() {
    setRows(((await list({})) as { rejections: Rejection[] }).rejections);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);
  if (rows.length === 0) return <Muted>Nothing was rejected. Postings from Billing and Payroll are in the books.</Muted>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Muted>Fix the cause (map the role under Chart &amp; roles, reopen the period, or correct the document in the other plugin), then Retry. Retry also tells the sending plugin the result.</Muted>
      <Table head={["Posting", "Error", "Tries", ""]}>
        {rows.map((r) => (
          <tr key={r.key}>
            <Td>
              <div style={{ display: "grid" }}>
                <span>{r.payload.memo || r.key}</span>
                <span style={{ fontSize: 12, color: tokens.muted }}>{r.source.plugin} · {r.payload.date} · {r.key}</span>
              </div>
            </Td>
            <Td>{r.error}</Td>
            <Td>{r.attempts}</Td>
            <Td>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("retry", async () => {
                  const res = (await retry({ key: r.key })) as { journalNumber?: string | null };
                  await refresh();
                  return res;
                }, (res) => `Posted as ${res.journalNumber ?? "a journal"}.`)}>Retry</Button>
                <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("dismiss", async () => { await dismiss({ key: r.key }); await refresh(); }, "Dismissed.")}>Dismiss</Button>
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Periods({ onMessage }: { onMessage: (m: string) => void }) {
  const list = usePluginAction("accounting.periods");
  const setPeriod = usePluginAction("accounting.set-period");
  const checklist = usePluginAction("accounting.close-checklist");
  const { busy, run } = useRunner(onMessage);
  const [periods, setPeriods] = useState<Array<{ period: string; status: string }>>([]);
  const [check, setCheck] = useState<{ month: string; items: ChecklistItem[]; ready: boolean } | null>(null);
  async function refresh() {
    setPeriods(((await list({})) as { periods: Array<{ period: string; status: string }> }).periods);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Muted>Open: everything posts. Soft-closed: only approved manual journals and reversals. Closed: nothing posts; other plugins' postings are rejected until it is reopened.</Muted>
      <Table head={["Month", "Status", ""]}>
        {periods.map((p) => (
          <tr key={p.period}>
            <Td>{p.period}</Td>
            <Td>
              <Select value={p.status} disabled={busy !== ""} onChange={(e) => void run("period", async () => { await setPeriod({ period: p.period, status: e.target.value }); await refresh(); }, `${p.period} is now ${words(e.target.value)}.`)}>
                <option value="open">Open</option>
                <option value="soft_closed">Soft-closed</option>
                <option value="closed">Closed</option>
              </Select>
            </Td>
            <Td>
              <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("check", async () => setCheck((await checklist({ month: p.period })) as { month: string; items: ChecklistItem[]; ready: boolean }))}>Close checklist</Button>
            </Td>
          </tr>
        ))}
      </Table>
      {check ? (
        <Section title={`Close checklist ${check.month}`}>
          <Table head={["", "Check", "Detail"]}>
            {check.items.map((i) => (
              <tr key={i.key}>
                <Td><StatusBadge label={i.ok ? "ok" : "to do"} status={i.ok ? "ok" : "warning"} /></Td>
                <Td>{i.label}</Td>
                <Td muted>{i.detail}</Td>
              </tr>
            ))}
          </Table>
          <Muted>{check.ready ? "Everything is done. Close the period above." : "Finish the open items before closing the period."}</Muted>
        </Section>
      ) : null}
    </div>
  );
}
