import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Section,
  Select,
  StatRow,
  Tabs,
  TextArea,
  Toolbar,
  errorText,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";

const PLUGIN_ID = "partnersinbiz.payroll";

// ---------------------------------------------------------------------------
// Types (what the worker returns)
// ---------------------------------------------------------------------------

type Frequency = "monthly" | "fortnightly" | "weekly";

interface Totals {
  employeeCount: number;
  grossMinor: number;
  payeMinor: number;
  etiMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  deductionsMinor: number;
  employerContributionsMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
}

interface RunSummary {
  id: string;
  number: string;
  kind: "regular" | "correction" | "reversal";
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: string;
  status: string;
  preparedBy: { kind: string; id: string } | null;
  approverUserId: string | null;
  approvalIssueId: string | null;
  approvedByUserId: string | null;
  reversesRunId: string | null;
  reversedByRunId: string | null;
  ledger: { status: string; journalNumber: string | null; error: string | null };
  totals: Totals;
  warnings: string[];
}

interface TermsView {
  frequency: Frequency;
  workerCategory: "salaried" | "hourly";
  rateMinor: number;
  standardHours: number;
  hoursPerDay: number;
  daysPerWeek: number;
  overtimeMultiplier: number;
  uifApplicable: boolean;
  sdlApplicable: boolean;
  medical: { members: number; employeeContributionMinor: number; employerContributionMinor: number } | null;
  retirement: { fund: string; employeeContributionMinor: number; employerContributionMinor: number } | null;
  travel: { amountMinor: number; businessUseAtLeast80: boolean } | null;
  annualLeaveDays: number | null;
  effectiveFrom: string;
  version: number;
}

interface EmployeeView {
  id: string;
  employeeNumber: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  dateOfBirth: string | null;
  age: number | null;
  status: string;
  startDate: string;
  endDate: string | null;
  taxResidency: string;
  details: { idOrPassport: string; taxReference: string; bank: string };
  has: { identity: boolean; tax: boolean; bank: boolean };
  etiEligible: boolean;
  etiMonthsBefore: number;
  terms: TermsView | null;
  recurring: Array<{ code: string; amountMinor: number; label: string | null }>;
}

interface Component {
  code: string;
  name: string;
  kind: string;
  sarsCode: string | null;
  active: boolean;
}

interface Snapshot {
  today: string;
  me: string | null;
  settings: {
    saved: boolean;
    employerNamed: boolean;
    payeReference: boolean;
    encryptionKey: boolean;
    privateStorage: boolean;
    defaultApproverSet: boolean;
    defaultApproverUserId?: string | null;
    sdlMode: string;
    etiRegistered: boolean;
    defaultPayDay: number;
  };
  rules: { id: string | null; taxYear: string; unverified: Array<{ path: string; note: string }>; notes: string[] };
  counts: { employees: number; withoutTerms: number; withoutBank: number; withoutTax: number; pendingLeave: number };
  estimatedMonthlyBasicMinor: number;
  openRuns: RunSummary[];
  lastLocked: RunSummary | null;
  members: Array<{ userId: string; role: string | null; isYou: boolean }>;
  employees: EmployeeView[];
  runs: RunSummary[];
  components: Component[];
  hire: { agent: { id: string; name: string; status: string } | null; hire: { issueId: string; identifier: string | null } | null } | null;
  rulesReviewed: boolean;
}

interface Line {
  code: string;
  label: string;
  section: string;
  sarsCode: string | null;
  amountMinor: number;
  quantityCenti?: number | null;
  rateMinor?: number | null;
}

interface TraceStep {
  step: number;
  code: string;
  label: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

interface ItemView {
  id: string;
  employeeId: string;
  name: string;
  employeeNumber: string;
  status: string;
  error: string | null;
  grossMinor: number;
  payeMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  etiMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  lines: Line[];
  trace: TraceStep[];
  warnings: string[];
  bank: string | null;
  inputs: Record<string, unknown>;
}

interface RunDetail {
  run: RunSummary;
  approvalStatus: string | null;
  items: ItemView[];
  excluded: Array<{ employeeId: string; name: string }>;
  payslips: Array<{ id: string; employeeId: string; number: string; status: string; emailedTo: string | null; emailedAt: string | null; error: string | null }>;
}

type TabId = "overview" | "employees" | "runs" | "payslips" | "leave" | "statutory";
const TAB_IDS: TabId[] = ["overview", "employees", "runs", "payslips", "leave", "statutory"];

/** `?tab=` from the address (Setup links to e.g. /payroll?tab=employees). */
function tabFrom(search: string): TabId | null {
  const value = new URLSearchParams(search).get("tab");
  return value && (TAB_IDS as string[]).includes(value) ? (value as TabId) : null;
}

/** False once Setup says the company switched this module off; true while loading or unknown. */
function useModuleEnabled(companyId: string | null | undefined): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, PLUGIN_ID).then((value) => { if (live) setEnabled(value); }, () => { if (live) setEnabled(true); });
    return () => { live = false; };
  }, [companyId]);
  return enabled;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same format as the payslip PDF: R 12,345.67. */
function rand(minor: number | null | undefined): string {
  const value = Math.trunc(minor ?? 0);
  const abs = Math.abs(value);
  return `${value < 0 ? "-" : ""}R ${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

function toMinor(text: string): number | null {
  const cleaned = text.replace(/[R\s,]/gi, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

function minorText(minor: number | null | undefined): string {
  return minor ? (minor / 100).toFixed(2) : "";
}

function words(value: string): string {
  return value.replace(/_/g, " ");
}

function runBadge(status: string): "ok" | "warning" | "error" | "info" | "pending" {
  if (status === "locked") return "ok";
  if (status === "approved") return "info";
  if (status === "pending_approval" || status === "calculated" || status === "draft") return "pending";
  if (status === "cancelled" || status === "reversed") return "warning";
  return "info";
}

function memberLabel(m: { userId: string; role: string | null; isYou: boolean }): string {
  return `${m.isYou ? "You" : `Member ${m.userId.slice(0, 8)}`}${m.role ? ` (${m.role})` : ""}`;
}

function download(result: { url?: string | null; content?: string | null; fileName: string; contentType?: string }) {
  if (result.url) {
    window.open(result.url, "_blank", "noopener");
    return;
  }
  if (result.content != null) {
    const blob = new Blob([result.content], { type: result.contentType ?? "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = result.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 5_000);
  }
}

const small = { height: 28, fontSize: 12 } as const;

function Notice({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "warn" ? "alert" : "status"}
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${tone === "warn" ? "color-mix(in oklab, var(--destructive) 45%, transparent)" : tokens.border}`,
        background: tone === "warn" ? "color-mix(in oklab, var(--destructive) 8%, transparent)" : tokens.secondary,
        color: tokens.fg,
      }}
    >
      {children}
    </div>
  );
}

function Money({ minor }: { minor: number }) {
  return <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{rand(minor)}</span>;
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PayrollPage({ context }: PluginPageProps) {
  const enabled = useModuleEnabled(context.companyId);
  if (enabled === false) return <ModuleOff />;
  return <PayrollWorkspace context={context} />;
}

function ModuleOff() {
  const hostNavigation = useHostNavigation();
  return (
    <Page title="Payroll" description="South African payroll for your own staff.">
      <Notice tone="info">
        This module is switched off for this company. Turn it on in <a {...hostNavigation.linkProps("/setup")}>Setup</a>.
      </Notice>
    </Page>
  );
}

function PayrollWorkspace({ context }: PluginPageProps) {
  const load = usePluginAction("payroll.load");
  const reviewRules = usePluginAction("payroll.review-rules");
  const location = useHostLocation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>(() => tabFrom(location.search) ?? "overview");
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  async function refresh() {
    setSnapshot((await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Snapshot);
  }

  useEffect(() => {
    if (!context.companyId) return;
    setSnapshot(null);
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  useEffect(() => {
    const next = tabFrom(location.search);
    if (next) {
      setTab(next);
      setOpenRunId(null);
    }
  }, [location.search]);

  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | null> {
    setMessage("");
    try {
      const result = await work();
      await refresh();
      if (success) setMessage(success);
      return result;
    } catch (error) {
      setMessage(errorText(error));
      return null;
    }
  }

  const s = snapshot;
  const banners: ReactNode[] = [];
  if (s && !s.settings.saved) banners.push(<Notice key="saved" tone="warn">Payroll settings are not saved for this company. Open Settings → Plugins → Payroll, fill in the employer details and click Save.</Notice>);
  if (s && s.settings.saved && !s.settings.encryptionKey) banners.push(<Notice key="key" tone="warn">Add the encryption key in the Payroll settings before entering ID numbers, tax numbers or bank details.</Notice>);
  if (s && s.settings.saved && !s.settings.privateStorage) banners.push(<Notice key="r2" tone="warn">Payslips and bank files need private storage. Fill in the R2 section of the Payroll settings with a private bucket.</Notice>);
  if (s && !s.rules.id) banners.push(<Notice key="rules" tone="warn">No payroll rules are loaded for {s.rules.taxYear}. Pay runs cannot be calculated until they are.</Notice>);
  if (s && s.rules.unverified.length && !s.rulesReviewed) {
    banners.push(
      <Notice key="unverified" tone="warn">
        <strong>{s.rules.unverified.length} payroll rule{s.rules.unverified.length === 1 ? "" : "s"} for {s.rules.taxYear} not confirmed yet.</strong> Have an accountant check them before relying on the figures.
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {s.rules.unverified.map((u) => <li key={u.path}>{u.note}</li>)}
        </ul>
        <div style={{ marginTop: 8 }}>
          <Button type="button" variant="secondary" style={small} onClick={() => void run(() => reviewRules({}), "Marked as checked")}>My accountant checked these</Button>
        </div>
      </Notice>,
    );
  }

  return (
    <Page
      title="Payroll"
      description="South African payroll for your own staff: pay runs with separate approval, payslips, leave and SARS evidence packs. Nothing is paid or submitted automatically."
      message={message || undefined}
    >
      {banners}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "employees", label: `Employees (${s?.employees.length ?? 0})` },
          { id: "runs", label: "Pay runs" },
          { id: "payslips", label: "Payslips" },
          { id: "leave", label: `Leave${s?.counts.pendingLeave ? ` (${s.counts.pendingLeave})` : ""}` },
          { id: "statutory", label: "Statutory" },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id as TabId);
          setOpenRunId(null);
        }}
      />
      {!s ? <p style={{ fontSize: 13, color: tokens.muted }}>Loading…</p> : null}
      {s && tab === "overview" ? <OverviewTab s={s} run={run} openRun={(id) => { setTab("runs"); setOpenRunId(id); }} /> : null}
      {s && tab === "employees" ? <EmployeesTab s={s} run={run} /> : null}
      {s && tab === "runs" ? <RunsTab s={s} run={run} openRunId={openRunId} setOpenRunId={setOpenRunId} setMessage={setMessage} /> : null}
      {s && tab === "payslips" ? <PayslipsTab run={run} setMessage={setMessage} /> : null}
      {s && tab === "leave" ? <LeaveTab s={s} run={run} /> : null}
      {s && tab === "statutory" ? <StatutoryTab s={s} run={run} setMessage={setMessage} /> : null}
    </Page>
  );
}

type RunFn = <T>(work: () => Promise<T>, success?: string) => Promise<T | null>;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ s, run, openRun }: { s: Snapshot; run: RunFn; openRun: (id: string) => void }) {
  const hireOptions = usePluginAction("payroll.hire-options");
  const startHire = usePluginAction("payroll.start-hire");
  const last = s.lastLocked;
  const next = s.openRuns[0] ?? null;
  const steps: string[] = [];
  if (!s.settings.saved) steps.push("Save the Payroll settings (employer details, PAYE, UIF and SDL numbers, encryption key, private storage).");
  if (!s.counts.employees) steps.push("Add your employees on the Employees tab.");
  if (s.counts.withoutTerms) steps.push(`${s.counts.withoutTerms} employee(s) need employment terms (salary and pay frequency).`);
  if (s.counts.withoutBank) steps.push(`${s.counts.withoutBank} employee(s) have no bank details (needed for the net pay file).`);
  if (s.counts.withoutTax) steps.push(`${s.counts.withoutTax} employee(s) have no tax reference number (needed for the IRP5).`);
  if (!s.settings.defaultApproverSet) steps.push("Choose a default approver in the Payroll settings (someone other than the person who prepares runs).");
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <StatRow>
        <MetricCard label="Employees" value={s.counts.employees} />
        <MetricCard label="Monthly basic pay (estimate)" value={rand(s.estimatedMonthlyBasicMinor)} />
        <MetricCard label="Last run net pay" value={last ? rand(last.totals.netPayMinor) : "—"} />
        <MetricCard label="Last run cost to company" value={last ? rand(last.totals.employerCostMinor) : "—"} />
      </StatRow>
      <Section title="Next pay run">
        {next ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13 }}>
              <strong>{next.number}</strong> · {next.periodStart} to {next.periodEnd} · paid {next.payDate} · <StatusBadge label={words(next.status)} status={runBadge(next.status)} />
            </div>
            <Button type="button" onClick={() => openRun(next.id)}>Open</Button>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No open pay run. Start one on the Pay runs tab.</p>
        )}
      </Section>
      {steps.length ? (
        <Section title="To do">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>{steps.map((step) => <li key={step}>{step}</li>)}</ul>
        </Section>
      ) : null}
      <Section title="Payroll Clerk (optional agent)">
        {s.hire?.agent ? (
          <p style={{ margin: 0, fontSize: 13 }}>{s.hire.agent.name} prepares pay runs and checks variances ({s.hire.agent.status}). It never approves runs or sees personal details.</p>
        ) : s.hire?.hire ? (
          <p style={{ margin: 0, fontSize: 13 }}>A hire request is open{s.hire.hire.identifier ? ` (${s.hire.hire.identifier})` : ""}. The plugin links the agent when it appears.</p>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontSize: 13, color: tokens.muted, maxWidth: 620 }}>An agent can prepare each month's run, enter hours and bonuses, and explain changes against last month. A board member still approves and locks.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void run(async () => {
                const options = (await hireOptions({})) as { defaultAssigneeAgentId: string | null };
                return startHire({ assigneeAgentId: options.defaultAssigneeAgentId ?? undefined });
              }, "Hire request opened")}
            >
              Hire Payroll Clerk
            </Button>
          </div>
        )}
      </Section>
      {s.rules.notes.length ? (
        <Section title={`Rules ${s.rules.taxYear}: notes`}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: tokens.muted }}>{s.rules.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </Section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

const EMPTY_EMPLOYEE = {
  employeeId: "", firstName: "", lastName: "", email: "", phone: "", jobTitle: "", employeeNumber: "", dateOfBirth: "", startDate: "", taxResidency: "resident",
  idNumber: "", passportNumber: "", passportCountry: "", taxReference: "", bankName: "", branchCode: "", accountNumber: "", accountType: "current", accountHolder: "",
  etiEligible: false, etiMonthsBefore: "0",
};

function EmployeesTab({ s, run }: { s: Snapshot; run: RunFn }) {
  const save = usePluginAction("payroll.save-employee");
  const saveTerms = usePluginAction("payroll.save-terms");
  const reveal = usePluginAction("payroll.reveal");
  const terminate = usePluginAction("payroll.terminate-employee");
  const setRecurring = usePluginAction("payroll.set-recurring");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<typeof EMPTY_EMPLOYEE | null>(null);
  const [termsFor, setTermsFor] = useState<EmployeeView | null>(null);
  const [terms, setTerms] = useState<Record<string, string | boolean>>({});
  const [revealed, setRevealed] = useState<{ name: string; field: string; value: unknown } | null>(null);
  const [recurringFor, setRecurringFor] = useState<EmployeeView | null>(null);
  const [recurring, setRecurringForm] = useState({ code: "OTHER_ALLOWANCE", amount: "", label: "" });

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => s.employees.filter((e) => !q || e.name.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q)), [s.employees, q]);
  const set = (key: keyof typeof EMPTY_EMPLOYEE, value: string | boolean) => setForm((f) => (f ? { ...f, [key]: value } : f));

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

  const addButton = <Button type="button" onClick={() => openEdit(null)}>+ Add employee</Button>;
  const f = form;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search employees…">{addButton}</Toolbar>
      {rows.length === 0 ? (
        <EmptyState title="No employees yet" description="Add each employee with their ID or passport, tax number and bank details, then set their employment terms." action={addButton} />
      ) : (
        <DataTable
          columns={[
            { key: "name", header: "Employee", render: (_v, row) => { const e = row as unknown as EmployeeView; return <div><div style={{ fontWeight: 600 }}>{e.name}</div><div style={{ fontSize: 12, color: tokens.muted }}>{e.employeeNumber}{e.jobTitle ? ` · ${e.jobTitle}` : ""}</div></div>; } },
            { key: "pay", header: "Pay", render: (_v, row) => { const e = row as unknown as EmployeeView; return e.terms ? <span>{rand(e.terms.rateMinor)} {e.terms.workerCategory === "hourly" ? "/ hour" : `/ ${e.terms.frequency.replace("ly", "")}`}</span> : <StatusBadge label="No terms" status="warning" />; } },
            { key: "idText", header: "ID / passport" },
            { key: "taxText", header: "Tax number" },
            { key: "bankText", header: "Bank" },
            { key: "status", header: "Status", render: (v) => <StatusBadge label={String(v)} status={v === "active" ? "ok" : "warning"} /> },
            {
              key: "id",
              header: "Actions",
              width: "330px",
              render: (_v, row) => {
                const e = row as unknown as EmployeeView;
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" style={small} onClick={() => openEdit(e)}>Edit</Button>
                    <Button type="button" variant="secondary" style={small} onClick={() => openTerms(e)}>Terms</Button>
                    <Button type="button" variant="secondary" style={small} onClick={() => { setRecurringFor(e); setRecurringForm({ code: "OTHER_ALLOWANCE", amount: "", label: "" }); }}>Monthly items</Button>
                    <Select
                      aria-label="Reveal"
                      value=""
                      style={{ ...small, minWidth: 92, width: 92 }}
                      onChange={(event) => {
                        const field = event.target.value;
                        if (!field) return;
                        void run(async () => {
                          const result = (await reveal({ employeeId: e.id, field })) as { value: unknown };
                          setRevealed({ name: e.name, field, value: result.value });
                        });
                      }}
                    >
                      <option value="">Reveal…</option>
                      {e.has.identity ? <option value="identity">ID</option> : null}
                      {e.has.tax ? <option value="tax">Tax no.</option> : null}
                      {e.has.bank ? <option value="bank">Bank</option> : null}
                    </Select>
                    {e.status === "active" ? (
                      <Button type="button" variant="secondary" style={small} onClick={() => {
                        const endDate = window.prompt(`Last working day for ${e.name} (YYYY-MM-DD)`, s.today);
                        if (endDate) void run(() => terminate({ employeeId: e.id, endDate }), `${e.name} marked as left`);
                      }}>Leaves</Button>
                    ) : null}
                  </div>
                );
              },
            },
          ]}
          rows={rows.map((e) => ({ ...e, pay: "", idText: e.details.idOrPassport, taxText: e.details.taxReference, bankText: e.details.bank }))}
          emptyMessage="No employees match."
        />
      )}

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
                  <option value="current">Current / cheque</option>
                  <option value="savings">Savings</option>
                  <option value="transmission">Transmission</option>
                </Select>
              </Field>
            </Row>
            <Field label="Account holder (if not the employee)"><Input value={f.accountHolder} onChange={(e) => set("accountHolder", e.target.value)} /></Field>
            <Row>
              <Field label="Employment Tax Incentive">
                <Select value={f.etiEligible ? "yes" : "no"} onChange={(e) => set("etiEligible", e.target.value === "yes")}>
                  <option value="no">Not claimed</option>
                  <option value="yes">Qualifies (18–29, valid ID)</option>
                </Select>
              </Field>
              <Field label="ETI months claimed before"><Input value={f.etiMonthsBefore} inputMode="numeric" onChange={(e) => set("etiMonthsBefore", e.target.value)} /></Field>
            </Row>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(termsFor)}
        title={termsFor ? `Employment terms: ${termsFor.name}` : ""}
        description="Saving adds a new version from the date below; earlier runs keep the terms they used."
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
            }, "Employment terms saved")}>Save terms</Button>
          </>
        )}
      >
        <Row>
          <Field label="Pay frequency">
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
          <Field label="UIF">
            <Select value={terms.uifApplicable ? "yes" : "no"} onChange={(e) => setTerms({ ...terms, uifApplicable: e.target.value === "yes" })}>
              <option value="yes">Contributes</option>
              <option value="no">Exempt (e.g. under 24 hours a month)</option>
            </Select>
          </Field>
          <Field label="SDL">
            <Select value={terms.sdlApplicable ? "yes" : "no"} onChange={(e) => setTerms({ ...terms, sdlApplicable: e.target.value === "yes" })}>
              <option value="yes">Included</option>
              <option value="no">Excluded</option>
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
              <option value="no">Under 80% (80% taxed)</option>
              <option value="yes">At least 80% (20% taxed)</option>
            </Select>
          </Field>
        </Row>
        <Row>
          <Field label="Annual leave days (if more than BCEA)"><Input value={String(terms.annualLeaveDays ?? "")} inputMode="numeric" onChange={(e) => setTerms({ ...terms, annualLeaveDays: e.target.value })} /></Field>
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
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{recurringFor.recurring.map((r) => <li key={r.code}>{r.label ?? r.code}: {rand(r.amountMinor)}</li>)}</ul>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No monthly items yet.</p>}
        <Field label="Item">
          <Select value={recurring.code} onChange={(e) => setRecurringForm({ ...recurring, code: e.target.value })}>
            {s.components.filter((c) => c.active && !["BASIC", "HOURLY", "OVERTIME", "DOUBLE_TIME", "LEAVE_PAID", "LEAVE_UNPAID", "TRAVEL_ALLOWANCE", "MEDICAL_EE", "MEDICAL_ER", "PENSION_EE", "PENSION_ER", "PROVIDENT_EE", "PROVIDENT_ER", "RA_EE", "RA_ER"].includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.name}{c.sarsCode ? ` (${c.sarsCode})` : ""}</option>
            ))}
          </Select>
        </Field>
        <Row>
          <Field label="Amount per run (R)"><Input value={recurring.amount} inputMode="decimal" onChange={(e) => setRecurringForm({ ...recurring, amount: e.target.value })} /></Field>
          <Field label="Label on payslip"><Input value={recurring.label} onChange={(e) => setRecurringForm({ ...recurring, label: e.target.value })} /></Field>
        </Row>
      </Modal>

      <Modal open={Boolean(revealed)} title={revealed ? `${revealed.name}: ${revealed.field === "identity" ? "ID" : revealed.field === "tax" ? "tax number" : "bank details"}` : ""} description="This view was logged. Close it when you are done." onClose={() => setRevealed(null)} footer={<Button type="button" onClick={() => setRevealed(null)}>Close</Button>}>
        <pre style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          {revealed?.value && typeof revealed.value === "object"
            ? Object.entries(revealed.value as Record<string, unknown>).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${String(v)}`).join("\n")
            : "Nothing on file"}
        </pre>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

function RunsTab({ s, run, openRunId, setOpenRunId, setMessage }: { s: Snapshot; run: RunFn; openRunId: string | null; setOpenRunId: (id: string | null) => void; setMessage: (m: string) => void }) {
  const createRun = usePluginAction("payroll.create-run");
  const [creating, setCreating] = useState(false);
  const [newRun, setNewRun] = useState({ frequency: "monthly", periodStart: "", periodEnd: "", payDate: "" });
  if (openRunId) return <RunDetailView s={s} runId={openRunId} back={() => setOpenRunId(null)} run={run} setMessage={setMessage} />;
  const button = <Button type="button" onClick={() => setCreating(true)}>+ New pay run</Button>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar>{button}</Toolbar>
      {s.runs.length === 0 ? (
        <EmptyState title="No pay runs yet" description="Start a pay run for the month, calculate it, then send it to a board member for approval." action={button} />
      ) : (
        <DataTable
          columns={[
            { key: "number", header: "Pay run", render: (_v, row) => { const r = row as unknown as RunSummary; return <div><div style={{ fontWeight: 600 }}>{r.number}</div><div style={{ fontSize: 12, color: tokens.muted }}>{r.kind !== "regular" ? `${r.kind} · ` : ""}{r.frequency}</div></div>; } },
            { key: "period", header: "Period" },
            { key: "payDate", header: "Pay date" },
            { key: "status", header: "Status", render: (v) => <StatusBadge label={words(String(v))} status={runBadge(String(v))} /> },
            { key: "employees", header: "Staff" },
            { key: "net", header: "Net pay", render: (_v, row) => <Money minor={(row as unknown as RunSummary).totals.netPayMinor} /> },
            { key: "ledgerText", header: "Accounting" },
            { key: "id", header: "", width: "90px", render: (_v, row) => <Button type="button" variant="secondary" style={small} onClick={() => setOpenRunId((row as unknown as RunSummary).id)}>Open</Button> },
          ]}
          rows={s.runs.map((r) => ({
            ...r,
            period: `${r.periodStart} to ${r.periodEnd}`,
            employees: r.totals.employeeCount,
            net: "",
            ledgerText: r.ledger.status === "posted" ? `Posted ${r.ledger.journalNumber ?? ""}` : r.ledger.status === "none" ? (r.ledger.error ? "Not posted" : "—") : words(r.ledger.status),
          }))}
          emptyMessage="No pay runs."
        />
      )}
      <Modal open={creating} title="New pay run" description="Leave the dates empty for this month and your default pay day." onClose={() => setCreating(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            const result = (await createRun({ frequency: newRun.frequency, periodStart: newRun.periodStart || undefined, periodEnd: newRun.periodEnd || undefined, payDate: newRun.payDate || undefined })) as { run: RunSummary };
            setCreating(false);
            setOpenRunId(result.run.id);
          }, "Pay run created. Calculate it next.")}>Create</Button>
        </>
      )}>
        <Field label="Frequency">
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

function RunDetailView({ s, runId, back, run, setMessage }: { s: Snapshot; runId: string; back: () => void; run: RunFn; setMessage: (m: string) => void }) {
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
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [traceItem, setTraceItem] = useState<ItemView | null>(null);
  const [adjustItem, setAdjustItem] = useState<ItemView | null>(null);
  const [adjustForm, setAdjustForm] = useState({ overtimeHours: "", doubleTimeHours: "", ordinaryHours: "", unpaidHours: "", bonus: "", commission: "", other: "", otherCode: "OTHER_ALLOWANCE", excluded: false });
  const [approving, setApproving] = useState(false);
  const [approver, setApprover] = useState(s.settings.defaultApproverUserId ?? "");
  const [variance, setVariance] = useState<{ comparedWith: { number: string } | null; changes: Array<{ name: string; field: string; previousMinor: number; currentMinor: number; changeBp: number | null }>; added: string[]; missing: string[] } | null>(null);

  async function refresh() {
    setDetail((await load({ runId })) as RunDetail);
  }
  useEffect(() => {
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [runId]);

  async function act<T>(work: () => Promise<T>, success: string) {
    const result = await run(work, success);
    await refresh().catch(() => undefined);
    return result;
  }

  if (!detail) return <p style={{ fontSize: 13, color: tokens.muted }}>Loading pay run…</p>;
  const r = detail.run;
  const t = r.totals;
  const iPrepared = s.me != null && r.preparedBy?.kind === "user" && r.preparedBy.id === s.me;
  const errors = detail.items.filter((i) => i.status === "error").length;
  const editable = ["draft", "calculated", "pending_approval"].includes(r.status) && r.kind !== "reversal";

  const buttons: ReactNode[] = [];
  if (editable) buttons.push(<Button key="calc" type="button" variant={r.status === "draft" ? "primary" : "secondary"} onClick={() => void act(() => calculate({ runId }), "Calculated")}>{r.status === "draft" ? "Calculate" : "Recalculate"}</Button>);
  if (r.status === "calculated") buttons.push(<Button key="appr" type="button" disabled={errors > 0} onClick={() => setApproving(true)}>Send for approval</Button>);
  if (r.status === "pending_approval" && !iPrepared) {
    buttons.push(<Button key="approve" type="button" onClick={() => void act(() => approve({ runId }), "Approved. Lock the run to post it and make payslips.")}>Approve</Button>);
    buttons.push(<Button key="reject" type="button" variant="secondary" onClick={() => {
      const reason = window.prompt("What needs to change?");
      if (reason) void act(() => reject({ runId, reason }), "Sent back to the preparer");
    }}>Send back</Button>);
  }
  if (r.status === "approved") buttons.push(<Button key="lock" type="button" onClick={() => {
    if (window.confirm(`Lock ${r.number}? It is sent to Accounting and cannot be changed afterwards (only reversed).`)) {
      void act(async () => {
        const result = (await lock({ runId })) as { payslips?: { created: number; skipped: string | null } };
        setMessage(result.payslips?.skipped
          ? `Locked and sent to Accounting. ${result.payslips.skipped}`
          : `Locked and sent to Accounting. ${result.payslips?.created ?? 0} payslip(s) made.`);
        return result;
      }, "");
    }
  }}>Lock and post</Button>);
  if (r.status === "locked" && r.kind !== "reversal") {
    const bankButton = (format: "acb" | "netcash", label: string) => (
      <Button key={format} type="button" variant="secondary" onClick={() => void act(async () => {
        const res = (await bankFile({ runId, format })) as { url?: string; content?: string; fileName: string; missing: string[]; rows: number };
        download(res);
        setMessage(`${label} ready for ${res.rows} employee(s). Upload it in your bank yourself; nothing was paid.${res.missing.length ? ` Left out (no bank details): ${res.missing.join(", ")}.` : ""}`);
        return res;
      }, "")}>{label}</Button>
    );
    buttons.push(bankButton("acb", "ACB file"), bankButton("netcash", "NetCash file"));
    buttons.push(<Button key="slips" type="button" variant="secondary" onClick={() => void act(async () => {
      const res = (await generate({ runId })) as { created: number; skipped: string | null };
      setMessage(res.skipped ?? `${res.created} payslip(s) made.`);
      return res;
    }, "")}>Make payslips</Button>);
    buttons.push(<Button key="email" type="button" variant="secondary" onClick={() => void act(async () => {
      const res = (await email({ runId })) as { queued: number; skipped: Array<{ payslip: string; reason: string }> };
      setMessage(`${res.queued} payslip(s) queued for email.${res.skipped.length ? ` Skipped: ${res.skipped.map((x) => `${x.payslip} (${x.reason})`).join(", ")}.` : ""}`);
      return res;
    }, "")}>Email payslips</Button>);
    if (!r.reversedByRunId) {
      buttons.push(<Button key="correct" type="button" variant="secondary" onClick={() => {
        if (window.confirm(`Correct ${r.number}? This creates a reversal of it and a new correction run with the same inputs for you to fix.`)) void act(() => correct({ runId }), "Reversal and correction runs created");
      }}>Correct</Button>);
      buttons.push(<Button key="reverse" type="button" variant="secondary" onClick={() => {
        const reason = window.prompt(`Why reverse ${r.number}?`);
        if (reason) void act(() => reverse({ runId, reason }), "Reversal run created; send it for approval");
      }}>Reverse</Button>);
    }
  }
  if ((r.status === "locked" || r.status === "reversed") && (r.ledger.status === "rejected" || r.ledger.status === "failed" || (r.ledger.status === "none" && r.ledger.error))) buttons.push(<Button key="repost" type="button" variant="secondary" onClick={() => void act(() => repost({ runId }), "Posting again")}>Post again</Button>);
  if (["draft", "calculated", "pending_approval"].includes(r.status)) buttons.push(<Button key="cancel" type="button" variant="secondary" onClick={() => { if (window.confirm(`Cancel ${r.number}?`)) void act(() => cancel({ runId }), "Cancelled"); }}>Cancel run</Button>);
  if (r.status !== "draft") buttons.push(<Button key="var" type="button" variant="secondary" onClick={() => void act(async () => { setVariance((await variances({ runId })) as typeof variance); }, "")}>Changes since last run</Button>);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <a href="#" onClick={(e) => { e.preventDefault(); back(); }} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none" }}>← All pay runs</a>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{r.number} <StatusBadge label={words(r.status)} status={runBadge(r.status)} /></h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: tokens.muted }}>
            {r.kind !== "regular" ? `${r.kind} · ` : ""}{r.frequency} · {r.periodStart} to {r.periodEnd} · paid {r.payDate} · tax year {r.taxYear}
            {r.status === "pending_approval" ? ` · approval ${detail.approvalStatus ?? "requested"}${iPrepared ? " (you prepared it, so someone else approves)" : ""}` : ""}
            {r.ledger.status !== "none" || r.ledger.error ? ` · Accounting: ${r.ledger.status === "posted" ? `posted ${r.ledger.journalNumber ?? ""}` : r.ledger.status === "none" ? "not posted" : words(r.ledger.status)}${r.ledger.error ? ` (${r.ledger.error})` : ""}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{buttons}</div>
      </div>
      {r.warnings.length ? <Notice tone="warn"><ul style={{ margin: 0, paddingLeft: 18 }}>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice> : null}
      <StatRow>
        <MetricCard label="Gross pay" value={rand(t.grossMinor)} />
        <MetricCard label="PAYE" value={rand(t.payeMinor)} />
        <MetricCard label="UIF (both)" value={rand(t.uifEmployeeMinor + t.uifEmployerMinor)} />
        <MetricCard label="SDL" value={rand(t.sdlMinor)} />
        <MetricCard label="ETI" value={rand(t.etiMinor)} />
        <MetricCard label="Net pay" value={rand(t.netPayMinor)} />
        <MetricCard label="Cost to company" value={rand(t.employerCostMinor)} />
      </StatRow>
      <DataTable
        columns={[
          { key: "name", header: "Employee", render: (_v, row) => { const i = row as unknown as ItemView; return <div><div style={{ fontWeight: 600 }}>{i.name}</div><div style={{ fontSize: 12, color: tokens.muted }}>{i.employeeNumber}{i.bank ? ` · ${i.bank}` : " · no bank details"}</div>{i.error ? <div style={{ fontSize: 12, color: tokens.destructive }}>{i.error}</div> : null}</div>; } },
          { key: "grossMinor", header: "Gross", render: (v) => <Money minor={Number(v)} /> },
          { key: "payeMinor", header: "PAYE", render: (v) => <Money minor={Number(v)} /> },
          { key: "uifEmployeeMinor", header: "UIF", render: (v) => <Money minor={Number(v)} /> },
          { key: "deductionsMinor", header: "Other deductions", render: (v) => <Money minor={Number(v)} /> },
          { key: "netMinor", header: "Net", render: (v) => <strong><Money minor={Number(v)} /></strong> },
          {
            key: "id",
            header: "",
            width: "170px",
            render: (_v, row) => {
              const i = row as unknown as ItemView;
              return (
                <div style={{ display: "flex", gap: 6 }}>
                  <Button type="button" variant="secondary" style={small} onClick={() => setTraceItem(i)} disabled={!i.trace.length && !i.lines.length}>How</Button>
                  {editable ? <Button type="button" variant="secondary" style={small} onClick={() => {
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
                  }}>Adjust</Button> : null}
                </div>
              );
            },
          },
        ]}
        rows={detail.items as unknown as Array<Record<string, unknown>>}
        emptyMessage={r.status === "draft" ? "Calculate the run to see each employee." : "Nobody in this run."}
      />
      {detail.excluded.length ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Left out: {detail.excluded.map((x) => x.name).join(", ")}</p> : null}
      {detail.payslips.length ? (
        <Section title="Payslips">
          <DataTable
            columns={[
              { key: "number", header: "Payslip" },
              { key: "status", header: "Status", render: (v) => <StatusBadge label={String(v)} status={v === "sent" ? "ok" : v === "failed" ? "error" : "pending"} /> },
              { key: "emailedTo", header: "Emailed to" },
              { key: "error", header: "Note" },
            ]}
            rows={detail.payslips as unknown as Array<Record<string, unknown>>}
          />
        </Section>
      ) : null}

      <Modal open={Boolean(traceItem)} title={traceItem ? `How ${traceItem.name}'s pay was worked out` : ""} onClose={() => setTraceItem(null)} footer={<Button type="button" onClick={() => setTraceItem(null)}>Close</Button>}>
        {traceItem ? (
          <div style={{ display: "grid", gap: 12, fontSize: 12.5 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {traceItem.lines.map((l, idx) => (
                  <tr key={`${l.code}-${idx}`} style={{ borderBottom: `1px solid ${tokens.border}` }}>
                    <td style={{ padding: "4px 0" }}>{l.label}{l.sarsCode ? <span style={{ color: tokens.muted }}> · {l.sarsCode}</span> : null}</td>
                    <td style={{ padding: "4px 0", color: tokens.muted }}>{l.section}</td>
                    <td style={{ padding: "4px 0", textAlign: "right" }}><Money minor={l.amountMinor} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {traceItem.trace.map((step) => (
                <li key={step.step}>
                  <strong>{step.label}</strong>
                  <div style={{ color: tokens.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, overflowWrap: "anywhere" }}>
                    {Object.entries(step.inputs).map(([k, v]) => `${k}=${String(v)}`).join("  ")} → {Object.entries(step.outputs).map(([k, v]) => `${k}=${String(v)}`).join("  ")}
                  </div>
                </li>
              ))}
            </ol>
            {traceItem.warnings.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{traceItem.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            <p style={{ margin: 0, color: tokens.muted }}>Amounts in the steps are cents; hours are hundredths of an hour; rates are basis points (1800 = 18%).</p>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(adjustItem)} title={adjustItem ? `This run for ${adjustItem.name}` : ""} description="Changes apply to this run only; recurring pay lives in the employee's terms." onClose={() => setAdjustItem(null)} footer={(
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

      <Modal open={approving} title={`Send ${r.number} for approval`} description="A board member who did not prepare the run approves it. They get an issue with the totals." onClose={() => setApproving(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setApproving(false)}>Cancel</Button>
          <Button type="button" disabled={!approver} onClick={() => void act(async () => { await requestApproval({ runId, approverUserId: approver }); setApproving(false); }, "Sent for approval")}>Send</Button>
        </>
      )}>
        <Field label="Approver">
          <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
            <option value="">Choose…</option>
            {s.members.map((m) => <option key={m.userId} value={m.userId} disabled={m.isYou || (r.preparedBy?.kind === "user" && r.preparedBy.id === m.userId)}>{memberLabel(m)}{m.userId === s.settings.defaultApproverUserId ? " · default" : ""}</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal open={Boolean(variance)} title="Changes since the last locked run" description={variance?.comparedWith ? `Compared with ${variance.comparedWith.number}; changes of 10% or more.` : "There is no earlier locked run to compare with."} onClose={() => setVariance(null)} footer={<Button type="button" onClick={() => setVariance(null)}>Close</Button>}>
        {variance ? (
          <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
            {variance.changes.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {variance.changes.map((c, idx) => <li key={idx}>{c.name}: {c.field} {rand(c.previousMinor)} → {rand(c.currentMinor)}{c.changeBp != null ? ` (${(c.changeBp / 100).toFixed(1)}%)` : ""}</li>)}
              </ul>
            ) : <p style={{ margin: 0 }}>No big changes.</p>}
            {variance.added.length ? <p style={{ margin: 0 }}>New: {variance.added.join(", ")}</p> : null}
            {variance.missing.length ? <p style={{ margin: 0 }}>Not in this run: {variance.missing.join(", ")}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

function PayslipsTab({ run, setMessage }: { run: RunFn; setMessage: (m: string) => void }) {
  const list = usePluginAction("payroll.payslips");
  const downloadSlip = usePluginAction("payroll.download-payslip");
  const email = usePluginAction("payroll.email-payslips");
  const [rows, setRows] = useState<Array<{ id: string; number: string; runId: string; run: string | null; payDate: string | null; employee: string | null; status: string; emailedTo: string | null; emailedAt: string | null; error: string | null }> | null>(null);
  async function refresh() {
    setRows(((await list({})) as { payslips: NonNullable<typeof rows> }).payslips);
  }
  useEffect(() => {
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, []);
  if (!rows) return <p style={{ fontSize: 13, color: tokens.muted }}>Loading payslips…</p>;
  if (!rows.length) return <EmptyState title="No payslips yet" description="Payslips are made when a pay run is locked." />;
  return (
    <DataTable
      columns={[
        { key: "number", header: "Payslip" },
        { key: "employee", header: "Employee" },
        { key: "payDate", header: "Pay date" },
        { key: "status", header: "Status", render: (v) => <StatusBadge label={String(v)} status={v === "sent" ? "ok" : v === "failed" ? "error" : v === "ready" ? "info" : "pending"} /> },
        { key: "emailedTo", header: "Emailed to" },
        {
          key: "id",
          header: "",
          width: "200px",
          render: (_v, row) => {
            const p = row as unknown as NonNullable<typeof rows>[number];
            return (
              <div style={{ display: "flex", gap: 6 }}>
                <Button type="button" variant="secondary" style={small} disabled={p.status === "pending" || (p.status === "failed" && !p.emailedTo)} onClick={() => void run(async () => download((await downloadSlip({ payslipId: p.id })) as { url: string; fileName: string }))}>Download</Button>
                <Button type="button" variant="secondary" style={small} disabled={p.status === "pending" || p.status === "sending"} onClick={() => void run(async () => { await email({ runId: p.runId, payslipIds: [p.id] }); await refresh(); }, "Queued for email")}>{p.status === "sent" ? "Email again" : "Email"}</Button>
              </div>
            );
          },
        },
      ]}
      rows={rows as unknown as Array<Record<string, unknown>>}
    />
  );
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

interface LeaveData {
  asOf: string;
  requests: Array<{ id: string; employeeId: string; employee: string | null; type: string; label: string; startDate: string; endDate: string; days: number; status: string; reason: string | null }>;
  balances: Array<{ employeeId: string; name: string; balances: Array<{ type: string; label: string; balanceCenti: number; takenCenti: number; pendingCenti: number; note: string | null }> }>;
}

function LeaveTab({ s, run }: { s: Snapshot; run: RunFn }) {
  const load = usePluginAction("payroll.leave");
  const request = usePluginAction("payroll.request-leave");
  const decide = usePluginAction("payroll.decide-leave");
  const cancel = usePluginAction("payroll.cancel-leave");
  const opening = usePluginAction("payroll.leave-opening");
  const [data, setData] = useState<LeaveData | null>(null);
  const [form, setForm] = useState<{ employeeId: string; type: string; startDate: string; endDate: string; days: string; reason: string } | null>(null);
  const [openingForm, setOpeningForm] = useState<{ employeeId: string; type: string; days: string; asOf: string } | null>(null);
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
  const days = (centi: number) => (centi / 100).toFixed(2).replace(/\.00$/, "");
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Toolbar>
        <Button type="button" variant="secondary" onClick={() => setOpeningForm({ employeeId: active[0]?.id ?? "", type: "annual", days: "", asOf: s.today })}>Opening balance</Button>
        <Button type="button" onClick={() => setForm({ employeeId: active[0]?.id ?? "", type: "annual", startDate: s.today, endDate: s.today, days: "", reason: "" })}>+ Record leave</Button>
      </Toolbar>
      <Section title="Requests">
        {data?.requests.length ? (
          <DataTable
            columns={[
              { key: "employee", header: "Employee" },
              { key: "label", header: "Type" },
              { key: "dates", header: "Dates" },
              { key: "days", header: "Days" },
              { key: "status", header: "Status", render: (v) => <StatusBadge label={String(v)} status={v === "approved" ? "ok" : v === "pending" ? "pending" : "warning"} /> },
              {
                key: "id",
                header: "",
                width: "230px",
                render: (_v, row) => {
                  const r = row as unknown as LeaveData["requests"][number];
                  return (
                    <div style={{ display: "flex", gap: 6 }}>
                      {r.status === "pending" ? <Button type="button" style={small} onClick={() => void act(() => decide({ requestId: r.id, decision: "approve" }), "Leave approved")}>Approve</Button> : null}
                      {r.status === "pending" ? <Button type="button" variant="secondary" style={small} onClick={() => void act(() => decide({ requestId: r.id, decision: "reject" }), "Leave declined")}>Decline</Button> : null}
                      {r.status === "pending" || r.status === "approved" ? <Button type="button" variant="secondary" style={small} onClick={() => void act(() => cancel({ requestId: r.id }), "Leave cancelled")}>Cancel</Button> : null}
                    </div>
                  );
                },
              },
            ]}
            rows={data.requests.map((r) => ({ ...r, dates: r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}` })) as unknown as Array<Record<string, unknown>>}
          />
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No leave recorded yet.</p>}
      </Section>
      <Section title={`Balances on ${data?.asOf ?? s.today} (days)`}>
        {data?.balances.length ? (
          <DataTable
            columns={[
              { key: "name", header: "Employee" },
              { key: "annual", header: "Annual" },
              { key: "sick", header: "Sick" },
              { key: "family", header: "Family resp." },
              { key: "unpaid", header: "Unpaid taken" },
            ]}
            rows={data.balances.map((b) => {
              const get = (type: string) => b.balances.find((x) => x.type === type);
              const show = (type: string) => { const x = get(type); return x ? `${days(x.balanceCenti)}${x.pendingCenti ? ` (${days(x.pendingCenti)} pending)` : ""}` : "—"; };
              return { id: b.employeeId, name: b.name, annual: show("annual"), sick: show("sick"), family: show("family"), unpaid: days(get("unpaid")?.takenCenti ?? 0) };
            })}
          />
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Add employees to see balances.</p>}
        <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>BCEA minimums: annual leave 21 consecutive days a year (days per week × 3 working days), sick leave 6 weeks' working days per 36 months, family responsibility 3 days a year after 4 months.</p>
      </Section>

      <Modal open={Boolean(form)} title="Record leave" description="Opens an approval issue. Unpaid leave is deducted in the pay run for that period." onClose={() => setForm(null)} footer={(
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

      <Modal open={Boolean(openingForm)} title="Opening leave balance" description="Days still available on a date, from the old system." onClose={() => setOpeningForm(null)} footer={(
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

// ---------------------------------------------------------------------------
// Statutory
// ---------------------------------------------------------------------------

interface Emp201View {
  month: string;
  payeMinor: number;
  sdlMinor: number;
  uifMinor: number;
  etiCalculatedMinor: number;
  etiBroughtForwardMinor: number;
  etiUsedMinor: number;
  etiCarriedForwardMinor: number;
  payeAfterEtiMinor: number;
  totalPayableMinor: number;
  dueDate: string;
  runs: string[];
  notes: string[];
  employees: number;
}

function StatutoryTab({ s, run, setMessage }: { s: Snapshot; run: RunFn; setMessage: (m: string) => void }) {
  const emp201 = usePluginAction("payroll.emp201");
  const certs = usePluginAction("payroll.certificates");
  const emp501 = usePluginAction("payroll.emp501");
  const exportFile = usePluginAction("payroll.export");
  const importYtd = usePluginAction("payroll.import-ytd");
  const rules = usePluginAction("payroll.rules");
  const [month, setMonth] = useState(s.today.slice(0, 7));
  const [taxYear, setTaxYear] = useState(s.rules.taxYear);
  const [e201, setE201] = useState<Emp201View | null>(null);
  const [certificates, setCertificates] = useState<Array<{ employeeId: string; employeeNumber: string; name: string; kind: string; payeMinor: number; grossTaxableMinor: number; uifMinor: number; sdlMinor: number; codes: Record<string, number>; includesOpening: boolean }> | null>(null);
  const [e501, setE501] = useState<{ reconciled: boolean; declared: { payeMinor: number; sdlMinor: number; uifMinor: number; etiMinor: number }; certificates: { count: number; irp5: number; it3a: number; payeMinor: number }; difference: { payeMinor: number; sdlMinor: number; uifMinor: number } } | null>(null);
  const [period, setPeriod] = useState<"annual" | "interim">("interim");
  const [csv, setCsv] = useState("");
  const [ruleData, setRuleData] = useState<{ version: { rules: Record<string, unknown>; sources: Array<{ title: string; url: string; accessed: string }>; unverified: Array<{ path: string; note: string }> } | null } | null>(null);

  const exportAndDownload = (params: Record<string, unknown>, success: string) =>
    void run(async () => download((await exportFile(params)) as { url?: string; content?: string; fileName: string; contentType?: string }), success);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Notice tone="info">These are evidence packs and exports. Payroll never submits to SARS and never pays SARS; file the EMP201 and EMP501 on eFiling yourself.</Notice>
      <Section title="EMP201 (monthly)" actions={<div style={{ display: "flex", gap: 8 }}>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 160 }} />
        <Button type="button" variant="secondary" onClick={() => void run(async () => setE201(((await emp201({ month })) as { emp201: Emp201View }).emp201))}>Show</Button>
        <Button type="button" variant="secondary" onClick={() => exportAndDownload({ kind: "emp201", month }, "EMP201 exported")}>CSV</Button>
      </div>}>
        {e201 ? (
          <div style={{ display: "grid", gap: 10 }}>
            <StatRow>
              <MetricCard label="PAYE" value={rand(e201.payeMinor)} />
              <MetricCard label="ETI used" value={rand(e201.etiUsedMinor)} />
              <MetricCard label="SDL" value={rand(e201.sdlMinor)} />
              <MetricCard label="UIF" value={rand(e201.uifMinor)} />
              <MetricCard label="Total payable" value={rand(e201.totalPayableMinor)} />
            </StatRow>
            <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>
              Due {e201.dueDate} · {e201.employees} employee(s) · runs {e201.runs.join(", ") || "none"} · ETI calculated {rand(e201.etiCalculatedMinor)}, brought forward {rand(e201.etiBroughtForwardMinor)}, carried forward {rand(e201.etiCarriedForwardMinor)}
            </p>
            {e201.notes.map((n) => <p key={n} style={{ margin: 0, fontSize: 12.5 }}>{n}</p>)}
          </div>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Pick a month to see PAYE, SDL, UIF and ETI from its locked pay runs.</p>}
      </Section>

      <Section title="IRP5 / IT3(a) certificates" actions={<div style={{ display: "flex", gap: 8 }}>
        <Input value={taxYear} onChange={(e) => setTaxYear(e.target.value)} style={{ width: 110 }} aria-label="Tax year" />
        <Button type="button" variant="secondary" onClick={() => void run(async () => setCertificates(((await certs({ taxYear })) as { certificates: NonNullable<typeof certificates> }).certificates))}>Show</Button>
        <Button type="button" variant="secondary" onClick={() => { if (window.confirm("The certificate file holds ID and tax numbers. Download it?")) exportAndDownload({ kind: "irp5", taxYear }, "Certificates exported"); }}>CSV</Button>
      </div>}>
        {certificates ? (
          certificates.length ? (
            <DataTable
              columns={[
                { key: "name", header: "Employee" },
                { key: "kind", header: "Certificate" },
                { key: "grossTaxableMinor", header: "3699 gross", render: (v) => <Money minor={Number(v)} /> },
                { key: "payeMinor", header: "4102 PAYE", render: (v) => <Money minor={Number(v)} /> },
                { key: "uifMinor", header: "4141 UIF", render: (v) => <Money minor={Number(v)} /> },
                { key: "sdlMinor", header: "4142 SDL", render: (v) => <Money minor={Number(v)} /> },
                { key: "codeText", header: "Codes" },
              ]}
              rows={certificates.map((c) => ({ ...c, id: c.employeeId, codeText: Object.keys(c.codes).sort().join(" ") + (c.includesOpening ? " · incl. opening" : "") }))}
            />
          ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No locked pay runs or openings in {taxYear}.</p>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Totals per employee per SARS source code for the tax year.</p>}
      </Section>

      <Section title="EMP501 reconciliation" actions={<div style={{ display: "flex", gap: 8 }}>
        <Select value={period} onChange={(e) => setPeriod(e.target.value as "annual" | "interim")} style={{ width: 170 }}>
          <option value="interim">Interim (Mar–Aug)</option>
          <option value="annual">Annual (Mar–Feb)</option>
        </Select>
        <Button type="button" variant="secondary" onClick={() => void run(async () => setE501((await emp501({ taxYear, period })) as NonNullable<typeof e501>))}>Show</Button>
        <Button type="button" variant="secondary" onClick={() => exportAndDownload({ kind: "emp501", taxYear, period }, "EMP501 pack exported")}>CSV</Button>
      </div>}>
        {e501 ? (
          <div style={{ fontSize: 13, display: "grid", gap: 6 }}>
            <div><StatusBadge label={e501.reconciled ? "Reconciled" : "Differences"} status={e501.reconciled ? "ok" : "warning"} /></div>
            <div>Declared: PAYE {rand(e501.declared.payeMinor)}, SDL {rand(e501.declared.sdlMinor)}, UIF {rand(e501.declared.uifMinor)}, ETI {rand(e501.declared.etiMinor)}</div>
            <div>Certificates: {e501.certificates.count} ({e501.certificates.irp5} IRP5, {e501.certificates.it3a} IT3(a)), PAYE {rand(e501.certificates.payeMinor)}</div>
            <div>Difference: PAYE {rand(e501.difference.payeMinor)}, SDL {rand(e501.difference.sdlMinor)}, UIF {rand(e501.difference.uifMinor)}</div>
          </div>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Compares the EMP201s with the certificates for {taxYear}.</p>}
      </Section>

      <Section title="Year-to-date openings (cut-over)">
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Paste a CSV from the old payroll: an <code>employee_number</code> column, then one column per SARS code in rand (e.g. 3601, 3605, 4001, 4005, 4102, 4141, 4142) and optionally <code>eti</code>.</p>
        <TextArea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"employee_number,3601,4102,4141,4142\nE001,150000.00,21000.00,885.60,1500.00"} style={{ minHeight: 110, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
        <div>
          <Button type="button" variant="secondary" disabled={!csv.trim()} onClick={() => void run(async () => {
            const result = (await importYtd({ taxYear, csv })) as { imported: number; errors: string[] };
            setMessage(`${result.imported} employee(s) imported for ${taxYear}${result.errors.length ? `. Problems: ${result.errors.join("; ")}` : ""}`);
            if (!result.errors.length) setCsv("");
          })}>Import for {taxYear}</Button>
        </div>
      </Section>

      <Section title={`Rules in use (${s.rules.taxYear})`} actions={<Button type="button" variant="secondary" onClick={() => void run(async () => setRuleData((await rules({ taxYear: s.rules.taxYear })) as NonNullable<typeof ruleData>))}>Show sources</Button>}>
        {ruleData?.version ? (
          <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              {ruleData.version.sources.map((src) => <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer">{src.title}</a> <span style={{ color: tokens.muted }}>(checked {src.accessed})</span></li>)}
            </ul>
            {ruleData.version.unverified.length ? <Notice tone="warn">Not confirmed: {ruleData.version.unverified.map((u) => u.note).join(" ")}</Notice> : null}
          </div>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>PAYE brackets, rebates, medical credits, UIF, SDL, ETI, retirement and travel rules for the tax year, each with its SARS source.</p>}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function PayrollSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const enabled = useModuleEnabled(context.companyId);
  const href = hostNavigation.resolveHref("/payroll");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  if (enabled === false) return null;
  return (
    <a
      {...hostNavigation.linkProps("/payroll")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M6 12h.01M18 12h.01" />
        </svg>
      </span>
      <span className="flex-1 truncate">Payroll</span>
    </a>
  );
}
