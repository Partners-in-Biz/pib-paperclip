/**
 * Employees: one "+ Add employee" (in the toolbar once there are staff, in
 * the empty state before), off until the encryption key is set. Each person
 * opens a panel with their details and every action for them.
 */
import { useMemo, useState } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  CompactRows,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Sheet,
  Toolbar,
  formatDate,
  tokens,
  tone,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { revealedLines } from "./series.js";
import { Money, Muted, rand, minorText, Row, small, StatusPill, toMinor } from "./shared.js";
import type { EmployeeView, RunFn, Snapshot, TermsView } from "./types.js";

const EMPTY_EMPLOYEE = {
  employeeId: "", firstName: "", lastName: "", email: "", phone: "", jobTitle: "", employeeNumber: "", dateOfBirth: "", startDate: "", taxResidency: "resident",
  idNumber: "", passportNumber: "", passportCountry: "", taxReference: "", bankName: "", branchCode: "", accountNumber: "", accountType: "current", accountHolder: "",
  etiEligible: false, etiMonthsBefore: "0",
};

/** Pay that is set up in terms, not in the monthly items list. */
const TERMS_CODES = ["BASIC", "HOURLY", "OVERTIME", "DOUBLE_TIME", "LEAVE_PAID", "LEAVE_UNPAID", "TRAVEL_ALLOWANCE", "MEDICAL_EE", "MEDICAL_ER", "PENSION_EE", "PENSION_ER", "PROVIDENT_EE", "PROVIDENT_ER", "RA_EE", "RA_ER"];

function per(terms: TermsView): string {
  if (terms.workerCategory === "hourly") return "an hour";
  return terms.frequency === "monthly" ? "a month" : terms.frequency === "weekly" ? "a week" : "a fortnight";
}

/** "R 30,000.00 a month". */
export function payText(terms: TermsView | null): string | null {
  return terms ? `${rand(terms.rateMinor)} ${per(terms)}` : null;
}

/** One muted line for a person: what is missing, else number and job title. */
function employeeLine(e: EmployeeView): string {
  if (e.status !== "active") return e.endDate ? `Left on ${formatDate(e.endDate)}` : "No longer employed";
  const missing = [!e.terms ? "pay terms" : null, !e.has.bank ? "bank details" : null, !e.has.tax ? "tax number" : null].filter(Boolean);
  if (missing.length) return `Still needs: ${missing.join(", ")}`;
  return [e.employeeNumber, e.jobTitle].filter(Boolean).join(" · ");
}

function detailText(value: string) {
  return value === "missing" ? <span style={{ color: tone("warn").fg }}>Missing</span> : <span style={{ overflowWrap: "anywhere" }}>{value}</span>;
}

export function EmployeesTab({ s, run, settingsLink }: { s: Snapshot; run: RunFn; settingsLink: Record<string, unknown> }) {
  const save = usePluginAction("payroll.save-employee");
  const saveTerms = usePluginAction("payroll.save-terms");
  const reveal = usePluginAction("payroll.reveal");
  const terminate = usePluginAction("payroll.terminate-employee");
  const setRecurring = usePluginAction("payroll.set-recurring");
  const narrow = useIsNarrow();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<typeof EMPTY_EMPLOYEE | null>(null);
  const [termsFor, setTermsFor] = useState<EmployeeView | null>(null);
  const [terms, setTerms] = useState<Record<string, string | boolean>>({});
  const [revealed, setRevealed] = useState<{ name: string; field: string; value: unknown } | null>(null);
  const [recurringFor, setRecurringFor] = useState<EmployeeView | null>(null);
  const [recurring, setRecurringForm] = useState({ code: "OTHER_ALLOWANCE", amount: "", label: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<{ id: string; date: string } | null>(null);

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => s.employees.filter((e) => !q || e.name.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q) || (e.jobTitle ?? "").toLowerCase().includes(q)), [s.employees, q]);
  const set = (key: keyof typeof EMPTY_EMPLOYEE, value: string | boolean) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const componentName = (code: string) => s.components.find((c) => c.code === code)?.name ?? code.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const open = openId ? s.employees.find((e) => e.id === openId) ?? null : null;

  function openEdit(e: EmployeeView | null) {
    setForm(e ? {
      ...EMPTY_EMPLOYEE,
      employeeId: e.id, firstName: e.firstName, lastName: e.lastName, email: e.email ?? "", phone: e.phone ?? "", jobTitle: e.jobTitle ?? "",
      employeeNumber: e.employeeNumber, dateOfBirth: e.dateOfBirth ?? "", startDate: e.startDate, taxResidency: e.taxResidency, etiEligible: e.etiEligible, etiMonthsBefore: String(e.etiMonthsBefore),
    } : { ...EMPTY_EMPLOYEE, startDate: s.today });
  }

  function openTerms(e: EmployeeView) {
    const t = e.terms;
    setTermsFor(e);
    setTerms({
      frequency: t?.frequency ?? "monthly",
      workerCategory: t?.workerCategory ?? "salaried",
      rate: minorText(t?.rateMinor),
      standardHours: t ? String(t.standardHours) : "",
      hoursPerDay: t ? String(t.hoursPerDay) : "8",
      daysPerWeek: t ? String(t.daysPerWeek) : "5",
      overtimeMultiplier: t ? String(t.overtimeMultiplier) : "1.5",
      uifApplicable: t?.uifApplicable ?? true,
      sdlApplicable: t?.sdlApplicable ?? true,
      medicalMembers: t?.medical ? String(t.medical.members) : "",
      medicalEmployee: minorText(t?.medical?.employeeContributionMinor),
      medicalEmployer: minorText(t?.medical?.employerContributionMinor),
      retirementFund: t?.retirement?.fund ?? "pension",
      retirementEmployee: minorText(t?.retirement?.employeeContributionMinor),
      retirementEmployer: minorText(t?.retirement?.employerContributionMinor),
      travel: minorText(t?.travel?.amountMinor),
      travelBusiness: t?.travel?.businessUseAtLeast80 ?? false,
      annualLeaveDays: t?.annualLeaveDays != null ? String(t.annualLeaveDays) : "",
      effectiveFrom: s.today,
    });
  }

  function openRecurring(e: EmployeeView) {
    setRecurringFor(e);
    setRecurringForm({ code: "OTHER_ALLOWANCE", amount: "", label: "" });
  }

  function doReveal(e: EmployeeView, field: "identity" | "tax" | "bank") {
    void run(async () => {
      const result = (await reveal({ employeeId: e.id, field })) as { value: unknown };
      setRevealed({ name: e.name, field, value: result.value });
    });
  }

  const keyReady = s.settings.encryptionKey;
  const addButton = <Button type="button" disabled={!keyReady} onClick={() => openEdit(null)}>+ Add employee</Button>;
  // Visible, not only a tooltip: why the button is off, with the fix.
  const keyReason = keyReady ? null : (
    <span style={{ fontSize: 12.5, color: tokens.muted, alignSelf: "center" }}>
      Set the encryption key first. <a {...settingsLink} style={{ color: tokens.primary, fontWeight: 600, whiteSpace: "nowrap" }}>Open settings</a>
    </span>
  );
  const f = form;

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {s.employees.length === 0 ? (
        <EmptyState
          title="No employees yet"
          description={keyReady
            ? "Add each person with their ID or passport, tax number and bank details, then set their pay terms."
            : "Staff ID, tax and bank details are sealed with the encryption key, so set it in the Payroll settings first."}
          action={<div style={{ display: "grid", gap: 8, justifyItems: "center" }}>{addButton}{keyReason}</div>}
        />
      ) : (
        <>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search employees…">{keyReason}{addButton}</Toolbar>
          {narrow ? (
            <CompactRows
              label="Employees"
              rows={rows}
              title={(e) => e.name}
              meta={(e) => employeeLine(e)}
              trailing={(e) => (e.terms ? rand(e.terms.rateMinor) : <StatusPill status="pending" label="No pay terms" />)}
              onOpen={(e) => setOpenId(e.id)}
              empty="No employees match."
            />
          ) : (
            <DataTable
              columns={[
                {
                  key: "name",
                  header: "Employee",
                  render: (_v, row) => {
                    const e = row as unknown as EmployeeView;
                    return (
                      <div style={{ display: "grid", gap: 2 }}>
                        <button type="button" onClick={() => setOpenId(e.id)} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, textAlign: "left", fontWeight: 600, color: tokens.fg, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>{e.name}</button>
                        <span style={{ fontSize: 12, color: tokens.muted }}>{employeeLine(e)}</span>
                      </div>
                    );
                  },
                },
                { key: "pay", header: "Pay", render: (_v, row) => { const e = row as unknown as EmployeeView; return e.terms ? <span style={{ whiteSpace: "nowrap" }}>{payText(e.terms)}</span> : <StatusPill status="pending" label="No pay terms" />; } },
                { key: "idText", header: "ID or passport", render: (v) => detailText(String(v)) },
                { key: "taxText", header: "Tax number", render: (v) => detailText(String(v)) },
                { key: "bankText", header: "Bank", render: (v) => detailText(String(v)) },
                { key: "status", header: "Status", render: (v) => <StatusPill status={String(v)} label={v === "active" ? "Employed" : v === "terminated" ? "Left" : undefined} tone={v === "active" ? "ok" : v === "terminated" ? "neutral" : "warn"} /> },
                { key: "id", header: "", width: "90px", render: (_v, row) => <Button type="button" variant="secondary" style={small} onClick={() => setOpenId((row as unknown as EmployeeView).id)}>Open</Button> },
              ]}
              rows={rows.map((e) => ({ ...e, pay: "", idText: e.details.idOrPassport, taxText: e.details.taxReference, bankText: e.details.bank }))}
              emptyMessage="No employees match."
            />
          )}
        </>
      )}

      <Sheet open={Boolean(open)} title={open?.name ?? ""} onClose={() => { setOpenId(null); setLeaving(null); }}>
        {open ? (
          <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <StatusPill status={open.status} label={open.status === "active" ? "Employed" : "Left"} tone={open.status === "active" ? "ok" : "neutral"} />
              <span style={{ fontSize: 12.5, color: tokens.muted }}>{[open.employeeNumber, open.jobTitle].filter(Boolean).join(" · ")}</span>
            </div>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, 11em) minmax(0, 1fr)", gap: "8px 12px", fontSize: 13 }}>
              <dt style={{ color: tokens.muted }}>Started</dt><dd style={{ margin: 0 }}>{formatDate(open.startDate)}</dd>
              {open.endDate ? <><dt style={{ color: tokens.muted }}>Last day</dt><dd style={{ margin: 0 }}>{formatDate(open.endDate)}</dd></> : null}
              <dt style={{ color: tokens.muted }}>Pay</dt><dd style={{ margin: 0 }}>{payText(open.terms) ?? <span style={{ color: tone("warn").fg }}>No pay terms yet</span>}</dd>
              <dt style={{ color: tokens.muted }}>ID or passport</dt><dd style={{ margin: 0 }}>{detailText(open.details.idOrPassport)}</dd>
              <dt style={{ color: tokens.muted }}>Tax number</dt><dd style={{ margin: 0 }}>{detailText(open.details.taxReference)}</dd>
              <dt style={{ color: tokens.muted }}>Bank</dt><dd style={{ margin: 0 }}>{detailText(open.details.bank)}</dd>
              <dt style={{ color: tokens.muted }}>Email</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{open.email ?? "–"}</dd>
              <dt style={{ color: tokens.muted }}>Monthly items</dt>
              <dd style={{ margin: 0 }}>{open.recurring.length ? open.recurring.map((r) => <div key={r.code}>{r.label ?? componentName(r.code)}: <Money minor={r.amountMinor} /></div>) : "None"}</dd>
            </dl>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" onClick={() => openEdit(open)}>Edit details</Button>
              <Button type="button" variant="secondary" onClick={() => openTerms(open)}>Pay terms</Button>
              <Button type="button" variant="secondary" onClick={() => openRecurring(open)}>Monthly items</Button>
            </div>
            {open.has.identity || open.has.tax || open.has.bank ? (
              <div style={{ display: "grid", gap: 6 }}>
                <Muted style={{ fontSize: 12.5 }}>See a sealed detail (each look is logged):</Muted>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {open.has.identity ? <Button type="button" variant="secondary" style={small} onClick={() => doReveal(open, "identity")}>ID number</Button> : null}
                  {open.has.tax ? <Button type="button" variant="secondary" style={small} onClick={() => doReveal(open, "tax")}>Tax number</Button> : null}
                  {open.has.bank ? <Button type="button" variant="secondary" style={small} onClick={() => doReveal(open, "bank")}>Bank details</Button> : null}
                </div>
              </div>
            ) : null}
            {open.status === "active" ? (
              <div style={{ display: "grid", gap: 8, borderTop: `1px solid ${tokens.border}`, paddingTop: 12 }}>
                {leaving?.id === open.id ? (
                  <>
                    <Field label="Last working day"><Input type="date" value={leaving.date} onChange={(e) => setLeaving({ id: open.id, date: e.target.value })} /></Field>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button type="button" disabled={!leaving.date} onClick={() => {
                        const endDate = leaving.date;
                        const name = open.name;
                        void run(async () => {
                          await terminate({ employeeId: open.id, endDate });
                          setLeaving(null);
                        }, `${name} marked as left`);
                      }}>Mark as left</Button>
                      <Button type="button" variant="secondary" onClick={() => setLeaving(null)}>Cancel</Button>
                    </div>
                  </>
                ) : (
                  <button type="button" onClick={() => setLeaving({ id: open.id, date: s.today })} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, minHeight: 36, textAlign: "left", color: tokens.destructive, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "fit-content" }}>
                    Mark as left…
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Modal
        open={Boolean(f)}
        title={f?.employeeId ? `Edit ${f.firstName} ${f.lastName}` : "New employee"}
        description="ID, tax and bank details are sealed as soon as you save. Leave them blank to keep what is on file."
        onClose={() => setForm(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
            <Button type="button" onClick={() => f && void run(async () => {
              const payload: Record<string, unknown> = {
                ...(f.employeeId ? { employeeId: f.employeeId } : {}),
                firstName: f.firstName, lastName: f.lastName, email: f.email || null, phone: f.phone || null, jobTitle: f.jobTitle || null,
                employeeNumber: f.employeeNumber || undefined, dateOfBirth: f.dateOfBirth || undefined, startDate: f.startDate, taxResidency: f.taxResidency,
                etiEligible: f.etiEligible, etiMonthsBefore: Number(f.etiMonthsBefore || 0),
              };
              for (const key of ["idNumber", "passportNumber", "passportCountry", "taxReference", "bankName", "branchCode", "accountNumber", "accountType", "accountHolder"] as const) {
                if (key === "accountType" && !f.accountNumber) continue;
                if (f[key]) payload[key] = f[key];
              }
              await save(payload);
              setForm(null);
            }, "Employee saved")}>Save</Button>
          </>
        )}
      >
        {f ? (
          <>
            <Row>
              <Field label="First names"><Input value={f.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
              <Field label="Surname"><Input value={f.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field>
            </Row>
            <Row>
              <Field label="Email (for payslips)"><Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
              <Field label="Job title"><Input value={f.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} /></Field>
            </Row>
            <Row>
              <Field label="Employee number"><Input value={f.employeeNumber} placeholder="Automatic" onChange={(e) => set("employeeNumber", e.target.value)} /></Field>
              <Field label="Start date"><Input type="date" value={f.startDate} onChange={(e) => set("startDate", e.target.value)} /></Field>
            </Row>
            <Row>
              <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Field>
              <Field label="Tax residency">
                <Select value={f.taxResidency} onChange={(e) => set("taxResidency", e.target.value)}>
                  <option value="resident">South African resident</option>
                  <option value="non_resident">Non-resident</option>
                </Select>
              </Field>
            </Row>
            <Row>
              <Field label="SA ID number"><Input value={f.idNumber} autoComplete="off" placeholder={f.employeeId ? "Leave blank to keep" : ""} onChange={(e) => set("idNumber", e.target.value)} /></Field>
              <Field label="Passport number (if no SA ID)"><Input value={f.passportNumber} autoComplete="off" onChange={(e) => set("passportNumber", e.target.value)} /></Field>
            </Row>
            <Field label="Tax reference number"><Input value={f.taxReference} autoComplete="off" placeholder={f.employeeId ? "Leave blank to keep" : "10 digits"} onChange={(e) => set("taxReference", e.target.value)} /></Field>
            <Row>
              <Field label="Bank"><Input value={f.bankName} autoComplete="off" onChange={(e) => set("bankName", e.target.value)} /></Field>
              <Field label="Branch code"><Input value={f.branchCode} autoComplete="off" inputMode="numeric" onChange={(e) => set("branchCode", e.target.value)} /></Field>
            </Row>
            <Row>
              <Field label="Account number"><Input value={f.accountNumber} autoComplete="off" inputMode="numeric" placeholder={f.employeeId ? "Leave blank to keep" : ""} onChange={(e) => set("accountNumber", e.target.value)} /></Field>
              <Field label="Account type">
                <Select value={f.accountType} onChange={(e) => set("accountType", e.target.value)}>
                  <option value="current">Current or cheque</option>
                  <option value="savings">Savings</option>
                  <option value="transmission">Transmission</option>
                </Select>
              </Field>
            </Row>
            <Field label="Account holder (if not the employee)"><Input value={f.accountHolder} onChange={(e) => set("accountHolder", e.target.value)} /></Field>
            <Row>
              <Field label="Employment Tax Incentive (ETI)">
                <Select value={f.etiEligible ? "yes" : "no"} onChange={(e) => set("etiEligible", e.target.value === "yes")}>
                  <option value="no">Not claimed</option>
                  <option value="yes">Qualifies (aged 18 to 29, valid ID)</option>
                </Select>
              </Field>
              <Field label="Months of ETI already claimed"><Input value={f.etiMonthsBefore} inputMode="numeric" onChange={(e) => set("etiMonthsBefore", e.target.value)} /></Field>
            </Row>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(termsFor)}
        title={termsFor ? `Pay terms: ${termsFor.name}` : ""}
        description="Saving adds a new version from the date below; earlier pay runs keep the terms they used."
        onClose={() => setTermsFor(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setTermsFor(null)}>Cancel</Button>
            <Button type="button" onClick={() => termsFor && void run(async () => {
              const t = terms;
              await saveTerms({
                employeeId: termsFor.id,
                effectiveFrom: t.effectiveFrom,
                frequency: t.frequency,
                workerCategory: t.workerCategory,
                rateMinor: toMinor(String(t.rate)) ?? undefined,
                standardHours: t.standardHours ? Number(t.standardHours) : undefined,
                hoursPerDay: Number(t.hoursPerDay || 8),
                daysPerWeek: Number(t.daysPerWeek || 5),
                overtimeMultiplier: Number(t.overtimeMultiplier || 1.5),
                uifApplicable: t.uifApplicable,
                sdlApplicable: t.sdlApplicable,
                medical: t.medicalMembers || t.medicalEmployee || t.medicalEmployer
                  ? { members: Number(t.medicalMembers || 0), employeeContributionMinor: toMinor(String(t.medicalEmployee)) ?? 0, employerContributionMinor: toMinor(String(t.medicalEmployer)) ?? 0 }
                  : null,
                retirement: t.retirementEmployee || t.retirementEmployer
                  ? { fund: t.retirementFund, employeeContributionMinor: toMinor(String(t.retirementEmployee)) ?? 0, employerContributionMinor: toMinor(String(t.retirementEmployer)) ?? 0 }
                  : null,
                travel: t.travel ? { amountMinor: toMinor(String(t.travel)) ?? 0, businessUseAtLeast80: t.travelBusiness } : null,
                annualLeaveDays: t.annualLeaveDays ? Number(t.annualLeaveDays) : undefined,
              });
              setTermsFor(null);
            }, "Pay terms saved")}>Save terms</Button>
          </>
        )}
      >
        <Row>
          <Field label="How often they're paid">
            <Select value={String(terms.frequency)} onChange={(e) => setTerms({ ...terms, frequency: e.target.value })}>
              <option value="monthly">Monthly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          <Field label="Paid by">
            <Select value={String(terms.workerCategory)} onChange={(e) => setTerms({ ...terms, workerCategory: e.target.value })}>
              <option value="salaried">Salary</option>
              <option value="hourly">The hour</option>
            </Select>
          </Field>
        </Row>
        <Row>
          <Field label={terms.workerCategory === "hourly" ? "Rate per hour (R)" : "Salary per pay period (R)"}><Input value={String(terms.rate ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, rate: e.target.value })} /></Field>
          <Field label="Normal hours per period"><Input value={String(terms.standardHours ?? "")} placeholder="173.33 a month" inputMode="decimal" onChange={(e) => setTerms({ ...terms, standardHours: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Hours per day"><Input value={String(terms.hoursPerDay ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, hoursPerDay: e.target.value })} /></Field>
          <Field label="Days per week"><Input value={String(terms.daysPerWeek ?? "")} inputMode="numeric" onChange={(e) => setTerms({ ...terms, daysPerWeek: e.target.value })} /></Field>
          <Field label="Overtime rate (×)"><Input value={String(terms.overtimeMultiplier ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, overtimeMultiplier: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="UIF (unemployment insurance)">
            <Select value={terms.uifApplicable ? "yes" : "no"} onChange={(e) => setTerms({ ...terms, uifApplicable: e.target.value === "yes" })}>
              <option value="yes">Contributes</option>
              <option value="no">Exempt (e.g. under 24 hours a month)</option>
            </Select>
          </Field>
          <Field label="SDL (skills development levy)">
            <Select value={terms.sdlApplicable ? "yes" : "no"} onChange={(e) => setTerms({ ...terms, sdlApplicable: e.target.value === "yes" })}>
              <option value="yes">Included</option>
              <option value="no">Left out</option>
            </Select>
          </Field>
        </Row>
        <Row>
          <Field label="Medical aid members"><Input value={String(terms.medicalMembers ?? "")} placeholder="Employee + dependants" inputMode="numeric" onChange={(e) => setTerms({ ...terms, medicalMembers: e.target.value })} /></Field>
          <Field label="Medical: employee pays (R)"><Input value={String(terms.medicalEmployee ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, medicalEmployee: e.target.value })} /></Field>
          <Field label="Medical: employer pays (R)"><Input value={String(terms.medicalEmployer ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, medicalEmployer: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Retirement fund">
            <Select value={String(terms.retirementFund)} onChange={(e) => setTerms({ ...terms, retirementFund: e.target.value })}>
              <option value="pension">Pension fund</option>
              <option value="provident">Provident fund</option>
              <option value="retirement_annuity">Retirement annuity</option>
            </Select>
          </Field>
          <Field label="Employee pays (R)"><Input value={String(terms.retirementEmployee ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, retirementEmployee: e.target.value })} /></Field>
          <Field label="Employer pays (R)"><Input value={String(terms.retirementEmployer ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, retirementEmployer: e.target.value })} /></Field>
        </Row>
        <Row>
          <Field label="Travel allowance per period (R)"><Input value={String(terms.travel ?? "")} inputMode="decimal" onChange={(e) => setTerms({ ...terms, travel: e.target.value })} /></Field>
          <Field label="Business use">
            <Select value={terms.travelBusiness ? "yes" : "no"} onChange={(e) => setTerms({ ...terms, travelBusiness: e.target.value === "yes" })}>
              <option value="no">Under 80% (80% is taxed)</option>
              <option value="yes">At least 80% (20% is taxed)</option>
            </Select>
          </Field>
        </Row>
        <Row>
          <Field label="Annual leave days (only if more than the legal minimum)"><Input value={String(terms.annualLeaveDays ?? "")} inputMode="numeric" onChange={(e) => setTerms({ ...terms, annualLeaveDays: e.target.value })} /></Field>
          <Field label="Applies from"><Input type="date" value={String(terms.effectiveFrom ?? "")} onChange={(e) => setTerms({ ...terms, effectiveFrom: e.target.value })} /></Field>
        </Row>
      </Modal>

      <Modal open={Boolean(recurringFor)} title={recurringFor ? `Monthly items: ${recurringFor.name}` : ""} description="Paid or deducted every run until you set the amount to 0." onClose={() => setRecurringFor(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setRecurringFor(null)}>Close</Button>
          <Button type="button" onClick={() => recurringFor && void run(async () => {
            await setRecurring({ employeeId: recurringFor.id, code: recurring.code, amountMinor: toMinor(recurring.amount) ?? 0, label: recurring.label || null });
            setRecurringFor(null);
          }, "Saved")}>Save item</Button>
        </>
      )}>
        {recurringFor?.recurring.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{recurringFor.recurring.map((r) => <li key={r.code}>{r.label ?? componentName(r.code)}: {rand(r.amountMinor)}</li>)}</ul>
        ) : <Muted>No monthly items yet.</Muted>}
        <Field label="Item">
          <Select value={recurring.code} onChange={(e) => setRecurringForm({ ...recurring, code: e.target.value })}>
            {s.components.filter((c) => c.active && !TERMS_CODES.includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Row>
          <Field label="Amount per run (R)"><Input value={recurring.amount} inputMode="decimal" onChange={(e) => setRecurringForm({ ...recurring, amount: e.target.value })} /></Field>
          <Field label="Label on payslip"><Input value={recurring.label} onChange={(e) => setRecurringForm({ ...recurring, label: e.target.value })} /></Field>
        </Row>
      </Modal>

      <Modal open={Boolean(revealed)} title={revealed ? `${revealed.name}: ${revealed.field === "identity" ? "ID number" : revealed.field === "tax" ? "tax number" : "bank details"}` : ""} description="This look was logged. Close it when you are done." onClose={() => setRevealed(null)} footer={<Button type="button" onClick={() => setRevealed(null)}>Close</Button>}>
        {revealed ? (
          revealedLines(revealed.value).length ? (
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, 10em) minmax(0, 1fr)", gap: "6px 12px", fontSize: 13 }}>
              {revealedLines(revealed.value).map((line) => (
                <div key={line.label} style={{ display: "contents" }}>
                  <dt style={{ color: tokens.muted }}>{line.label}</dt>
                  <dd style={{ margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere" }}>{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : <Muted>Nothing on file.</Muted>
        ) : null}
      </Modal>
    </div>
  );
}
