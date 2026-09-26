import type { PluginPerformActionContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { clientScopeFromInput, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { BillingError } from "./domain.js";

export function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new BillingError("Company is required");
  return context.companyId;
}

/** Money moves, voids and sends are done by a person in the Billing page, never by an agent. */
export function requirePerson(context: PluginPerformActionContext, what = "this"): string | null {
  if (context.actor.type === "agent") throw new BillingError(`Agents may not do ${what}. A person does it on the Billing page.`);
  return context.actor.userId ?? null;
}

export function actorLabel(context: PluginPerformActionContext): string | null {
  if (context.actor.type === "agent") return context.actor.agentId ? `agent:${context.actor.agentId}` : "agent";
  return context.actor.userId ? `user:${context.actor.userId}` : context.actor.type ?? null;
}

export function toolContext(run: ToolRunContext): PluginPerformActionContext {
  return {
    companyId: run.companyId,
    actor: { type: "agent", userId: null, agentId: run.agentId, runId: run.runId, companyId: run.companyId },
  };
}

export function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingError("Parameters must be an object");
  return value as Record<string, unknown>;
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new BillingError(`${key} is required`);
  return value.trim();
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new BillingError(`${key} must be a string`);
  return value.trim();
}

export function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount)) throw new BillingError(`${key} must be an integer`);
  return amount;
}

export function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  return integer(value, key);
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BillingError(`${key} must be true or false`);
}

export function optionalDate(params: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(params, key);
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BillingError(`${key} must be a date`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : parsed.toISOString();
}

export function currencyCode(value: unknown, fallback = "ZAR"): string {
  const code = String(value ?? fallback).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new BillingError("Currency must be a 3-letter code");
  return code;
}

/** `client` / `clientKind`+`clientRef` from an action. A malformed value is an error, not the whole book. */
export function readClientScope(params: Record<string, unknown>): ClientScope | undefined {
  const scope = clientScopeFromInput(params);
  if (scope !== undefined) return scope;
  const raw = "client" in params ? params.client : "clientRef" in params ? params.clientRef : undefined;
  if (raw === undefined) return undefined;
  throw new BillingError("client must be company:<crm company id> or contact:<crm contact id>");
}

export function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function dayOf(value: unknown): string | null {
  const stamp = isoOrNull(value);
  if (!stamp) return null;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? stamp.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
