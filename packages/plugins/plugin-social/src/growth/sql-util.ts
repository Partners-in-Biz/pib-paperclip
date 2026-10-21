/** Row helpers shared by the growth SQL files. */
import { clientWhere, type ClientScope } from "@partnersinbiz/pib-plugin-kit";

export type Row = Record<string, unknown>;

export function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function scopeFilter(scope: ClientScope, params: unknown[], alias = ""): string {
  const w = clientWhere(scope, params.length + 1, alias);
  params.push(...w.params);
  return w.sql;
}
