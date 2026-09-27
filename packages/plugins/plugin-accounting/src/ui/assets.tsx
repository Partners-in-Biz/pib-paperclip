import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, Field, Input, Modal, Section, Sheet, formatDate, formatMoney, formatMonth, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { AccountSelect, accountLabel, Muted, Row, small, StatusPill, Table, Td, toCents, today, useRunner } from "./shared.js";

interface Asset {
  id: string;
  name: string;
  category: string;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  expenseAccountCode: string;
  costMinor: number;
  residualMinor: number;
  lifeMonths: number;
  acquiredDate: string;
  depreciationStart: string;
  openingThrough: string | null;
  status: string;
  disposedDate: string | null;
}

interface ScheduleRow {
  month: string;
  amountMinor: number;
  accumulatedMinor: number;
  bookValueMinor: number;
  posted: boolean;
  beforeCutover: boolean;
  journalNumber: string | null;
}

interface FxView {
  rates: Array<{ currency: string; rate: number; date: string }>;
  foreignItems: Array<{ key: string; number: string; kind: string; currency: string; outstandingMinor: number; counterpartyName: string }>;
}

function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Rand per unit of a currency: `R 18.20` (four decimals under R 1). */
function randPerUnit(rate: number): string {
  return `R ${rate >= 1 ? rate.toFixed(2) : rate.toFixed(4)}`;
}

const MAIN_CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "CHF", "CNY", "JPY", "BWP", "NAD"];

export function AssetsTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const narrow = useIsNarrow();
  const list = usePluginAction("accounting.assets");
  const save = usePluginAction("accounting.save-asset");
  const dispose = usePluginAction("accounting.dispose-asset");
  const depreciate = usePluginAction("accounting.run-depreciation");
  const fx = usePluginAction("accounting.fx");
  const fetchFx = usePluginAction("accounting.fetch-fx");
  const revalue = usePluginAction("accounting.revalue-fx");
  const { busy, run } = useRunner(onMessage);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [detail, setDetail] = useState<{ asset: Asset; schedule: ScheduleRow[] } | null>(null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [disposal, setDisposal] = useState<{ asset: Asset; date: string; proceeds: string; account: string } | null>(null);
  const [through, setThrough] = useState(lastMonth());
  const [rates, setRates] = useState<FxView | null>(null);
  const [revalMonth, setRevalMonth] = useState(lastMonth());

  async function refresh() {
    setAssets(((await list({})) as { assets: Asset[] }).assets);
    setRates((await fx({})) as FxView);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  const accounts = data.accounts;
  const openDetail = (a: Asset) => void run("detail", async () => setDetail((await list({ assetId: a.id })) as { asset: Asset; schedule: ScheduleRow[] }));
  const startDisposal = (a: Asset) => {
    setDetail(null);
    setDisposal({ asset: a, date: today(), proceeds: "", account: "" });
  };
  const statusLabel = (a: Asset) => (a.status === "disposed" ? `Sold or scrapped ${a.disposedDate ? formatDate(a.disposedDate) : ""}`.trim() : "In use");
  const shownRates = rates?.rates.filter((r) => MAIN_CURRENCIES.includes(r.currency)) ?? [];

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Section
        title="Fixed assets"
        actions={<Button type="button" variant="secondary" style={small} onClick={() => setForm({ name: "", category: "", cost: "", residual: "", life: "36", acquired: today(), start: today(), assetAccountCode: "", accumulatedAccountCode: "", expenseAccountCode: "", openingThrough: "", openingAccumulated: "" })}>+ Add asset</Button>}
      >
        {assets === null ? (
          <Muted>Loading…</Muted>
        ) : assets.length === 0 ? (
          <Muted>No assets yet. Add equipment you will use for more than a year (laptops, furniture, vehicles); its cost is then spread over its useful life, month by month.</Muted>
        ) : narrow ? (
          <CompactRows
            rows={assets}
            label="Fixed assets"
            title={(a) => a.name}
            meta={(a) => [statusLabel(a), `${a.lifeMonths} months from ${formatDate(a.depreciationStart)}`].join(" · ")}
            trailing={(a) => formatMoney(a.costMinor)}
            onOpen={openDetail}
          />
        ) : (
          <Table head={["Asset", { label: "Cost", right: true }, "Useful life", "Depreciation starts", "Status", ""]}>
            {assets.map((a) => (
              <tr key={a.id}>
                <Td>{a.name}{a.category ? <span style={{ color: tokens.muted }}> · {a.category}</span> : null}</Td>
                <Td right>{formatMoney(a.costMinor)}</Td>
                <Td>{a.lifeMonths} months</Td>
                <Td>{formatDate(a.depreciationStart)}</Td>
                <Td><StatusPill status={a.status === "disposed" ? "disposed" : "in_use"} label={statusLabel(a)} /></Td>
                <Td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" style={small} onClick={() => openDetail(a)}>Schedule</Button>
                    {a.status === "active" ? <Button type="button" variant="secondary" style={small} onClick={() => startDisposal(a)}>Sell or scrap</Button> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          <div style={{ flex: "0 1 200px", minWidth: 0 }}>
            <Field label="Post depreciation up to"><Input type="month" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          </div>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("dep", async () => {
            const r = (await depreciate({ through })) as { posted: string[]; problems: string[] };
            await refresh();
            return r;
          }, (r) => (r.problems.length ? `Posted ${r.posted.length}; problems: ${r.problems.join("; ")}` : `Posted ${r.posted.length} depreciation journal${r.posted.length === 1 ? "" : "s"}.`))}>Run depreciation</Button>
        </div>
        <Muted>The month-end job also posts depreciation each month (one journal per asset per month, never twice).</Muted>
      </Section>

      <Section title="Foreign currency (FX)">
        <Muted>Exchange rates to rand, and the month-end revaluation of invoices and bills in other currencies.</Muted>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          <div style={{ flex: "0 1 200px", minWidth: 0 }}>
            <Field label="Revalue at the end of"><Input type="month" value={revalMonth} onChange={(e) => setRevalMonth(e.target.value)} /></Field>
          </div>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("reval", async () => {
            const r = (await revalue({ month: revalMonth })) as { journal: { number: string } | null; reversal: { number: string } | null; skipped: Array<{ key: string; reason: string }>; already: boolean };
            await refresh();
            return r;
          }, (r) => (r.journal ? `${r.already ? "Already revalued" : "Posted"} ${r.journal.number}${r.reversal ? `, reversed by ${r.reversal.number} next month` : ""}.${r.skipped.length ? ` Skipped ${r.skipped.length}.` : ""}` : `Nothing to revalue.${r.skipped.length ? ` Skipped: ${r.skipped.map((s) => s.reason).join("; ")}` : ""}`))}>Revalue</Button>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("fx", async () => { const r = (await fetchFx({})) as { date: string; saved: number }; await refresh(); return r; }, (r) => `Stored ${r.saved} rates for ${formatDate(r.date)}.`)}>Get today's rates</Button>
        </div>
        {rates?.foreignItems.length ? (
          <Table head={["Open invoice or bill", "Currency", { label: "Still owed", right: true }]}>
            {rates.foreignItems.map((i) => <tr key={i.key}><Td>{`${i.number} ${i.counterpartyName}`}</Td><Td>{i.currency}</Td><Td right>{formatMoney(i.outstandingMinor, i.currency)}</Td></tr>)}
          </Table>
        ) : <Muted>No open invoices or bills in other currencies.</Muted>}
        {shownRates.length ? (
          <Muted>Latest rates ({formatDate(shownRates[0]!.date)}): {shownRates.map((r) => `1 ${r.currency} = ${randPerUnit(r.rate)}`).join(" · ")}</Muted>
        ) : <Muted>No exchange rates yet. They are fetched every afternoon.</Muted>}
      </Section>

      <Sheet open={!!detail} title={detail ? detail.asset.name : "Asset"} onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <span>Cost {formatMoney(detail.asset.costMinor)} · worth {formatMoney(detail.asset.residualMinor)} at the end · {detail.asset.lifeMonths} months</span>
            <Muted>Expense account: {accountLabel(accounts, detail.asset.expenseAccountCode)}. Depreciation so far: {accountLabel(accounts, detail.asset.accumulatedAccountCode)}.</Muted>
            {detail.asset.status === "active" ? (
              <div><Button type="button" variant="secondary" onClick={() => startDisposal(detail.asset)}>Sell or scrap</Button></div>
            ) : null}
            <Table head={["Month", { label: "Depreciation", right: true }, { label: "Value after", right: true }, ""]}>
              {detail.schedule.map((s) => (
                <tr key={s.month}>
                  <Td>{formatMonth(s.month)}</Td>
                  <Td right>{formatMoney(s.amountMinor)}</Td>
                  <Td right>{formatMoney(s.bookValueMinor)}</Td>
                  <Td muted>{s.beforeCutover ? "In previous books" : s.posted ? s.journalNumber ?? "Posted" : ""}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Sheet>

      <Modal
        open={!!form}
        title="Add asset"
        description="Its cost, less what it is worth at the end, is spread evenly over its useful life from the month depreciation starts."
        onClose={() => setForm(null)}
        footer={
          <Button type="button" disabled={busy !== ""} onClick={() => form && void run("save", async () => {
            await save({
              name: form.name,
              category: form.category,
              costMinor: toCents(form.cost ?? ""),
              residualMinor: toCents(form.residual ?? "") ?? 0,
              lifeMonths: Number(form.life),
              acquiredDate: form.acquired,
              depreciationStart: form.start || form.acquired,
              assetAccountCode: form.assetAccountCode || undefined,
              accumulatedAccountCode: form.accumulatedAccountCode || undefined,
              expenseAccountCode: form.expenseAccountCode || undefined,
              openingThrough: form.openingThrough || null,
              openingAccumulatedMinor: toCents(form.openingAccumulated ?? "") ?? 0,
            });
            setForm(null);
            await refresh();
          }, "Asset added.")}>Add</Button>
        }
      >
        {form ? (
          <>
            <Row>
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Computers" /></Field>
            </Row>
            <Row>
              <Field label="Cost (R, excl. VAT)"><Input inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
              <Field label="Worth at the end (R)"><Input inputMode="decimal" value={form.residual} onChange={(e) => setForm({ ...form, residual: e.target.value })} /></Field>
              <Field label="Useful life (months)"><Input inputMode="numeric" value={form.life} onChange={(e) => setForm({ ...form, life: e.target.value })} /></Field>
            </Row>
            <Row>
              <Field label="Bought on"><Input type="date" value={form.acquired} onChange={(e) => setForm({ ...form, acquired: e.target.value })} /></Field>
              <Field label="Depreciation starts"><Input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            </Row>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32, display: "flex", alignItems: "center" }}>Accounts (optional)</summary>
              <div style={{ display: "grid", gap: 10, paddingTop: 8 }}>
                <Field label="Asset account (cost)"><AccountSelect accounts={accounts} value={form.assetAccountCode} onChange={(c) => setForm({ ...form, assetAccountCode: c })} filter={(a) => a.subtype === "fixed_asset"} placeholder="Default account" fullWidth /></Field>
                <Field label="Depreciation so far (accumulated)"><AccountSelect accounts={accounts} value={form.accumulatedAccountCode} onChange={(c) => setForm({ ...form, accumulatedAccountCode: c })} filter={(a) => a.subtype === "accumulated_depreciation"} placeholder="Default account" fullWidth /></Field>
                <Field label="Depreciation expense"><AccountSelect accounts={accounts} value={form.expenseAccountCode} onChange={(c) => setForm({ ...form, expenseAccountCode: c })} filter={(a) => a.type === "expense"} placeholder="Default account" fullWidth /></Field>
              </div>
            </details>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32, display: "flex", alignItems: "center" }}>Bought before these books started?</summary>
              <div style={{ display: "grid", gap: 10, paddingTop: 8 }}>
                <Muted>Give the last month your previous books already depreciated; months up to it are not posted again.</Muted>
                <Row>
                  <Field label="Depreciated in previous books up to"><Input type="month" value={form.openingThrough} onChange={(e) => setForm({ ...form, openingThrough: e.target.value })} /></Field>
                  <Field label="Depreciation so far (R)"><Input inputMode="decimal" value={form.openingAccumulated} onChange={(e) => setForm({ ...form, openingAccumulated: e.target.value })} /></Field>
                </Row>
              </div>
            </details>
          </>
        ) : null}
      </Modal>

      <Modal
        open={!!disposal}
        title={disposal ? `Sell or scrap ${disposal.asset.name}` : "Sell or scrap"}
        description="Depreciation is brought up to date, the asset comes off the books, and any profit or loss on it is posted."
        onClose={() => setDisposal(null)}
        footer={
          <Button type="button" disabled={busy !== ""} onClick={() => disposal && void run("dispose", async () => {
            const r = (await dispose({ assetId: disposal.asset.id, date: disposal.date, proceedsMinor: toCents(disposal.proceeds) ?? 0, proceedsAccountCode: disposal.account || undefined })) as { journal: { number: string }; gainMinor: number };
            setDisposal(null);
            await refresh();
            return r;
          }, (r) => `Posted ${r.journal.number}; ${r.gainMinor >= 0 ? "profit" : "loss"} of ${formatMoney(Math.abs(r.gainMinor))}.`)}>Post it</Button>
        }
      >
        {disposal ? (
          <>
            <Field label="Date"><Input type="date" value={disposal.date} onChange={(e) => setDisposal({ ...disposal, date: e.target.value })} /></Field>
            <Field label="Sold for (R, excl. VAT; 0 if scrapped)"><Input inputMode="decimal" value={disposal.proceeds} onChange={(e) => setDisposal({ ...disposal, proceeds: e.target.value })} /></Field>
            <Field label="Money went to"><AccountSelect accounts={accounts} value={disposal.account} onChange={(c) => setDisposal({ ...disposal, account: c })} placeholder="Bank (default)" fullWidth /></Field>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
