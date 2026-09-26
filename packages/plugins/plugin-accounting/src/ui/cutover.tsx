import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, TextArea } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { Banner, Muted, rand, Row, Table, Td, useRunner } from "./shared.js";

interface Preview {
  lines: Array<{ code: string; name: string; accountName: string | null; debitMinor: number; creditMinor: number }>;
  totalDebitMinor: number;
  totalCreditMinor: number;
  differenceMinor: number;
  balanced: boolean;
  unknownCodes: string[];
  inactiveCodes: string[];
  checks: {
    receivables: { trialBalanceMinor: number; openItemsMinor: number; count: number };
    payables: { trialBalanceMinor: number; openItemsMinor: number; count: number };
  };
  existingOpeningJournalId: string | null;
}

export function CutoverTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const preview = usePluginAction("accounting.cutover-preview");
  const post = usePluginAction("accounting.cutover-post");
  const { busy, run } = useRunner(onMessage);
  const [csv, setCsv] = useState("");
  const [date, setDate] = useState(data.book.cutoverDate ?? "");
  const [result, setResult] = useState<Preview | null>(null);
  const [toEquity, setToEquity] = useState(false);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section title="Opening balances">
        {data.book.openingJournalId ? (
          <Banner tone="ok"><span>Opening balances are posted{data.book.cutoverDate ? ` at ${data.book.cutoverDate}` : ""}. To replace them, reverse the opening journal under Journals first.</span></Banner>
        ) : (
          <Muted>
            Import the trial balance from the old books at the cut-over date (usually the day before the first month kept here). It posts as one opening journal. Open invoices and bills come from Billing; the check below compares them with the trial balance's receivables and payables.
          </Muted>
        )}
        <Muted>CSV columns: <code>code, name, debit, credit</code> (or <code>code, balance</code> with debits positive). Codes must exist in the chart.</Muted>
        <Row>
          <Field label="CSV file">
            <input type="file" accept=".csv,.txt" style={{ fontSize: 13 }} onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(setCsv);
            }} />
          </Field>
          <Field label="Cut-over date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </Row>
        <TextArea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"code,name,debit,credit\n1000,Bank,125000.00,\n3100,Retained earnings,,125000.00"} style={{ minHeight: 140, fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
        <Row>
          <Button type="button" variant="secondary" disabled={!csv.trim() || busy !== ""} onClick={() => void run("preview", async () => setResult((await preview({ csv })) as Preview))}>Check</Button>
        </Row>
      </Section>

      {result ? (
        <Section title="Check">
          {result.unknownCodes.length ? <Banner tone="warn"><span>Not in the chart: {result.unknownCodes.join(", ")}. Add them under Chart &amp; roles first.</span></Banner> : null}
          {result.balanced ? <Banner tone="ok"><span>The trial balance balances.</span></Banner> : <Banner tone="warn"><span>Out of balance by {rand(result.differenceMinor)} (debits minus credits).</span></Banner>}
          <Table
            head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]}
            footer={<tr><Td strong>Total</Td><Td right strong>{rand(result.totalDebitMinor)}</Td><Td right strong>{rand(result.totalCreditMinor)}</Td></tr>}
          >
            {result.lines.map((l) => (
              <tr key={l.code}><Td>{`${l.code} ${l.accountName ?? l.name ?? ""}`}</Td><Td right>{l.debitMinor ? rand(l.debitMinor) : ""}</Td><Td right>{l.creditMinor ? rand(l.creditMinor) : ""}</Td></tr>
            ))}
          </Table>
          <Table head={["", { label: "Trial balance", right: true }, { label: "Open in Billing", right: true }]}>
            <tr><Td>Receivables ({result.checks.receivables.count} open)</Td><Td right>{rand(result.checks.receivables.trialBalanceMinor)}</Td><Td right>{rand(result.checks.receivables.openItemsMinor)}</Td></tr>
            <tr><Td>Payables ({result.checks.payables.count} open)</Td><Td right>{rand(result.checks.payables.trialBalanceMinor)}</Td><Td right>{rand(result.checks.payables.openItemsMinor)}</Td></tr>
          </Table>
          {!result.balanced ? (
            <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={toEquity} onChange={(e) => setToEquity(e.target.checked)} /> Post the difference to opening balance equity (your accountant clears it later)
            </label>
          ) : null}
          <Row>
            <Button type="button" disabled={!date || busy !== "" || result.unknownCodes.length > 0 || (!result.balanced && !toEquity) || Boolean(data.book.openingJournalId)} onClick={() => void run("post", async () => {
              const r = (await post({ csv, date, balanceToEquity: toEquity })) as { journal: { number: string } };
              return r;
            }, (r) => `Opening balances posted as ${r.journal.number}. Reload the page to see them in the reports.`)}>Post opening balances</Button>
          </Row>
        </Section>
      ) : null}
    </div>
  );
}
