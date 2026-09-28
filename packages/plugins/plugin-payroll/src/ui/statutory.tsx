/**
 * Statutory: the tax rules first (each unconfirmed one in plain words, the
 * year's notes and the accountant's sign-off), then the SARS returns and
 * files Payroll prepares. Payroll never submits or pays anything to SARS.
 */
import { useState } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  CircleCheck,
  CompactRows,
  Field,
  FileText,
  Input,
  KpiCard,
  Scale,
  SectionCard,
  Select,
  Stamp,
  TextArea,
  Database,
  fluidColumns,
  formatDate,
  formatMonth,
  tokens,
  tone,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { ruleLabel, rulesCheckText } from "../rule-labels.js";
import { plural } from "./series.js";
import { download, Money, Muted, Notice, rand, Row, StatusPill } from "./shared.js";
import type { Emp201FilingView, Emp201View, RunFn, Snapshot } from "./types.js";

type Certificate = { employeeId: string; employeeNumber: string; name: string; kind: string; payeMinor: number; grossTaxableMinor: number; uifMinor: number; sdlMinor: number; codes: Record<string, number>; includesOpening: boolean };
type Emp501 = { reconciled: boolean; declared: { payeMinor: number; sdlMinor: number; uifMinor: number; etiMinor: number }; certificates: { count: number; irp5: number; it3a: number; payeMinor: number }; difference: { payeMinor: number; sdlMinor: number; uifMinor: number } };

const toolbar = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } as const;

export function StatutoryTab({ s, run, setMessage }: { s: Snapshot; run: RunFn; setMessage: (m: string) => void }) {
  const emp201 = usePluginAction("payroll.emp201");
  const markFiled = usePluginAction("payroll.mark-emp201-filed");
  const unmarkFiled = usePluginAction("payroll.unmark-emp201-filed");
  const certs = usePluginAction("payroll.certificates");
  const emp501 = usePluginAction("payroll.emp501");
  const exportFile = usePluginAction("payroll.export");
  const importYtd = usePluginAction("payroll.import-ytd");
  const narrow = useIsNarrow();
  const [month, setMonth] = useState(s.today.slice(0, 7));
  const [taxYear, setTaxYear] = useState(s.rules.taxYear);
  const [e201, setE201] = useState<Emp201View | null>(null);
  const [filing, setFiling] = useState<Emp201FilingView | null>(null);
  const [reference, setReference] = useState("");
  const [filedOn, setFiledOn] = useState(s.today);
  const showEmp201 = (forMonth: string) =>
    run(async () => {
      const r = (await emp201({ month: forMonth })) as { emp201: Emp201View; filing: Emp201FilingView | null };
      setE201(r.emp201);
      setFiling(r.filing);
    });
  const [certificates, setCertificates] = useState<Certificate[] | null>(null);
  const [e501, setE501] = useState<Emp501 | null>(null);
  const [period, setPeriod] = useState<"annual" | "interim">("interim");
  const [csv, setCsv] = useState("");

  const exportAndDownload = (params: Record<string, unknown>, success: string) =>
    void run(async () => download((await exportFile(params)) as { url?: string; content?: string; fileName: string; contentType?: string }), success);

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <TaxRulesSection s={s} run={run} />

      <Notice tone="info">Payroll prepares these SARS returns and files for you. You submit and pay them on SARS eFiling yourself; nothing is sent to SARS from here.</Notice>

      <SectionCard
        title="EMP201 (monthly)"
        icon={Stamp}
        subtitle="Your monthly declaration to SARS: PAYE, UIF and SDL from locked pay runs, less ETI. Due by the 7th of the next month."
        actions={(
          <div style={toolbar}>
            <Input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 170 }} />
            <Button type="button" variant="secondary" disabled={!month} onClick={() => void showEmp201(month)}>Show</Button>
            <Button type="button" variant="secondary" disabled={!month} onClick={() => exportAndDownload({ kind: "emp201", month }, "EMP201 figures downloaded")}>Download CSV</Button>
          </div>
        )}
      >
        {e201 ? (
          <div style={{ display: "grid", gap: 10 }}>
            <strong style={{ fontSize: 13 }}>{formatMonth(e201.month)}</strong>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(140), gap: 10 }}>
              <KpiCard size="sm" label="PAYE" value={rand(e201.payeMinor)} hint="Income tax" />
              <KpiCard size="sm" label="ETI used" value={rand(e201.etiUsedMinor)} tone={e201.etiUsedMinor > 0 ? "ok" : undefined} hint="Takes PAYE down" />
              <KpiCard size="sm" label="SDL" value={rand(e201.sdlMinor)} />
              <KpiCard size="sm" label="UIF" value={rand(e201.uifMinor)} />
              <KpiCard size="sm" label="To pay SARS" value={rand(e201.totalPayableMinor)} tone={e201.totalPayableMinor > 0 ? "warn" : undefined} hint={`Due ${formatDate(e201.dueDate)}`} />
            </div>
            <Muted style={{ fontSize: 12.5 }}>
              {plural(e201.employees, "employee", "employees")} · {e201.runs.length ? `from ${e201.runs.join(", ")}` : "no locked pay runs in this month"}
              {e201.etiCalculatedMinor || e201.etiBroughtForwardMinor || e201.etiCarriedForwardMinor
                ? ` · ETI worked out ${rand(e201.etiCalculatedMinor)}, brought forward ${rand(e201.etiBroughtForwardMinor)}, carried forward ${rand(e201.etiCarriedForwardMinor)}`
                : ""}
            </Muted>
            {e201.notes.map((n) => <p key={n} style={{ margin: 0, fontSize: 12.5 }}>{n}</p>)}
            <Emp201Filed
              month={e201.month}
              today={s.today}
              filing={filing}
              reference={reference}
              filedOn={filedOn}
              onReference={setReference}
              onFiledOn={setFiledOn}
              onMark={() => void run(async () => {
                setFiling((await markFiled({ month: e201.month, reference: reference.trim() || undefined, filedOn })) as Emp201FilingView);
                setReference("");
              }, `EMP201 for ${formatMonth(e201.month)} marked filed`)}
              onUndo={() => void run(async () => {
                await unmarkFiled({ month: e201.month });
                setFiling(null);
              }, `EMP201 for ${formatMonth(e201.month)} is no longer marked filed`)}
            />
          </div>
        ) : <Muted>Pick a month and click Show to see its PAYE, SDL, UIF and ETI from locked pay runs.</Muted>}
      </SectionCard>

      <SectionCard
        title="IRP5 and IT3(a) certificates"
        icon={FileText}
        subtitle="Each employee's yearly tax certificate: an IRP5 when tax was taken off their pay, an IT3(a) when none was."
        actions={(
          <div style={toolbar}>
            <Input value={taxYear} onChange={(e) => setTaxYear(e.target.value)} style={{ width: 110 }} aria-label="Tax year" />
            <Button type="button" variant="secondary" onClick={() => void run(async () => setCertificates(((await certs({ taxYear })) as { certificates: Certificate[] }).certificates))}>Show</Button>
            <Button type="button" variant="secondary" onClick={() => { if (window.confirm("The certificate file holds ID and tax numbers. Download it?")) exportAndDownload({ kind: "irp5", taxYear }, "Certificates downloaded"); }}>Download CSV</Button>
          </div>
        )}
      >
        {certificates ? (
          certificates.length ? (
            narrow ? (
              <CompactRows
                label="Certificates"
                rows={certificates}
                rowKey={(c) => c.employeeId}
                title={(c) => c.name}
                meta={(c) => `${c.kind} · PAYE ${rand(c.payeMinor)}${c.includesOpening ? " · includes old-system totals" : ""}`}
                trailing={(c) => rand(c.grossTaxableMinor)}
              />
            ) : (
              <DataTable
                columns={[
                  { key: "name", header: "Employee" },
                  { key: "kindText", header: "Certificate" },
                  { key: "grossTaxableMinor", header: "Gross (3699)", render: (v) => <Money minor={Number(v)} /> },
                  { key: "payeMinor", header: "PAYE (4102)", render: (v) => <Money minor={Number(v)} /> },
                  { key: "uifMinor", header: "UIF (4141)", render: (v) => <Money minor={Number(v)} /> },
                  { key: "sdlMinor", header: "SDL (4142)", render: (v) => <Money minor={Number(v)} /> },
                ]}
                rows={certificates.map((c) => ({ ...c, id: c.employeeId, kindText: `${c.kind}${c.includesOpening ? " · includes old-system totals" : ""}` }))}
              />
            )
          ) : <Muted>No locked pay runs or old-system totals in {taxYear}.</Muted>
        ) : <Muted>Totals per employee for the tax year, by SARS code. Pick the tax year and click Show.</Muted>}
      </SectionCard>

      <SectionCard
        title="EMP501 reconciliation"
        icon={Scale}
        subtitle="Twice a year SARS wants your EMP201s matched with the certificates: interim for March to August, annual for the whole tax year."
        actions={(
          <div style={toolbar}>
            <Select value={period} aria-label="Period" onChange={(e) => setPeriod(e.target.value as "annual" | "interim")}>
              <option value="interim">Interim (Mar–Aug)</option>
              <option value="annual">Annual (Mar–Feb)</option>
            </Select>
            <Button type="button" variant="secondary" onClick={() => void run(async () => setE501((await emp501({ taxYear, period })) as Emp501))}>Show</Button>
            <Button type="button" variant="secondary" onClick={() => exportAndDownload({ kind: "emp501", taxYear, period }, "EMP501 pack downloaded")}>Download CSV</Button>
          </div>
        )}
      >
        {e501 ? (
          <div style={{ fontSize: 13, display: "grid", gap: 6 }}>
            <div><StatusPill status={e501.reconciled ? "ok" : "pending"} label={e501.reconciled ? "They match" : "They don't match yet"} /></div>
            <div>On the EMP201s: PAYE {rand(e501.declared.payeMinor)}, SDL {rand(e501.declared.sdlMinor)}, UIF {rand(e501.declared.uifMinor)}, ETI {rand(e501.declared.etiMinor)}</div>
            <div>On the certificates: {e501.certificates.count} ({e501.certificates.irp5} IRP5, {e501.certificates.it3a} IT3(a)), PAYE {rand(e501.certificates.payeMinor)}</div>
            {!e501.reconciled ? <div>Difference: PAYE {rand(e501.difference.payeMinor)}, SDL {rand(e501.difference.sdlMinor)}, UIF {rand(e501.difference.uifMinor)}</div> : null}
          </div>
        ) : <Muted>Compares the EMP201s with the certificates for {taxYear}.</Muted>}
      </SectionCard>

      <SectionCard title="Moving from another payroll system?" icon={Database} subtitle="Bring in each employee's totals so far this tax year, so their certificates and tax add up.">
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32, display: "list-item" }}>Import year-to-date totals</summary>
          <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
            <Muted style={{ fontSize: 12.5 }}>Paste a CSV from the old payroll: an <code>employee_number</code> column, then one column per SARS code in rand (for example 3601, 3605, 4001, 4005, 4102, 4141, 4142) and, if claimed, <code>eti</code>.</Muted>
            <TextArea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"employee_number,3601,4102,4141,4142\nE001,150000.00,21000.00,885.60,1500.00"} style={{ minHeight: 110, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
            <div>
              <Button type="button" variant="secondary" disabled={!csv.trim()} onClick={() => void run(async () => {
                const result = (await importYtd({ taxYear, csv })) as { imported: number; errors: string[] };
                setMessage(`${plural(result.imported, "employee", "employees")} imported for ${taxYear}${result.errors.length ? `. Problems: ${result.errors.join("; ")}` : ""}`);
                if (!result.errors.length) setCsv("");
              })}>Import for {taxYear}</Button>
            </div>
          </div>
        </details>
      </SectionCard>
    </div>
  );
}

/** The tax rules in plain words, the year's notes and the accountant's sign-off. */
function TaxRulesSection({ s, run }: { s: Snapshot; run: RunFn }) {
  const review = usePluginAction("payroll.review-rules");
  const rulesAction = usePluginAction("payroll.rules");
  const [name, setName] = useState("");
  const [checkedOn, setCheckedOn] = useState(s.today);
  const [sources, setSources] = useState<Array<{ title: string; url: string; accessed: string }> | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const unverified = s.rules.unverified;
  const needsCheck = Boolean(s.rules.id) && unverified.length > 0 && !s.rulesReviewed;
  const checked = s.rulesReview ?? null;
  const title = `Tax rules for ${s.rules.taxYear}`;
  const intro = "Payroll works out PAYE (income tax), UIF (unemployment insurance), SDL (skills development levy) and ETI (Employment Tax Incentive) with these rules.";

  if (!s.rules.id) {
    return (
      <SectionCard title={title} icon={Scale} tone="bad" strip>
        <Muted>No tax rules are loaded for {s.rules.taxYear}, so pay runs can't be calculated. Ask your Paperclip admin to update the Payroll plugin to the latest version.</Muted>
      </SectionCard>
    );
  }

  const ruleList = unverified.length ? (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
      {unverified.map((u) => (
        <li key={u.path} style={{ display: "grid", gap: 2, padding: "8px 10px", borderRadius: 9, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${needsCheck ? tone("warn").solid : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
          <strong style={{ fontSize: 13 }}>{u.label ?? ruleLabel(u.path)}</strong>
          <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}>{u.note}</span>
        </li>
      ))}
    </ul>
  ) : null;
  const notes = s.rules.notes.length ? (
    <div style={{ display: "grid", gap: 4 }}>
      <strong style={{ fontSize: 12.5 }}>Notes on this year's rules</strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: tokens.muted }}>{s.rules.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  ) : null;
  const sourceList = (
    <details
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open || sources) return;
        rulesAction({ taxYear: s.rules.taxYear }).then(
          (result) => setSources((result as { version: { sources: Array<{ title: string; url: string; accessed: string }> } | null }).version?.sources ?? []),
          () => setSourcesFailed(true),
        );
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600, minHeight: 28, display: "list-item" }}>Where each figure comes from (SARS sources)</summary>
      {sources?.length ? (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
          {sources.map((src) => <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer">{src.title}</a> <span style={{ color: tokens.muted }}>(checked {formatDate(src.accessed)})</span></li>)}
        </ul>
      ) : <Muted style={{ fontSize: 12.5, marginTop: 6 }}>{sourcesFailed ? "Couldn't load the sources right now." : sources ? "No sources listed." : "Loading…"}</Muted>}
    </details>
  );

  if (!needsCheck) {
    const done = checked
      ? checked.accountantName
        ? `Checked by ${checked.accountantName} on ${formatDate(checked.checkedOn)}.`
        : `Marked as checked on ${formatDate(checked.checkedOn)}.`
      : `Every ${s.rules.taxYear} rule is confirmed against SARS.`;
    return (
      <SectionCard title={title} icon={Scale} subtitle={intro}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <CircleCheck size={16} aria-hidden="true" style={{ color: tone("ok").solid, flexShrink: 0 }} />
          <span>{done}</span>
        </div>
        {ruleList || notes ? (
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600, minHeight: 28, display: "list-item" }}>Show the rules{notes ? " and notes" : ""}</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 8 }}>{ruleList}{notes}</div>
          </details>
        ) : null}
        {sourceList}
      </SectionCard>
    );
  }

  const valid = name.trim().length >= 2 && Boolean(checkedOn) && checkedOn <= s.today;
  return (
    <SectionCard title={title} icon={Scale} tone="warn" strip subtitle={`${rulesCheckText(unverified.length)}. SARS doesn't state these directly, so pay runs use them as shown until then.`}>
      <Muted style={{ fontSize: 12.5 }}>{intro}</Muted>
      {ruleList}
      {notes}
      <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 10, border: `1px dashed ${tone("warn").border}`, background: tokens.bg, minWidth: 0 }}>
        <strong style={{ fontSize: 13 }}>Record your accountant's check</strong>
        <Muted style={{ fontSize: 12.5 }}>Once your accountant has checked each rule above against how you pay your staff, enter who checked and when.</Muted>
        <Row>
          <Field label="Accountant's name"><Input value={name} autoComplete="off" placeholder="Full name" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Date they checked"><Input type="date" value={checkedOn} max={s.today} onChange={(e) => setCheckedOn(e.target.value)} /></Field>
        </Row>
        {checkedOn > s.today ? <span style={{ fontSize: 12.5, color: tone("bad").fg }}>The date can't be in the future.</span> : null}
        <div>
          <Button type="button" disabled={!valid} onClick={() => void run(() => review({ accountantName: name.trim(), checkedOn }), `Saved: checked by ${name.trim()} on ${formatDate(checkedOn)}.`)}>Record the check</Button>
        </div>
      </div>
      {sourceList}
    </SectionCard>
  );
}

/**
 * Whether the month's EMP201 is filed. Payroll never files or pays: a person
 * does it on eFiling, then marks it here (or the agent records their
 * confirmation), so the Cockpit stops showing it as due.
 */
function Emp201Filed(props: {
  month: string;
  today: string;
  filing: Emp201FilingView | null;
  reference: string;
  filedOn: string;
  onReference: (value: string) => void;
  onFiledOn: (value: string) => void;
  onMark: () => void;
  onUndo: () => void;
}) {
  const { month, today, filing } = props;
  if (filing) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <StatusPill status="filed" label={`Filed ${formatDate(filing.filedOn)}`} tone="ok" />
        {filing.reference ? <span style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere" }}>Reference {filing.reference}</span> : null}
        <Button type="button" variant="secondary" onClick={props.onUndo} style={{ height: 28, fontSize: 12 }}>Not filed yet</Button>
      </div>
    );
  }
  if (month >= today.slice(0, 7)) {
    return <Muted style={{ fontSize: 12.5 }}>Once {formatMonth(month)} has ended and you have filed and paid it on eFiling, mark it filed here.</Muted>;
  }
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <Muted style={{ fontSize: 12.5 }}>Filed and paid on eFiling? Mark it filed so the Cockpit stops showing it as due.</Muted>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", minWidth: 0 }}>
        <Field label="Payment reference (optional)">
          <Input value={props.reference} autoComplete="off" maxLength={60} placeholder="PRN from eFiling" onChange={(e) => props.onReference(e.target.value)} style={{ width: 200, maxWidth: "100%" }} />
        </Field>
        <Field label="Filed on">
          <Input type="date" value={props.filedOn} max={today} onChange={(e) => props.onFiledOn(e.target.value)} style={{ width: 160 }} />
        </Field>
        <Button type="button" disabled={!props.filedOn} onClick={props.onMark}>Mark as filed</Button>
      </div>
    </div>
  );
}
