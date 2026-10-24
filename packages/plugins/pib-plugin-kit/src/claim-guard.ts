/**
 * A guard for public endpoints that read a company's secret for a company id
 * the caller only claims (an unsigned token or body).
 *
 * Why. The claimed id is checked against that company's secret, so the secret
 * must be read first. Without a guard, a flood of made-up ids makes one secret
 * read each (the host allows 30 a minute per company and counts the rest as
 * failures). The guard does three things, all in worker memory:
 * - a visitor (address from the proxy headers) gets a few requests a minute;
 * - a looked-up value, a miss included, is kept for a minute, so a repeated id costs nothing;
 * - the number of uncached lookups a minute is capped for the whole worker.
 * A refused request looks like any other bad token to the caller.
 */

export interface ClaimGuardOptions {
  ttlMs?: number;
  perVisitorPerMinute?: number;
  lookupsPerMinute?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface ClaimGuard<T> {
  /** False when this visitor is over its allowance (counts the request when true). */
  allow(headers: Record<string, string | string[] | undefined>): boolean;
  /** The value for a claimed id: cached for the TTL (a null too); null without calling `load` when over the lookup budget. */
  resolve(id: string, load: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
}

const MINUTE = 60_000;

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The visitor's address as the proxy reports it; one shared bucket when it reports none. */
export function visitorKey(headers: Record<string, string | string[] | undefined>): string {
  return header(headers, "x-real-ip")?.trim() || header(headers, "x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function createClaimGuard<T>(options: ClaimGuardOptions = {}): ClaimGuard<T> {
  const ttl = options.ttlMs ?? MINUTE;
  const perVisitor = options.perVisitorPerMinute ?? 30;
  const lookupCap = options.lookupsPerMinute ?? 60;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: T | null }>();
  const visitors = new Map<string, { windowStart: number; count: number }>();
  let lookups = { windowStart: 0, count: 0 };

  const trim = (map: Map<string, unknown>): void => {
    while (map.size > maxEntries) map.delete(map.keys().next().value as string);
  };

  return {
    allow(headers) {
      const key = visitorKey(headers);
      const at = now();
      const seen = visitors.get(key);
      if (!seen || at - seen.windowStart >= MINUTE) {
        visitors.delete(key);
        visitors.set(key, { windowStart: at, count: 1 });
        trim(visitors);
        return true;
      }
      seen.count += 1;
      return seen.count <= perVisitor;
    },
    async resolve(id, load) {
      const at = now();
      const hit = cache.get(id);
      if (hit && at - hit.at < ttl) return hit.value;
      if (at - lookups.windowStart >= MINUTE) lookups = { windowStart: at, count: 0 };
      if (lookups.count >= lookupCap) return null;
      lookups.count += 1;
      let value: T | null = null;
      try {
        value = await load();
      } catch {
        return null; // a failed read is not remembered
      }
      cache.delete(id);
      cache.set(id, { at, value });
      trim(cache);
      return value;
    },
    clear() {
      cache.clear();
      visitors.clear();
      lookups = { windowStart: 0, count: 0 };
    },
  };
}
