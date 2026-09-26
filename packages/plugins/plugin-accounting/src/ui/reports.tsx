import { useState, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, Select, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { AccountSelect, Banner, base64ToBytes, download, Muted, rand, Row, Table, Td, today, useRunner } from "./shared.js";

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
  ["trial_balance", "Trial balance"],
  ["profit_and_loss", "Profit and loss"],
  ["balance_sheet", "Balance sheet"],
  ["cash_flow", "Cash flow (indirect)"],
  ["general_ledger", "General ledger (one account)"],
  ["comparison", "Period comparison"],
  ["budget_vs_actual", "Budget vs actual"],
  ["aged_receivables", "Aged receivables"],
  ["aged_payables", "Aged payables"],
];

interface Line {
  accountId: string;
  code: string;
  name: string;
  amountMinor: number;
}

type AnyReport = Record<string, unknown> & { kind: Kind };

function Section2({ title, lines, total }: { title: string; lines: Line[]; total: number }) {
  if (!lines.length && !total) return null;
  return (
    <>
      <tr><Td strong colSpan={2}>{title}</Td></tr>
      {lines.map((l) => (
        <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{rand(l.amountMinor)}</Td></tr>
      ))}
      <tr><Td muted>Total {title.toLowerCase()}</Td><Td right strong>{rand(total)}</Td></tr>
    </>
  );
}

function Render({ report }: { report: AnyReport }): ReactNode {
  const r = report as Record<string, any>;
  switch (report.kind) {
    case "trial_balance":
      return (
        <>
          {!r.balanced ? <Banner tone="warn"><span>The trial balance does not balance. Check the audit chain in Journals.</span></Banner> : null}
          <Table head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]} footer={<tr><Td strong>Total</Td><Td right strong>{rand(r.totalDebitMinor)}</Td><Td right strong>{rand(r.totalCreditMinor)}</Td></tr>}>
            {r.lines.map((l: any) => <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{l.debitMinor ? rand(l.debitMinor) : ""}</Td><Td right>{l.creditMinor ? rand(l.creditMinor) : ""}</Td></tr>)}
          </Table>
        </>
      );
    case "profit_and_loss":
      return (
        <Table head={[`${r.from} to ${r.to}`, { label: "Amount", right: true }]}>
          <Section2 title="Revenue" lines={r.revenue} total={r.totalRevenueMinor} />
          <Section2 title="Cost of sales" lines={r.costOfSales} total={r.totalCostOfSalesMinor} />
          <tr><Td strong>Gross profit</Td><Td right strong>{rand(r.grossProfitMinor)}</Td></tr>
          <Section2 title="Other income" lines={r.otherIncome} total={r.totalOtherIncomeMinor} />
          <Section2 title="Expenses" lines={r.expenses} total={r.totalExpensesMinor} />
          <tr><Td strong>Net profit</Td><Td right strong>{rand(r.netProfitMinor)}</Td></tr>
        </Table>
      );
    case "balance_sheet":
      return (
        <>
          {!r.balanced ? <Banner tone="warn"><span>Assets do not equal liabilities plus equity.</span></Banner> : <Banner tone="ok"><span>Assets = liabilities + equity.</span></Banner>}
          <Table head={[`At ${r.asOf}`, { label: "Amount", right: true }]}>
            <Section2 title="Current assets" lines={r.currentAssets} total={r.currentAssets.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <Section2 title="Non-current assets" lines={r.nonCurrentAssets} total={r.nonCurrentAssets.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <tr><Td strong>Total assets</Td><Td right strong>{rand(r.totalAssetsMinor)}</Td></tr>
            <Section2 title="Current liabilities" lines={r.currentLiabilities} total={r.currentLiabilities.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <Section2 title="Non-current liabilities" lines={r.nonCurrentLiabilities} total={r.nonCurrentLiabilities.reduce((s: number, l: Line) => s + l.amountMinor, 0)} />
            <tr><Td strong>Total liabilities</Td><Td right strong>{rand(r.totalLiabilitiesMinor)}</Td></tr>
            <tr><Td strong colSpan={2}>Equity</Td></tr>
            {r.equity.map((l: Line) => <tr key={l.accountId}><Td>{`${l.code} ${l.name}`}</Td><Td right>{rand(l.amountMinor)}</Td></tr>)}
            <tr><Td>Profit of earlier years</Td><Td right>{rand(r.retainedEarningsMinor)}</Td></tr>
            <tr><Td>Current year earnings (from {r.financialYearStart})</Td><Td right>{rand(r.currentYearEarningsMinor)}</Td></tr>
            <tr><Td strong>Total equity</Td><Td right strong>{rand(r.totalEquityMinor)}</Td></tr>
            <tr><Td strong>Liabilities + equity</Td><Td right strong>{rand(r.totalLiabilitiesMinor + r.totalEquityMinor)}</Td></tr>
          </Table>
        </>
      );
    case "cash_flow":
      return (
        <Table head={[`${r.from} to ${r.to}`, { label: "Amount", right: true }]}>
          <tr><Td strong colSpan={2}>Operating activities</Td></tr>
          <tr><Td>Net profit</Td><Td right>{rand(r.netProfitMinor)}</Td></tr>
          {r.operating.map((l: Line) => <tr key={l.accountId}><Td>{`Change in ${l.code} ${l.name}`}</Td><Td right>{rand(l.amountMinor)}</Td></tr>)}
          <tr><Td muted>Cash from operating activities</Td><Td right strong>{rand(r.operatingTotalMinor)}</Td></tr>
          <Section2 title="Investing activities" lines={r.investing} total={r.investingTotalMinor} />
          <Section2 title="Financing activities" lines={r.financing} total={r.financingTotalMinor} />
          <Section2 title="Other movements" lines={r.other} total={r.otherTotalMinor} />
          <tr><Td strong>Net change in cash</Td><Td right strong>{rand(r.netChangeMinor)}</Td></tr>
          <tr><Td>Cash at the start</Td><Td right>{rand(r.openingCashMinor)}</Td></tr>
          <tr><Td strong>Cash at the end</Td><Td right strong>{rand(r.closingCashMinor)}</Td></tr>
          {!r.reconciles ? <tr><Td colSpan={2}>This does not agree with the bank and cash accounts; check the cash-flow class of the accounts.</Td></tr> : null}
        </Table>
      );
    case "general_ledger":
      return (
        <Table
          head={["Date", "Journal", "Memo", { label: "Debit", right: true }, { label: "Credit", right: true }, { label: "Balance", right: true }]}
          footer={<tr><Td strong colSpan={5}>Closing balance</Td><Td right strong>{rand(r.closingMinor)}</Td></tr>}
        >
          <tr><Td muted colSpan={5}>{`${r.account.code} ${r.account.name} · opening balance ${r.from}`}</Td><Td right>{rand(r.openingMinor)}</Td></tr>
          {r.rows.map((e: any, i: number) => (
            <tr key={i}><Td>{e.date}</Td><Td>{e.number}</Td><Td>{e.lineMemo || e.memo}</Td><Td right>{e.debitMinor ? rand(e.debitMinor) : ""}</Td><Td right>{e.creditMinor ? rand(e.creditMinor) : ""}</Td><Td right>{rand(e.balanceMinor)}</Td></tr>
          ))}
        </Table>
      );
    case "comparison":
      return (
        <Table head={["Account", ...r.labels.map((l: string, i: number) => ({ label: `${l} (${r.ranges[i].start.slice(0, 7)})`, right: true }))]}>
          {r.rows.map((row: any) => <tr key={row.accountId}><Td>{`${row.code} ${row.name}`}</Td>{row.values.map((v: number, i: number) => <Td key={i} right>{rand(v)}</Td>)}</tr>)}
          <tr><Td strong>Net profit</Td>{r.netProfit.map((v: number, i: number) => <Td key={i} right strong>{rand(v)}</Td>)}</tr>
        </Table>
      );
    case "budget_vs_actual":
      return (
        <Table
          head={["Account", { label: "Budget", right: true }, { label: "Actual", right: true }, { label: "Better / (worse)", right: true }]}
          footer={<tr><Td strong>Total</Td><Td right strong>{rand(r.totals.budgetMinor)}</Td><Td right strong>{rand(r.totals.actualMinor)}</Td><Td right strong>{rand(r.totals.varianceMinor)}</Td></tr>}
        >
          {r.rows.map((row: any) => <tr key={row.accountCode}><Td>{`${row.accountCode} ${row.name}`}</Td><Td right>{rand(row.budgetMinor)}</Td><Td right>{rand(row.actualMinor)}</Td><Td right>{rand(row.varianceMinor)}</Td></tr>)}
        </Table>
      );
    case "aged_receivables":
    case "aged_payables":
      return (
        <Table
          head={[report.kind === "aged_receivables" ? "Customer" : "Supplier", { label: "Current", right: true }, { label: "1–30", right: true }, { label: "31–60", right: true }, { label: "61–90", right: true }, { label: "90+", right: true }, { label: "Total", right: true }]}
          footer={<tr><Td strong>Total</Td>{["current", "1_30", "31_60", "61_90", "over_90", "total"].map((k) => <Td key={k} right strong>{rand(r.totals[k])}</Td>)}</tr>}
        >
          {r.rows.map((row: any) => (
            <tr key={row.counterpartyName}><Td>{row.counterpartyName}</Td>{["current", "1_30", "31_60", "61_90", "over_90"].map((k) => <Td key={k} right>{row.buckets[k] ? rand(row.buckets[k]) : ""}</Td>)}<Td right strong>{rand(row.totalMinor)}</Td></tr>
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

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section title="Report">
        <Row>
          <Field label="Report">
            <Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setResult(null); }}>
              {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </Field>
          {!pointInTime ? <Field label={kind === "comparison" ? "Period from (empty: this month)" : "From (empty: year start)"}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field> : null}
          <Field label={pointInTime ? "At" : "To"}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          {kind === "general_ledger" ? <Field label="Account"><AccountSelect accounts={data.accounts} value={accountCode} onChange={setAccountCode} /></Field> : null}
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
        </Row>
        {result ? <Render report={result} /> : <Muted>Every report is computed from the posted journals.</Muted>}
      </Section>

      <Section title="Accountant pack">
        <Row>
          <Field label="From (empty: financial year start)"><Input type="date" value={packFrom} onChange={(e) => setPackFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={packTo} onChange={(e) => setPackTo(e.target.value)} /></Field>
          <Button type="button" disabled={busy !== ""} onClick={() => void run("pack", async () => {
            const r = (await pack({ from: packFrom || undefined, to: packTo })) as { fileName: string; url: string | null; data: string | null; audit: { hashChain: { ok: boolean } } };
            if (r.url) window.open(r.url, "_blank", "noopener");
            else if (r.data) download(r.fileName, base64ToBytes(r.data), "application/zip");
            return r;
          }, (r) => `Pack ready (${r.fileName}). Audit chain ${r.audit.hashChain.ok ? "intact" : "BROKEN – check Journals"}.${r.url ? " The link works for 24 hours." : ""}`)}>{busy === "pack" ? "Building…" : "Download ZIP"}</Button>
        </Row>
        <Muted>Trial balance, general ledger, journals, chart, open items, VAT returns and the audit hash check, as CSV files in one ZIP.</Muted>
        <span style={{ fontSize: 12, color: tokens.muted }}>{data.settings.r2Configured ? "Stored in the private bucket; you get a download link." : "Without the private bucket, small packs download directly."}</span>
      </Section>
    </div>
  );
}
