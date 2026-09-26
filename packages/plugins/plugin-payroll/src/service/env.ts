import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { loadPayrollConfig, type PayrollConfig } from "../config.js";
import { LOCAL_BOARD_USER_ID, type Actor } from "../domain.js";
import { PayrollError } from "../money.js";

export interface Env {
  ctx: PluginContext;
  now: () => Date;
  config: (companyId: string) => Promise<PayrollConfig>;
  /** Native fetch for R2 (ctx.http.fetch blocks private addresses and redirects). */
  fetch: typeof fetch;
}

export function createEnv(ctx: PluginContext, overrides: Partial<Omit<Env, "ctx">> = {}): Env {
  return {
    ctx,
    now: overrides.now ?? (() => new Date()),
    config: overrides.config ?? ((companyId) => loadPayrollConfig(ctx, companyId)),
    fetch: overrides.fetch ?? fetch,
  };
}

export function today(env: Env): string {
  return env.now().toISOString().slice(0, 10);
}

export function actionActor(context: PluginPerformActionContext): Actor {
  if (context.actor.type === "user") return { kind: "user", userId: context.actor.userId, agentId: null };
  if (context.actor.type === "agent" && context.actor.agentId) return { kind: "agent", userId: null, agentId: context.actor.agentId };
  return { kind: "system", userId: null, agentId: null };
}

export function requireUser(actor: Actor): Actor & { userId: string } {
  if (actor.kind !== "user" || !actor.userId) throw new PayrollError("This action is for board members");
  return actor as Actor & { userId: string };
}

/** A real, assignable user id (the local-board sentinel is not a member). */
export function assignableUser(userId: string | null | undefined): string | null {
  return userId && userId !== LOCAL_BOARD_USER_ID ? userId : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reqStr(params: Record<string, unknown>, key: string, max = 200): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new PayrollError(`${key} is required`);
  return value.trim().slice(0, max);
}

export function optStr(params: Record<string, unknown>, key: string, max = 500): string | null {
  const value = params[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") throw new PayrollError(`${key} must be text`);
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

export function optDate(params: Record<string, unknown>, key: string): string | null {
  const value = optStr(params, key, 10);
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new PayrollError(`${key} must be a date (YYYY-MM-DD)`);
  return value;
}

export function reqDate(params: Record<string, unknown>, key: string): string {
  const value = optDate(params, key);
  if (!value) throw new PayrollError(`${key} is required (YYYY-MM-DD)`);
  return value;
}

/** Whole cents from a number of cents (`*Minor`) or a rand amount. */
export function optMinor(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new PayrollError(`${key} must be a whole number of cents, zero or more`);
  return n;
}

export function optNumber(params: Record<string, unknown>, key: string, min = 0, max = 1e9): number | null {
  const value = params[key];
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new PayrollError(`${key} must be a number between ${min} and ${max}`);
  return n;
}

export function optBool(params: Record<string, unknown>, key: string): boolean | null {
  const value = params[key];
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new PayrollError(`${key} must be true or false`);
}

export function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
