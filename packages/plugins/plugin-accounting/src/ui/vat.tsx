import { useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, Field, Input, Pill, SectionCard, Stamp, formatDate, formatMoney, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { periodLabel, readableDates } from "../domain/dates.js";
import type { LoadResult } from "./overview.js";
import { vatCategoryText, vatPeriodState } from "./series.js";
import { approveBlocked, Banner, centsToInput, Details, download, IssueLink, Muted, ReviewBadge, ReviewOverride, Row, small, statusTone, Table, taxLabel, Td, toCents, today, useRunner, type ReviewInfo } from "./shared.js";

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

interface VatPeriod {
  start: string;
  end: string;
  current: boolean;
  dueDate?: string;
  returnId: string | null;
  status: string;
  payableMinor: number | null;
}

interface VatData {
  category: string;
  /** The first day these books cover, and where that comes from. */
  booksStart?: { date: string; from: "cutover" | "first_journal" | "set_up" } | null;
  /** Periods left out because they ended before the books start. */
  hidden?: number;
  periods: VatPeriod[];
  returns: VatReturn[];
  reviews?: Record<string, ReviewInfo>;
  labels: Record<string, string>;
  fields: string[];
  manualFields: string[];
}

/** The VAT201 fields shown, in SARS order; totals are always shown. */
const SHOWN = ["f1", "f1A", "f2", "f2A", "f3", "f4", "f4A", "f10", "f11", "f12", "f13", "f14", "f14A", "f15", "f15A", "f16", "f17", "f18", "f19", "f20"];
const TOTALS = new Set(["f13", "f19", "f20"]);

export function VatTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const narrow = useIsNarrow();
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
  const [allFields, setAllFields] = useState(false);
  const [override, setOverride] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

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
    setAllFields(false);
    setAdj(Object.fromEntries(Object.entries(existing?.adjustments ?? {}).map(([k, n]) => [k, centsToInput(n)])));
    // On a phone the return opens below the list: bring it into view.
    if (narrow) setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 50);
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
  if (vat.category === "none") {
    return (
      <Banner>
        <span>These books are set as not registered for VAT, so there are no VAT201 returns (the VAT return you file with SARS). If the business is registered, choose its VAT category in the Accounting settings.</span>
      </Banner>
    );
  }

  const day = today();
  const booksLine = vat.booksStart && (vat.hidden ?? 0) > 0
    ? `Your books start on ${formatDate(vat.booksStart.date)}, so earlier VAT periods are not shown.${vat.booksStart.from === "cutover" ? " Their returns came from your previous books." : ""}`
    : null;
  const payable = (p: VatPeriod) => (p.payableMinor == null ? "—" : formatMoney(p.payableMinor));
  const shownFields = ret ? SHOWN.filter((f) => allFields || TOTALS.has(f) || Number(ret.boxes[f] ?? 0) !== 0) : [];
  const hiddenFields = ret ? SHOWN.length - shownFields.length : 0;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <SectionCard title="VAT returns (VAT201)" icon={Stamp} subtitle={vatCategoryText(vat.category, data.settings.yearEndMonth)}>
        {booksLine ? <Muted>{booksLine}</Muted> : null}
        {vat.periods.length === 0 ? (
          <Muted>No VAT periods in these books yet.</Muted>
        ) : narrow ? (
          <CompactRows
            rows={vat.periods}
            rowKey={(p) => p.start}
            label="VAT periods"
            title={(p) => periodLabel(p.start, p.end)}
            meta={(p) => {
              const state = vatPeriodState(p, day);
              return [state.label, p.dueDate && state.key !== "locked" ? `due ${formatDate(p.dueDate)}` : null].filter(Boolean).join(" · ");
            }}
            trailing={(p) => {
              const state = vatPeriodState(p, day);
              if (p.payableMinor != null) return payable(p);
              return state.key === "late" || state.key === "not_prepared" ? <Pill tone={statusTone(state.key)} size="sm">{state.key === "late" ? "Late" : "To prepare"}</Pill> : null;
            }}
            onOpen={(p) => choose(p)}
          />
        ) : (
          <Table head={["Period", "Status", "Due", { label: "To pay / (refund)", right: true }, ""]}>
            {vat.periods.map((p) => {
              const state = vatPeriodState(p, day);
              return (
                <tr key={p.start}>
                  <Td strong={p.current}>{periodLabel(p.start, p.end)}</Td>
                  <Td><Pill tone={statusTone(state.key)} dot size="sm">{state.label}</Pill></Td>
                  <Td muted>{p.dueDate ? formatDate(p.dueDate) : "—"}</Td>
                  <Td right>{payable(p)}</Td>
                  <Td><Button type="button" variant="secondary" style={small} onClick={() => choose(p)}>Open</Button></Td>
                </tr>
              );
            })}
          </Table>
        )}
        <Muted>Built from the VAT on your journals (invoices, bills, bank lines and manual journals). Approving a return locks its period, so nothing dated inside it can post afterwards. You still file and pay on SARS eFiling.</Muted>
      </SectionCard>

      {period ? (
        <div ref={detailRef} style={{ scrollMarginTop: 16 }}>
          <SectionCard
            title={`VAT201 for ${periodLabel(period.start, period.end)}`}
            icon={Stamp}
            subtitle={`${formatDate(period.start)} to ${formatDate(period.end)}`}
            actions={ret ? <Pill tone={statusTone(ret.status)} dot size="sm">{ret.status === "locked" ? "Approved" : ret.status === "pending_approval" ? "Waiting for approval" : "Draft"}</Pill> : null}
          >
            {(!ret || ret.status === "draft") ? (
              <>
                <Row>
                  <Button type="button" disabled={busy !== ""} onClick={() => void run("prepare", doPrepare, "Worked out from the journals.")}>{busy === "prepare" ? "Working it out…" : ret ? "Work it out again" : "Work out the return"}</Button>
                  {ret ? (
                    <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("request", async () => { setRet((await request({ returnId: ret.id })) as VatReturn); await refresh(); }, "Approval issue opened.")}>Ask for approval</Button>
                  ) : null}
                </Row>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 28, display: "flex", alignItems: "center" }}>Amounts entered by hand (only if they apply)</summary>
                  <div style={{ display: "grid", gap: 8, paddingTop: 8 }}>
                    <Muted>Imports, change in use, bad debts and other adjustments are not in the journals. Enter them in rand, then work the return out again.</Muted>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(200px, 100%), 1fr))", gap: 8 }}>
                      {vat.manualFields.map((f) => (
                        <Field key={f} label={vat.labels[f] ?? f}>
                          <Input inputMode="decimal" value={adj[f] ?? ""} onChange={(e) => setAdj({ ...adj, [f]: e.target.value })} />
                        </Field>
                      ))}
                    </div>
                  </div>
                </details>
              </>
            ) : null}
            {ret?.status === "pending_approval" ? (
              <Row>
                <Button type="button" disabled={busy !== "" || approveBlocked(vat.reviews?.[ret.id], override)} onClick={() => void run("approve", async () => { setRet((await approve({ returnId: ret.id, overrideReview: override })) as VatReturn); setOverride(false); await refresh(); }, "Approved and locked.")}>Approve and lock</Button>
                <ReviewBadge review={vat.reviews?.[ret.id]} />
                <ReviewOverride review={vat.reviews?.[ret.id]} checked={override} onChange={setOverride} />
                {ret.approvalIssueId ? <span style={{ fontSize: 12.5 }}><IssueLink id={ret.approvalIssueId} label="Open the approval issue" /></span> : null}
              </Row>
            ) : null}
            {warnings.length ? <Banner tone="warn">{warnings.map((w) => <span key={w}>{readableDates(w)}</span>)}</Banner> : null}
            {ret ? (
              <>
                <Table head={["Field", { label: "Amount", right: true }]}>
                  {shownFields.map((f) => (
                    <tr key={f}>
                      <Td strong={TOTALS.has(f)}>{vat.labels[f] ?? f}</Td>
                      <Td right strong={TOTALS.has(f)}>{formatMoney(Number(ret.boxes[f] ?? 0))}</Td>
                    </tr>
                  ))}
                </Table>
                {hiddenFields > 0 || allFields ? (
                  <div>
                    <button type="button" onClick={() => setAllFields(!allFields)} style={{ border: "none", background: "transparent", padding: 0, color: tokens.primary, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minHeight: 28 }}>
                      {allFields ? "Hide empty fields" : `Show all ${SHOWN.length} fields (${hiddenFields} are empty)`}
                    </button>
                  </div>
                ) : null}
                {ret.detail.length ? (
                  <Details summary="How these amounts were worked out">
                    <Table head={["", "VAT type", "SARS field", { label: "Before VAT", right: true }, { label: "VAT", right: true }, { label: "Journals", right: true }]}>
                      {ret.detail.map((d, i) => (
                        <tr key={i}>
                          <Td>{d.direction === "output" ? "Sales" : "Purchases"}</Td>
                          <Td>{taxLabel(d.taxCode)}</Td>
                          <Td muted>{d.field === "—" ? "None" : d.field.replace("/", " and ")}</Td>
                          <Td right>{formatMoney(d.baseMinor)}</Td>
                          <Td right>{formatMoney(d.taxMinor)}</Td>
                          <Td right>{d.journals}</Td>
                        </tr>
                      ))}
                    </Table>
                  </Details>
                ) : null}
                <Row>
                  <Button type="button" variant="secondary" style={small} onClick={() => void run("csv", async () => {
                    const r = (await csv({ returnId: ret.id })) as { fileName: string; csv: string };
                    download(r.fileName, r.csv, "text/csv");
                  })}>Download CSV</Button>
                </Row>
              </>
            ) : (
              <Muted>Not worked out yet. Click the button above: it adds up the VAT on the journals in this period.</Muted>
            )}
            {data.settings.vatNumber ? null : <Muted>Add the VAT number in the Accounting settings so it prints on the download.</Muted>}
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
