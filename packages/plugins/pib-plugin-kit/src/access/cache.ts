/**
 * The guard's cache (PAR-12578 plan, 4.4 "The cache").
 *
 * - Per company and person: role, member status and grant, 30 seconds.
 * - Per run: the acting person, 30 seconds.
 * - Each company has a counter that goes up on every receive. An entry keeps the
 *   counter's value from when its read started and is dropped once the counter
 *   has moved, so a read under way during a receive cannot put old data back.
 * - Only successful reads are stored; an error costs one refused call.
 * - At most 2,000 entries per worker; the oldest go first.
 *
 * One cache per plugin context. The receiver calls `noteAccessReceived` after
 * every applied receive (wired by the guard through `onAccessReceived`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { LOCAL_BOARD_USER_ID } from "../cockpit.js";
import { BYPASS, loadGrant, type Access, type AccessGrant } from "../permissions.js";
import { actingPersonForRun, type ActingPerson, type RunRef } from "./acting-person.js";

export const ACCESS_CACHE_TTL_MS = 30_000;
export const ACCESS_CACHE_MAX = 2_000;

/** One person in one company, as read from core and the plugin's grant copy. */
export interface MemberEntry {
  /** Membership role, or null when he is not a member. */
  role: string | null;
  /** Membership status (`active`, `suspended`, ...), or null when he is not a member. */
  status: string | null;
  /** His grant; only read for a limited person. */
  grant: AccessGrant | null;
}

export interface AccessCacheOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

interface Entry<T> {
  value: T;
  at: number;
  counter: number;
}

export class AccessCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly counters = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: AccessCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? ACCESS_CACHE_TTL_MS;
    this.max = options.max ?? ACCESS_CACHE_MAX;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Bumps the company's counter, so every entry read before it is dropped. */
  received(companyId: string): void {
    this.counters.set(companyId, this.counter(companyId) + 1);
  }

  /**
   * The cached value, or `load()`'s result. A load that throws is not stored and
   * the error goes to the caller. `store` decides whether a result is kept.
   */
  async read<T>(companyId: string, key: string, load: () => Promise<T>, store: (v: T) => boolean = () => true): Promise<T> {
    const k = `${companyId}|${key}`;
    const hit = this.entries.get(k);
    if (hit) {
      if (hit.counter === this.counter(companyId) && this.now() - hit.at < this.ttlMs) return hit.value as T;
      this.entries.delete(k);
    }
    const counter = this.counter(companyId);
    const at = this.now();
    const value = await load();
    // A receive while the read was under way: the result may be old, so keep it out.
    if (store(value) && counter === this.counter(companyId)) {
      this.entries.delete(k);
      this.entries.set(k, { value, at, counter });
      while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    }
    return value;
  }

  private counter(companyId: string): number {
    return this.counters.get(companyId) ?? 0;
  }
}

const caches = new WeakMap<PluginContext, AccessCache>();

/** The plugin's one cache. `options` apply only when it is created (tests). */
export function accessCacheFor(ctx: PluginContext, options?: AccessCacheOptions): AccessCache {
  let cache = caches.get(ctx);
  if (!cache) caches.set(ctx, (cache = new AccessCache(options)));
  return cache;
}

/** Call after every applied receive for the company. */
export function noteAccessReceived(ctx: PluginContext, companyId: string): void {
  accessCacheFor(ctx).received(companyId);
}

/** Reads the person's role and status from core, and his grant when he is limited. Throws on a failed read. */
export async function readMember(ctx: PluginContext, companyId: string, userId: string): Promise<MemberEntry> {
  const members = await ctx.access.members.list({ companyId });
  const member = members.find((m) => m.principalType === "user" && m.principalId === userId);
  const role = member?.membershipRole ?? null;
  const status = member ? String(member.status) : null;
  const limited = status === "active" && role !== null && role !== "owner" && role !== "admin";
  return { role, status, grant: limited ? await loadGrant(ctx, companyId, userId) : null };
}

/** `MemberEntry` turned into what the person may do. Not active, or not a member: no access. */
export function accessOfMember(userId: string, entry: MemberEntry): Access {
  if (entry.status !== "active" || !entry.role) return { userId, bypass: false, grant: null, reason: "You are not an active member of this company" };
  if (entry.role === "owner" || entry.role === "admin") return { ...BYPASS, userId };
  return { userId, bypass: false, grant: entry.grant };
}

/**
 * `resolveAccess` for one person, through the cache. A read that fails denies
 * this call and stores nothing.
 */
export async function cachedAccessFor(ctx: PluginContext, companyId: string, userId: string): Promise<Access> {
  if (userId === LOCAL_BOARD_USER_ID) return { ...BYPASS, userId };
  try {
    const entry = await accessCacheFor(ctx).read(companyId, `u:${userId}`, () => readMember(ctx, companyId, userId));
    return accessOfMember(userId, entry);
  } catch {
    return { userId, bypass: false, grant: null, reason: "Cannot verify your access" };
  }
}

/** `actingPersonForRun` through the cache. A failed read is not stored. */
export function cachedActingPerson(ctx: PluginContext, run: RunRef): Promise<ActingPerson> {
  return accessCacheFor(ctx).read(
    run.companyId,
    `run:${run.runId}|${run.agentId}`,
    () => actingPersonForRun(ctx, run),
    (v) => v.ok || v.reason !== "read-failed",
  );
}
