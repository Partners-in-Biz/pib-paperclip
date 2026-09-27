import { useState, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, Select, formatDate, formatMonth, formatMoney } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { AccountSelect, Banner, base64ToBytes, download, memoText, Muted, signTone, Table, Td, today, useRunner } from "./shared.js";

type Kind =
  | "trial_balance"
  | "profit_and_loss"
  | "balance_sheet"
  | "cash_flow"
  | "general_ledger"
  | "comparison"
  | "budget_vs_actual"
  | "aged_receivables"
  | "aged_payables";

const KINDS: Array<[Kind, string]> = [
  ["profit_and_loss", "Profit and loss"],
  ["balance_sheet", "Balance sheet"],
  ["cash_flow", "Cash flow"],
  ["trial_balance", "Trial balance"],
  ["general_ledger", "One account's entries (general ledger)"],
  ["comparison", "This month against earlier months"],
  ["budget_vs_actual", "Budget against actual"],
  ["aged_receivables", "Who owes you, by age (receivables)"],
  ["aged_payables", "Who you owe, by age (payables)"],
];

/** A report's range as people read it: `1 Mar 2026 to 30 Sep 2026`. */
const range = (from: string, to: string) => `${formatDate(from)} to ${formatDate(to)}`;

interface Line {
  accountId: string;
  code: string;
  name: string;
  amountMinor: number;
}

type AnyReport = Record<string, unknown> & { kind: Kind };

/** Ageing columns: current plain, 31–60 amber, older red. */
const AGED_TONE: Record<string, "warn" | "bad" | undefined> = { current: undefined, "1_30": undefined, "31_60": "warn", "61_90": "bad", over_90: "bad", total: undefined };

function Section2({ title, lines, total }: { title: string; lines: Line[]; total: number }) {
  if (!lines.length && !total) return null;
  return (
    <>
      <tr><Td strong colSpan={2}>{title}</Td></tr>
      {lines.map((l) => (
        <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{formatMoney(l.amountMinor)}</Td></tr>
      ))}
      <tr><Td muted>Total {title.toLowerCase()}</Td><Td right strong>{formatMoney(total)}</Td></tr>
    </>
  );
}

function Render({ report }: { report: AnyReport }): ReactNode {
  const r = report as Record<string, any>;
  switch (report.kind) {
    case "trial_balance":
      return (
        <>
          {!r.balanced ? <Banner tone="bad"><span>The trial balance does not balance. Check the audit chain in Journals.</span></Banner> : null}
          <Table head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]} footer={<tr><Td strong>Total</Td><Td right strong tone={r.balanced ? "ok" : "bad"}>{formatMoney(r.totalDebitMinor)}</Td><Td right strong tone={r.balanced ? "ok" : "bad"}>{formatMoney(r.totalCreditMinor)}</Td></tr>}>
            {r.lines.map((l: any) => <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{l.debitMinor ? formatMoney(l.debitMinor) : ""}</Td><Td right>{l.creditMinor ? formatMoney(l.creditMinor) : ""}</Td></tr>)}
          </Table>
        </>
      );
    case "profit_and_loss":
      return (
        <Table head={[range(r.from, r.to), { label: "Amount", right: true }]}>
          <Section2 title="Revenue" lines={r.revenue} total={r.totalRevenueMinor} />
          <Section2 title="Cost of sales" lines={r.costOfSales} total={r.totalCostOfSalesMinor} />
          <tr><Td strong>Gross profit</Td><Td right strong tone={signTone(r.grossProfitMinor)}>{formatMoney(r.grossProfitMinor)}</Td></tr>
          <Section2 title="Other income" lines={r.otherIncome} total={r.totalOtherIncomeMinor} />
          <Section2 title="Expenses" lines={r.expenses} total={r.totalExpensesMinor} />
          <tr><Td strong>Net profit</Td><Td right strong tone={signTone(r.netProfitMinor)}>{formatMoney(r.netProfitMinor)}</Td></tr>
        </Table>
      );
    case "balance_sheet":
      return (
        <>
          {!r.balanced ? <Banner tone="bad"><span>Assets do not equal liabilities plus equity.</span></Banner> : <Banner tone="ok"><span>Assets = liabilities + equity.</span></Banner>}
          <Table head={[`At ${formatDate(r.asOf)}`, { label: "Amount", right: true }]}>
            <Section2 title="Current assets" lines={r.currentAssets} total={r.currentAssets.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <Section2 title="Non-current assets" lines={r.nonCurrentAssets} total={r.nonCurrentAssets.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <tr><Td strong>Total assets</Td><Td right strong>{formatMoney(r.totalAssetsMinor)}</Td></tr>
            <Section2 title="Current liabilities" lines={r.currentLiabilities} total={r.currentLiabilities.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <Section2 title="Non-current liabilities" lines={r.nonCurrentLiabilities} total={r.nonCurrentLiabilities.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <tr><Td strong>Total liabilities</Td><Td right strong>{formatMoney(r.totalLiabilitiesMinor)}</Td></tr>
            <tr><Td strong colSpan={2}>Equity</Td></tr>
            {r.equity.map((l: Line) => <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{formatMoney(l.amountMinor)}</Td></tr>)}
            <tr><Td>Profit of earlier years</Td><Td right>{formatMoney(r.retainedEarningsMinor)}</Td></tr>
            <tr><Td>This year's profit (from {formatDate(r.financialYearStart)})</Td><Td right>{formatMoney(r.currentYearEarningsMinor)}</Td></tr>
            <tr><Td strong>Total equity</Td><Td right strong>{formatMoney(r.totalEquityMinor)}</Td></tr>
            <tr><Td strong>Liabilities + equity</Td><Td right strong tone={r.balanced ? "ok" : "bad"}>{formatMoney(r.totalLiabilitiesMinor + r.totalEquityMinor)}</Td></tr>
          </Table>
        </>
      );
    case "cash_flow":
      return (
        <Table head={[range(r.from, r.to), { label: "Amount", right: true }]}>
          <tr><Td strong colSpan={2}>Operating activities</Td></tr>
          <tr><Td>Net profit</Td><Td right>{formatMoney(r.netProfitMinor)}</Td></tr>
          {r.operating.map((l: Line) => <tr key={l.accountId}><Td>{`Change in ${l.code} ${l.name}`}</Td><Td right>{formatMoney(l.amountMinor)}</Td></tr>)}
          <tr><Td muted>Cash from operating activities</Td><Td right strong>{formatMoney(r.operatingTotalMinor)}</Td></tr>
          <Section2 title="Investing activities" lines={r.investing} total={r.investingTotalMinor} />
          <Section2 title="Financing activities" lines={r.financing} total={r.financingTotalMinor} />
          <Section2 title="Other movements" lines={r.other} total={r.otherTotalMinor} />
          <tr><Td strong>Net change in cash</Td><Td right strong tone={signTone(r.netChangeMinor)}>{formatMoney(r.netChangeMinor)}</Td></tr>
          <tr><Td>Cash at the start</Td><Td right>{formatMoney(r.openingCashMinor)}</Td></tr>
          <tr><Td strong>Cash at the end</Td><Td right strong tone={r.closingCashMinor < 0 ? "bad" : undefined}>{formatMoney(r.closingCashMinor)}</Td></tr>
          {!r.reconciles ? <tr><Td colSpan={2}>This does not agree with the bank and cash accounts; check the cash-flow class of the accounts.</Td></tr> : null}
        </Table>
      );
    case "general_ledger":
      return (
        <Table
          head={["Date", "Journal", "Memo", { label: "Debit", right: true }, { label: "Credit", right: true }, { label: "Balance", right: true }]}
          footer={<tr><Td strong colSpan={5}>Closing balance</Td><Td right strong>{formatMoney(r.closingMinor)}</Td></tr>}
        >
          <tr><Td muted colSpan={5}>{`${r.account.code} ${r.account.name} · balance on ${formatDate(r.from)}`}</Td><Td right>{formatMoney(r.openingMinor)}</Td></tr>
          {r.rows.map((e: any, i: number) => (
            <tr key={i}><Td>{formatDate(e.date)}</Td><Td>{e.number}</Td><Td>{memoText(e.lineMemo, "") || memoText(e.memo)}</Td><Td right>{e.debitMinor ? formatMoney(e.debitMinor) : ""}</Td><Td right>{e.creditMinor ? formatMoney(e.creditMinor) : ""}</Td><Td right>{formatMoney(e.balanceMinor)}</Td></tr>
          ))}
        </Table>
      );
    case "comparison":
      return (
        <Table head={["Account", ...r.labels.map((l: string, i: number) => ({ label: `${l} (${formatMonth(r.ranges[i].start)})`, right: true }))]}>
          {r.rows.map((row: any) => <tr key={row.accountId}><Td>{`${row.code} ${row.name}`}</Td>{row.values.map((v: number, i: number) => <Td key={i} right>{formatMoney(v)}</Td>)}</tr>)}
          <tr><Td strong>Net profit</Td>{r.netProfit.map((v: number, i: number) => <Td key={i} right strong tone={signTone(v)}>{formatMoney(v)}</Td>)}</tr>
        </Table>
      );
    case "budget_vs_actual":
      return (
        <Table
          head={["Account", { label: "Budget", right: true }, { label: "Actual", right: true }, { label: "Better / (worse)", right: true }]}
          footer={<tr><Td strong>Total</Td><Td right strong>{formatMoney(r.totals.budgetMinor)}</Td><Td right strong>{formatMoney(r.totals.actualMinor)}</Td><Td right strong tone={signTone(r.totals.varianceMinor)}>{formatMoney(r.totals.varianceMinor)}</Td></tr>}
        >
          {r.rows.map((row: any) => <tr key={row.accountCode}><Td>{`${row.accountCode} ${row.name}`}</Td><Td right>{formatMoney(row.budgetMinor)}</Td><Td right>{formatMoney(row.actualMinor)}</Td><Td right tone={signTone(row.varianceMinor)}>{formatMoney(row.varianceMinor)}</Td></tr>)}
        </Table>
      );
    case "aged_receivables":
    case "aged_payables":
      return (
        <Table
          head={[report.kind === "aged_receivables" ? "Customer" : "Supplier", { label: "Not yet due", right: true }, { label: "1–30 days late", right: true }, { label: "31–60 days", right: true }, { label: "61–90 days", right: true }, { label: "Over 90 days", right: true }, { label: "Total", right: true }]}
          footer={<tr><Td strong>Total</Td>{["current", "1_30", "31_60", "61_90", "over_90", "total"].map((k) => <Td key={k} right strong tone={r.totals[k] > 0 ? AGED_TONE[k] : undefined}>{formatMoney(r.totals[k])}</Td>)}</tr>}
        >
          {r.rows.map((row: any) => (
            <tr key={row.counterpartyName}><Td>{row.counterpartyName}</Td>{["current", "1_30", "31_60", "61_90", "over_90"].map((k) => <Td key={k} right tone={row.buckets[k] ? AGED_TONE[k] : undefined}>{row.buckets[k] ? formatMoney(row.buckets[k]) : ""}</Td>)}<Td right strong>{formatMoney(row.totalMinor)}</Td></tr>
          ))}
        </Table>
      );
    default:
      return null;
  }
}

export function ReportsTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const report = usePluginAction("accounting.report");
  const pack = usePluginAction("accounting.pack");
  const { busy, run } = useRunner(onMessage);
  const [kind, setKind] = useState<Kind>("profit_and_loss");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today());
  const [accountCode, setAccountCode] = useState("");
  const [result, setResult] = useState<AnyReport | null>(null);
  const [packFrom, setPackFrom] = useState("");
  const [packTo, setPackTo] = useState(today());
  const pointInTime = kind === "trial_balance" || kind === "balance_sheet" || kind === "aged_receivables" || kind === "aged_payables";
  const cell = (child: ReactNode, basis: number, grow = 1) => <div style={{ flex: `${grow} 1 ${basis}px`, minWidth: 0 }}>{child}</div>;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Section title="Report">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          {cell(
            <Field label="Report">
              <Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setResult(null); }}>
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </Select>
            </Field>,
            240,
            2,
          )}
          {!pointInTime ? cell(<Field label={kind === "comparison" ? "Month (optional)" : "From (optional)"}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>, 140) : null}
          {cell(<Field label={pointInTime ? "As at" : "To"}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>, 140)}
          {kind === "general_ledger" ? cell(<Field label="Account"><AccountSelect accounts={data.accounts} value={accountCode} onChange={setAccountCode} fullWidth /></Field>, 200, 2) : null}
          <Button type="button" disabled={busy !== "" || (kind === "general_ledger" && !accountCode)} onClick={() => void run("report", async () => {
            const params: Record<string, unknown> = { kind, accountCode: accountCode || undefined };
            if (pointInTime) params.asOf = to;
            else {
              if (from) params.from = from;
              if (to) params.to = to;
              if (kind === "comparison" && !from) params.month = to.slice(0, 7);
            }
            setResult((await report(params)) as AnyReport);
          })}>{busy === "report" ? "Running…" : "Run"}</Button>
        </div>
        {!pointInTime && !result ? <Muted>{kind === "comparison" ? "Leave Month empty to compare the month of the To date." : "Leave From empty to start at the beginning of the financial year."}</Muted> : null}
        {result ? <Render report={result} /> : <Muted>Every report is worked out from the posted journals.</Muted>}
      </Section>

      <Section title="Accountant pack">
        <Muted>Everything your accountant needs in one ZIP: trial balance, general ledger, journals, chart of accounts, open invoices and bills, VAT returns and the audit check.</Muted>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          {cell(<Field label="From (optional)"><Input type="date" value={packFrom} onChange={(e) => setPackFrom(e.target.value)} /></Field>, 140)}
          {cell(<Field label="To"><Input type="date" value={packTo} onChange={(e) => setPackTo(e.target.value)} /></Field>, 140)}
          <Button type="button" disabled={busy !== ""} onClick={() => void run("pack", async () => {
            const r = (await pack({ from: packFrom || undefined, to: packTo })) as { fileName: string; url: string | null; data: string | null; audit: { hashChain: { ok: boolean } } };
            if (r.url) window.open(r.url, "_blank", "noopener");
            else if (r.data) download(r.fileName, base64ToBytes(r.data), "application/zip");
            return r;
          }, (r) => `Pack ready (${r.fileName}). ${r.audit.hashChain.ok ? "Audit check passed: no journal was changed." : "Audit check failed: a posted journal was changed. See Journals."}${r.url ? " The download link works for 24 hours." : ""}`)}>{busy === "pack" ? "Building…" : "Download ZIP"}</Button>
        </div>
        <Muted>
          Leave From empty to start at the beginning of the financial year.{" "}
          {data.settings.r2Configured ? "The pack is kept in your private file storage and you get a download link." : "Big packs need private file storage (Accounting settings); smaller ones download straight away."}
        </Muted>
      </Section>
    </div>
  );
}
