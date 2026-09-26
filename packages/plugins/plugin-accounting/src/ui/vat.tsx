import { useEffect, useState } from "react";
import { StatusBadge, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { Banner, centsToInput, download, IssueLink, Muted, rand, Row, small, statusTone, Table, Td, toCents, useRunner, words } from "./shared.js";

interface VatReturn {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  boxes: Record<string, number>;
  detail: Array<{ direction: string; taxCode: string; field: string; baseMinor: number; taxMinor: number; journals: number }>;
  adjustments: Record<string, number>;
  approvalIssueId: string | null;
}

interface VatData {
  category: string;
  periods: Array<{ start: string; end: string; current: boolean; returnId: string | null; status: string; payableMinor: number | null }>;
  returns: VatReturn[];
  labels: Record<string, string>;
  fields: string[];
  manualFields: string[];
}

const SHOWN = ["f1", "f1A", "f2", "f2A", "f3", "f4", "f4A", "f10", "f11", "f12", "f13", "f14", "f14A", "f15", "f15A", "f16", "f17", "f18", "f19", "f20"];

export function VatTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const load = usePluginAction("accounting.vat");
  const prepare = usePluginAction("accounting.prepare-vat");
  const request = usePluginAction("accounting.request-vat-approval");
  const approve = usePluginAction("accounting.approve-vat");
  const csv = usePluginAction("accounting.vat-csv");
  const { busy, run } = useRunner(onMessage);
  const [vat, setVat] = useState<VatData | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);
  const [ret, setRet] = useState<VatReturn | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adj, setAdj] = useState<Record<string, string>>({});

  async function refresh() {
    const v = (await load({})) as VatData;
    setVat(v);
    return v;
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  function choose(p: { start: string; end: string }, v = vat) {
    setPeriod(p);
    const existing = v?.returns.find((r) => r.periodStart === p.start && r.periodEnd === p.end) ?? null;
    setRet(existing);
    setWarnings([]);
    setAdj(Object.fromEntries(Object.entries(existing?.adjustments ?? {}).map(([k, n]) => [k, centsToInput(n)])));
  }

  async function doPrepare() {
    if (!period) return;
    const adjustments = Object.fromEntries(Object.entries(adj).map(([k, v]) => [k, toCents(v) ?? 0]));
    const r = (await prepare({ periodStart: period.start, periodEnd: period.end, adjustments })) as { vatReturn: VatReturn; warnings: string[] };
    setRet(r.vatReturn);
    setWarnings(r.warnings);
    await refresh();
  }

  if (!vat) return <Muted>Loading…</Muted>;
  if (vat.category === "none") return <Banner><span>The company is set as not VAT-registered. Choose a VAT category in the Accounting settings to prepare VAT201 returns.</span></Banner>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section title={`VAT periods (category ${vat.category})`}>
        <Table head={["Period", "Status", { label: "Payable / (refund)", right: true }, ""]}>
          {vat.periods.map((p) => (
            <tr key={p.start}>
              <Td>{`${p.start} to ${p.end}`}{p.current ? <span style={{ color: tokens.muted }}> · current</span> : null}</Td>
              <Td><StatusBadge label={words(p.status)} status={statusTone(p.status)} /></Td>
              <Td right>{p.payableMinor == null ? "—" : rand(p.payableMinor)}</Td>
              <Td><Button type="button" variant="secondary" style={small} onClick={() => choose(p)}>Open</Button></Td>
            </tr>
          ))}
        </Table>
        <Muted>The return is built from the VAT codes on journal lines (invoices, bills, bank categorisation, manual journals). Approving it locks the period, so nothing dated inside it can post afterwards. Filing on SARS eFiling stays with you.</Muted>
      </Section>

      {period ? (
        <Section title={`VAT201 ${period.start} to ${period.end}`} actions={ret ? <StatusBadge label={words(ret.status)} status={statusTone(ret.status)} /> : null}>
          {(!ret || ret.status === "draft") ? (
            <>
              <strong style={{ fontSize: 13 }}>Adjustments (entered by hand, rand)</strong>
              <Row>
                {vat.manualFields.map((f) => (
                  <Field key={f} label={vat.labels[f] ?? f}>
                    <Input style={{ width: 130, minWidth: 110 }} value={adj[f] ?? ""} onChange={(e) => setAdj({ ...adj, [f]: e.target.value })} />
                  </Field>
                ))}
              </Row>
              <Row>
                <Button type="button" disabled={busy !== ""} onClick={() => void run("prepare", doPrepare, "Prepared from the journals.")}>{busy === "prepare" ? "Preparing…" : ret ? "Prepare again" : "Prepare"}</Button>
                {ret ? (
                  <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("request", async () => { setRet((await request({ returnId: ret.id })) as VatReturn); await refresh(); }, "Approval issue opened.")}>Request approval</Button>
                ) : null}
              </Row>
            </>
          ) : null}
          {ret?.status === "pending_approval" ? (
            <Row>
              <Button type="button" disabled={busy !== ""} onClick={() => void run("approve", async () => { setRet((await approve({ returnId: ret.id })) as VatReturn); await refresh(); }, "Approved and locked.")}>Approve and lock</Button>
              {ret.approvalIssueId ? <span style={{ fontSize: 12 }}>Approval: <IssueLink id={ret.approvalIssueId} /></span> : null}
            </Row>
          ) : null}
          {warnings.length ? <Banner tone="warn">{warnings.map((w) => <span key={w}>{w}</span>)}</Banner> : null}
          {ret ? (
            <>
              <Table head={["Field", { label: "Amount", right: true }]}>
                {SHOWN.map((f) => (
                  <tr key={f}>
                    <Td strong={f === "f13" || f === "f19" || f === "f20"}>{vat.labels[f] ?? f}</Td>
                    <Td right strong={f === "f13" || f === "f19" || f === "f20"}>{rand(Number(ret.boxes[f] ?? 0))}</Td>
                  </tr>
                ))}
              </Table>
              {ret.detail.length ? (
                <Table head={["Direction", "Code", "Field", { label: "Base", right: true }, { label: "VAT", right: true }, { label: "Journals", right: true }]}>
                  {ret.detail.map((d, i) => (
                    <tr key={i}>
                      <Td>{d.direction}</Td>
                      <Td>{d.taxCode}</Td>
                      <Td>{d.field}</Td>
                      <Td right>{rand(d.baseMinor)}</Td>
                      <Td right>{rand(d.taxMinor)}</Td>
                      <Td right>{d.journals}</Td>
                    </tr>
                  ))}
                </Table>
              ) : null}
              <Row>
                <Button type="button" variant="secondary" style={small} onClick={() => void run("csv", async () => {
                  const r = (await csv({ returnId: ret.id })) as { fileName: string; csv: string };
                  download(r.fileName, r.csv, "text/csv");
                })}>Export CSV</Button>
              </Row>
            </>
          ) : (
            <Muted>Not prepared yet.</Muted>
          )}
          {data.settings.vatNumber ? null : <Muted>Add the VAT number in the settings so it prints on the export.</Muted>}
        </Section>
      ) : null}
    </div>
  );
}
