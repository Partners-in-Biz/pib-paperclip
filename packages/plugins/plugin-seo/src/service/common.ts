/**
 * Shared plumbing for the SEO services: the environment (host context,
 * clocks, fetchers), actors, errors, parameter parsing and per-company info.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createSkillSyncer, normalizeUrl, safeFetch } from "@partnersinbiz/pib-plugin-kit";
import type { SiteFetcher } from "../checks/site.js";
import { loadSeoConfig, type LoadedConfig } from "../config.js";
import { sprintPagePath, sprintScope, type SprintClientFields } from "../engine/scope.js";
import { localDate, localHour } from "../engine/time.js";
import type { FetchLike } from "../integrations/google.js";
import { SKILLS } from "../skills.js";

export class SeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoError";
  }
}

export type Actor =
  | { kind: "user"; userId: string | null }
  | { kind: "agent"; agentId: string; runId: string | null; responsibleUserId: string | null }
  | { kind: "system" };

export const LOCAL_BOARD_USER_ID = "local-board";

export function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return actor.userId ? `user ${actor.userId}` : "a board user";
  if (actor.kind === "agent") return `agent ${actor.agentId}`;
  return "the SEO plugin";
}

export function actorId(actor: Actor): string {
  if (actor.kind === "user") return actor.userId ?? "user";
  if (actor.kind === "agent") return actor.agentId;
  return "system";
}

/** A real, assignable user id (the local-board sentinel is not a member). */
export function assignableUser(userId: string | null | undefined): string | null {
  return userId && userId !== LOCAL_BOARD_USER_ID ? userId : null;
}

export interface Env {
  ctx: PluginContext;
  now: () => Date;
  /** Native fetch for fixed third-party APIs (Google, Bing). */
  fetch: FetchLike;
  /** SSRF-guarded fetch for client websites. */
  site: SiteFetcher;
  skills: ReturnType<typeof createSkillSyncer>;
}

export function createEnv(ctx: PluginContext, overrides: Partial<Omit<Env, "ctx">> = {}): Env {
  return {
    ctx,
    now: overrides.now ?? (() => new Date()),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    site: overrides.site ?? ((url, init) => safeFetch(ctx, url, init)),
    skills: overrides.skills ?? createSkillSyncer(ctx, SKILLS),
  };
}

export interface CompanyInfo {
  companyId: string;
  loaded: LoadedConfig;
  timezone: string;
  today: string;
  hour: number;
  prefix: string | null;
}

/** Config + calendar + issue prefix for one company. Always explicit about the company. */
export async function companyInfo(env: Env, companyId: string): Promise<CompanyInfo> {
  const loaded = await loadSeoConfig(env.ctx, companyId);
  const now = env.now();
  let prefix: string | null = null;
  try {
    prefix = (await env.ctx.companies.get(companyId))?.issuePrefix ?? null;
  } catch {
    prefix = null;
  }
  return {
    companyId,
    loaded,
    timezone: loaded.config.timezone,
    today: localDate(now, loaded.config.timezone),
    hour: localHour(now, loaded.config.timezone),
    prefix,
  };
}

/** The sprint's cockpit link, in the sprint's scope (`&client=` for client sprints). */
export function cockpitPath(info: Pick<CompanyInfo, "prefix">, sprint: { id: string } & SprintClientFields): string | null {
  return info.prefix ? sprintPagePath(`/${info.prefix}/seo`, sprint.id, sprintScope(sprint)) : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

export type Params = Record<string, unknown>;

export function asParams(value: unknown): Params {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new SeoError("Parameters must be an object");
  return value as Params;
}

export function str(params: Params, key: string, opts: { max?: number } = {}): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new SeoError(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (opts.max && trimmed.length > opts.max) throw new SeoError(`${key} is longer than ${opts.max} characters`);
  return trimmed;
}

export function reqStr(params: Params, key: string, opts: { max?: number } = {}): string {
  const value = str(params, key, opts);
  if (!value) throw new SeoError(`${key} is required`);
  return value;
}

export function num(params: Params, key: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new SeoError(`${key} must be a number`);
  if (opts.integer && !Number.isInteger(parsed)) throw new SeoError(`${key} must be a whole number`);
  if (opts.min != null && parsed < opts.min) throw new SeoError(`${key} must be at least ${opts.min}`);
  if (opts.max != null && parsed > opts.max) throw new SeoError(`${key} must be at most ${opts.max}`);
  return parsed;
}

export function bool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SeoError(`${key} must be true or false`);
}

export function oneOf<T extends string>(params: Params, key: string, allowed: readonly T[]): T | undefined {
  const value = str(params, key);
  if (value == null) return undefined;
  if (!allowed.includes(value as T)) throw new SeoError(`${key} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export function strList(params: Params, key: string, opts: { max?: number; itemMax?: number } = {}): string[] {
  const value = params[key];
  if (value == null) return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : null;
  if (!list) throw new SeoError(`${key} must be a list of strings`);
  const out = list
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .map((item) => (opts.itemMax ? item.slice(0, opts.itemMax) : item));
  return opts.max ? out.slice(0, opts.max) : out;
}

export function isoDateParam(params: Params, key: string): string | undefined {
  const value = str(params, key);
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new SeoError(`${key} must be a date like 2026-10-01`);
  }
  return value;
}

/** A normalised http(s) URL; relative paths resolve against the sprint site. */
export function urlParam(value: string, siteUrl?: string | null): string {
  try {
    if (siteUrl && value.startsWith("/")) return new URL(value, normalizeUrl(siteUrl)).toString();
    return normalizeUrl(value);
  } catch {
    throw new SeoError(`Not a valid URL: ${value}`);
  }
}

/** Store a site as its origin (plus path when the site lives in a sub-folder). */
export function canonicalSiteUrl(value: string): string {
  const parsed = new URL(urlParam(value));
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}
