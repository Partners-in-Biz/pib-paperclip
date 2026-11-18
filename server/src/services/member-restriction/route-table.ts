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

const TASKS_TEST = "server/src/__tests__/member-restriction-route-table-tasks.test.ts";
const TREE_TEST = "server/src/__tests__/member-restriction-route-table-comments-projects.test.ts";
const DOCS_TEST = "server/src/__tests__/member-restriction-route-table-documents.test.ts";
const ACCOUNT_TEST = "server/src/__tests__/member-restriction-route-table-account.test.ts";

export const MEMBER_RESTRICTION_ROUTE_TABLE: readonly MemberRestrictionRouteEntry[] = [
  // C4b-1a (PAR-12730): the task routes of `routes/issues.ts`. Comments,
  // documents, attachments, work products, approvals, questions, inbox, search
  // and chat are other areas. Every `open` and `run` handler reads the task
  // through `issue:read` (or a list through `issueReadSqlCondition`) first.
  { method: "GET", path: "/api/companies/:companyId/issues", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/companies/:companyId/issues/summaries", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/companies/:companyId/issues/count", class: "open", test: TASKS_TEST },
  { method: "POST", path: "/api/companies/:companyId/issues", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id", class: "open", test: TASKS_TEST },
  { method: "PATCH", path: "/api/issues/:id", class: "open", test: TASKS_TEST },
  { method: "POST", path: "/api/issues/:id/children", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/external-objects", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/external-object-summary", class: "open", test: TASKS_TEST },
  // An agent's own work on a task.
  { method: "GET", path: "/api/issues/:id/heartbeat-context", class: "run", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/runner-goal", class: "run", test: TASKS_TEST },
  { method: "POST", path: "/api/issues/:id/checkout", class: "run", test: TASKS_TEST },
  { method: "POST", path: "/api/issues/:id/release", class: "run", test: TASKS_TEST },
  // Closed on purpose: company set-up (labels), operator tools (recovery,
  // diagnostics, watchdog, monitors, retries, review decisions, low-trust
  // promotions, plan decompositions), sharing (grants, privacy constraints),
  // deleting a task, and feedback traces. Several of these handlers check
  // only the company, not the task. `PUT .../title` checks the task only for
  // agents and answers an agent 403, not "not found" (AC-G3); renaming stays
  // open through `PATCH /api/issues/:id`.
  { method: "GET", path: "/api/issues", class: "closed" },
  { method: "PUT", path: "/api/issues/:id/title", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/labels", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/labels", class: "closed" },
  { method: "DELETE", path: "/api/labels/:labelId", class: "closed" },
  { method: "POST", path: "/api/issues/:id/runner-goal/actions", class: "closed" },
  { method: "POST", path: "/api/issues/:id/context/compact", class: "closed" },
  { method: "GET", path: "/api/issues/:id/diagnostics/blockers", class: "closed" },
  { method: "GET", path: "/api/issues/:id/diagnostics/wakes", class: "closed" },
  { method: "GET", path: "/api/issues/:id/diagnostics/subtree", class: "closed" },
  { method: "GET", path: "/api/issues/:id/watchdog", class: "closed" },
  { method: "PUT", path: "/api/issues/:id/watchdog", class: "closed" },
  { method: "DELETE", path: "/api/issues/:id/watchdog", class: "closed" },
  { method: "GET", path: "/api/issues/:id/recovery-actions", class: "closed" },
  { method: "POST", path: "/api/issues/:id/retry", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/recover-workspace", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/resume-workspace-finalization", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/confirm-controller-stopped", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/retry-workspace-export", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/reconstruct-workspace", class: "closed" },
  { method: "POST", path: "/api/issues/:id/recovery-actions/resolve", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/issues/external-object-summaries", class: "closed" },
  { method: "POST", path: "/api/issues/:id/external-objects/refresh", class: "closed" },
  { method: "POST", path: "/api/issues/:id/low-trust/promotions", class: "closed" },
  { method: "GET", path: "/api/issues/:id/accepted-plan-decompositions", class: "closed" },
  { method: "POST", path: "/api/issues/:id/accepted-plan-decompositions", class: "closed" },
  { method: "POST", path: "/api/issues/:id/monitor/check-now", class: "closed" },
  { method: "POST", path: "/api/issues/:id/scheduled-retry/retry-now", class: "closed" },
  { method: "GET", path: "/api/issues/:id/privacy-constraints", class: "closed" },
  { method: "GET", path: "/api/issues/:id/access-grants", class: "closed" },
  { method: "POST", path: "/api/issues/:id/access-grants", class: "closed" },
  { method: "POST", path: "/api/issues/:id/access-grants/:grantId/revoke", class: "closed" },
  { method: "POST", path: "/api/issues/:id/stalled-review-decision", class: "closed" },
  { method: "DELETE", path: "/api/issues/:id", class: "closed" },
  { method: "POST", path: "/api/issues/:id/admin/force-release", class: "closed" },
  { method: "GET", path: "/api/issues/:id/feedback-votes", class: "closed" },
  { method: "POST", path: "/api/issues/:id/feedback-votes", class: "closed" },
  { method: "GET", path: "/api/issues/:id/feedback-traces", class: "closed" },
  { method: "GET", path: "/api/feedback-traces/:traceId", class: "closed" },
  { method: "GET", path: "/api/feedback-traces/:traceId/bundle", class: "closed" },

  // C4b-1b (PAR-12731): the comment routes of `routes/issues.ts`. Each `open`
  // handler reads the task through `issue:read` first ("Issue not found").
  // Annotation comments are documents (C4b-2); `resolve-from-comment` is
  // questions (C4d).
  { method: "GET", path: "/api/issues/:id/recent-comments", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/issues/:id/comments", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/issues/:id/comments", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/issues/:id/comments/:commentId", class: "open", test: TREE_TEST },
  { method: "DELETE", path: "/api/issues/:id/comments/:commentId", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/issues/:id/queued-comments", class: "open", test: TREE_TEST },
  // Closed: the queued-comment writes check only the company (edit, reorder,
  // discard) or answer a denied `issue:comment` with 403 (interrupt, steer),
  // which tells R that O's task exists (AC-G3).
  { method: "PATCH", path: "/api/issues/:id/queued-comments/:commentId", class: "closed" },
  { method: "PUT", path: "/api/issues/:id/queued-comments/order", class: "closed" },
  { method: "POST", path: "/api/issues/:id/queued-comments/interrupt", class: "closed" },
  { method: "POST", path: "/api/issues/:id/queued-comments/:commentId/steer", class: "closed" },
  { method: "DELETE", path: "/api/issues/:id/queued-comments/:commentId", class: "closed" },

  // C4b-1b: `routes/projects.ts`. Every `open` handler reads the project
  // through `project:read` (lists through `projectReadSqlCondition`) first;
  // workspace delete then asks `project:write_workspace`, access members the
  // privacy-owner rule (4.4, AC-P3).
  { method: "GET", path: "/api/companies/:companyId/projects", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/external-object-summary", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/access-members", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/projects/:id/access-members", class: "open", test: TREE_TEST },
  { method: "DELETE", path: "/api/projects/:id/access-members/:memberId", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/workspaces", class: "open", test: TREE_TEST },
  { method: "DELETE", path: "/api/projects/:id/workspaces/:workspaceId", class: "open", test: TREE_TEST },
  // Closed until PAR-12933: project create and patch take a workspace
  // `provisionCommand`, `env` with any company `secret_ref` and an
  // `environmentId`; workspace create and patch take a host `cwd`, a
  // `cleanupCommand` and runtime commands. 4.6 denies secrets, `runtime:*`
  // and `environments:manage`; PAR-12933 adds the handler guard and reopens
  // them (creating a project is allowed, 4.5).
  { method: "POST", path: "/api/companies/:companyId/projects", class: "closed" },
  { method: "PATCH", path: "/api/projects/:id", class: "closed" },
  { method: "POST", path: "/api/projects/:id/workspaces", class: "closed" },
  { method: "PATCH", path: "/api/projects/:id/workspaces/:workspaceId", class: "closed" },
  // Closed: repositories and git authorization are the company's tool access
  // (4.6 "tool access"); runtime services need `runtime:*`, which the action
  // list denies; deleting a project, as deleting a task, is the owner's.
  { method: "GET", path: "/api/companies/:companyId/project-repositories", class: "closed" },
  { method: "GET", path: "/api/projects/:id/git-authorization", class: "closed" },
  { method: "PUT", path: "/api/projects/:id/git-authorization", class: "closed" },
  { method: "PUT", path: "/api/projects/:id/repositories", class: "closed" },
  { method: "POST", path: "/api/projects/:id/workspaces/:workspaceId/runtime-services/:action", class: "closed" },
  { method: "POST", path: "/api/projects/:id/workspaces/:workspaceId/runtime-commands/:action", class: "closed" },
  { method: "DELETE", path: "/api/projects/:id", class: "closed" },

  // C4b-1b: `routes/issue-tree-control.ts` (board only). Reading a task's
  // pause state and holds, and previewing a hold, read the root task first.
  // Placing and releasing a hold pause, cancel or wake a whole subtree's runs:
  // an operator tool, closed like the recovery and retry rows above.
  { method: "GET", path: "/api/issues/:id/tree-control/state", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/issues/:id/tree-control/preview", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/issues/:id/tree-holds", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/issues/:id/tree-holds/:holdId", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/issues/:id/tree-holds", class: "closed" },
  { method: "POST", path: "/api/issues/:id/tree-holds/:holdId/release", class: "closed" },

  // C4b-2 (PAR-12732): documents, annotations, work products and attachments
  // of `routes/issues.ts`. Every `open` handler reads the task through
  // `issue:read` first ("Issue not found"); writes do it through
  // `assertAgentIssueMutationAllowed`. Work-product and attachment routes by
  // their own id read the object's task the same way.
  { method: "GET", path: "/api/issues/:id/documents", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/documents/:key", class: "open", test: DOCS_TEST },
  { method: "PUT", path: "/api/issues/:id/documents/:key", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/documents/:key/revisions", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/documents/:key/revisions/:revisionId", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/documents/:key/revisions/:revisionId/restore", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/documents/:key/annotations", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/documents/:key/annotations", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/documents/:key/annotations/:threadId", class: "open", test: DOCS_TEST },
  { method: "PATCH", path: "/api/issues/:id/documents/:key/annotations/:threadId", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/documents/:key/annotations/:threadId/comments", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/work-products", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/work-products", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/work-products/:workProductId/review-document", class: "open", test: DOCS_TEST },
  { method: "PATCH", path: "/api/work-products/:id", class: "open", test: DOCS_TEST },
  { method: "DELETE", path: "/api/work-products/:id", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/issues/:id/attachments", class: "open", test: DOCS_TEST },
  { method: "GET", path: "/api/attachments/:attachmentId/content", class: "open", test: DOCS_TEST },
  { method: "DELETE", path: "/api/attachments/:attachmentId", class: "open", test: DOCS_TEST },
  // Closed: lock, unlock and delete of a document check only the company and
  // that the caller is a board user; they never read the task, so R could
  // lock or delete a document on O's task. Attachment upload answers 403
  // ("Only the conversation owner") on O's chat and 422 for a task of another
  // company before it reads the task (AC-G3). PAR-12940 adds the task read to
  // these four handlers and reopens them.
  { method: "POST", path: "/api/issues/:id/documents/:key/lock", class: "closed" },
  { method: "POST", path: "/api/issues/:id/documents/:key/unlock", class: "closed" },
  { method: "DELETE", path: "/api/issues/:id/documents/:key", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/issues/:issueId/attachments", class: "closed" },

  // C4e-1 (PAR-12733): account, session and company record. His own account
  // (4.6 and 4.6a row 8): every handler reads only `req.actor.userId`'s rows
  // (profile, preferences, board keys) or a CLI challenge by its secret token.
  { method: "GET", path: "/api/auth/get-session", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/auth/profile", class: "open", test: ACCOUNT_TEST },
  { method: "PATCH", path: "/api/auth/profile", class: "open", test: ACCOUNT_TEST },
  { method: "POST", path: "/api/cli-auth/challenges", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/cli-auth/challenges/:id", class: "open", test: ACCOUNT_TEST },
  { method: "POST", path: "/api/cli-auth/challenges/:id/approve", class: "open", test: ACCOUNT_TEST },
  { method: "POST", path: "/api/cli-auth/challenges/:id/cancel", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/cli-auth/me", class: "open", test: ACCOUNT_TEST },
  { method: "POST", path: "/api/cli-auth/revoke-current", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/board-api-keys", class: "open", test: ACCOUNT_TEST },
  { method: "POST", path: "/api/board-api-keys", class: "open", test: ACCOUNT_TEST },
  { method: "DELETE", path: "/api/board-api-keys/:keyId", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/sidebar-preferences/me", class: "open", test: ACCOUNT_TEST },
  { method: "PUT", path: "/api/sidebar-preferences/me", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/companies/:companyId/sidebar-preferences/me", class: "open", test: ACCOUNT_TEST },
  { method: "PUT", path: "/api/companies/:companyId/sidebar-preferences/me", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/workspace-preferences/me", class: "open", test: ACCOUNT_TEST },
  { method: "PUT", path: "/api/companies/:companyId/workspace-preferences/me", class: "open", test: ACCOUNT_TEST },
  // The company record: reduced to id, name, logo and task prefix in a
  // company where his person is restricted under `enforce` (`company-record.ts`).
  // Artifacts are listed through `issueReadSqlCondition` (4.3).
  { method: "GET", path: "/api/companies", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/companies/:companyId", class: "open", test: ACCOUNT_TEST },
  { method: "GET", path: "/api/companies/:companyId/artifacts", class: "open", test: ACCOUNT_TEST },
  // Closed: company-wide numbers and the work timeline (the company activity
  // feed), feedback traces, export and import, and every change to a company
  // (create, settings, branding, archive, delete). `/stats` and `/issues` need
  // their own rows, or the `/:companyId` row would catch them.
  { method: "GET", path: "/api/companies/stats", class: "closed" },
  { method: "GET", path: "/api/companies/issues", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/timeline", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/feedback-traces", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/export", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/export/fidelity", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/exports/preview", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/exports", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/imports/preview", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/imports/apply", class: "closed" },
  { method: "POST", path: "/api/companies/import/preview", class: "closed" },
  { method: "GET", path: "/api/companies/import/jobs/:jobId", class: "closed" },
  { method: "POST", path: "/api/companies/import", class: "closed" },
  { method: "POST", path: "/api/companies/import/transfers", class: "closed" },
  { method: "PUT", path: "/api/companies/import/transfers/:transferId/parts/:partIndex", class: "closed" },
  { method: "GET", path: "/api/companies/import/transfers/:transferId", class: "closed" },
  { method: "POST", path: "/api/companies/import/transfers/:transferId/preview", class: "closed" },
  { method: "POST", path: "/api/companies/import/transfers/:transferId/apply", class: "closed" },
  { method: "POST", path: "/api/companies", class: "closed" },
  { method: "PATCH", path: "/api/companies/:companyId", class: "closed" },
  { method: "PATCH", path: "/api/companies/:companyId/branding", class: "closed" },
  { method: "POST", path: "/api/companies/:companyId/archive", class: "closed" },
  { method: "DELETE", path: "/api/companies/:companyId", class: "closed" },
];

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
