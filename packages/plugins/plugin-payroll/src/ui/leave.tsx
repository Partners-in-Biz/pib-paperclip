/**
 * Leave: requests (one main action, "+ Record leave") and each person's
 * balances. Setting an opening balance sits with the balances.
 */
import { useEffect, useState } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, Field, Input, Modal, ProgressBar, Section, Select, Toolbar, fluidColumns, formatDate, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { leaveStatusLabel, leaveUsed, periodText } from "./series.js";
import { Muted, Row, small, StatusPill } from "./shared.js";
import type { LeaveData, LeaveRequestRow, RunFn, Snapshot } from "./types.js";

const days = (centi: number) => (centi / 100).toFixed(2).replace(/\.00$/, "");
const dayCount = (n: number) => `${String(n).replace(/\.0+$/, "")} ${n === 1 ? "day" : "days"}`;

export function LeaveTab({ s, run }: { s: Snapshot; run: RunFn }) {
  const load = usePluginAction("payroll.leave");
  const request = usePluginAction("payroll.request-leave");
  const decide = usePluginAction("payroll.decide-leave");
  const cancel = usePluginAction("payroll.cancel-leave");
  const opening = usePluginAction("payroll.leave-opening");
  const narrow = useIsNarrow();
  const [data, setData] = useState<LeaveData | null>(null);
  const [form, setForm] = useState<{ employeeId: string; type: string; startDate: string; endDate: string; days: string; reason: string } | null>(null);
  const [openingForm, setOpeningForm] = useState<{ employeeId: string; type: string; days: string; asOf: string } | null>(null);
  const [openRequest, setOpenRequest] = useState<LeaveRequestRow | null>(null);
  async function refresh() {
    setData((await load({})) as LeaveData);
  }
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);
  async function act(work: () => Promise<unknown>, success: string) {
    await run(work, success);
    await refresh().catch(() => undefined);
  }
  const active = s.employees.filter((e) => e.status === "active");
  const decisionButtons = (r: LeaveRequestRow, after?: () => void) => (
    <>
      {r.status === "pending" ? <Button type="button" style={small} onClick={() => { after?.(); void act(() => decide({ requestId: r.id, decision: "approve" }), "Leave approved"); }}>Approve</Button> : null}
      {r.status === "pending" ? <Button type="button" variant="secondary" style={small} onClick={() => { after?.(); void act(() => decide({ requestId: r.id, decision: "reject" }), "Leave declined"); }}>Decline</Button> : null}
      {r.status === "pending" || r.status === "approved" ? <Button type="button" variant="secondary" style={small} onClick={() => { after?.(); void act(() => cancel({ requestId: r.id }), "Leave cancelled"); }}>Cancel leave</Button> : null}
    </>
  );

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <Toolbar>
        {!active.length ? <span style={{ fontSize: 12.5, color: tokens.muted, alignSelf: "center" }}>Add employees first.</span> : null}
        <Button type="button" disabled={!active.length} onClick={() => setForm({ employeeId: active[0]?.id ?? "", type: "annual", startDate: s.today, endDate: s.today, days: "", reason: "" })}>+ Record leave</Button>
      </Toolbar>
      <Section title="Requests">
        {!data ? <Muted>Loading leave…</Muted> : data.requests.length ? (
          narrow ? (
            <CompactRows
              label="Leave requests"
              rows={data.requests}
              title={(r) => r.employee ?? "Employee"}
              meta={(r) => `${r.label} · ${periodText(r.startDate, r.endDate)}`}
              trailing={(r) => <StatusPill status={r.status} label={leaveStatusLabel(r.status)} />}
              onOpen={(r) => setOpenRequest(r)}
            />
          ) : (
            <DataTable
              columns={[
                { key: "employee", header: "Employee" },
                { key: "label", header: "Type" },
                { key: "dates", header: "Dates" },
                { key: "daysText", header: "Days" },
                { key: "status", header: "Status", render: (v) => <StatusPill status={String(v)} label={leaveStatusLabel(String(v))} /> },
                { key: "id", header: "", width: "250px", render: (_v, row) => <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{decisionButtons(row as unknown as LeaveRequestRow)}</div> },
              ]}
              rows={data.requests.map((r) => ({ ...r, dates: periodText(r.startDate, r.endDate), daysText: dayCount(r.days) })) as unknown as Array<Record<string, unknown>>}
            />
          )
        ) : <Muted>No leave recorded yet.</Muted>}
      </Section>
      <Section
        title={`Leave balances on ${formatDate(data?.asOf ?? s.today)}`}
        actions={active.length ? <Button type="button" variant="secondary" style={small} onClick={() => setOpeningForm({ employeeId: active[0]?.id ?? "", type: "annual", days: "", asOf: s.today })}>Set an opening balance</Button> : undefined}
      >
        {data?.balances.length ? (
          <div style={{ display: "grid", gridTemplateColumns: fluidColumns(260), gap: 12 }}>
            {data.balances.map((b) => (
              <div key={b.employeeId} style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
                <strong style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{b.name}</strong>
                {b.balances.filter((x) => x.type !== "unpaid").map((x) => {
                  const used = leaveUsed(x);
                  return (
                    <ProgressBar
                      key={x.type}
                      value={used.entitlementCenti ? 1 - used.ratio : 0}
                      label={x.label}
                      valueText={`${days(x.balanceCenti)} days left${x.pendingCenti ? ` · ${days(x.pendingCenti)} waiting` : ""}`}
                      tone={x.balanceCenti <= 0 ? "bad" : used.ratio >= 0.8 ? "warn" : "ok"}
                      size="sm"
                    />
                  );
                })}
                {(() => { const u = b.balances.find((x) => x.type === "unpaid"); return u && u.takenCenti ? <span style={{ fontSize: 12, color: tokens.muted }}>Unpaid leave taken: {days(u.takenCenti)} day{u.takenCenti === 100 ? "" : "s"}</span> : null; })()}
              </div>
            ))}
          </div>
        ) : <Muted>{data ? "Add employees to see their leave balances." : "Loading…"}</Muted>}
        <p style={{ margin: 0, fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>
          Legal minimums (Basic Conditions of Employment Act): 21 days' annual leave a year, shown here as working days (15 for a 5-day week); 6 weeks' sick leave every 3 years; 3 days' family responsibility leave a year after 4 months.
        </p>
      </Section>

      <Modal open={Boolean(openRequest)} title={openRequest ? `${openRequest.employee ?? "Leave"}: ${openRequest.label.toLowerCase()}` : ""} onClose={() => setOpenRequest(null)} footer={openRequest ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>{decisionButtons(openRequest, () => setOpenRequest(null))}<Button type="button" variant="secondary" style={small} onClick={() => setOpenRequest(null)}>Close</Button></div> : undefined}>
        {openRequest ? (
          <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <div><StatusPill status={openRequest.status} label={leaveStatusLabel(openRequest.status)} /></div>
            <span>{periodText(openRequest.startDate, openRequest.endDate)} · {dayCount(openRequest.days)}</span>
            {openRequest.reason ? <span style={{ color: tokens.muted }}>Reason: {openRequest.reason}</span> : null}
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(form)} title="Record leave" description="Opens an approval task for the leave approver. Unpaid leave is taken off pay in the pay run for that period." onClose={() => setForm(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
          <Button type="button" onClick={() => form && void act(async () => {
            await request({ employeeId: form.employeeId, type: form.type, startDate: form.startDate, endDate: form.endDate, days: form.days ? Number(form.days) : undefined, reason: form.reason || undefined });
            setForm(null);
          }, "Leave recorded; waiting for approval")}>Record</Button>
        </>
      )}>
        {form ? (
          <>
            <Field label="Employee">
              <Select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                {active.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            </Field>
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="annual">Annual leave</option>
                <option value="sick">Sick leave</option>
                <option value="family">Family responsibility leave</option>
                <option value="unpaid">Unpaid leave</option>
              </Select>
            </Field>
            <Row>
              <Field label="From"><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="To"><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
              <Field label="Days"><Input value={form.days} placeholder="Working days" inputMode="decimal" onChange={(e) => setForm({ ...form, days: e.target.value })} /></Field>
            </Row>
            <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </>
        ) : null}
      </Modal>

      <Modal open={Boolean(openingForm)} title="Opening leave balance" description="Days still available on a date, from your old system." onClose={() => setOpeningForm(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setOpeningForm(null)}>Cancel</Button>
          <Button type="button" onClick={() => openingForm && void act(async () => {
            await opening({ employeeId: openingForm.employeeId, type: openingForm.type, days: Number(openingForm.days), asOf: openingForm.asOf });
            setOpeningForm(null);
          }, "Opening balance saved")}>Save</Button>
        </>
      )}>
        {openingForm ? (
          <>
            <Field label="Employee">
              <Select value={openingForm.employeeId} onChange={(e) => setOpeningForm({ ...openingForm, employeeId: e.target.value })}>
                {active.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            </Field>
            <Row>
              <Field label="Type">
                <Select value={openingForm.type} onChange={(e) => setOpeningForm({ ...openingForm, type: e.target.value })}>
                  <option value="annual">Annual</option>
                  <option value="sick">Sick</option>
                </Select>
              </Field>
              <Field label="Days available"><Input value={openingForm.days} inputMode="decimal" onChange={(e) => setOpeningForm({ ...openingForm, days: e.target.value })} /></Field>
              <Field label="On"><Input type="date" value={openingForm.asOf} onChange={(e) => setOpeningForm({ ...openingForm, asOf: e.target.value })} /></Field>
            </Row>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
