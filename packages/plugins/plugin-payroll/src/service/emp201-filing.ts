/**
 * EMP201 filed or not. Payroll never files or pays SARS: a person does both
 * on eFiling. This records that they did (on the Statutory page, or the
 * agent relaying the owner's confirmation with `mark-emp201-filed`), so the
 * Cockpit's "EMP201 to file" stage and the EMP201 issue's done-check know.
 * Kept in plugin state per company and month, with an audit row.
 */
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { readableDate } from "../dates.js";
import { PayrollError } from "../money.js";
import { optDate, optStr, reqStr, today, type Env } from "./env.js";

export interface Emp201Filing {
  month: string;
  /** The day it was filed and paid on eFiling (YYYY-MM-DD). */
  filedOn: string;
  /** SARS payment reference (PRN) or bank reference, when given. */
  reference: string | null;
  recordedBy: { userId: string | null; agentId: string | null };
  at: string;
}

const KEY = (companyId: string, month: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "payroll-emp201", stateKey: `filed:${month}` });

function isFiling(value: unknown): value is Emp201Filing {
  return Boolean(value) && typeof value === "object" && typeof (value as Emp201Filing).filedOn === "string";
}

/** The month's filing, or null when it is not marked filed. */
export async function emp201Filing(env: Env, companyId: string, month: string): Promise<Emp201Filing | null> {
  const value = await env.ctx.state.get(KEY(companyId, month)).catch(() => null);
  return isFiling(value) ? value : null;
}

function requireEndedMonth(env: Env, params: Record<string, unknown>): string {
  const month = reqStr(params, "month", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new PayrollError("month must be YYYY-MM (the month the staff were paid)");
  if (month >= today(env).slice(0, 7)) throw new PayrollError(`The EMP201 for ${month} can only be filed once the month has ended.`);
  return month;
}

/** Mark the EMP201 for a month filed and paid (a person on the page, or the agent passing on the owner's confirmation). */
export async function markEmp201Filed(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must record the filing");
  const month = requireEndedMonth(env, params);
  const filedOn = optDate(params, "filedOn") ?? today(env);
  if (filedOn > today(env)) throw new PayrollError("filedOn cannot be in the future");
  const reference = optStr(params, "reference", 60);
  const filing: Emp201Filing = { month, filedOn, reference, recordedBy: { userId: actor.userId, agentId: actor.agentId }, at: env.now().toISOString() };
  await env.ctx.state.set(KEY(companyId, month), filing);
  await db.audit(env.ctx, companyId, { userId: actor.userId, agentId: actor.agentId }, "emp201.filed", "emp201", month, { filedOn, reference });
  return filing;
}

/** A filing marked by mistake (board members only): the EMP201 counts as not filed again. */
export async function unmarkEmp201Filed(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind !== "user" || !actor.userId) throw new PayrollError("This action is for board members");
  const month = reqStr(params, "month", 7);
  const before = await emp201Filing(env, companyId, month);
  if (!before) return { month, filed: false };
  await env.ctx.state.set(KEY(companyId, month), null);
  await db.audit(env.ctx, companyId, { userId: actor.userId, agentId: null }, "emp201.unfiled", "emp201", month, { filedOn: before.filedOn });
  return { month, filed: false };
}

/** The `mark-emp201-filed` tool result: no reference echoed (tool output never carries long numbers). */
export async function markEmp201FiledTool(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const filing = await markEmp201Filed(env, companyId, actor, params);
  return {
    month: filing.month,
    filed: true,
    filedOn: filing.filedOn,
    referenceSaved: Boolean(filing.reference),
    next: `Recorded as filed on ${readableDate(filing.filedOn)}. Close the EMP201 issue with the owner's confirmation.`,
  };
}
