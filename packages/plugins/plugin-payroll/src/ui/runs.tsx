/**
 * Pay runs: who approves them, the list (rows on a phone) and one run with
 * its one main action for the status it is in; everything else sits in
 * "More". Runs need employees, and the tax rules for the pay date.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  ChartPie,
  CompactRows,
  DonutChart,
  EmptyState,
  Field,
  Input,
  KpiCard,
  Modal,
  ScrollX,
  Section,
  SectionCard,
  Select,
  Toolbar,
  errorText,
  fluidColumns,
  formatDate,
  formatDateTime,
  formatMoneyCompact,
  formatShortDate,
  tokens,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { ApproverCard } from "./approver-card.js";
import { approverName, approverOptions, type DirectoryPerson } from "./approver.js";
import {
  costSplit,
  ledgerLabel,
  newRunBlocker,
  lineSectionLabel,
  payslipStatusLabel,
  periodText,
  plural,
  runKindText,
  runStatusLabel,
  varianceFieldLabel,
} from "./series.js";
import { Details, download, minorText, Money, MoreMenu, Muted, Notice, rand, Row, RunStatus, small, StatusPill, toMinor, type MenuItem } from "./shared.js";
import type { ItemView, RunDetail, RunFn, RunSummary, Snapshot } from "./types.js";

const EMPTY_ADJUST = { overtimeHours: "", doubleTimeHours: "", ordinaryHours: "", unpaidHours: "", bonus: "", commission: "", other: "", otherCode: "OTHER_ALLOWANCE", excluded: false };

type Variance = {
  comparedWith: { number: string } | null;
  changes: Array<{ name: string; field: string; previousMinor: number; currentMinor: number; changeBp: number | null }>;
  added: string[];
  missing: string[];
};

export function RunsTab({ s, run, openRunId, setOpenRunId, setMessage, people, peopleFailed, companyId, onApproverSaved, goEmployees }: {
  s: Snapshot;
  run: RunFn;
  openRunId: string | null;
  setOpenRunId: (id: string | null) => void;
  setMessage: (m: string) => void;
  people: DirectoryPerson[] | null;
  peopleFailed: boolean;
  companyId: string | null | undefined;
  onApproverSaved: (message: string) => Promise<void>;
  goEmployees: () => void;
}) {
  const createRun = usePluginAction("payroll.create-run");
  const narrow = useIsNarrow();
  const [creating, setCreating] = useState(false);
  const [newRun, setNewRun] = useState({ frequency: "monthly", periodStart: "", periodEnd: "", payDate: "" });
  if (openRunId) return <RunDetailView s={s} runId={openRunId} back={() => setOpenRunId(null)} run={run} setMessage={setMessage} people={people} />;

  const blocker = newRunBlocker(s);
  const noStaff = !s.employees.some((e) => e.status === "active");
  // One "+ New pay run" on the tab: in the toolbar once there are runs, else in the empty state.
  const newButton = <Button type="button" disabled={Boolean(blocker)} onClick={() => setCreating(true)}>+ New pay run</Button>;
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <ApproverCard s={s} people={people} peopleFailed={peopleFailed} companyId={companyId} onSaved={onApproverSaved} />
      {s.runs.length === 0 ? (
        <EmptyState
          title="No pay runs yet"
          description={noStaff ? "Add employees first. Then start a pay run, calculate it and send it for approval." : blocker ?? "Start the first pay run, calculate it, then send it for approval."}
          action={noStaff ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Button type="button" onClick={goEmployees}>Go to employees</Button>
              <Button type="button" variant="secondary" disabled>+ New pay run</Button>
            </div>
          ) : newButton}
        />
      ) : (
        <>
          <Toolbar>
            {blocker ? <span style={{ fontSize: 12.5, color: tokens.muted, alignSelf: "center" }}>{blocker}</span> : null}
            {newButton}
          </Toolbar>
          {narrow ? (
            <CompactRows
              label="Pay runs"
              rows={s.runs}
              title={(r) => r.number}
              meta={(r) => `${runStatusLabel(r.status)} · paid ${formatShortDate(r.payDate)}`}
              trailing={(r) => (r.totals.netPayMinor ? rand(r.totals.netPayMinor) : null)}
              onOpen={(r) => setOpenRunId(r.id)}
            />
          ) : (
            <DataTable
              columns={[
                { key: "number", header: "Pay run", render: (_v, row) => { const r = row as unknown as RunSummary; return <div><div style={{ fontWeight: 600 }}>{r.number}</div><div style={{ fontSize: 12, color: tokens.muted }}>{runKindText(r)}</div></div>; } },
                { key: "period", header: "Period" },
                { key: "payText", header: "Pay date" },
                { key: "status", header: "Status", render: (v) => <RunStatus status={String(v)} /> },
                { key: "staff", header: "Staff" },
                { key: "net", header: "Net pay", render: (_v, row) => <Money minor={(row as unknown as RunSummary).totals.netPayMinor} /> },
                { key: "ledgerText", header: "Accounting" },
                { key: "id", header: "", width: "90px", render: (_v, row) => <Button type="button" variant="secondary" style={small} onClick={() => setOpenRunId((row as unknown as RunSummary).id)}>Open</Button> },
              ]}
              rows={s.runs.map((r) => ({
                ...r,
                period: periodText(r.periodStart, r.periodEnd),
                payText: formatDate(r.payDate),
                staff: r.totals.employeeCount || "–",
                net: "",
                ledgerText: ledgerLabel(r.ledger),
              }))}
              emptyMessage="No pay runs."
            />
          )}
        </>
      )}
      <Modal open={creating} title="New pay run" description="Leave the dates empty for this month and your usual pay day." onClose={() => setCreating(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            const result = (await createRun({ frequency: newRun.frequency, periodStart: newRun.periodStart || undefined, periodEnd: newRun.periodEnd || undefined, payDate: newRun.payDate || undefined })) as { run: RunSummary };
            setCreating(false);
            setOpenRunId(result.run.id);
          }, "Pay run started. Calculate it next.")}>Start pay run</Button>
        </>
      )}>
        <Field label="How often staff are paid">
          <Select value={newRun.frequency} onChange={(e) => setNewRun({ ...newRun, frequency: e.target.value })}>
            <option value="monthly">Monthly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="weekly">Weekly</option>
          </Select>
        </Field>
        <Row>
          <Field label="Period start"><Input type="date" value={newRun.periodStart} onChange={(e) => setNewRun({ ...newRun, periodStart: e.target.value })} /></Field>
          <Field label="Period end"><Input type="date" value={newRun.periodEnd} onChange={(e) => setNewRun({ ...newRun, periodEnd: e.target.value })} /></Field>
          <Field label="Pay date"><Input type="date" value={newRun.payDate} onChange={(e) => setNewRun({ ...newRun, payDate: e.target.value })} /></Field>
        </Row>
      </Modal>
    </div>
  );
}

function RunDetailView({ s, runId, back, run, setMessage, people }: { s: Snapshot; runId: string; back: () => void; run: RunFn; setMessage: (m: string) => void; people: DirectoryPerson[] | null }) {
  const load = usePluginAction("payroll.run");
  const calculate = usePluginAction("payroll.calculate-run");
  const adjust = usePluginAction("payroll.adjust-item");
  const requestApproval = usePluginAction("payroll.request-approval");
  const approve = usePluginAction("payroll.approve-run");
  const reject = usePluginAction("payroll.reject-run");
  const lock = usePluginAction("payroll.lock-run");
  const bankFile = usePluginAction("payroll.net-pay-file");
  const email = usePluginAction("payroll.email-payslips");
  const generate = usePluginAction("payroll.generate-payslips");
  const reverse = usePluginAction("payroll.reverse-run");
  const correct = usePluginAction("payroll.correct-run");
  const cancel = usePluginAction("payroll.cancel-run");
  const repost = usePluginAction("payroll.repost-ledger");
  const variances = usePluginAction("payroll.variances");
  const narrow = useIsNarrow();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [traceItem, setTraceItem] = useState<ItemView | null>(null);
  const [adjustItem, setAdjustItem] = useState<ItemView | null>(null);
  const [adjustForm, setAdjustForm] = useState(EMPTY_ADJUST);
  const [approving, setApproving] = useState(false);
  const [approver, setApprover] = useState(s.settings.defaultApproverUserId ?? "");
  const [bankOpen, setBankOpen] = useState(false);
  const [variance, setVariance] = useState<Variance | null>(null);

  // Everyone who could approve, by name (the members list stands in when the directory is not available).
  const options = useMemo(() => {
    const list = people ?? s.members.map((m) => ({ userId: m.userId, name: m.isYou ? "You" : m.role ? `A board member (${m.role})` : "A board member", email: null }));
    return approverOptions(list, { me: s.me, runs: [] });
  }, [people, s.members, s.me]);

  async function refresh() {
    setDetail((await load({ runId })) as RunDetail);
  }
  useEffect(() => {
    setLoadError("");
    refresh().catch((error: unknown) => setLoadError(errorText(error)));
  }, [runId]);

  async function act<T>(work: () => Promise<T>, success: string) {
    const result = await run(work, success);
    await refresh().catch(() => undefined);
    return result;
  }

  const backLink = <a href="#" onClick={(e) => { e.preventDefault(); back(); }} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none", minHeight: 32, display: "inline-flex", alignItems: "center", width: "fit-content" }}>← All pay runs</a>;
  if (loadError) {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        {backLink}
        <Notice tone="warn">Couldn't open this pay run. It may have been cancelled; open it from the list.</Notice>
        <Details summary="Details">{loadError}</Details>
      </div>
    );
  }
  if (!detail) return <Muted>Loading pay run…</Muted>;
  const r = detail.run;
  const t = r.totals;
  const iPrepared = s.me != null && r.preparedBy?.kind === "user" && r.preparedBy.id === s.me;
  const errors = detail.items.filter((i) => i.status === "error").length;
  const editable = ["draft", "calculated", "pending_approval"].includes(r.status) && r.kind !== "reversal";
  const cancellable = ["draft", "calculated", "pending_approval"].includes(r.status);
  const ledgerProblem = (r.status === "locked" || r.status === "reversed") && (r.ledger.status === "rejected" || r.ledger.status === "failed" || (r.ledger.status === "none" && Boolean(r.ledger.error)));

  const recalc = () => void act(() => calculate({ runId }), "Calculated again");
  const approveNow = () => {
    const lockToo = s.settings.lockOnApproval !== false;
    if (lockToo && !window.confirm(`Approve and lock ${r.number}? It goes to Accounting and the payslips are made${s.settings.emailPayslipsOnLock ? " (and emailed)" : ""}. After that it can't be changed, only reversed.`)) return;
    void act(async () => {
      const result = (await approve({ runId })) as { status: string; locked?: { payslips?: { created: number; skipped: string | null; emailed?: number } } | null; lockError?: string };
      const slips = result.locked?.payslips;
      setMessage(result.status === "locked"
        ? `Approved and locked, and sent to Accounting. ${slips?.skipped ? slips.skipped : `${plural(slips?.created ?? 0, "payslip", "payslips")} made${slips?.emailed ? ` and ${slips.emailed} emailed` : ""}.`}`
        : result.lockError
          ? `Approved, but locking failed: ${result.lockError}`
          : "Approved. Lock the run to send it to Accounting and make the payslips.");
      return result;
    }, "");
  };
  const lockNow = () => {
    if (!window.confirm(`Lock ${r.number}? It goes to Accounting and can't be changed afterwards, only reversed.`)) return;
    void act(async () => {
      const result = (await lock({ runId })) as { payslips?: { created: number; skipped: string | null; emailed?: number } };
      setMessage(result.payslips?.skipped
        ? `Locked and sent to Accounting. ${result.payslips.skipped}`
        : `Locked and sent to Accounting. ${plural(result.payslips?.created ?? 0, "payslip", "payslips")} made${result.payslips?.emailed ? ` and ${result.payslips.emailed} emailed` : ""}.`);
      return result;
    }, "");
  };

  // One main action for the run's status; the rest go in "More" (destructive ones last).
  let primary: ReactNode = null;
  const more: MenuItem[] = [];
  const danger: MenuItem[] = [];
  if (r.status === "draft" && editable) primary = <Button type="button" onClick={recalc}>Calculate</Button>;
  if (r.status === "calculated") {
    primary = <Button type="button" disabled={errors > 0} onClick={() => setApproving(true)}>Send for approval</Button>;
    if (editable) more.push({ key: "calc", label: "Calculate again", onSelect: recalc });
  }
  if (r.status === "pending_approval") {
    if (!iPrepared) {
      primary = <Button type="button" onClick={approveNow}>{s.settings.lockOnApproval !== false ? "Approve and lock" : "Approve"}</Button>;
      more.push({ key: "reject", label: "Send back to the preparer", onSelect: () => {
        const reason = window.prompt("What needs to change?");
        if (reason) void act(() => reject({ runId, reason }), "Sent back to the preparer");
      } });
    }
    if (editable) more.push({ key: "calc", label: "Calculate again", onSelect: recalc });
  }
  if (r.status === "approved") primary = <Button type="button" onClick={lockNow}>Lock and post</Button>;
  if (r.status === "locked" && r.kind !== "reversal") {
    primary = <Button type="button" onClick={() => setBankOpen(true)}>Bank payment file</Button>;
    more.push({ key: "email", label: "Email payslips", onSelect: () => void act(async () => {
      const res = (await email({ runId })) as { queued: number; skipped: Array<{ payslip: string; reason: string }> };
      setMessage(`${plural(res.queued, "payslip", "payslips")} queued for email.${res.skipped.length ? ` Skipped: ${res.skipped.map((x) => `${x.payslip} (${x.reason})`).join(", ")}.` : ""}`);
      return res;
    }, "") });
    more.push({ key: "slips", label: "Make missing payslips", onSelect: () => void act(async () => {
      const res = (await generate({ runId })) as { created: number; skipped: string | null };
      setMessage(res.skipped ?? `${plural(res.created, "payslip", "payslips")} made.`);
      return res;
    }, "") });
    if (!r.reversedByRunId) {
      more.push({ key: "correct", label: "Correct this run", onSelect: () => {
        if (window.confirm(`Correct ${r.number}? This makes a reversal of it and a new correction run with the same inputs for you to fix.`)) void act(() => correct({ runId }), "Reversal and correction runs made");
      } });
      danger.push({ key: "reverse", label: "Reverse this run", danger: true, onSelect: () => {
        const reason = window.prompt(`Why reverse ${r.number}?`);
        if (reason) void act(() => reverse({ runId, reason }), "Reversal run made. Send it for approval.");
      } });
    }
  }
  if (r.status !== "draft") more.push({ key: "var", label: "Changes since the last run", onSelect: () => void act(async () => { setVariance((await variances({ runId })) as Variance); }, "") });
  if (cancellable) danger.push({ key: "cancel", label: "Cancel this run", danger: true, onSelect: () => { if (window.confirm(`Cancel ${r.number}?`)) void act(() => cancel({ runId }), "Cancelled"); } });

  const waitingOn = r.approverUserId === s.me && s.me ? "your approval" : `${approverName(r.approverUserId, people, s.me) ?? "the approver"} to approve it`;
  const approvalLine = r.status === "pending_approval" ? `Waiting for ${waitingOn}.${iPrepared ? " You prepared it, so someone else approves it." : ""}` : null;
  const accountingLine = r.ledger.status === "posted" ? `In the books${r.ledger.journalNumber ? ` (${r.ledger.journalNumber})` : ""}.` : r.ledger.status === "pending" ? "Being sent to Accounting." : null;
  const shownWarnings = r.warnings.slice(0, 3);
  const moreWarnings = r.warnings.slice(3);
  const preparedThis = (userId: string) => r.preparedBy?.kind === "user" && r.preparedBy.id === userId;

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {backLink}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: "1 1 260px", display: "grid", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{r.number} <RunStatus status={r.status} /></h2>
          <Muted>{runKindText(r)} · {periodText(r.periodStart, r.periodEnd)} · paid {formatDate(r.payDate)} · tax year {r.taxYear}</Muted>
          {approvalLine ? <Muted>{approvalLine}</Muted> : null}
          {accountingLine ? <Muted>{accountingLine}</Muted> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", marginLeft: "auto" }}>
          {primary}
          <MoreMenu items={[...more, ...danger]} />
        </div>
      </div>
      {r.status === "calculated" && errors > 0 ? <Notice tone="warn">Fix the {plural(errors, "employee", "employees")} with an error first, or leave them out of this run (Adjust). Then send it for approval.</Notice> : null}
      {ledgerProblem ? (
        <Notice tone="bad">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 220px", minWidth: 0 }}>Accounting didn't take this run. Fix the cause in Accounting, then post it again.</span>
            <Button type="button" variant="secondary" style={small} onClick={() => void act(() => repost({ runId }), "Sending to Accounting again")}>Post again</Button>
          </div>
          {r.ledger.error ? <div style={{ marginTop: 6 }}><Details summary="Details">{r.ledger.error}</Details></div> : null}
        </Notice>
      ) : null}
      {shownWarnings.length ? (
        <Notice tone="warn">
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>{shownWarnings.map((w) => <li key={w}>{w}</li>)}</ul>
          {moreWarnings.length ? <div style={{ marginTop: 6 }}><Details summary={`${moreWarnings.length} more`}><ul style={{ margin: 0, paddingLeft: 18 }}>{moreWarnings.map((w) => <li key={w}>{w}</li>)}</ul></Details></div> : null}
        </Notice>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(140), gap: 10 }}>
        <KpiCard size="sm" label="Gross pay" value={rand(t.grossMinor)} />
        <KpiCard size="sm" label="PAYE" value={rand(t.payeMinor)} hint="Income tax" />
        <KpiCard size="sm" label="UIF" value={rand(t.uifEmployeeMinor + t.uifEmployerMinor)} hint="Unemployment insurance, both halves" />
        <KpiCard size="sm" label="SDL" value={rand(t.sdlMinor)} hint="Skills development levy" />
        <KpiCard size="sm" label="ETI" value={rand(t.etiMinor)} tone={t.etiMinor > 0 ? "ok" : undefined} hint="Employment Tax Incentive, less PAYE to pay" />
        <KpiCard size="sm" label="Net pay" value={rand(t.netPayMinor)} hint="Paid to staff" />
        <KpiCard size="sm" label="Cost to company" value={rand(t.employerCostMinor)} />
      </div>
      {costSplit(t).length ? (
        <SectionCard title="Where the money goes" icon={ChartPie} subtitle="This run's cost to company, all staff together.">
          <DonutChart title="Cost split" size={120} centerValue={formatMoneyCompact(t.employerCostMinor)} centerLabel="cost" segments={costSplit(t).map((x) => ({ ...x, ...(x.key === "net" ? { tone: "ok" as const } : {}) }))} formatValue={(v) => formatMoneyCompact(v)} />
        </SectionCard>
      ) : null}
      {narrow ? (
        <CompactRows
          label="Employees in this run"
          rows={detail.items}
          title={(i) => i.name}
          meta={(i) => (i.error ? i.error : `Gross ${rand(i.grossMinor)} · PAYE ${rand(i.payeMinor)}`)}
          trailing={(i) => (i.status === "error" ? <StatusPill status="error" label="Error" /> : rand(i.netMinor))}
          onOpen={(i) => setTraceItem(i)}
          empty={r.status === "draft" ? "Calculate the run to see each employee." : "Nobody in this run."}
        />
      ) : (
        <DataTable
          columns={[
            { key: "name", header: "Employee", render: (_v, row) => { const i = row as unknown as ItemView; return <div><div style={{ fontWeight: 600 }}>{i.name}</div><div style={{ fontSize: 12, color: tokens.muted }}>{i.employeeNumber}{i.bank ? ` · ${i.bank}` : " · no bank details"}</div>{i.error ? <div style={{ fontSize: 12, color: tokens.destructive }}>{i.error}</div> : null}</div>; } },
            { key: "grossMinor", header: "Gross", render: (v) => <Money minor={Number(v)} /> },
            { key: "payeMinor", header: "PAYE", render: (v) => <Money minor={Number(v)} /> },
            { key: "uifEmployeeMinor", header: "UIF", render: (v) => <Money minor={Number(v)} /> },
            { key: "deductionsMinor", header: "Other deductions", render: (v) => <Money minor={Number(v)} /> },
            { key: "netMinor", header: "Net pay", render: (v) => <strong><Money minor={Number(v)} /></strong> },
            {
              key: "id",
              header: "",
              width: "170px",
              render: (_v, row) => {
                const i = row as unknown as ItemView;
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" style={small} onClick={() => setTraceItem(i)} disabled={!i.trace.length && !i.lines.length}>How</Button>
                    {editable ? <Button type="button" variant="secondary" style={small} onClick={() => openAdjust(i)}>Adjust</Button> : null}
                  </div>
                );
              },
            },
          ]}
          rows={detail.items as unknown as Array<Record<string, unknown>>}
          emptyMessage={r.status === "draft" ? "Calculate the run to see each employee." : "Nobody in this run."}
        />
      )}
      {detail.excluded.length ? <Muted style={{ fontSize: 12.5 }}>Left out of this run: {detail.excluded.map((x) => x.name).join(", ")}</Muted> : null}
      {detail.payslips.length ? (
        <Section title="Payslips">
          {narrow ? (
            <CompactRows
              label="Payslips"
              rows={detail.payslips}
              title={(p) => p.number}
              meta={(p) => (p.emailedTo ? `Emailed to ${p.emailedTo}${p.emailedAt ? ` · ${formatShortDate(p.emailedAt)}` : ""}` : p.error ?? payslipStatusLabel(p.status))}
              trailing={(p) => <StatusPill status={p.status} label={payslipStatusLabel(p.status)} />}
            />
          ) : (
            <DataTable
              columns={[
                { key: "number", header: "Payslip" },
                { key: "status", header: "Status", render: (v) => <StatusPill status={String(v)} label={payslipStatusLabel(String(v))} /> },
                { key: "emailedTo", header: "Emailed to" },
                { key: "emailedText", header: "Emailed on" },
                { key: "error", header: "Note" },
              ]}
              rows={detail.payslips.map((p) => ({ ...p, emailedText: p.emailedAt ? formatDateTime(p.emailedAt) : "–" })) as unknown as Array<Record<string, unknown>>}
            />
          )}
        </Section>
      ) : null}

      <Modal
        open={Boolean(traceItem)}
        title={traceItem ? `How ${traceItem.name}'s pay was worked out` : ""}
        onClose={() => setTraceItem(null)}
        footer={(
          <>
            {traceItem && editable ? <Button type="button" variant="secondary" onClick={() => { const i = traceItem; setTraceItem(null); openAdjust(i); }}>Adjust</Button> : null}
            <Button type="button" onClick={() => setTraceItem(null)}>Close</Button>
          </>
        )}
      >
        {traceItem ? (
          <div style={{ display: "grid", gap: 12, fontSize: 12.5 }}>
            {traceItem.error ? <Notice tone="bad">{traceItem.error}</Notice> : null}
            {traceItem.lines.length ? (
              <ScrollX>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {traceItem.lines.map((l, idx) => (
                      <tr key={`${l.code}-${idx}`} style={{ borderBottom: `1px solid ${tokens.border}` }}>
                        <td style={{ padding: "6px 8px 6px 0" }}>{l.label}</td>
                        <td style={{ padding: "6px 8px", color: tokens.muted }}>{lineSectionLabel(l.section)}</td>
                        <td style={{ padding: "6px 0", textAlign: "right" }}><Money minor={l.amountMinor} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            ) : null}
            {traceItem.warnings.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{traceItem.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            {traceItem.trace.length ? (
              <Details summary="Calculation steps">
                <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: tokens.fg }}>
                  {traceItem.trace.map((step) => (
                    <li key={step.step}>
                      <strong>{step.label}</strong>
                      <div style={{ color: tokens.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, overflowWrap: "anywhere" }}>
                        {Object.entries(step.inputs).map(([k, v]) => `${k}=${String(v)}`).join("  ")} → {Object.entries(step.outputs).map(([k, v]) => `${k}=${String(v)}`).join("  ")}
                      </div>
                    </li>
                  ))}
                </ol>
                <span>Amounts in the steps are cents; hours are hundredths of an hour; rates are basis points (1800 = 18%). SARS codes: {traceItem.lines.filter((l) => l.sarsCode).map((l) => `${l.label} ${l.sarsCode}`).join(", ") || "none"}.</span>
              </Details>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(adjustItem)} title={adjustItem ? `This run for ${adjustItem.name}` : ""} description="Changes apply to this run only; pay that repeats lives in the employee's terms." onClose={() => setAdjustItem(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setAdjustItem(null)}>Cancel</Button>
          <Button type="button" onClick={() => adjustItem && void act(async () => {
            const components: Array<{ code: string; amountMinor: number }> = [];
            const bonus = toMinor(adjustForm.bonus);
            const commission = toMinor(adjustForm.commission);
            const other = toMinor(adjustForm.other);
            if (bonus) components.push({ code: "BONUS", amountMinor: bonus });
            if (commission) components.push({ code: "COMMISSION", amountMinor: commission });
            if (other) components.push({ code: adjustForm.otherCode, amountMinor: other });
            await adjust({
              runId,
              employeeId: adjustItem.employeeId,
              inputs: {
                excluded: adjustForm.excluded,
                overtimeHours: adjustForm.overtimeHours ? Number(adjustForm.overtimeHours) : 0,
                doubleTimeHours: adjustForm.doubleTimeHours ? Number(adjustForm.doubleTimeHours) : 0,
                ...(adjustForm.ordinaryHours ? { ordinaryHours: Number(adjustForm.ordinaryHours) } : {}),
                unpaidHours: adjustForm.unpaidHours ? Number(adjustForm.unpaidHours) : 0,
                components,
              },
            });
            setAdjustItem(null);
          }, "Updated and recalculated")}>Save and recalculate</Button>
        </>
      )}>
        <Row>
          <Field label="Overtime hours"><Input value={adjustForm.overtimeHours} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, overtimeHours: e.target.value })} /></Field>
          <Field label="Sunday / public holiday hours"><Input value={adjustForm.doubleTimeHours} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, doubleTimeHours: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Ordinary hours (hourly staff)"><Input value={adjustForm.ordinaryHours} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, ordinaryHours: e.target.value })} /></Field>
          <Field label="Extra unpaid hours"><Input value={adjustForm.unpaidHours} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, unpaidHours: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Bonus (R)"><Input value={adjustForm.bonus} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, bonus: e.target.value })} /></Field>
          <Field label="Commission (R)"><Input value={adjustForm.commission} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, commission: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Other item">
            <Select value={adjustForm.otherCode} onChange={(e) => setAdjustForm({ ...adjustForm, otherCode: e.target.value })}>
              {s.components.filter((c) => c.active && ["earning", "allowance", "reimbursement", "deduction_post_tax", "fringe_benefit"].includes(c.kind) && !["BASIC", "HOURLY", "OVERTIME", "DOUBLE_TIME", "LEAVE_PAID", "LEAVE_UNPAID", "BONUS", "COMMISSION", "MEDICAL_ER", "PENSION_ER", "PROVIDENT_ER", "RA_ER"].includes(c.code)).map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Amount (R)"><Input value={adjustForm.other} inputMode="decimal" onChange={(e) => setAdjustForm({ ...adjustForm, other: e.target.value })} /></Field>
        </Row>
        <Field label="In this run">
          <Select value={adjustForm.excluded ? "out" : "in"} onChange={(e) => setAdjustForm({ ...adjustForm, excluded: e.target.value === "out" })}>
            <option value="in">Include</option>
            <option value="out">Leave out of this run</option>
          </Select>
        </Field>
      </Modal>

      <Modal open={approving} title={`Send ${r.number} for approval`} description="Someone who didn't prepare the run approves it. They get an approval task with the totals." onClose={() => setApproving(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setApproving(false)}>Cancel</Button>
          <Button type="button" disabled={!approver} onClick={() => void act(async () => { await requestApproval({ runId, approverUserId: approver }); setApproving(false); }, "Sent for approval")}>Send</Button>
        </>
      )}>
        <Field label="Approver">
          <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
            <option value="">Choose a person…</option>
            {options.map((o) => (
              <option key={o.userId} value={o.userId} disabled={o.isYou || preparedThis(o.userId)}>
                {o.name}{o.isYou && o.name !== "You" ? " (you)" : ""}{o.detail ? ` · ${o.detail}` : ""}{o.userId === s.settings.defaultApproverUserId ? " · usual approver" : ""}{!o.isYou && preparedThis(o.userId) ? " · prepared this run" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Muted style={{ fontSize: 12.5 }}>You can't send a run to yourself, or to the person who prepared it.</Muted>
      </Modal>

      <Modal open={bankOpen} title="Bank payment file" description="A file of everyone's net pay to upload in your bank's online banking. Nothing is paid until you do that." onClose={() => setBankOpen(false)} footer={<Button type="button" variant="secondary" onClick={() => setBankOpen(false)}>Close</Button>}>
        <div style={{ display: "grid", gap: 8 }}>
          {([["acb", "ACB file", "The standard South African bank format (most banks)."], ["netcash", "NetCash file", "For paying staff through NetCash."]] as const).map(([format, label, hint]) => (
            <button
              key={format}
              type="button"
              className="pib-link-card"
              onClick={() => {
                setBankOpen(false);
                void act(async () => {
                  const res = (await bankFile({ runId, format })) as { url?: string; content?: string; fileName: string; missing: string[]; rows: number };
                  download(res);
                  setMessage(`${label} ready for ${plural(res.rows, "person", "people")}. Upload it in your bank yourself; nothing was paid.${res.missing.length ? ` Left out (no bank details): ${res.missing.join(", ")}.` : ""}`);
                  return res;
                }, "");
              }}
              style={{ appearance: "none", textAlign: "left", display: "grid", gap: 2, minHeight: 48, padding: "8px 12px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.fg, fontFamily: "inherit", cursor: "pointer" }}
            >
              <strong style={{ fontSize: 13.5 }}>{label}</strong>
              <span style={{ fontSize: 12, color: tokens.muted }}>{hint}</span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={Boolean(variance)} title="Changes since the last locked run" description={variance?.comparedWith ? `Compared with ${variance.comparedWith.number}: changes of 10% or more.` : "There is no earlier locked run to compare with."} onClose={() => setVariance(null)} footer={<Button type="button" onClick={() => setVariance(null)}>Close</Button>}>
        {variance ? (
          <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
            {variance.changes.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {variance.changes.map((c, idx) => <li key={idx}>{c.name}: {varianceFieldLabel(c.field)} {rand(c.previousMinor)} → {rand(c.currentMinor)}{c.changeBp != null ? ` (${c.changeBp > 0 ? "+" : ""}${(c.changeBp / 100).toFixed(1)}%)` : ""}</li>)}
              </ul>
            ) : <p style={{ margin: 0 }}>No big changes.</p>}
            {variance.added.length ? <p style={{ margin: 0 }}>New: {variance.added.join(", ")}</p> : null}
            {variance.missing.length ? <p style={{ margin: 0 }}>Not in this run: {variance.missing.join(", ")}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );

  function openAdjust(i: ItemView) {
    const inputs = i.inputs as { overtimeHours?: number; doubleTimeHours?: number; ordinaryHours?: number; unpaidHours?: number; excluded?: boolean; components?: Array<{ code: string; amountMinor: number }> };
    const comp = (code: string) => minorText(inputs.components?.find((c) => c.code === code)?.amountMinor);
    const otherComp = inputs.components?.find((c) => !["BONUS", "COMMISSION"].includes(c.code));
    setAdjustForm({
      overtimeHours: inputs.overtimeHours ? String(inputs.overtimeHours) : "",
      doubleTimeHours: inputs.doubleTimeHours ? String(inputs.doubleTimeHours) : "",
      ordinaryHours: inputs.ordinaryHours ? String(inputs.ordinaryHours) : "",
      unpaidHours: inputs.unpaidHours ? String(inputs.unpaidHours) : "",
      bonus: comp("BONUS"),
      commission: comp("COMMISSION"),
      other: minorText(otherComp?.amountMinor),
      otherCode: otherComp?.code ?? "OTHER_ALLOWANCE",
      excluded: Boolean(inputs.excluded),
    });
    setAdjustItem(i);
  }
}
