import { useEffect, useMemo, useState } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, EmptyState, Field, Input, Modal, Pill, Section, Select, Sheet, tokens, tone, formatDate, formatMoney, formatShortDate, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { cleanMemo } from "../domain/memo.js";
import type { LoadResult } from "./overview.js";
import {
  AccountSelect,
  accountLabel,
  Banner,
  centsToInput,
  IssueLink,
  Muted,
  Row,
  small,
  Table,
  TAX_OPTIONS,
  Td,
  toCents,
  useRunner,
  words,
  type BankAccount,
  StatusPill,
} from "./shared.js";

type Suggestion =
  | { kind: "open_item"; basis: string; key: string; itemKind: string; number: string; counterparty: string; outstandingMinor: number; confidence: number }
  | { kind: "journal"; journalId: string; number: string; date: string; memo: string; confidence: number }
  | { kind: "category"; source: "rule" | "jev"; accountCode: string; taxCode: string | null; counterparty: string | null; confidence: number; vatApplies?: number | null; isTransfer?: number | null };

interface BankLine {
  id: string;
  bankAccountId: string;
  date: string;
  amountMinor: number;
  description: string;
  reference: string | null;
  counterparty: string | null;
  balanceMinor: number | null;
  status: string;
  suggestions: Suggestion[];
  match: Record<string, unknown> | null;
  journalId: string | null;
  reconciliationId: string | null;
  note: string | null;
}

interface OpenItem {
  key: string;
  kind: "receivable" | "payable";
  number: string;
  counterpartyName: string;
  outstandingMinor: number;
  dueDate: string | null;
}

interface Rule {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  field: string;
  operator: string;
  value: string;
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
  direction: string;
  accountCode: string;
  taxCode: string | null;
}

interface Reconciliation {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  differenceMinor: number;
  unreconciledCount: number;
  glBalanceMinor: number;
  status: string;
  approvalIssueId: string | null;
}

interface Statement {
  id: string;
  bankAccountId: string;
  fileName: string;
  format: string;
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string | null;
}

/** A statement email from the Mailbox that is still waiting to be imported. */
interface StatementEmail {
  messageId: string;
  subject: string;
  sender: string;
  receivedAt: string | null;
  createdAt: string | null;
  issueId: string | null;
}

interface BankSnapshot {
  bankAccounts: BankAccount[];
  statements: Statement[];
  rules: Rule[];
  reconciliations: Reconciliation[];
  counts: Record<string, number>;
  statementEmails?: StatementEmail[];
}

/** Whole days since an ISO time (0 for today or an unreadable time). */
function daysSince(value: string | null): number {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : 0;
}

/** "Your September statement · FNB · 3 days ago", for the email picker and the waiting list. */
function emailLabel(e: StatementEmail): string {
  const age = daysSince(e.receivedAt ?? e.createdAt);
  const sender = e.sender.replace(/\s*<[^>]*>\s*$/, "") || e.sender;
  return [e.subject || "(no subject)", sender || null, age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`].filter(Boolean).join(" · ");
}

interface Summary {
  openingMinor: number;
  closingMinor: number;
  linesTotalMinor: number;
  computedClosingMinor: number;
  differenceMinor: number;
  unreconciledCount: number;
  glBalanceMinor: number;
  glDifferenceMinor: number;
  ready: boolean;
  blockers: string[];
}

function describe(s: Suggestion, accounts: LoadResult["accounts"]): string {
  if (s.kind === "open_item") return `${s.itemKind === "receivable" ? "Invoice" : "Bill"} ${s.number}${s.counterparty ? ` (${s.counterparty})` : ""} · ${s.basis === "exact" ? "amount and number match" : s.basis === "amount" ? "same amount" : `part payment of ${formatMoney(s.outstandingMinor)}`}`;
  if (s.kind === "journal") return `Journal ${s.number} on ${formatShortDate(s.date)}${s.memo ? ` – ${cleanMemo(s.memo)}` : ""}`;
  const tax = s.taxCode ? ` · ${TAX_OPTIONS.find((t) => t.value === s.taxCode)?.label ?? "VAT code"}` : "";
  const from = s.source === "rule" ? "bank rule" : `smart match ${Math.round(s.confidence * 100)}%${s.isTransfer != null && s.isTransfer >= 0.7 ? ", looks like a transfer" : ""}`;
  return `${accountLabel(accounts, s.accountCode)}${tax} · ${from}`;
}

/** A statement only holds money that already moved: a line dated after `asOf` is almost always a wrong date. */
function datedLater(date: string, asOf: string): boolean {
  return date > asOf;
}

function lastMonth(): { start: string; end: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

function importMessage(r: Record<string, unknown>): string {
  return (r.duplicateFile
    ? "This file was imported before; nothing new was added."
    : `Imported ${r.lines} line(s): ${r.added} new, ${r.duplicates} already in the books. ${r.suggested} have suggestions${Number(r.jevAsked) ? ` (smart matching looked at ${r.jevAsked})` : ""}.${r.issueId ? " The Bookkeeper has an issue to reconcile them." : ""}${Number(r.futureLines) ? ` ${r.futureLines} line(s) are dated after today (first ${formatShortDate(String(r.firstFutureDate))}): check those dates on the statement. They count in no balance until then.` : ""}`)
    + (r.statementEmail ? " The statement email no longer waits to be imported." : "");
}

export function BankTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const loadBank = usePluginAction("accounting.bank");
  const loadLines = usePluginAction("accounting.bank-lines");
  const saveBankAccount = usePluginAction("accounting.save-bank-account");
  const uploadUrl = usePluginAction("accounting.statement-upload-url");
  const importStatement = usePluginAction("accounting.import-statement");
  const queuePdfStatements = usePluginAction("accounting.queue-pdf-statements");
  const refreshSuggestions = usePluginAction("accounting.refresh-suggestions");
  const accept = usePluginAction("accounting.accept-suggestion");
  const categorise = usePluginAction("accounting.categorise");
  const matchOpenItem = usePluginAction("accounting.match-open-item");
  const exclude = usePluginAction("accounting.exclude-line");
  const undo = usePluginAction("accounting.undo-line");
  const saveRule = usePluginAction("accounting.save-rule");
  const deleteRule = usePluginAction("accounting.delete-rule");
  const prepareRec = usePluginAction("accounting.prepare-reconciliation");
  const requestRec = usePluginAction("accounting.request-reconciliation-approval");
  const approveRec = usePluginAction("accounting.approve-reconciliation");
  const discardRec = usePluginAction("accounting.discard-reconciliation");
  const { busy, run } = useRunner(onMessage);

  const [snap, setSnap] = useState<BankSnapshot | null>(null);
  const [bankId, setBankId] = useState("");
  const [status, setStatus] = useState("unreconciled");
  const [lines, setLines] = useState<BankLine[]>([]);
  const [openItems, setOpenItems] = useState<OpenItem[]>([]);
  const [selected, setSelected] = useState<BankLine | null>(null);
  const [newAccount, setNewAccount] = useState(false);
  const [accountForm, setAccountForm] = useState({ name: "", bankName: "", numberLast4: "", accountCode: "" });
  const [format, setFormat] = useState("auto");
  const [files, setFiles] = useState<File[]>([]);
  /** Import even when the statement checks fail (a real export that does not add up). */
  const [skipChecks, setSkipChecks] = useState(false);
  /** The statement email the file came from (links the import to it), or "". */
  const [fromEmail, setFromEmail] = useState("");
  const [ruleForm, setRuleForm] = useState<Record<string, string> | null>(null);
  const [recForm, setRecForm] = useState({ ...lastMonth(), opening: "", closing: "" });
  const [prepared, setPrepared] = useState<{ reconciliation: Reconciliation; summary: Summary } | null>(null);
  const [catForm, setCatForm] = useState({ accountCode: "", taxCode: "", memo: "" });
  const [matchKey, setMatchKey] = useState("");
  const [excludeNote, setExcludeNote] = useState("");

  const accounts = data.accounts;
  const narrow = useIsNarrow();
  const asOf = data.overview.asOf ?? new Date().toISOString().slice(0, 10);
  const futureLines = (data.overview.future?.items ?? []).filter((i) => i.kind === "bank_line");
  const futureCount = data.overview.future?.bankLines ?? futureLines.length;

  async function refreshAll(nextBank = bankId, nextStatus = status) {
    const s = (await loadBank({})) as BankSnapshot;
    setSnap(s);
    const chosen = nextBank || s.bankAccounts[0]?.id || "";
    if (chosen !== bankId) setBankId(chosen);
    if (chosen) {
      const r = (await loadLines({ bankAccountId: chosen, status: nextStatus === "all" ? undefined : nextStatus, limit: 300 })) as { lines: BankLine[]; openItems: OpenItem[] };
      setLines(r.lines);
      setOpenItems(r.openItems);
    } else {
      setLines([]);
    }
  }

  useEffect(() => {
    void run("load", () => refreshAll());
  }, []);

  function pick(line: BankLine) {
    setSelected(line);
    const cat = line.suggestions.find((s) => s.kind === "category") as Extract<Suggestion, { kind: "category" }> | undefined;
    setCatForm({ accountCode: cat?.accountCode ?? "", taxCode: cat?.taxCode ?? "", memo: "" });
    setMatchKey("");
    setExcludeNote("");
  }

  async function afterLineChange(message: string) {
    setSelected(null);
    await refreshAll();
    onMessage(message);
  }

  async function upload(f: File): Promise<string> {
    const target = (await uploadUrl({ fileName: f.name, bytes: f.size })) as { uploadUrl: string; objectKey: string };
    const put = await fetch(target.uploadUrl, { method: "PUT", body: f });
    if (!put.ok) throw new Error(`Upload of ${f.name} to the private bucket failed (HTTP ${put.status}). Check the bucket's CORS settings.`);
    return target.objectKey;
  }

  async function doImport() {
    if (!files.length || !bankId) return;
    const messageId = fromEmail || undefined;
    // PDFs go to the Bookkeeper, who reads them with its pdf skill. They always upload as bytes:
    // file.text() would decode a PDF as UTF-8 and corrupt it.
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const others = files.filter((f) => !pdfs.includes(f));
    await run("import", async () => {
      const messages: string[] = [];
      for (const f of others) {
        const r = (f.size <= 900_000
          ? await importStatement({ bankAccountId: bankId, content: await f.text(), fileName: f.name, format, messageId, skipChecks })
          : await importStatement({ bankAccountId: bankId, objectKey: await upload(f), fileName: f.name, format, messageId, skipChecks })) as Record<string, unknown>;
        messages.push(`${others.length > 1 ? `${f.name}: ` : ""}${importMessage(r)}`);
      }
      if (pdfs.length) {
        const uploaded: Array<{ objectKey: string; fileName: string }> = [];
        for (const f of pdfs) uploaded.push({ objectKey: await upload(f), fileName: f.name });
        const q = (await queuePdfStatements({ bankAccountId: bankId, files: uploaded })) as { files: number; assignedTo: string };
        messages.push(
          `${q.files} PDF statement${q.files === 1 ? "" : "s"} handed to ${q.assignedTo === "bookkeeper" ? "the Bookkeeper" : "the team"} to read and import. They appear here as each one is imported.`,
        );
      }
      setFiles([]);
      setSkipChecks(false);
      setFromEmail("");
      await refreshAll();
      return { text: messages.join(" ") };
    }, (r) => r.text);
  }

  const bank = snap?.bankAccounts.find((b) => b.id === bankId) ?? null;
  const recs = (snap?.reconciliations ?? []).filter((r) => r.bankAccountId === bankId);
  const statements = (snap?.statements ?? []).filter((s) => s.bankAccountId === bankId).slice(0, 5);
  const waitingEmails = snap?.statementEmails ?? [];
  const matchable = useMemo(() => {
    if (!selected) return [];
    const kind = selected.amountMinor > 0 ? "receivable" : "payable";
    return openItems.filter((i) => i.kind === kind && i.outstandingMinor >= Math.abs(selected.amountMinor));
  }, [selected, openItems]);

  if (snap && snap.bankAccounts.length === 0 && !newAccount) {
    return (
      <EmptyState
        title="No bank accounts yet"
        description="Add PiB's bank account to import statements and reconcile. It links to a Bank account in the chart."
        action={<Button type="button" onClick={() => setNewAccount(true)}>+ Add bank account</Button>}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Row>
        <Field label="Bank account">
          <Select value={bankId} onChange={(e) => { setBankId(e.target.value); void run("load", () => refreshAll(e.target.value)); }}>
            {(snap?.bankAccounts ?? []).map((b) => <option key={b.id} value={b.id}>{`${b.name}${b.numberLast4 ? ` ••${b.numberLast4}` : ""}`}</option>)}
          </Select>
        </Field>
        <Button type="button" variant="secondary" onClick={() => setNewAccount(true)}>+ Add bank account</Button>
      </Row>

      <Section
        title="Statement lines"
        actions={
          <Row>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); void run("load", () => refreshAll(bankId, e.target.value)); }}>
              <option value="unreconciled">To reconcile</option>
              <option value="matching">Waiting for Billing</option>
              <option value="reconciled">Reconciled</option>
              <option value="excluded">Excluded</option>
              <option value="all">All</option>
            </Select>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("suggest", async () => {
              const r = (await refreshSuggestions({ bankAccountId: bankId })) as { lines: number; suggested: number; jevAsked: number };
              await refreshAll();
              return r;
            }, (r) => `Checked ${r.lines} line(s); ${r.suggested} have suggestions${r.jevAsked ? `, Jev looked at ${r.jevAsked}` : ""}.`)}>{busy === "suggest" ? "Checking…" : "Refresh suggestions"}</Button>
          </Row>
        }
      >
        {futureCount > 0 ? (
          <Banner tone="warn">
            <span>
              <strong>{futureCount} bank line{futureCount === 1 ? " is" : "s are"} dated after today{futureLines[0] ? ` (first ${formatShortDate(futureLines[0].date)})` : ""}.</strong> A statement only holds money that already moved, so the date is probably wrong (often the day and month swapped). {futureCount === 1 ? "It counts" : "They count"} in no balance until then, and the Bookkeeper leaves {futureCount === 1 ? "it" : "them"} for you.
            </span>
          </Banner>
        ) : null}
        {lines.length === 0 ? (
          <Muted>{status === "unreconciled" ? "Nothing to reconcile on this account." : "No lines."}</Muted>
        ) : narrow ? (
          <CompactRows
            rows={lines}
            label="Statement lines"
            title={(line) => line.description}
            meta={(line) => [formatShortDate(line.date), datedLater(line.date, asOf) ? "dated after today" : null, line.status === "unreconciled" ? (line.suggestions[0] ? describe(line.suggestions[0], accounts) : "No suggestion") : words(line.status)].filter(Boolean).join(" · ")}
            trailing={(line) => <span style={{ color: line.amountMinor > 0 ? tone("ok").fg : tokens.fg }}>{formatMoney(line.amountMinor)}</span>}
            onOpen={(line) => pick(line)}
          />
        ) : (
          <DataTable
            columns={[
              {
                key: "date",
                header: "Date",
                width: "110px",
                render: (v) => (
                  <div style={{ display: "grid", gap: 3, justifyItems: "start" }}>
                    <span style={{ whiteSpace: "nowrap" }}>{formatShortDate(String(v))}</span>
                    {datedLater(String(v), asOf) ? <Pill tone="warn" size="sm">After today</Pill> : null}
                  </div>
                ),
              },
              {
                key: "description",
                header: "Description",
                render: (_v, row) => (
                  <div style={{ display: "grid", gap: 2 }}>
                    <span>{String(row.description)}</span>
                    {row.reference || row.counterparty ? <span style={{ fontSize: 12, color: tokens.muted }}>{[row.counterparty, row.reference].filter(Boolean).join(" · ")}</span> : null}
                    {row.note ? <span style={{ fontSize: 12, color: tokens.muted }}>{String(row.note)}</span> : null}
                  </div>
                ),
              },
              { key: "amount", header: "Amount", width: "120px", render: (_v, row) => <span style={{ fontVariantNumeric: "tabular-nums", color: Number(row.amountMinor) < 0 ? tokens.fg : tone("ok").fg, fontWeight: Number(row.amountMinor) > 0 ? 600 : undefined }}>{formatMoney(Number(row.amountMinor))}</span> },
              { key: "status", header: "Status", width: "120px", render: (v) => <StatusPill status={String(v)} /> },
              {
                key: "suggestion",
                header: "Suggestion",
                render: (_v, row) => {
                  const line = row as unknown as BankLine;
                  const best = line.suggestions[0];
                  if (line.status !== "unreconciled") return <span style={{ fontSize: 12, color: tokens.muted }}>{line.match ? words(String((line.match as { kind?: string }).kind ?? "")) : ""}</span>;
                  return best ? <span style={{ fontSize: 12.5 }}>{describe(best, accounts)}</span> : <span style={{ fontSize: 12, color: tokens.muted }}>None</span>;
                },
              },
              {
                key: "id",
                header: "",
                width: "150px",
                render: (_v, row) => {
                  const line = row as unknown as BankLine;
                  return (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {line.status === "unreconciled" && line.suggestions.length ? (
                        <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("accept", async () => {
                          await accept({ lineId: line.id, index: 0 });
                          await refreshAll();
                        }, "Accepted.")}>Accept</Button>
                      ) : null}
                      <Button type="button" variant="secondary" style={small} onClick={() => pick(line)}>Open</Button>
                    </div>
                  );
                },
              },
            ]}
            rows={lines.map((l) => ({ ...l, amount: l.amountMinor, suggestion: "" }))}
          />
        )}
      </Section>

      <Section title="Import statement">
        {waitingEmails.length ? (
          <Banner tone={waitingEmails.some((e) => daysSince(e.receivedAt ?? e.createdAt) > 2) ? "warn" : "info"}>
            <strong>
              {waitingEmails.length === 1 ? "1 statement email is" : `${waitingEmails.length} statement emails are`} waiting to be imported
            </strong>
            {waitingEmails.slice(0, 5).map((e) => (
              <span key={e.messageId} style={{ display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{emailLabel(e)}</span>
                {e.issueId ? <IssueLink id={e.issueId} label="Open its issue" /> : null}
              </span>
            ))}
            <span style={{ color: tokens.muted }}>
              The Bookkeeper imports these. Doing it yourself: pick the email below with the file from it. Nothing to import? Close its issue.
            </span>
          </Banner>
        ) : null}
        <Row>
          <Field label="Files (CSV, OFX, MT940 or PDF; several at once)">
            <input type="file" multiple accept=".csv,.txt,.ofx,.qfx,.sta,.mt940,.940,.pdf" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} style={{ fontSize: 13 }} />
          </Field>
          <Field label="Format">
            <Select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="auto">Detect</option>
              <option value="csv">CSV</option>
              <option value="ofx">OFX</option>
              <option value="mt940">MT940</option>
            </Select>
          </Field>
          {waitingEmails.length ? (
            <Field label="From email">
              <Select value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} style={{ maxWidth: 280 }}>
                <option value="">Not from a waiting email</option>
                {waitingEmails.map((e) => <option key={e.messageId} value={e.messageId}>{emailLabel(e)}</option>)}
              </Select>
            </Field>
          ) : null}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: tokens.muted }} title="Imports are refused when the balances do not add up, every line is on one side, or descriptions are missing. Tick this only for a genuine bank export you have checked.">
            <input type="checkbox" checked={skipChecks} onChange={(e) => setSkipChecks(e.target.checked)} />
            Import even if the checks fail
          </label>
          <Button type="button" disabled={!files.length || !bankId || busy === "import"} onClick={() => void doImport()}>{busy === "import" ? "Importing…" : files.length > 1 ? `Import  files` : "Import"}</Button>
        </Row>
        <Muted>
          Lines already in the books are skipped, so overlapping statements are safe. PDFs go to the Bookkeeper, who reads them and imports the lines. {data.settings.r2Configured ? "Files over 1 MB go to the private bucket first." : "Files over 1 MB need the private R2 bucket (Accounting settings)."}
        </Muted>
        {statements.length ? (
          <Muted>Recent: {statements.map((s) => `${s.fileName || s.format.toUpperCase()} (${s.periodStart ? formatShortDate(s.periodStart) : "?"} to ${s.periodEnd ? formatShortDate(s.periodEnd) : "?"}, ${s.newCount} new)`).join(" · ")}</Muted>
        ) : null}
      </Section>

      <Section title="Reconcile" actions={bank ? <span style={{ fontSize: 12, color: tokens.muted }}>{bank.name} · ledger account {accountLabel(accounts, bank.accountCode)}</span> : null}>
        <Row>
          <Field label="From"><Input type="date" value={recForm.start} onChange={(e) => setRecForm({ ...recForm, start: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={recForm.end} onChange={(e) => setRecForm({ ...recForm, end: e.target.value })} /></Field>
          <Field label="Opening balance (R)"><Input value={recForm.opening} placeholder="from statement" onChange={(e) => setRecForm({ ...recForm, opening: e.target.value })} /></Field>
          <Field label="Closing balance (R)"><Input value={recForm.closing} placeholder="from statement" onChange={(e) => setRecForm({ ...recForm, closing: e.target.value })} /></Field>
          <Button type="button" disabled={!bankId || busy !== ""} onClick={() => void run("rec", async () => {
            const r = (await prepareRec({ bankAccountId: bankId, periodStart: recForm.start, periodEnd: recForm.end, openingMinor: toCents(recForm.opening), closingMinor: toCents(recForm.closing) })) as { reconciliation: Reconciliation; summary: Summary };
            setPrepared(r);
            setRecForm((f) => ({ ...f, opening: f.opening || centsToInput(r.summary.openingMinor), closing: f.closing || centsToInput(r.summary.closingMinor) }));
            await refreshAll();
          })}>{busy === "rec" ? "Checking…" : "Prepare"}</Button>
        </Row>
        {prepared ? (
          <div style={{ display: "grid", gap: 10 }}>
            <Table head={["", { label: "Amount", right: true }]}>
              <tr><Td>Opening balance</Td><Td right>{formatMoney(prepared.summary.openingMinor)}</Td></tr>
              <tr><Td>Lines in the period</Td><Td right>{formatMoney(prepared.summary.linesTotalMinor)}</Td></tr>
              <tr><Td>Opening + lines</Td><Td right>{formatMoney(prepared.summary.computedClosingMinor)}</Td></tr>
              <tr><Td>Closing balance (statement)</Td><Td right>{formatMoney(prepared.summary.closingMinor)}</Td></tr>
              <tr><Td strong>Difference</Td><Td right strong>{formatMoney(prepared.summary.differenceMinor)}</Td></tr>
              <tr><Td muted>Ledger balance of the bank account</Td><Td right muted>{formatMoney(prepared.summary.glBalanceMinor)}</Td></tr>
              <tr><Td muted>Statement minus ledger</Td><Td right muted>{formatMoney(prepared.summary.glDifferenceMinor)}</Td></tr>
            </Table>
            {prepared.summary.blockers.length ? <Banner tone="warn">{prepared.summary.blockers.map((b) => <span key={b}>{b}</span>)}</Banner> : <Banner tone="ok"><span>Balances agree and every line is reconciled.</span></Banner>}
            <Row>
              {prepared.reconciliation.status === "draft" ? (
                <Button type="button" disabled={!prepared.summary.ready || busy !== ""} onClick={() => void run("rec", async () => {
                  const r = (await requestRec({ reconciliationId: prepared.reconciliation.id })) as Reconciliation;
                  setPrepared({ ...prepared, reconciliation: r });
                  await refreshAll();
                }, "Approval requested. A board user approves it here or by marking the issue done.")}>Request approval</Button>
              ) : null}
              {prepared.reconciliation.status === "pending_approval" ? (
                <Button type="button" disabled={busy !== ""} onClick={() => void run("rec", async () => {
                  const r = (await approveRec({ reconciliationId: prepared.reconciliation.id })) as Reconciliation;
                  setPrepared({ ...prepared, reconciliation: r });
                  await refreshAll();
                }, "Approved and locked.")}>Approve and lock</Button>
              ) : null}
              {prepared.reconciliation.approvalIssueId ? <span style={{ fontSize: 12 }}>Approval: <IssueLink id={prepared.reconciliation.approvalIssueId} /></span> : null}
            </Row>
          </div>
        ) : null}
        {recs.length ? (
          <Table head={["Period", { label: "Closing", right: true }, { label: "Difference", right: true }, "Status", ""]}>
            {recs.map((r) => (
              <tr key={r.id}>
                <Td>{`${formatShortDate(r.periodStart)} to ${formatShortDate(r.periodEnd)}`}</Td>
                <Td right>{formatMoney(r.closingMinor)}</Td>
                <Td right>{formatMoney(r.differenceMinor)}</Td>
                <Td><StatusPill status={r.status} /></Td>
                <Td>
                  {r.status !== "locked" ? (
                    <Button type="button" variant="secondary" style={small} onClick={() => {
                      setRecForm({ start: r.periodStart, end: r.periodEnd, opening: centsToInput(r.openingMinor), closing: centsToInput(r.closingMinor) });
                      void run("rec", async () => setPrepared((await prepareRec({ bankAccountId: r.bankAccountId, periodStart: r.periodStart, periodEnd: r.periodEnd, openingMinor: r.openingMinor, closingMinor: r.closingMinor })) as { reconciliation: Reconciliation; summary: Summary }));
                    }}>Open</Button>
                  ) : null}
                  {r.status !== "locked" ? (
                    <Button type="button" variant="secondary" style={{ ...small, marginLeft: 6 }} disabled={busy !== ""} onClick={() => {
                      if (!window.confirm(`Discard the reconciliation ${r.periodStart} to ${r.periodEnd}? Its lines stay as they are; only this reconciliation (and its approval request) goes.`)) return;
                      void run("rec", async () => {
                        await discardRec({ reconciliationId: r.id });
                        setPrepared(null);
                        await refreshAll();
                      }, "Reconciliation discarded.");
                    }}>Discard</Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>

      <Section title="Bank rules" actions={<Button type="button" variant="secondary" style={small} onClick={() => setRuleForm({ name: "", field: "description", operator: "contains", value: "", direction: "any", accountCode: "", taxCode: "", priority: "100", min: "", max: "" })}>+ Add rule</Button>}>
        {(snap?.rules ?? []).length === 0 ? (
          <Muted>Rules suggest an account for lines whose description, counterparty, reference or amount match. They never post on their own.</Muted>
        ) : (
          <Table head={["Rule", "When", "Account", "VAT", ""]}>
            {(snap?.rules ?? []).map((r) => (
              <tr key={r.id}>
                <Td>{r.name}{r.active ? "" : " (off)"}</Td>
                <Td>{r.operator === "amount_between" ? `amount ${formatMoney(r.amountMinMinor ?? 0)} – ${r.amountMaxMinor == null ? "any" : formatMoney(r.amountMaxMinor)}` : `${r.field} ${words(r.operator)} "${r.value}"`}{r.direction !== "any" ? ` · money ${r.direction}` : ""}</Td>
                <Td>{accountLabel(accounts, r.accountCode)}</Td>
                <Td>{TAX_OPTIONS.find((t) => t.value === (r.taxCode ?? ""))?.label ?? r.taxCode}</Td>
                <Td>
                  <Button type="button" variant="secondary" style={small} onClick={() => void run("rule", async () => {
                    await deleteRule({ ruleId: r.id });
                    await refreshAll();
                  }, "Rule deleted.")}>Delete</Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Sheet open={!!selected} title="Bank line" onClose={() => setSelected(null)}>
        {selected ? (
          <div style={{ display: "grid", gap: 14, fontSize: 13 }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong>{formatMoney(selected.amountMinor)} on {formatDate(selected.date)}</strong>
              {datedLater(selected.date, asOf) ? <span style={{ color: tone("warn").fg, fontWeight: 600 }}>Dated after today: check this date on the statement before you reconcile it.</span> : null}
              <span>{selected.description}</span>
              {selected.counterparty ? <span style={{ color: tokens.muted }}>Counterparty: {selected.counterparty}</span> : null}
              {selected.reference ? <span style={{ color: tokens.muted }}>Reference: {selected.reference}</span> : null}
              <span style={{ color: tokens.muted }}>Status: {words(selected.status)}{selected.note ? ` · ${selected.note}` : ""}</span>
            </div>
            {selected.status === "unreconciled" ? (
              <>
                {selected.suggestions.length ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    <strong>Suggestions</strong>
                    {selected.suggestions.map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                        <span>{describe(s, accounts)}</span>
                        <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("accept", async () => {
                          await accept({ lineId: selected.id, index: i });
                          await afterLineChange(s.kind === "open_item" ? "Sent to Billing to settle. The line reconciles when the payment journal arrives." : "Reconciled.");
                        })}>Accept</Button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: "grid", gap: 8 }}>
                  <strong>Categorise</strong>
                  <AccountSelect accounts={accounts} value={catForm.accountCode} onChange={(code) => setCatForm({ ...catForm, accountCode: code })} filter={(a) => a.code !== bank?.accountCode} />
                  <Select value={catForm.taxCode} onChange={(e) => setCatForm({ ...catForm, taxCode: e.target.value })}>
                    {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </Select>
                  <Input placeholder="Memo (optional)" value={catForm.memo} onChange={(e) => setCatForm({ ...catForm, memo: e.target.value })} />
                  <div>
                    <Button type="button" disabled={!catForm.accountCode || busy !== ""} onClick={() => void run("cat", async () => {
                      await categorise({ lineId: selected.id, accountCode: catForm.accountCode, taxCode: catForm.taxCode || null, memo: catForm.memo || null });
                      await afterLineChange("Posted and reconciled.");
                    })}>Post and reconcile</Button>
                  </div>
                  <Muted>Posts a bank journal: bank against the account, with VAT split out for a 15% code.</Muted>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  <strong>{selected.amountMinor > 0 ? "Match to an invoice" : "Match to a bill"}</strong>
                  <Select value={matchKey} onChange={(e) => setMatchKey(e.target.value)}>
                    <option value="">Choose…</option>
                    {matchable.map((i) => <option key={i.key} value={i.key}>{`${i.number} ${i.counterpartyName} (${formatMoney(i.outstandingMinor)} open${i.dueDate ? `, due ${formatShortDate(i.dueDate)}` : ""})`}</option>)}
                  </Select>
                  <div>
                    <Button type="button" variant="secondary" disabled={!matchKey || busy !== ""} onClick={() => void run("match", async () => {
                      await matchOpenItem({ lineId: selected.id, openItemKey: matchKey });
                      await afterLineChange("Sent to Billing to settle.");
                    })}>Send to Billing</Button>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  <strong>Exclude</strong>
                  <Input placeholder="Why (e.g. duplicate line)" value={excludeNote} onChange={(e) => setExcludeNote(e.target.value)} />
                  <div>
                    <Button type="button" variant="secondary" disabled={!excludeNote.trim() || busy !== ""} onClick={() => void run("exclude", async () => {
                      await exclude({ lineId: selected.id, note: excludeNote });
                      await afterLineChange("Excluded.");
                    })}>Exclude line</Button>
                  </div>
                </div>
              </>
            ) : selected.reconciliationId ? (
              <Muted>This line is in a locked reconciliation.</Muted>
            ) : (
              <div>
                <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("undo", async () => {
                  await undo({ lineId: selected.id });
                  await afterLineChange("Undone. A category journal was reversed.");
                })}>Undo</Button>
              </div>
            )}
          </div>
        ) : null}
      </Sheet>

      <Modal
        open={newAccount}
        title="Add bank account"
        description="Links to a Bank account in the chart. Leave the ledger account empty to use 1000 (or create a new one)."
        onClose={() => setNewAccount(false)}
        footer={
          <Button type="button" disabled={!accountForm.name.trim() || busy !== ""} onClick={() => void run("account", async () => {
            const b = (await saveBankAccount({ ...accountForm, accountCode: accountForm.accountCode || null })) as BankAccount;
            setNewAccount(false);
            setAccountForm({ name: "", bankName: "", numberLast4: "", accountCode: "" });
            setBankId(b.id);
            await refreshAll(b.id);
          }, "Bank account added.")}>Add</Button>
        }
      >
        <Field label="Name"><Input value={accountForm.name} placeholder="FNB business cheque" onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })} /></Field>
        <Field label="Bank"><Input value={accountForm.bankName} onChange={(e) => setAccountForm({ ...accountForm, bankName: e.target.value })} /></Field>
        <Field label="Last 4 digits"><Input value={accountForm.numberLast4} onChange={(e) => setAccountForm({ ...accountForm, numberLast4: e.target.value })} /></Field>
        <Field label="Ledger account">
          <AccountSelect accounts={accounts} value={accountForm.accountCode} onChange={(code) => setAccountForm({ ...accountForm, accountCode: code })} filter={(a) => a.subtype === "bank" || a.subtype === "cash" || a.subtype === "current_liability"} placeholder="Automatic" />
        </Field>
      </Modal>

      <Modal
        open={!!ruleForm}
        title="Add bank rule"
        description="When a line matches, the account (and VAT code) is suggested. A person still accepts it."
        onClose={() => setRuleForm(null)}
        footer={
          <Button type="button" disabled={busy !== ""} onClick={() => ruleForm && void run("rule", async () => {
            await saveRule({
              name: ruleForm.name,
              field: ruleForm.operator === "amount_between" ? "amount" : ruleForm.field,
              operator: ruleForm.operator,
              value: ruleForm.value,
              amountMinMinor: toCents(ruleForm.min ?? ""),
              amountMaxMinor: toCents(ruleForm.max ?? ""),
              direction: ruleForm.direction,
              accountCode: ruleForm.accountCode,
              taxCode: ruleForm.taxCode || null,
              priority: Number(ruleForm.priority || 100),
            });
            setRuleForm(null);
            await refreshAll();
          }, "Rule saved. Refresh suggestions to apply it.")}>Save rule</Button>
        }
      >
        {ruleForm ? (
          <>
            <Field label="Name"><Input value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} /></Field>
            <Row>
              <Field label="When">
                <Select value={ruleForm.operator} onChange={(e) => setRuleForm({ ...ruleForm, operator: e.target.value })}>
                  <option value="contains">contains</option>
                  <option value="starts_with">starts with</option>
                  <option value="equals">equals</option>
                  <option value="amount_between">amount between</option>
                </Select>
              </Field>
              {ruleForm.operator !== "amount_between" ? (
                <Field label="Field">
                  <Select value={ruleForm.field} onChange={(e) => setRuleForm({ ...ruleForm, field: e.target.value })}>
                    <option value="description">description</option>
                    <option value="counterparty">counterparty</option>
                    <option value="reference">reference</option>
                  </Select>
                </Field>
              ) : null}
            </Row>
            {ruleForm.operator === "amount_between" ? (
              <Row>
                <Field label="Minimum (R)"><Input value={ruleForm.min} onChange={(e) => setRuleForm({ ...ruleForm, min: e.target.value })} /></Field>
                <Field label="Maximum (R)"><Input value={ruleForm.max} onChange={(e) => setRuleForm({ ...ruleForm, max: e.target.value })} /></Field>
              </Row>
            ) : (
              <Field label="Text"><Input value={ruleForm.value} onChange={(e) => setRuleForm({ ...ruleForm, value: e.target.value })} /></Field>
            )}
            <Field label="Direction">
              <Select value={ruleForm.direction} onChange={(e) => setRuleForm({ ...ruleForm, direction: e.target.value })}>
                <option value="any">Money in or out</option>
                <option value="in">Money in</option>
                <option value="out">Money out</option>
              </Select>
            </Field>
            <Field label="Account"><AccountSelect accounts={accounts} value={ruleForm.accountCode} onChange={(code) => setRuleForm({ ...ruleForm, accountCode: code })} /></Field>
            <Field label="VAT">
              <Select value={ruleForm.taxCode} onChange={(e) => setRuleForm({ ...ruleForm, taxCode: e.target.value })}>
                {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label="Priority (lower runs first)"><Input value={ruleForm.priority} onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })} /></Field>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
