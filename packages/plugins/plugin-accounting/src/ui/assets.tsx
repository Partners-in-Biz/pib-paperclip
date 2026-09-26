import { useEffect, useState } from "react";
import { StatusBadge, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, Section, Sheet, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { AccountSelect, accountLabel, Muted, rand, Row, small, Table, Td, toCents, today, useRunner } from "./shared.js";

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

function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function AssetsTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const list = usePluginAction("accounting.assets");
  const save = usePluginAction("accounting.save-asset");
  const dispose = usePluginAction("accounting.dispose-asset");
  const depreciate = usePluginAction("accounting.run-depreciation");
  const fx = usePluginAction("accounting.fx");
  const fetchFx = usePluginAction("accounting.fetch-fx");
  const revalue = usePluginAction("accounting.revalue-fx");
  const { busy, run } = useRunner(onMessage);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [detail, setDetail] = useState<{ asset: Asset; schedule: ScheduleRow[] } | null>(null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [disposal, setDisposal] = useState<{ asset: Asset; date: string; proceeds: string; account: string } | null>(null);
  const [through, setThrough] = useState(lastMonth());
  const [rates, setRates] = useState<{ rates: Array<{ currency: string; rate: number; date: string }>; foreignItems: Array<{ key: string; number: string; kind: string; currency: string; outstandingMinor: number; counterpartyName: string }> } | null>(null);
  const [revalMonth, setRevalMonth] = useState(lastMonth());

  async function refresh() {
    setAssets(((await list({})) as { assets: Asset[] }).assets);
    setRates((await fx({})) as typeof rates);
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  const accounts = data.accounts;
  const main = ["USD", "EUR", "GBP", "AUD", "CAD", "CHF", "CNY", "JPY", "BWP", "NAD"];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section
        title="Fixed assets"
        actions={<Button type="button" variant="secondary" style={small} onClick={() => setForm({ name: "", category: "", cost: "", residual: "", life: "36", acquired: today(), start: today(), assetAccountCode: "", accumulatedAccountCode: "", expenseAccountCode: "", openingThrough: "", openingAccumulated: "" })}>+ Add asset</Button>}
      >
        {assets.length === 0 ? (
          <Muted>No assets yet. Straight-line depreciation posts monthly once an asset is registered.</Muted>
        ) : (
          <Table head={["Asset", { label: "Cost", right: true }, "Life", "Starts", "Status", ""]}>
            {assets.map((a) => (
              <tr key={a.id}>
                <Td>{a.name}{a.category ? <span style={{ color: tokens.muted }}> · {a.category}</span> : null}</Td>
                <Td right>{rand(a.costMinor)}</Td>
                <Td>{a.lifeMonths} months</Td>
                <Td>{a.depreciationStart}</Td>
                <Td><StatusBadge label={a.status === "disposed" ? `disposed ${a.disposedDate}` : "in use"} status={a.status === "disposed" ? "info" : "ok"} /></Td>
                <Td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" style={small} onClick={() => void run("detail", async () => setDetail((await list({ assetId: a.id })) as { asset: Asset; schedule: ScheduleRow[] }))}>Schedule</Button>
                    {a.status === "active" ? <Button type="button" variant="secondary" style={small} onClick={() => setDisposal({ asset: a, date: today(), proceeds: "", account: "" })}>Dispose</Button> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <Row>
          <Field label="Post depreciation through"><Input type="month" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("dep", async () => {
            const r = (await depreciate({ through })) as { posted: string[]; problems: string[] };
            await refresh();
            return r;
          }, (r) => (r.problems.length ? `Posted ${r.posted.length}; problems: ${r.problems.join("; ")}` : `Posted ${r.posted.length} depreciation journal(s).`))}>Run depreciation</Button>
        </Row>
        <Muted>The month-end job also posts depreciation each month (one journal per asset per month, never twice).</Muted>
      </Section>

      <Section title="FX rates and revaluation">
        <Row>
          <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("fx", async () => { const r = (await fetchFx({})) as { date: string; saved: number }; await refresh(); return r; }, (r) => `Stored ${r.saved} rates for ${r.date}.`)}>Fetch today's rates</Button>
          <Field label="Revalue at the end of"><Input type="month" value={revalMonth} onChange={(e) => setRevalMonth(e.target.value)} /></Field>
          <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("reval", async () => {
            const r = (await revalue({ month: revalMonth })) as { journal: { number: string } | null; reversal: { number: string } | null; skipped: Array<{ key: string; reason: string }>; already: boolean };
            await refresh();
            return r;
          }, (r) => (r.journal ? `${r.already ? "Already revalued" : "Posted"} ${r.journal.number}${r.reversal ? `, reversed by ${r.reversal.number} next month` : ""}.${r.skipped.length ? ` Skipped ${r.skipped.length}.` : ""}` : `Nothing to revalue.${r.skipped.length ? ` Skipped: ${r.skipped.map((s) => s.reason).join("; ")}` : ""}`))}>Revalue</Button>
        </Row>
        {rates?.foreignItems.length ? (
          <Table head={["Open item", "Currency", { label: "Outstanding", right: true }]}>
            {rates.foreignItems.map((i) => <tr key={i.key}><Td>{`${i.number} ${i.counterpartyName}`}</Td><Td>{i.currency}</Td><Td right>{(i.outstandingMinor / 100).toFixed(2)}</Td></tr>)}
          </Table>
        ) : <Muted>No open foreign-currency invoices or bills.</Muted>}
        {rates?.rates.length ? (
          <Muted>Latest rates (ZAR per unit): {rates.rates.filter((r) => main.includes(r.currency)).map((r) => `${r.currency} ${r.rate.toFixed(4)}`).join(" · ")} ({rates.rates[0]?.date})</Muted>
        ) : <Muted>No rates stored yet. The daily job fetches them from frankfurter.app.</Muted>}
      </Section>

      <Sheet open={!!detail} title={detail ? detail.asset.name : "Asset"} onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <span>{rand(detail.asset.costMinor)} · residual {rand(detail.asset.residualMinor)} · {detail.asset.lifeMonths} months</span>
            <Muted>{accountLabel(accounts, detail.asset.expenseAccountCode)} / {accountLabel(accounts, detail.asset.accumulatedAccountCode)}</Muted>
            <Table head={["Month", { label: "Charge", right: true }, { label: "Book value", right: true }, ""]}>
              {detail.schedule.map((s) => (
                <tr key={s.month}>
                  <Td>{s.month}</Td>
                  <Td right>{rand(s.amountMinor)}</Td>
                  <Td right>{rand(s.bookValueMinor)}</Td>
                  <Td muted>{s.beforeCutover ? "before cut-over" : s.posted ? s.journalNumber ?? "posted" : ""}</Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Sheet>

      <Modal
        open={!!form}
        title="Add asset"
        description="Straight-line over the useful life, from the month depreciation starts."
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
              <Field label="Cost (R, excl. VAT)"><Input value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
              <Field label="Residual (R)"><Input value={form.residual} onChange={(e) => setForm({ ...form, residual: e.target.value })} /></Field>
              <Field label="Life (months)"><Input value={form.life} onChange={(e) => setForm({ ...form, life: e.target.value })} /></Field>
            </Row>
            <Row>
              <Field label="Acquired"><Input type="date" value={form.acquired} onChange={(e) => setForm({ ...form, acquired: e.target.value })} /></Field>
              <Field label="Depreciation starts"><Input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            </Row>
            <Field label="Asset account (cost)"><AccountSelect accounts={accounts} value={form.assetAccountCode} onChange={(c) => setForm({ ...form, assetAccountCode: c })} filter={(a) => a.subtype === "fixed_asset"} placeholder="Default (fixed assets role)" /></Field>
            <Field label="Accumulated depreciation"><AccountSelect accounts={accounts} value={form.accumulatedAccountCode} onChange={(c) => setForm({ ...form, accumulatedAccountCode: c })} filter={(a) => a.subtype === "accumulated_depreciation"} placeholder="Default" /></Field>
            <Field label="Depreciation expense"><AccountSelect accounts={accounts} value={form.expenseAccountCode} onChange={(c) => setForm({ ...form, expenseAccountCode: c })} filter={(a) => a.type === "expense"} placeholder="Default" /></Field>
            <Muted>Bought before cut-over? Give the last month already depreciated in the old books; months up to it are not posted again.</Muted>
            <Row>
              <Field label="Depreciated before cut-over up to"><Input type="month" value={form.openingThrough} onChange={(e) => setForm({ ...form, openingThrough: e.target.value })} /></Field>
              <Field label="Accumulated at cut-over (R)"><Input value={form.openingAccumulated} onChange={(e) => setForm({ ...form, openingAccumulated: e.target.value })} /></Field>
            </Row>
          </>
        ) : null}
      </Modal>

      <Modal
        open={!!disposal}
        title={disposal ? `Dispose of ${disposal.asset.name}` : "Dispose"}
        description="Depreciation catches up to the month before; the asset and its accumulated depreciation come off the books and the profit or loss is posted."
        onClose={() => setDisposal(null)}
        footer={
          <Button type="button" disabled={busy !== ""} onClick={() => disposal && void run("dispose", async () => {
            const r = (await dispose({ assetId: disposal.asset.id, date: disposal.date, proceedsMinor: toCents(disposal.proceeds) ?? 0, proceedsAccountCode: disposal.account || undefined })) as { journal: { number: string }; gainMinor: number };
            setDisposal(null);
            await refresh();
            return r;
          }, (r) => `Posted ${r.journal.number}; ${r.gainMinor >= 0 ? "profit" : "loss"} of ${rand(Math.abs(r.gainMinor))}.`)}>Dispose</Button>
        }
      >
        {disposal ? (
          <>
            <Field label="Date"><Input type="date" value={disposal.date} onChange={(e) => setDisposal({ ...disposal, date: e.target.value })} /></Field>
            <Field label="Proceeds (R, excl. VAT)"><Input value={disposal.proceeds} onChange={(e) => setDisposal({ ...disposal, proceeds: e.target.value })} /></Field>
            <Field label="Proceeds went to"><AccountSelect accounts={accounts} value={disposal.account} onChange={(c) => setDisposal({ ...disposal, account: c })} placeholder="Bank (default)" /></Field>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
