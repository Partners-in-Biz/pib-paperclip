import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CalendarCheck, Field, Input, Modal, SectionCard, TextArea, formatDate, formatMoney, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { Banner, Details, Muted, Row, small, Table, Td, useRunner } from "./shared.js";

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

const linkButton = { border: "none", background: "transparent", padding: 0, color: tokens.primary, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" } as const;

/**
 * Opening balances: bring over the previous books' closing balances as one
 * opening journal, or say the business started on these books (nothing to
 * bring over). Posting opening balances later undoes that.
 */
export function CutoverTab({ data, onMessage, onChanged, onOpen }: { data: LoadResult; onMessage: (m: string) => void; onChanged: () => Promise<void>; onOpen: (view: string) => void }) {
  const skip = usePluginAction("accounting.skip-cutover");
  const undoSkip = usePluginAction("accounting.undo-skip-cutover");
  const { busy, run } = useRunner(onMessage);
  const [confirming, setConfirming] = useState(false);
  const book = data.book;
  const skippedAt = book.cutoverSkippedAt ?? null;

  if (book.openingJournalId) {
    return (
      <SectionCard title="Opening balances" icon={CalendarCheck} tone="ok">
        <Banner tone="ok">
          <span>Opening balances from your previous books are posted{book.cutoverDate ? ` as at ${formatDate(book.cutoverDate)}` : ""}. The balance sheet starts from them.</span>
        </Banner>
        <Muted>
          To replace them, reverse the opening journal under{" "}
          <button type="button" onClick={() => onOpen("journals")} style={linkButton}>Journals</button> first, then post the new trial balance here.
        </Muted>
      </SectionCard>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {skippedAt ? (
        <SectionCard title="Opening balances" icon={CalendarCheck} tone="ok">
          <Banner tone="ok">
            <span>You started on these books (confirmed {formatDate(skippedAt)}), so balances start at zero. There is nothing to bring over.</span>
          </Banner>
          <Row>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("undo", async () => {
              await undoSkip({});
              await onChanged();
            }, "Undone. Bring over the balances from your previous books below, or say again that you started on these books.")}>Undo</Button>
          </Row>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32, display: "flex", alignItems: "center" }}>Found earlier books after all? Bring over their balances</summary>
            <div style={{ paddingTop: 10 }}>
              <OpeningBalancesForm data={data} onMessage={onMessage} onChanged={onChanged} onOpen={onOpen} />
            </div>
          </details>
        </SectionCard>
      ) : (
        <SectionCard
          title="Opening balances"
          icon={CalendarCheck}
          subtitle="Bring over the closing balances from your previous books, so the balance sheet starts from the right figures."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
            <span style={{ flex: "1 1 240px", minWidth: 0, fontSize: 13, lineHeight: 1.45 }}>
              <strong>No earlier books?</strong> If the business started trading on these books, there is nothing to bring over.
            </span>
            <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => setConfirming(true)}>We started on these books</Button>
          </div>
          <OpeningBalancesForm data={data} onMessage={onMessage} onChanged={onChanged} onOpen={onOpen} />
        </SectionCard>
      )}

      <Modal
        open={confirming}
        title="We started on these books"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" disabled={busy !== ""} onClick={() => void run("skip", async () => {
              await skip({});
              setConfirming(false);
              await onChanged();
            }, "Saved: you started on these books, so balances start at zero.")}>{busy === "skip" ? "Saving…" : "Yes, we started on these books"}</Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 10, fontSize: 13.5, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>Use this only when there are <strong>no earlier books</strong> to bring over: the business started trading on these books.</p>
          <p style={{ margin: 0 }}>Balances start at zero, and the warning about opening balances goes away.</p>
          <p style={{ margin: 0, color: tokens.muted }}>Found earlier books later? You can still post their opening balances here, and that undoes this.</p>
        </div>
      </Modal>
    </div>
  );
}

/** Import the trial balance from the previous books: check it, then post it as one opening journal. */
function OpeningBalancesForm({ data, onMessage, onChanged, onOpen }: { data: LoadResult; onMessage: (m: string) => void; onChanged: () => Promise<void>; onOpen: (view: string) => void }) {
  const narrow = useIsNarrow();
  const preview = usePluginAction("accounting.cutover-preview");
  const post = usePluginAction("accounting.cutover-post");
  const { busy, run } = useRunner(onMessage);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [date, setDate] = useState(data.book.cutoverDate ?? "");
  const [result, setResult] = useState<Preview | null>(null);
  const [toEquity, setToEquity] = useState(false);

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 10 }}>
        <Field label="Trial balance from the previous books (CSV)">
          <input
            type="file"
            accept=".csv,.txt"
            style={{ fontSize: 13, minHeight: 36, maxWidth: "100%" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFileName(f.name);
                setResult(null);
                void f.text().then(setCsv);
              }
            }}
          />
        </Field>
        <Field label="Cut-over date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Muted>The cut-over date is the last day kept in the previous books, usually the day before the first month kept here. The balances are as at the end of that day.</Muted>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32, display: "flex", alignItems: "center" }}>{fileName ? `Loaded ${fileName}. See or edit the text` : "Or paste the CSV text"}</summary>
        <div style={{ display: "grid", gap: 6, paddingTop: 8 }}>
          <TextArea aria-label="Trial balance CSV" value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); }} placeholder={"code,name,debit,credit\n1000,Bank,125000.00,\n3100,Retained earnings,,125000.00"} style={{ minHeight: 140, fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
        </div>
      </details>
      <Details summary="What the file should look like">
        <span>Columns <code>code, name, debit, credit</code>, or <code>code, balance</code> with debits as positive amounts. A header row first.</span>
        <span>Every code must be an account in your chart (Books setup → Chart &amp; roles).</span>
      </Details>
      <Row>
        <Button type="button" variant="secondary" disabled={!csv.trim() || busy !== ""} onClick={() => void run("preview", async () => setResult((await preview({ csv })) as Preview))}>{busy === "preview" ? "Checking…" : "Check"}</Button>
      </Row>

      {result ? (
        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
          {result.unknownCodes.length ? (
            <Banner tone="warn">
              <span>
                Not in your chart: {result.unknownCodes.join(", ")}. Add them under{" "}
                <button type="button" onClick={() => onOpen("chart")} style={linkButton}>Chart &amp; roles</button> first.
              </span>
            </Banner>
          ) : null}
          {result.balanced
            ? <Banner tone="ok"><span>The trial balance balances.</span></Banner>
            : <Banner tone="warn"><span>Out of balance by {formatMoney(result.differenceMinor)} (debits minus credits).</span></Banner>}
          <Table
            head={["Account", { label: "Debit", right: true }, { label: "Credit", right: true }]}
            footer={<tr><Td strong>Total</Td><Td right strong>{formatMoney(result.totalDebitMinor)}</Td><Td right strong>{formatMoney(result.totalCreditMinor)}</Td></tr>}
          >
            {result.lines.map((l) => (
              <tr key={l.code}><Td>{`${l.code} ${l.accountName ?? l.name ?? ""}`}</Td><Td right>{l.debitMinor ? formatMoney(l.debitMinor) : ""}</Td><Td right>{l.creditMinor ? formatMoney(l.creditMinor) : ""}</Td></tr>
            ))}
          </Table>
          <Table head={["Compared with Billing", { label: "Trial balance", right: true }, { label: "Open in Billing", right: true }]}>
            <tr><Td>Money owed to you ({result.checks.receivables.count} open invoice{result.checks.receivables.count === 1 ? "" : "s"})</Td><Td right>{formatMoney(result.checks.receivables.trialBalanceMinor)}</Td><Td right>{formatMoney(result.checks.receivables.openItemsMinor)}</Td></tr>
            <tr><Td>Money you owe ({result.checks.payables.count} open bill{result.checks.payables.count === 1 ? "" : "s"})</Td><Td right>{formatMoney(result.checks.payables.trialBalanceMinor)}</Td><Td right>{formatMoney(result.checks.payables.openItemsMinor)}</Td></tr>
          </Table>
          {!result.balanced ? (
            <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
              <input type="checkbox" checked={toEquity} onChange={(e) => setToEquity(e.target.checked)} /> Post the difference to opening balance equity (your accountant clears it later)
            </label>
          ) : null}
          <Row>
            <Button type="button" disabled={!date || busy !== "" || result.unknownCodes.length > 0 || (!result.balanced && !toEquity)} onClick={() => void run("post", async () => {
              const r = (await post({ csv, date, balanceToEquity: toEquity })) as { journal: { number: string } };
              await onChanged();
              return r;
            }, (r) => `Opening balances posted as ${r.journal.number}.`)}>{busy === "post" ? "Posting…" : "Post opening balances"}</Button>
            {!date ? <span style={{ fontSize: 12.5, color: tokens.muted }}>Choose the cut-over date first.</span> : null}
          </Row>
        </div>
      ) : null}
    </div>
  );
}
