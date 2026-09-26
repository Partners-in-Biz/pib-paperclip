/**
 * In-memory stand-in for src/db.ts, for service-level tests (vi.mock). It
 * keeps the same signatures and stores domain objects. `rows()` returns
 * everything as stored, so tests can scan it for plaintext.
 */
import { randomUUID } from "node:crypto";
import type * as Real from "../src/db.js";
import { EMPTY_MASKS } from "../src/pii.js";
import { RULE_VERSION_2026_27 } from "../src/seed.js";

type Employee = Real.Employee & { sealedIdentity: string | null; sealedTax: string | null; sealedBank: string | null };

const s = {
  employees: new Map<string, Employee>(),
  terms: [] as Real.Terms[],
  recurring: [] as Real.Recurring[],
  runs: new Map<string, Real.PayRun>(),
  inputs: new Map<string, Real.RunInputs>(),
  items: new Map<string, Real.RunItem>(),
  payslips: new Map<string, Real.Payslip>(),
  leave: new Map<string, Real.LeaveRequest>(),
  openings: [] as Real.LeaveOpeningRow[],
  ytd: [] as Real.YtdRow[],
  exports: [] as Real.ExportRow[],
  audit: [] as Array<Record<string, unknown>>,
};

export function reset(): void {
  s.employees.clear();
  s.terms = [];
  s.recurring = [];
  s.runs.clear();
  s.inputs.clear();
  s.items.clear();
  s.payslips.clear();
  s.leave.clear();
  s.openings = [];
  s.ytd = [];
  s.exports = [];
  s.audit = [];
}

export function rows(): unknown {
  return { ...s, employees: [...s.employees.values()], runs: [...s.runs.values()], inputs: [...s.inputs.entries()], items: [...s.items.values()], payslips: [...s.payslips.values()], leave: [...s.leave.values()] };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pub = (e: Employee): Real.Employee => {
  const { sealedIdentity, sealedTax, sealedBank, ...rest } = e;
  return clone({ ...rest, hasIdentity: Boolean(sealedIdentity), hasTax: Boolean(sealedTax), hasBank: Boolean(sealedBank) });
};

export const table = (_ctx: unknown, name: string) => `ns.${name}`;
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export async function listRuleVersions() {
  return [RULE_VERSION_2026_27];
}

export async function listEmployees(_c: unknown, companyId: string, options: { status?: string } = {}) {
  return [...s.employees.values()].filter((e) => e.companyId === companyId && (!options.status || e.status === options.status)).map(pub);
}
export async function getEmployee(_c: unknown, companyId: string, id: string) {
  const e = s.employees.get(id);
  return e && e.companyId === companyId ? pub(e) : null;
}
export async function getEmployeeByNumber(_c: unknown, companyId: string, n: string) {
  const e = [...s.employees.values()].find((x) => x.companyId === companyId && x.employeeNumber === n);
  return e ? pub(e) : null;
}
export async function getSealed(_c: unknown, companyId: string, ids: string[]) {
  return new Map(ids.map((id) => s.employees.get(id)).filter((e): e is Employee => Boolean(e && e.companyId === companyId)).map((e) => [e.id, { sealedIdentity: e.sealedIdentity, sealedTax: e.sealedTax, sealedBank: e.sealedBank }]));
}
export async function nextEmployeeNumber(_c: unknown, companyId: string) {
  return `E${String([...s.employees.values()].filter((e) => e.companyId === companyId).length + 1).padStart(3, "0")}`;
}
export async function insertEmployee(_c: unknown, e: Real.EmployeeWrite) {
  s.employees.set(e.id, {
    ...e,
    name: `${e.firstName} ${e.lastName}`,
    status: "active",
    masks: { ...EMPTY_MASKS },
    hasIdentity: false,
    hasTax: false,
    hasBank: false,
    sealedIdentity: null,
    sealedTax: null,
    sealedBank: null,
  });
}
const EMP_MAP: Record<string, string> = {
  employee_number: "employeeNumber", first_name: "firstName", last_name: "lastName", email: "email", phone: "phone", job_title: "jobTitle", date_of_birth: "dateOfBirth",
  start_date: "startDate", end_date: "endDate", status: "status", tax_residency: "taxResidency", sealed_identity: "sealedIdentity", sealed_tax: "sealedTax", sealed_bank: "sealedBank",
  pii_masks: "masks", eti_eligible: "etiEligible", eti_months_before: "etiMonthsBefore", key_version: "keyVersion",
};
export async function updateEmployee(_c: unknown, companyId: string, id: string, patch: Record<string, unknown>) {
  const e = s.employees.get(id) as unknown as Record<string, unknown> | undefined;
  if (!e || e.companyId !== companyId) return 0;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) e[EMP_MAP[k] ?? k] = v;
  e.name = `${e.firstName} ${e.lastName}`;
  return 1;
}

export async function listTerms(_c: unknown, _companyId: string, employeeId: string) {
  return clone(s.terms.filter((t) => t.employeeId === employeeId).sort((a, b) => b.version - a.version));
}
export async function termsOn(_c: unknown, _companyId: string, onDate: string) {
  const map = new Map<string, Real.Terms>();
  for (const t of [...s.terms].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version)) if (t.effectiveFrom <= onDate) map.set(t.employeeId, clone(t));
  return map;
}
export async function insertTerms(_c: unknown, _companyId: string, t: Omit<Real.Terms, "version" | "createdAt">) {
  const version = s.terms.filter((x) => x.employeeId === t.employeeId).length + 1;
  s.terms.push({ ...clone(t), version, createdAt: new Date().toISOString() });
}

export async function listCustomComponents() {
  return [];
}
export async function upsertComponent() {}
export async function listRecurring(_c: unknown, _companyId: string, employeeId?: string) {
  return clone(s.recurring.filter((r) => !employeeId || r.employeeId === employeeId));
}
export async function upsertRecurring(_c: unknown, _companyId: string, r: Omit<Real.Recurring, "id">) {
  s.recurring = s.recurring.filter((x) => !(x.employeeId === r.employeeId && x.code === r.code));
  s.recurring.push({ id: newId("rc"), ...r });
}

export async function listRuns(_c: unknown, companyId: string) {
  return clone([...s.runs.values()].filter((r) => r.companyId === companyId).sort((a, b) => b.payDate.localeCompare(a.payDate)));
}
export async function getRun(_c: unknown, companyId: string, id: string) {
  const r = s.runs.get(id);
  return r && r.companyId === companyId ? clone(r) : null;
}
export async function getRunByApprovalIssue(_c: unknown, companyId: string, issueId: string) {
  const r = [...s.runs.values()].find((x) => x.companyId === companyId && x.approvalIssueId === issueId);
  return r ? clone(r) : null;
}
export async function runsNeedingFollowUp() {
  // Locked runs (not reversals) with an ok item that has no made payslip, like the real query.
  return [...s.runs.values()]
    .filter((r) => r.status === "locked" && r.kind !== "reversal")
    .filter((r) => [...s.items.values()].some((i) => i.runId === r.id && i.status === "ok" && ![...s.payslips.values()].some((p) => p.runId === r.id && p.employeeId === i.employeeId && p.status !== "pending")))
    .map((r) => ({ id: r.id, companyId: r.companyId }));
}
export async function countRuns(_c: unknown, companyId: string, month: string, frequency: string, kind: string) {
  return [...s.runs.values()].filter((r) => r.companyId === companyId && r.payDate.startsWith(month) && r.frequency === frequency && r.kind === kind).length;
}
export async function insertRun(_c: unknown, run: Real.PayRun) {
  s.runs.set(run.id, clone(run));
}
const RUN_MAP: Record<string, keyof Real.PayRun> = {
  status: "status", rule_version_id: "ruleVersionId", prepared_by_user_id: "preparedByUserId", prepared_by_agent_id: "preparedByAgentId", prepared_at: "preparedAt",
  approver_user_id: "approverUserId", approval_issue_id: "approvalIssueId", approval_requested_at: "approvalRequestedAt", approved_by_user_id: "approvedByUserId",
  approved_at: "approvedAt", locked_by_user_id: "lockedByUserId", locked_at: "lockedAt", reversed_by_run_id: "reversedByRunId", ledger_status: "ledgerStatus",
  journal_id: "journalId", journal_number: "journalNumber", ledger_error: "ledgerError", totals: "totals", warnings: "warnings", notes: "notes",
};
export async function updateRun(_c: unknown, companyId: string, id: string, patch: Record<string, unknown>, expect?: string[]) {
  const r = s.runs.get(id) as unknown as Record<string, unknown> | undefined;
  if (!r || r.companyId !== companyId) return 0;
  if (expect?.length && !expect.includes(String(r.status))) return 0;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const key = RUN_MAP[k];
    if (!key) throw new Error(`Column ${k} cannot be updated`);
    r[key] = clone(v);
  }
  return 1;
}

export async function getInputs(_c: unknown, runId: string) {
  return new Map([...s.inputs.entries()].filter(([k]) => k.startsWith(`${runId}|`)).map(([k, v]) => [k.split("|")[1]!, clone(v)]));
}
export async function upsertInputs(_c: unknown, _companyId: string, runId: string, employeeId: string, inputs: Real.RunInputs) {
  s.inputs.set(`${runId}|${employeeId}`, clone(inputs));
}
export async function listItems(_c: unknown, _companyId: string, runId: string) {
  return clone([...s.items.values()].filter((i) => i.runId === runId));
}
export async function upsertItem(_c: unknown, _companyId: string, item: Real.RunItem) {
  const existing = [...s.items.values()].find((i) => i.runId === item.runId && i.employeeId === item.employeeId);
  s.items.set(existing?.id ?? item.id, clone({ ...item, id: existing?.id ?? item.id }));
}
export async function excludeItemsNotIn(_c: unknown, _companyId: string, runId: string, ids: string[]) {
  for (const i of s.items.values()) if (i.runId === runId && !ids.includes(i.employeeId)) i.status = "excluded";
}
export async function postedItems(_c: unknown, companyId: string, from: string, to: string, employeeId?: string) {
  const out: Real.PostedItem[] = [];
  for (const i of s.items.values()) {
    const r = s.runs.get(i.runId);
    if (!r || r.companyId !== companyId || !["locked", "reversed"].includes(r.status) || i.status !== "ok") continue;
    if (r.payDate < from || r.payDate > to || (employeeId && i.employeeId !== employeeId)) continue;
    out.push({ ...clone(i), runNumber: r.number, runKind: r.kind, payDate: r.payDate, frequency: r.frequency, runStatus: r.status });
  }
  return out;
}
export async function etiMonthsClaimed() {
  return new Map<string, number>();
}

export async function listPayslips(_c: unknown, _companyId: string, runId?: string) {
  return clone([...s.payslips.values()].filter((p) => !runId || p.runId === runId));
}
export async function getPayslip(_c: unknown, _companyId: string, id: string) {
  return s.payslips.has(id) ? clone(s.payslips.get(id)!) : null;
}
export async function getPayslipByMailKey(_c: unknown, key: string) {
  const p = [...s.payslips.values()].find((x) => x.mailKey === key);
  return p ? { ...clone(p), companyId: "company-1" } : null;
}
export async function upsertPayslip(_c: unknown, _companyId: string, p: Real.Payslip) {
  const existing = [...s.payslips.values()].find((x) => x.runId === p.runId && x.employeeId === p.employeeId);
  if (existing && !["pending", "ready", "failed"].includes(existing.status)) return;
  s.payslips.set(existing?.id ?? p.id, clone({ ...p, id: existing?.id ?? p.id }));
}
export async function claimPayslip(_c: unknown, _companyId: string, id: string, from: string[], mailKey: string, emailedTo: string) {
  const p = s.payslips.get(id);
  if (!p || !from.includes(p.status)) return false;
  Object.assign(p, { status: "sending", mailKey, emailedTo, error: null });
  return true;
}
export async function updatePayslip(_c: unknown, _companyId: string, id: string, patch: Record<string, unknown>) {
  const p = s.payslips.get(id) as unknown as Record<string, unknown> | undefined;
  if (!p) return 0;
  const map: Record<string, string> = { status: "status", mail_key: "mailKey", emailed_to: "emailedTo", emailed_at: "emailedAt", error: "error" };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) p[map[k]!] = v;
  return 1;
}

export async function listLeave(_c: unknown, _companyId: string, options: { employeeId?: string; status?: string } = {}) {
  return clone([...s.leave.values()].filter((l) => (!options.employeeId || l.employeeId === options.employeeId) && (!options.status || l.status === options.status)));
}
export async function getLeave(_c: unknown, _companyId: string, id: string) {
  return s.leave.has(id) ? clone(s.leave.get(id)!) : null;
}
export async function getLeaveByIssue(_c: unknown, _companyId: string, issueId: string) {
  const l = [...s.leave.values()].find((x) => x.approvalIssueId === issueId);
  return l ? clone(l) : null;
}
export async function insertLeave(_c: unknown, _companyId: string, l: Real.LeaveRequest) {
  s.leave.set(l.id, clone(l));
}
export async function updateLeave(_c: unknown, _companyId: string, id: string, patch: Record<string, unknown>, expect?: string) {
  const l = s.leave.get(id) as unknown as Record<string, unknown> | undefined;
  if (!l || (expect && l.status !== expect)) return 0;
  const map: Record<string, string> = { status: "status", approval_issue_id: "approvalIssueId", decided_by_user_id: "decidedByUserId", decided_at: "decidedAt" };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) l[map[k]!] = v;
  return 1;
}
export async function listLeaveOpenings() {
  return clone(s.openings);
}
export async function upsertLeaveOpening(_c: unknown, _companyId: string, o: Real.LeaveOpeningRow) {
  s.openings = s.openings.filter((x) => !(x.employeeId === o.employeeId && x.type === o.type));
  s.openings.push(clone(o));
}
export async function listYtd(_c: unknown, _companyId: string, taxYear: string) {
  return clone(s.ytd.filter((y) => y.taxYear === taxYear));
}
export async function upsertYtd(_c: unknown, _companyId: string, y: Real.YtdRow) {
  s.ytd = s.ytd.filter((x) => !(x.employeeId === y.employeeId && x.taxYear === y.taxYear));
  s.ytd.push(clone(y));
}
export async function insertExport(_c: unknown, _companyId: string, e: Real.ExportRow) {
  s.exports.push(clone(e));
}
export async function listExports() {
  return clone(s.exports);
}
export async function getExport(_c: unknown, _companyId: string, id: string) {
  return clone(s.exports.find((e) => e.id === id) ?? null);
}
export async function audit(_c: unknown, companyId: string, actor: unknown, action: string, entityKind: string, entityId: string, detail: Record<string, unknown> = {}) {
  s.audit.push(clone({ companyId, actor, action, entityKind, entityId, detail }));
}
export async function listAudit() {
  return clone(s.audit);
}
export async function companiesWithRuns() {
  return ["company-1"];
}
export async function companiesWithEmployees() {
  return [...new Set([...s.employees.values()].map((e) => e.companyId))];
}
