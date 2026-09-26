/**
 * Employees, employment terms and recurring components. Personal details are
 * sealed on the way in; views carry masks only. "Reveal" is the one path
 * that returns plaintext, for a board user, and it is audited.
 */
import { COMPONENT_KINDS, componentByCode, mergeComponents, normaliseCode, type ComponentDefinition } from "../components.js";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { ageOn, type RetirementFund } from "../engine.js";
import { PayrollError, toCentiHours } from "../money.js";
import {
  masksFor,
  normaliseBank,
  normaliseIdentity,
  normaliseTax,
  openDetails,
  PII_FIELDS,
  sealDetails,
  validateSaId,
  type BankDetails,
  type IdentityDetails,
  type PiiField,
  type TaxDetails,
} from "../pii.js";
import type { PayFrequency } from "../rules.js";
import { optBool, optDate, optMinor, optNumber, optStr, reqDate, reqStr, requireUser, today, type Env } from "./env.js";

export interface TermsView {
  id: string;
  version: number;
  effectiveFrom: string;
  frequency: PayFrequency;
  workerCategory: "salaried" | "hourly";
  rateMinor: number;
  standardHours: number;
  hoursPerDay: number;
  daysPerWeek: number;
  overtimeMultiplier: number;
  uifApplicable: boolean;
  sdlApplicable: boolean;
  medical: db.Terms["medical"];
  retirement: db.Terms["retirement"];
  travel: db.Terms["travel"];
  annualLeaveDays: number | null;
}

export function termsView(t: db.Terms | null | undefined): TermsView | null {
  if (!t) return null;
  return {
    id: t.id,
    version: t.version,
    effectiveFrom: t.effectiveFrom,
    frequency: t.frequency,
    workerCategory: t.workerCategory,
    rateMinor: t.rateMinor,
    standardHours: t.standardHoursCenti / 100,
    hoursPerDay: t.hoursPerDayCenti / 100,
    daysPerWeek: t.daysPerWeek,
    overtimeMultiplier: t.overtimeMultiplierBp / 10_000,
    uifApplicable: t.uifApplicable,
    sdlApplicable: t.sdlApplicable,
    medical: t.medical,
    retirement: t.retirement,
    travel: t.travel,
    annualLeaveDays: t.annualLeaveDays,
  };
}

/** Safe for agents: no contact details, date of birth or sealed values. */
export function employeeSummary(e: db.Employee, terms?: db.Terms | null) {
  return {
    id: e.id,
    employeeNumber: e.employeeNumber,
    name: e.name,
    jobTitle: e.jobTitle,
    status: e.status,
    startDate: e.startDate,
    endDate: e.endDate,
    frequency: terms?.frequency ?? null,
    hasTerms: Boolean(terms),
    details: {
      idOrPassport: e.hasIdentity ? (e.masks.idNumber ?? e.masks.passportNumber ?? "on file") : "missing",
      taxReference: e.hasTax ? (e.masks.taxReference ?? "on file") : "missing",
      bank: e.hasBank ? `${e.masks.bankName ?? "Bank"} ${e.masks.accountNumber ?? ""}`.trim() : "missing",
    },
    etiEligible: e.etiEligible,
  };
}

/** For the board page: adds contact details and the date of birth (not sealed), still masked for sealed values. */
export function employeeView(e: db.Employee, terms: db.Terms | null, recurring: db.Recurring[], asOf: string) {
  return {
    ...employeeSummary(e, terms),
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    phone: e.phone,
    dateOfBirth: e.dateOfBirth,
    age: e.dateOfBirth ? ageOn(e.dateOfBirth, asOf) : null,
    taxResidency: e.taxResidency,
    masks: e.masks,
    has: { identity: e.hasIdentity, tax: e.hasTax, bank: e.hasBank },
    etiMonthsBefore: e.etiMonthsBefore,
    terms: termsView(terms),
    recurring: recurring.filter((r) => r.active).map((r) => ({ code: r.code, amountMinor: r.amountMinor, label: r.label })),
  };
}

function anyPresent(params: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => params[k] != null && String(params[k]).trim() !== "");
}

export async function saveEmployee(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const { ctx } = env;
  const id = optStr(params, "employeeId", 64);
  const existing = id ? await db.getEmployee(ctx, companyId, id) : null;
  if (id && !existing) throw new PayrollError("Employee not found");

  const wantsIdentity = anyPresent(params, ["idNumber", "passportNumber"]);
  const wantsTax = anyPresent(params, ["taxReference"]);
  const wantsBank = anyPresent(params, ["accountNumber", "branchCode", "bankName"]);
  const identity: IdentityDetails | null = wantsIdentity ? normaliseIdentity(params) : null;
  const tax: TaxDetails | null = wantsTax ? normaliseTax(params) : null;
  const bank: BankDetails | null = wantsBank
    ? normaliseBank({ ...params, accountHolder: params.accountHolder ?? `${params.firstName ?? existing?.firstName ?? ""} ${params.lastName ?? existing?.lastName ?? ""}`.trim() })
    : null;

  let dateOfBirth = optDate(params, "dateOfBirth") ?? existing?.dateOfBirth ?? null;
  if (identity?.idNumber) {
    const fromId = validateSaId(identity.idNumber, Number(today(env).slice(0, 4))).dateOfBirth;
    if (!dateOfBirth) dateOfBirth = fromId;
    else if (fromId && fromId !== dateOfBirth) throw new PayrollError("The date of birth does not match the ID number");
  }
  const residency = params.taxResidency === "non_resident" ? "non_resident" : params.taxResidency === "resident" ? "resident" : existing?.taxResidency ?? "resident";
  const firstName = optStr(params, "firstName", 80) ?? existing?.firstName;
  const lastName = optStr(params, "lastName", 80) ?? existing?.lastName;
  if (!firstName || !lastName) throw new PayrollError("First name and last name are required");
  const startDate = optDate(params, "startDate") ?? existing?.startDate;
  if (!startDate) throw new PayrollError("Start date is required");
  const email = params.email === undefined ? existing?.email ?? null : optStr(params, "email", 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PayrollError("The email address does not look right");
  const endDate = params.endDate === undefined ? existing?.endDate ?? null : optDate(params, "endDate");
  if (endDate && endDate < startDate) throw new PayrollError("The end date is before the start date");

  const keyring = identity || tax || bank ? await (await env.config(companyId)).keyring() : null;
  const sealedPatch: Record<string, unknown> = {};
  if (keyring) {
    if (identity) sealedPatch.sealed_identity = sealDetails(identity, keyring);
    if (tax) sealedPatch.sealed_tax = sealDetails(tax, keyring);
    if (bank) sealedPatch.sealed_bank = sealDetails(bank, keyring);
    sealedPatch.pii_masks = masksFor(identity, tax, bank, existing?.masks);
    sealedPatch.key_version = keyring.currentVersion;
  }

  const etiEligible = optBool(params, "etiEligible") ?? existing?.etiEligible ?? false;
  const etiMonthsBefore = optNumber(params, "etiMonthsBefore", 0, 24) ?? existing?.etiMonthsBefore ?? 0;
  let employeeId = existing?.id ?? null;
  if (!existing) {
    employeeId = db.newId("emp");
    const employeeNumber = optStr(params, "employeeNumber", 20) ?? (await db.nextEmployeeNumber(ctx, companyId));
    if (await db.getEmployeeByNumber(ctx, companyId, employeeNumber)) throw new PayrollError(`Employee number ${employeeNumber} is already used`);
    await db.insertEmployee(ctx, {
      id: employeeId,
      companyId,
      employeeNumber,
      firstName,
      lastName,
      email,
      phone: optStr(params, "phone", 40),
      jobTitle: optStr(params, "jobTitle", 120),
      dateOfBirth,
      startDate,
      endDate,
      taxResidency: residency,
      etiEligible,
      etiMonthsBefore: Math.round(etiMonthsBefore),
    });
    if (Object.keys(sealedPatch).length) await db.updateEmployee(ctx, companyId, employeeId, sealedPatch);
  } else {
    const employeeNumber = optStr(params, "employeeNumber", 20);
    if (employeeNumber && employeeNumber !== existing.employeeNumber) {
      const clash = await db.getEmployeeByNumber(ctx, companyId, employeeNumber);
      if (clash && clash.id !== existing.id) throw new PayrollError(`Employee number ${employeeNumber} is already used`);
    }
    await db.updateEmployee(ctx, companyId, existing.id, {
      employee_number: employeeNumber ?? undefined,
      first_name: firstName,
      last_name: lastName,
      email,
      phone: params.phone === undefined ? undefined : optStr(params, "phone", 40),
      job_title: params.jobTitle === undefined ? undefined : optStr(params, "jobTitle", 120),
      date_of_birth: dateOfBirth,
      start_date: startDate,
      end_date: endDate,
      tax_residency: residency,
      eti_eligible: etiEligible,
      eti_months_before: Math.round(etiMonthsBefore),
      ...sealedPatch,
    });
  }
  await db.audit(ctx, companyId, { userId: user.userId, agentId: null }, existing ? "employee.updated" : "employee.created", "employee", employeeId!, {
    sealed: Object.keys(sealedPatch).filter((k) => k.startsWith("sealed_")),
  });
  const saved = await db.getEmployee(ctx, companyId, employeeId!);
  return { employee: saved ? employeeSummary(saved) : null };
}

export async function terminateEmployee(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const employee = await db.getEmployee(env.ctx, companyId, reqStr(params, "employeeId", 64));
  if (!employee) throw new PayrollError("Employee not found");
  const endDate = reqDate(params, "endDate");
  if (endDate < employee.startDate) throw new PayrollError("The end date is before the start date");
  await db.updateEmployee(env.ctx, companyId, employee.id, { status: "terminated", end_date: endDate });
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "employee.terminated", "employee", employee.id, { endDate });
  return { employeeId: employee.id, status: "terminated", endDate };
}

const DEFAULT_HOURS: Record<PayFrequency, number> = { monthly: 173.33, fortnightly: 80, weekly: 40 };

export async function saveTerms(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const employee = await db.getEmployee(env.ctx, companyId, reqStr(params, "employeeId", 64));
  if (!employee) throw new PayrollError("Employee not found");
  const frequency = (params.frequency ?? "monthly") as PayFrequency;
  if (!["monthly", "fortnightly", "weekly"].includes(frequency)) throw new PayrollError("Pay frequency must be monthly, fortnightly or weekly");
  const workerCategory = params.workerCategory === "hourly" ? "hourly" : "salaried";
  const rateMinor = optMinor(params, "rateMinor");
  if (rateMinor == null) throw new PayrollError(workerCategory === "hourly" ? "Enter the rate per hour" : "Enter the salary for the pay period");
  const standardHours = optNumber(params, "standardHours", 0, 400) ?? DEFAULT_HOURS[frequency];
  const hoursPerDay = optNumber(params, "hoursPerDay", 1, 24) ?? 8;
  const daysPerWeek = optNumber(params, "daysPerWeek", 1, 7) ?? 5;
  const multiplier = optNumber(params, "overtimeMultiplier", 1, 3) ?? 1.5;
  const medical = parseMedical(params.medical);
  const retirement = parseRetirement(params.retirement);
  const travel = parseTravel(params.travel);
  const effectiveFrom = optDate(params, "effectiveFrom") ?? (employee.startDate > today(env) ? employee.startDate : today(env));
  const id = db.newId("terms");
  await db.insertTerms(env.ctx, companyId, {
    id,
    employeeId: employee.id,
    effectiveFrom,
    frequency,
    workerCategory,
    rateMinor,
    standardHoursCenti: toCentiHours(standardHours),
    hoursPerDayCenti: toCentiHours(hoursPerDay),
    daysPerWeek: Math.round(daysPerWeek),
    overtimeMultiplierBp: Math.round(multiplier * 10_000),
    uifApplicable: optBool(params, "uifApplicable") ?? true,
    sdlApplicable: optBool(params, "sdlApplicable") ?? true,
    medical,
    retirement,
    travel,
    annualLeaveDays: optNumber(params, "annualLeaveDays", 0, 60),
    createdBy: user.userId,
  });
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "terms.created", "employee", employee.id, { termsId: id, effectiveFrom });
  const terms = await db.listTerms(env.ctx, companyId, employee.id);
  return { terms: termsView(terms.find((t) => t.id === id) ?? terms[0] ?? null) };
}

function parseMedical(value: unknown): db.Terms["medical"] {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const members = Math.max(0, Math.round(Number(v.members ?? 0)));
  const ee = optMinor(v, "employeeContributionMinor") ?? 0;
  const er = optMinor(v, "employerContributionMinor") ?? 0;
  if (!members && !ee && !er) return null;
  if ((ee || er) && members < 1) throw new PayrollError("Medical aid needs at least one member (the employee)");
  return { members, employeeContributionMinor: ee, employerContributionMinor: er };
}

function parseRetirement(value: unknown): db.Terms["retirement"] {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const ee = optMinor(v, "employeeContributionMinor") ?? 0;
  const er = optMinor(v, "employerContributionMinor") ?? 0;
  if (!ee && !er) return null;
  const fund = (v.fund ?? "pension") as RetirementFund;
  if (!["pension", "provident", "retirement_annuity"].includes(fund)) throw new PayrollError("Retirement fund must be pension, provident or retirement_annuity");
  return { fund, employeeContributionMinor: ee, employerContributionMinor: er };
}

function parseTravel(value: unknown): db.Terms["travel"] {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const amount = optMinor(v, "amountMinor") ?? 0;
  if (!amount) return null;
  return { amountMinor: amount, businessUseAtLeast80: v.businessUseAtLeast80 === true };
}

export async function setRecurring(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const employee = await db.getEmployee(env.ctx, companyId, reqStr(params, "employeeId", 64));
  if (!employee) throw new PayrollError("Employee not found");
  const code = normaliseCode(params.code);
  const catalogue = mergeComponents(await db.listCustomComponents(env.ctx, companyId));
  const component = componentByCode(catalogue, code);
  if (!component) throw new PayrollError(`Unknown pay component ${code}`);
  if (["BASIC", "HOURLY", "OVERTIME", "DOUBLE_TIME", "LEAVE_PAID", "LEAVE_UNPAID", "TRAVEL_ALLOWANCE"].includes(code)) {
    throw new PayrollError(`${component.name} comes from the employment terms; change the terms instead`);
  }
  const amountMinor = optMinor(params, "amountMinor") ?? 0;
  const active = optBool(params, "active") ?? amountMinor > 0;
  await db.upsertRecurring(env.ctx, companyId, { employeeId: employee.id, code, amountMinor, label: optStr(params, "label", 80), active });
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "recurring.saved", "employee", employee.id, { code, amountMinor, active });
  return { employeeId: employee.id, code, amountMinor, active };
}

export async function saveComponent(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  requireUser(actor);
  const code = normaliseCode(params.code);
  const kind = String(params.kind ?? "");
  if (!(COMPONENT_KINDS as string[]).includes(kind)) throw new PayrollError(`Kind must be one of: ${COMPONENT_KINDS.join(", ")}`);
  const sarsCode = params.sarsCode == null || params.sarsCode === "" ? null : String(params.sarsCode).trim();
  if (sarsCode && !/^\d{4}$/.test(sarsCode)) throw new PayrollError("A SARS source code is four digits, e.g. 3713");
  const taxable = optBool(params, "taxable") ?? ["earning", "allowance", "travel_allowance", "fringe_benefit"].includes(kind);
  const def: ComponentDefinition = {
    code,
    name: reqStr(params, "name", 80),
    kind: kind as ComponentDefinition["kind"],
    sarsCode,
    taxable,
    irregular: optBool(params, "irregular") ?? false,
    uif: optBool(params, "uif") ?? taxable,
    sdl: optBool(params, "sdl") ?? taxable,
    builtIn: false,
    active: optBool(params, "active") ?? true,
  };
  await db.upsertComponent(env.ctx, companyId, def);
  return { component: def };
}

/**
 * Board-only: decrypt one sealed field for display. Audited. Never exposed
 * as an agent tool.
 */
export async function revealEmployeeField(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind !== "user" || !actor.userId) throw new PayrollError("Only a board member can reveal personal details");
  const employeeId = reqStr(params, "employeeId", 64);
  const field = String(params.field ?? "") as PiiField;
  if (!(PII_FIELDS as readonly string[]).includes(field)) throw new PayrollError("field must be identity, tax or bank");
  const employee = await db.getEmployee(env.ctx, companyId, employeeId);
  if (!employee) throw new PayrollError("Employee not found");
  const sealed = (await db.getSealed(env.ctx, companyId, [employeeId])).get(employeeId);
  const keyring = await (await env.config(companyId)).keyring();
  const value =
    field === "identity" ? openDetails<IdentityDetails>(sealed?.sealedIdentity, keyring)
      : field === "tax" ? openDetails<TaxDetails>(sealed?.sealedTax, keyring)
        : openDetails<BankDetails>(sealed?.sealedBank, keyring);
  await db.audit(env.ctx, companyId, { userId: actor.userId, agentId: null }, "employee.revealed", "employee", employeeId, { field });
  env.ctx.logger.info("Payroll personal details revealed", { companyId, employeeId, field });
  return { employeeId, field, value };
}
