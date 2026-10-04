import { createHash } from "node:crypto";
import { formatClientParam, parseClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { OWN_SCOPE, type ScopeKey } from "./platforms.js";

/** A refusal the person or agent can act on. The message is shown as it is. */
export class AdsError extends Error {
  constructor(message: string, readonly code: string = "refused") {
    super(message);
    this.name = "AdsError";
  }
}

export function scopeKeyOf(scope: ClientScope): ScopeKey {
  return scope ? formatClientParam(scope) : OWN_SCOPE;
}

export function scopeOfKey(key: ScopeKey | null | undefined): ClientScope {
  return !key || key === OWN_SCOPE ? null : parseClientParam(key);
}

export function validScopeKey(key: unknown): key is ScopeKey {
  return typeof key === "string" && (key === OWN_SCOPE || parseClientParam(key) !== null);
}

export function scopeLabelOf(key: ScopeKey, name?: string | null): string {
  return key === OWN_SCOPE ? "PiB (own ads)" : name?.trim() || `Client ${key.split(":")[1] ?? key}`;
}

/** Stable JSON: object keys sorted, so the same numbers always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdsError("Parameters must be an object");
  return value as Record<string, unknown>;
}

export function requiredString(params: Record<string, unknown>, key: string, max = 2000): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new AdsError(`${key} is required`);
  if (value.length > max) throw new AdsError(`${key} is too long (${max} characters at most)`);
  return value.trim();
}

export function optionalString(params: Record<string, unknown>, key: string, max = 2000): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AdsError(`${key} must be text`);
  if (value.length > max) throw new AdsError(`${key} is too long (${max} characters at most)`);
  return value.trim();
}

export function optionalChoice<T extends string>(params: Record<string, unknown>, key: string, choices: readonly T[]): T | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) throw new AdsError(`${key} must be one of ${choices.join(", ")}`);
  return value as T;
}

/** A whole number of minor units (money), not negative. */
export function minorField(params: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new AdsError(`${key} is required (a whole number of minor units, e.g. 15000 for 150.00)`);
    return undefined;
  }
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new AdsError(`${key} must be a whole number of minor units (cents), 0 or more`);
  if (n > (options.max ?? 100_000_000_000)) throw new AdsError(`${key} is larger than any sane budget; check the units (minor units: 15000 means 150.00)`);
  return n;
}

export function stringList(value: unknown, max = 200, itemMax = 120): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : null;
  if (!list) throw new AdsError("Expected a list of words");
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text && text.length <= itemMax && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** `user:<id>` / `agent:<id>` actor text stored on rows. */
export function actorText(actor: { userId?: string | null; agentId?: string | null }): string {
  return actor.userId ? `user:${actor.userId}` : actor.agentId ? `agent:${actor.agentId}` : "system";
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
