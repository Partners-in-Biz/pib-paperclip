import { Router, type Request, type Response } from "express";

/**
 * The route table of PAR-12608 section 4.6: which `/api` routes a caller who
 * works for a restricted person may reach. Shape (one line): a default-closed
 * rule with no per-route rows. A route with no row is `closed`, so only `open`,
 * `run`, `by-company` and `plugin` rows are ever written; a `closed` row only
 * documents a deliberate choice.
 *
 * - `open`: the restricted person and runs/keys working for him; the handler
 *   decides per object (`decide()` or the read conditions of 4.3). Needs `test`.
 * - `run`: only an agent run or key working for him, not his browser session.
 *   Needs `test`.
 * - `plugin`: decided by the plugin gate (4.8).
 * - `by-company`: the path names no company; the handler calls a company check
 *   of `routes/authz.ts` before it answers. Needs `test`.
 *
 * The area tickets (C4b to C4f, C5-1) add rows here, one ticket at a time.
 * The scan in `__tests__/openapi-routes.test.ts` fails the build when a row
 * matches no registered route, two rows match one route, a row needing a test
 * names none, or a `by-company` handler has no company check.
 */

export const MEMBER_RESTRICTION_ROUTE_CLASSES = ["open", "run", "plugin", "by-company", "closed"] as const;
export type MemberRestrictionRouteClass = (typeof MEMBER_RESTRICTION_ROUTE_CLASSES)[number];

/** `USE` is a mount (`router.use(path)`): it matches the path and everything below it, any method. */
export type MemberRestrictionRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "USE";

export interface MemberRestrictionRouteEntry {
  method: MemberRestrictionRouteMethod;
  /** Mounted Express path pattern, `/api` included, e.g. `/api/issues/:id`. */
  path: string;
  class: MemberRestrictionRouteClass;
  /** Repo-relative test file proving the per-object rule (AC-G3, AC-G9); it must name `path`. */
  test?: string;
}

export const MEMBER_RESTRICTION_ROUTE_TABLE: readonly MemberRestrictionRouteEntry[] = [];

export type MemberRestrictionRouteMatch =
  /** Refused before the lookup (unsafe path) or unroutable; treat as `closed`. */
  | { kind: "refused"; reason: "unsafe_path" | "ambiguous" | "unroutable" }
  /** No row: `closed`. */
  | { kind: "unlisted" }
  /** `entry.class` may be `closed`: a `closed` row wins over every other row the request matches. */
  | { kind: "matched"; entry: MemberRestrictionRouteEntry; params: Record<string, string> };

/**
 * True for a path a caller bound by R may not use at all (4.6, "Matching the
 * way Express matches"): an empty segment (`//`), an encoded slash or
 * backslash, or a dot segment, plain or percent-encoded. Such a path could be
 * classified one way here and routed another way behind a proxy.
 */
export function isUnsafeRestrictedPath(path: string): boolean {
  if (path.includes("//") || /%2f|%5c|\\/i.test(path)) return true;
  return path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

const HITS = Symbol("memberRestrictionRouteHits");
type ClassifierRequest = Request & { [HITS]?: Array<{ entry: MemberRestrictionRouteEntry; params: Record<string, string> }> };

/**
 * A classifier that matches exactly as the `/api` routers route: it registers
 * every row on an Express `Router` with the routers' own options
 * (case-insensitive, optional trailing slash), so `HEAD` reaches `GET` rows,
 * the query is ignored and params decode as Express decodes them.
 *
 * A request can match more than one row (`/agents/me` and `/agents/:id`);
 * which handler answers then depends on the routers' order, which the table
 * does not know. So a `closed` row wins, rows of different classes refuse, and
 * rows of one class agree. The scan fails the build when a row's pattern
 * catches a registered route other than its own.
 */
export function createRouteClassifier(entries: readonly MemberRestrictionRouteEntry[] = MEMBER_RESTRICTION_ROUTE_TABLE) {
  const router = Router();
  for (const entry of entries) {
    const hit = (req: Request, _res: Response, next: (err?: unknown) => void) => {
      (req as ClassifierRequest)[HITS]?.push({ entry, params: { ...(req.params as Record<string, string>) } });
      next();
    };
    if (entry.method === "USE") router.use(entry.path, hit);
    else router[entry.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"](entry.path, hit);
  }

  return function classify(method: string, url: string): Promise<MemberRestrictionRouteMatch> {
    const path = url.split("?")[0] ?? "";
    if (isUnsafeRestrictedPath(path)) return Promise.resolve({ kind: "refused", reason: "unsafe_path" });
    const upper = method.toUpperCase();
    // The router answers OPTIONS itself; no row is ever written for it.
    if (upper === "OPTIONS") return Promise.resolve({ kind: "unlisted" });
    const req = { method: upper, url: path, [HITS]: [] } as unknown as ClassifierRequest;
    return new Promise((resolve) => {
      (router as unknown as { handle(req: Request, res: Response, done: (err?: unknown) => void): void })
        .handle(req, {} as Response, (err?: unknown) => {
          const hits = req[HITS] ?? [];
          const closed = hits.find((hit) => hit.entry.class === "closed");
          if (err) resolve({ kind: "refused", reason: "unroutable" });
          else if (hits.length === 0) resolve({ kind: "unlisted" });
          else if (closed) resolve({ kind: "matched", ...closed });
          else if (hits.some((hit) => hit.entry.class !== hits[0]!.entry.class)) resolve({ kind: "refused", reason: "ambiguous" });
          else resolve({ kind: "matched", ...hits[0]! });
        });
    });
  };
}
