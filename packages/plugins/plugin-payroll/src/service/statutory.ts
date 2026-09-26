/**
 * EMP201, IRP5 / IT3(a) and EMP501 packs, YTD opening import, and the
 * net-pay bank file. Evidence and exports only: nothing is submitted to
 * SARS and no payment is made. Exports with personal details are built for
 * board members only and stored in the private bucket.
 */
import { createHash } from "node:crypto";
import { buildBankFile, type BankFormat, type BankPaymentRow } from "../bank-files.js";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { minorToDecimal, parseRandToMinor, PayrollError } from "../money.js";
import { openDetails, type BankDetails, type IdentityDetails, type TaxDetails } from "../pii.js";
import { taxYearBounds, taxYearOf } from "../rules.js";
import {
  buildCertificate,
  buildEmp201,
  buildEmp501,
  certificatesCsv,
  emp201Csv,
  emp501Csv,
  parseYtdCsv,
  taxYearMonths,
  type Certificate,
  type CertificateEmployee,
  type Emp201,
  type EtiEmployee,
  type StatutoryItem,
} from "../statutory.js";
import { documentKey, DOWNLOAD_LINK_SECONDS, presignGet, putPrivate } from "../storage.js";
import { reqStr, requireUser, today, type Env } from "./env.js";
import { requireRun, ruleVersionForDate } from "./runs.js";

function toStatutoryItem(i: db.PostedItem): StatutoryItem {
  const t = i.result?.totals;
  return {
    runId: i.runId,
    runNumber: i.runNumber,
    runKind: i.runKind,
    employeeId: i.employeeId,
    payDate: i.payDate,
    frequency: i.frequency,
    totals: {
      grossMinor: i.grossMinor,
      payeMinor: i.payeMinor,
      uifEmployeeMinor: i.uifEmployeeMinor,
      uifEmployerMinor: i.uifEmployerMinor,
      sdlMinor: i.sdlMinor,
      etiMinor: i.etiMinor,
      regularTaxableMinor: t?.regularTaxableMinor ?? 0,
      irregularTaxableMinor: t?.irregularTaxableMinor ?? 0,
      netPayMinor: i.netMinor,
    },
    sarsCodes: i.result?.sarsCodes ?? {},
    hoursCenti: i.result?.hours?.ordinaryCenti ?? null,
    belowMinimumWage: i.result?.hours?.belowMinimumWage ?? false,
  };
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** EMP201s from the start of the reconciliation half (March or September) up to `month`, carrying unused ETI forward. */
export async function emp201Series(env: Env, companyId: string, month: string): Promise<Emp201[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new PayrollError("Month must be YYYY-MM");
  const taxYear = taxYearOf(`${month}-01`);
  const months = taxYearMonths(taxYear);
  const index = months.indexOf(month);
  const halfStart = index >= 6 ? 6 : 0;
  const series = months.slice(halfStart, index + 1);
  const version = await ruleVersionForDate(env, `${month}-01`);
  const first = monthBounds(series[0]!);
  const last = monthBounds(month);
  const [items, employees, etiMonths, openings] = await Promise.all([
    db.postedItems(env.ctx, companyId, first.from, last.to),
    db.listEmployees(env.ctx, companyId),
    db.etiMonthsClaimed(env.ctx, companyId, first.from),
    db.listYtd(env.ctx, companyId, taxYear),
  ]);
  const statItems = items.map(toStatutoryItem);
  const out: Emp201[] = [];
  let carry = 0;
  const monthsSoFar = new Map(etiMonths);
  for (const m of series) {
    const etiEmployees: EtiEmployee[] = employees.map((e) => ({ employeeId: e.id, eligible: e.etiEligible, dateOfBirth: e.dateOfBirth, qualifyingMonth: (monthsSoFar.get(e.id) ?? 0) + e.etiMonthsBefore + 1 }));
    const e = buildEmp201({ month: m, items: statItems, rules: version.rules, etiEmployees, etiBroughtForwardMinor: carry });
    out.push(e);
    carry = e.etiCarriedForwardMinor;
    for (const item of statItems.filter((i) => i.payDate.startsWith(m) && i.totals.etiMinor > 0)) monthsSoFar.set(item.employeeId, (monthsSoFar.get(item.employeeId) ?? 0) + 1);
  }
  if (openings.some((o) => o.etiMinor > 0)) out[out.length - 1]!.notes.push("Cut-over openings include ETI claimed before this system; it is on the certificates, not re-claimed here.");
  return out;
}

export async function emp201(env: Env, companyId: string, params: Record<string, unknown>) {
  const month = reqStr(params, "month", 7);
  const series = await emp201Series(env, companyId, month);
  const config = await env.config(companyId);
  return {
    emp201: series[series.length - 1]!,
    employer: { legalName: config.employer.legalName, payeReference: config.employer.payeReference, sdlReference: config.employer.sdlReference, uifReference: config.employer.uifReference },
  };
}

async function certificateEmployees(env: Env, companyId: string, withPii: boolean): Promise<CertificateEmployee[]> {
  const employees = await db.listEmployees(env.ctx, companyId);
  let sealed = new Map<string, db.SealedRow>();
  let keyring: Awaited<ReturnType<Awaited<ReturnType<Env["config"]>>["keyring"]>> | null = null;
  if (withPii) {
    sealed = await db.getSealed(env.ctx, companyId, employees.map((e) => e.id));
    keyring = await (await env.config(companyId)).keyring();
  }
  return employees.map((e) => {
    const s = sealed.get(e.id);
    const identity = keyring && s ? openDetails<IdentityDetails>(s.sealedIdentity, keyring) : null;
    const tax = keyring && s ? openDetails<TaxDetails>(s.sealedTax, keyring) : null;
    return {
      employeeId: e.id,
      employeeNumber: e.employeeNumber,
      firstName: e.firstName,
      lastName: e.lastName,
      dateOfBirth: e.dateOfBirth,
      startDate: e.startDate,
      endDate: e.endDate,
      idNumber: withPii ? identity?.idNumber ?? null : e.masks.idNumber,
      passportNumber: withPii ? identity?.passportNumber ?? null : e.masks.passportNumber,
      passportCountry: withPii ? identity?.passportCountry ?? null : null,
      taxReference: withPii ? tax?.taxReference ?? null : e.masks.taxReference,
    };
  });
}

export async function certificates(env: Env, companyId: string, taxYear: string, withPii = false, until?: string): Promise<{ certificates: Certificate[]; employees: CertificateEmployee[] }> {
  const { startDate, endDate } = taxYearBounds(taxYear);
  const [items, openings, employees] = await Promise.all([
    db.postedItems(env.ctx, companyId, startDate, until && until < endDate ? until : endDate),
    db.listYtd(env.ctx, companyId, taxYear),
    certificateEmployees(env, companyId, withPii),
  ]);
  const stat = items.map(toStatutoryItem);
  const certs: Certificate[] = [];
  for (const employee of employees) {
    const ytd = openings.find((o) => o.employeeId === employee.employeeId) ?? null;
    if (!stat.some((i) => i.employeeId === employee.employeeId) && !ytd) continue;
    certs.push(buildCertificate({ employee, taxYear, items: stat, ytd: ytd ? { ...ytd } : null }));
  }
  return { certificates: certs, employees };
}

export async function emp501(env: Env, companyId: string, params: Record<string, unknown>) {
  const taxYear = reqStr(params, "taxYear", 7);
  const period = params.period === "interim" ? "interim" : "annual";
  const months = taxYearMonths(taxYear, period);
  const series = [...(await emp201Series(env, companyId, months[Math.min(5, months.length - 1)]!))];
  if (period === "annual") series.push(...(await emp201Series(env, companyId, months[11]!)));
  const until = period === "interim" ? monthBounds(months[5]!).to : undefined;
  const { certificates: certs } = await certificates(env, companyId, taxYear, false, until);
  const openings = await db.listYtd(env.ctx, companyId, taxYear);
  const before = openings.reduce(
    (acc, o) => ({ payeMinor: acc.payeMinor + o.payeMinor, sdlMinor: acc.sdlMinor + o.sdlMinor, uifMinor: acc.uifMinor + o.uifMinor, etiMinor: acc.etiMinor + o.etiMinor }),
    { payeMinor: 0, sdlMinor: 0, uifMinor: 0, etiMinor: 0 },
  );
  return buildEmp501(taxYear, period, series, certs, before);
}

type ExportKind = "emp201" | "irp5" | "emp501" | "bank-acb" | "bank-netcash";

async function storeExport(env: Env, companyId: string, userId: string, kind: ExportKind, ref: string, fileName: string, contentType: string, content: string, rows: number) {
  const config = await env.config(companyId);
  const bytes = Buffer.from(content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = db.newId("exp");
  let r2Key: string | null = null;
  let url: string | null = null;
  if (config.r2Configured) {
    const r2 = await config.r2();
    r2Key = documentKey(r2, companyId, kind.startsWith("bank") ? "bank-files" : "exports", id, fileName, today(env).slice(0, 7));
    await putPrivate(r2, r2Key, new Uint8Array(bytes), contentType);
    url = presignGet(r2, r2Key, DOWNLOAD_LINK_SECONDS, fileName);
  }
  await db.insertExport(env.ctx, companyId, { id, kind, ref, fileName, contentType, r2Key, bytes: bytes.byteLength, sha256, rowCount: rows, createdByUserId: userId, createdAt: null });
  await db.audit(env.ctx, companyId, { userId, agentId: null }, "export.created", "export", id, { kind, ref, rows, stored: Boolean(r2Key) });
  // Without private storage the file goes straight back to the board member's browser.
  return { exportId: id, fileName, contentType, sha256, url, expiresInSeconds: url ? DOWNLOAD_LINK_SECONDS : null, content: url ? null : content };
}

export async function exportStatutory(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const kind = String(params.kind ?? "") as ExportKind;
  const config = await env.config(companyId);
  const employer = { legalName: config.employer.legalName, payeReference: config.employer.payeReference, sdlReference: config.employer.sdlReference, uifReference: config.employer.uifReference };
  if (kind === "emp201") {
    const month = reqStr(params, "month", 7);
    const series = await emp201Series(env, companyId, month);
    return storeExport(env, companyId, user.userId, kind, month, `emp201-${month}.csv`, "text/csv", emp201Csv(series[series.length - 1]!, employer), 1);
  }
  if (kind === "irp5") {
    const taxYear = reqStr(params, "taxYear", 7);
    const { certificates: certs, employees } = await certificates(env, companyId, taxYear, true);
    return storeExport(env, companyId, user.userId, kind, taxYear, `irp5-it3a-${taxYear.replace("/", "-")}.csv`, "text/csv", certificatesCsv(certs, employees), certs.length);
  }
  if (kind === "emp501") {
    const result = await emp501(env, companyId, params);
    return storeExport(env, companyId, user.userId, kind, `${result.taxYear} ${result.period}`, `emp501-${result.taxYear.replace("/", "-")}-${result.period}.csv`, "text/csv", emp501Csv(result), result.months.length);
  }
  throw new PayrollError("kind must be emp201, irp5 or emp501");
}

/** ACB or NetCash file of net pay for a locked run. Never pays anyone. Board only. */
export async function netPayFile(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  if (run.status !== "locked") throw new PayrollError("Lock the pay run before making the bank file");
  if (run.kind === "reversal") throw new PayrollError("A reversal run pays nothing");
  const format = String(params.format ?? "acb") as BankFormat;
  if (format !== "acb" && format !== "netcash") throw new PayrollError("format must be acb or netcash");
  const items = (await db.listItems(env.ctx, companyId, run.id)).filter((i) => i.status === "ok" && i.netMinor > 0);
  const sealed = await db.getSealed(env.ctx, companyId, items.map((i) => i.employeeId));
  const keyring = await (await env.config(companyId)).keyring();
  const rows: BankPaymentRow[] = [];
  const missing: string[] = [];
  const monthLabel = new Date(`${run.payDate}T00:00:00Z`).toLocaleString("en-ZA", { month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase();
  for (const item of items) {
    const bank = openDetails<BankDetails>(sealed.get(item.employeeId)?.sealedBank, keyring);
    if (!bank) {
      missing.push(item.snapshot.name);
      continue;
    }
    rows.push({
      beneficiaryName: bank.accountHolder,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      branchCode: bank.branchCode,
      accountType: bank.accountType,
      amountMinor: item.netMinor,
      reference: `SALARY ${monthLabel}`,
      ownReference: item.snapshot.employeeNumber,
      actionDate: run.payDate,
    });
  }
  if (!rows.length) throw new PayrollError(missing.length ? `No bank details on file for: ${missing.join(", ")}` : "Nobody in this run has net pay");
  const file = buildBankFile(format, rows, run.number);
  const stored = await storeExport(env, companyId, user.userId, format === "acb" ? "bank-acb" : "bank-netcash", run.id, file.name, file.contentType, file.content, file.rows);
  return { ...stored, rows: file.rows, totalMinor: file.totalMinor, total: minorToDecimal(file.totalMinor), missing };
}

export async function exportDownload(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const exp = await db.getExport(env.ctx, companyId, reqStr(params, "exportId", 64));
  if (!exp) throw new PayrollError("Export not found");
  if (!exp.r2Key) throw new PayrollError("That export was downloaded directly and was not stored. Make it again.");
  const r2 = await (await env.config(companyId)).r2();
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "export.downloaded", "export", exp.id, { kind: exp.kind });
  return { url: presignGet(r2, exp.r2Key, DOWNLOAD_LINK_SECONDS, exp.fileName), fileName: exp.fileName, expiresInSeconds: DOWNLOAD_LINK_SECONDS };
}

/** Cut-over: YTD figures per employee from the old payroll (CSV with employee_number and SARS code columns in rand). */
export async function importYtd(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const taxYear = reqStr(params, "taxYear", 7);
  taxYearBounds(taxYear);
  const csv = reqStr(params, "csv", 2_000_000);
  const { rows, errors } = parseYtdCsv(csv, parseRandToMinor);
  const employees = await db.listEmployees(env.ctx, companyId);
  let imported = 0;
  for (const row of rows) {
    const employee = employees.find((e) => e.employeeNumber === row.employeeNumber);
    if (!employee) {
      errors.push(`Employee number ${row.employeeNumber} is not in Payroll`);
      continue;
    }
    await db.upsertYtd(env.ctx, companyId, { employeeId: employee.id, taxYear, codes: row.codes, grossMinor: row.grossMinor, payeMinor: row.payeMinor, uifMinor: row.uifMinor, sdlMinor: row.sdlMinor, etiMinor: row.etiMinor }, user.userId);
    imported += 1;
  }
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "ytd.imported", "tax_year", taxYear, { imported, errors: errors.length });
  return { taxYear, imported, errors };
}
