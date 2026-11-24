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
  /**
   * Path of another row with the same method that also catches this row's
   * requests (`/api/agents/me` shadows `/api/agents/:id`). The scan proves the
   * router registers this row's route first, in the same file.
   */
  shadows?: string;
}

const QUESTIONS_TEST = "server/src/__tests__/member-restriction-route-table-questions.test.ts";
const TASKS_TEST = "server/src/__tests__/member-restriction-route-table-tasks.test.ts";
const TREE_TEST = "server/src/__tests__/member-restriction-route-table-comments-projects.test.ts";
const PROJECT_BODY_TEST = "server/src/__tests__/member-restriction-project-body-allowlist.test.ts";
const INBOX_TEST = "server/src/__tests__/member-restriction-route-table-inbox-search.test.ts";
const DOCS_TEST = "server/src/__tests__/member-restriction-route-table-documents.test.ts";
const ACCOUNT_TEST = "server/src/__tests__/member-restriction-route-table-account.test.ts";
const WORKSPACES_TEST = "server/src/__tests__/member-restriction-route-table-workspaces-assets.test.ts";
const APPROVALS_TEST = "server/src/__tests__/member-restriction-route-table-approvals.test.ts";
const AGENTS_TEST = "server/src/__tests__/member-restriction-route-table-agents.test.ts";
const TASK_LIST_TEST = "server/src/__tests__/member-restriction-task-list-callers.test.ts";
const INSTANCE_TEST = "server/src/__tests__/member-restriction-route-table-instance.test.ts";
const AGENT_PAGES_TEST = "server/src/__tests__/member-restriction-route-table-agent-pages.test.ts";
const PLANNING_CANVAS_TEST = "server/src/__tests__/planning-canvas-access-routes.test.ts";
const TASK_HISTORY_TEST = "server/src/__tests__/member-restriction-route-table-task-history.test.ts";

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
  // PAR-12929: a caller the restriction binds reads the task through
  // `issue:read` first; under `enforce` then the check of `PATCH .../:id`.
  { method: "PUT", path: "/api/issues/:id/title", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/external-objects", class: "open", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/external-object-summary", class: "open", test: TASKS_TEST },
  // An agent's own work on a task.
  { method: "GET", path: "/api/issues/:id/heartbeat-context", class: "run", test: TASKS_TEST },
  { method: "GET", path: "/api/issues/:id/runner-goal", class: "run", test: TASKS_TEST },
  { method: "POST", path: "/api/issues/:id/checkout", class: "run", test: TASKS_TEST },
  { method: "POST", path: "/api/issues/:id/release", class: "run", test: TASKS_TEST },
  // PAR-14342: the history of a task he can read (4.6 "task activity"). The
  // two run lists hold only the runs that work for him (4.6 "One run's
  // detail", AC-G5); company-wide run lists stay closed.
  { method: "GET", path: "/api/issues/:id/activity", class: "open", test: TASK_HISTORY_TEST },
  { method: "GET", path: "/api/issues/:id/runs", class: "open", test: TASK_HISTORY_TEST },
  { method: "GET", path: "/api/issues/:issueId/live-runs", class: "open", test: TASK_HISTORY_TEST },
  // Closed on purpose (PAR-14342): the session context reading and compaction
  // (agent runtime state), task browsers (browser tools) and the email thread
  // (email) are out of scope for him (section 2); the task page skips them.
  { method: "GET", path: "/api/issues/:id/context-usage", class: "closed" },
  { method: "GET", path: "/api/issues/:issueId/browsers", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/email/tasks/:issueId", class: "closed" },
  // Closed on purpose: company set-up (labels), operator tools (recovery,
  // diagnostics, watchdog, monitors, retries, review decisions, low-trust
  // promotions, plan decompositions), sharing (grants, privacy constraints),
  // deleting a task, and feedback traces. Several of these handlers check
  // only the company, not the task.
  { method: "GET", path: "/api/issues", class: "closed" },
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
  // access members then ask the privacy-owner rule (4.4, AC-P3).
  { method: "GET", path: "/api/companies/:companyId/projects", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/external-object-summary", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/access-members", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/projects/:id/access-members", class: "open", test: TREE_TEST },
  { method: "DELETE", path: "/api/projects/:id/access-members/:memberId", class: "open", test: TREE_TEST },
  { method: "GET", path: "/api/projects/:id/workspaces", class: "open", test: TREE_TEST },
  // PAR-12934 (C4i-a): create and patch run the body allowlist of
  // `body-allowlist.ts` first (4.5, 4.6): a bound caller sends no `env`,
  // execution workspace policy, workspace, lead agent or repository; patch
  // reads the project through `project:read` before it.
  { method: "POST", path: "/api/companies/:companyId/projects", class: "open", test: PROJECT_BODY_TEST },
  { method: "PATCH", path: "/api/projects/:id", class: "open", test: PROJECT_BODY_TEST },
  // Closed: a project workspace is a host `cwd`, a repository, commands and a
  // plugin; every field but `name`, `visibility` and `isPrimary` is host
  // configuration, so an allowlist would leave nothing to create (4.6), and
  // deleting one removes O's configuration.
  { method: "POST", path: "/api/projects/:id/workspaces", class: "closed" },
  { method: "PATCH", path: "/api/projects/:id/workspaces/:workspaceId", class: "closed" },
  { method: "DELETE", path: "/api/projects/:id/workspaces/:workspaceId", class: "closed" },
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
  // pause state reads the root task first. Placing and releasing a hold
  // pause, cancel or wake a whole subtree's runs: an operator tool, closed
  // like the recovery and retry rows above. The preview and the hold reads
  // return the active runs and affected agents under the root without the
  // run rule of AC-G5 or the agent list of 4.7: closed (PAR-12938).
  { method: "GET", path: "/api/issues/:id/tree-control/state", class: "open", test: TREE_TEST },
  { method: "POST", path: "/api/issues/:id/tree-control/preview", class: "closed" },
  { method: "GET", path: "/api/issues/:id/tree-holds", class: "closed" },
  { method: "GET", path: "/api/issues/:id/tree-holds/:holdId", class: "closed" },
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
  // C4j-2 (PAR-12943): lock, unlock and delete of a document read the task
  // through `issue:read` before the board-only 403 (PAR-12942). Upload checks
  // the path company first (403), then answers "Issue not found" for a task of
  // another company or one he cannot read, before the chat checks. Upload is
  // his only way to attach a file to his own task (spec section 9).
  { method: "POST", path: "/api/issues/:id/documents/:key/lock", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/issues/:id/documents/:key/unlock", class: "open", test: DOCS_TEST },
  { method: "DELETE", path: "/api/issues/:id/documents/:key", class: "open", test: DOCS_TEST },
  { method: "POST", path: "/api/companies/:companyId/issues/:issueId/attachments", class: "open", test: DOCS_TEST },

  // C4d-2 (PAR-13025): questions and confirmations on a task (4.6, S11): he
  // reads, answers, skips and dismisses those on a task he can read. Every
  // handler reads the task through `issue:read` first ("Issue not found"),
  // agents included; the answer routes do it in
  // `getIssueThreadInteractionResolutionAuthorization`. The run an answer
  // starts is held to invariant A by the wake queue (4.7). Pending questions
  // is board-only and the conversation owner's. `resolve-from-comment` records
  // a person's reply for the agent run that read it: a run only. Excluded:
  // a tool review or a secret proposal (payload `toolAction` or
  // `secretProposal`). Under `enforce` no resolving route decides one for
  // him (403 `MEMBER_RESTRICTED_GOVERNED_ACTION`, nothing runs), checked in
  // `assertIssueThreadInteractionResolutionAllowed`; tool access stays closed.
  { method: "GET", path: "/api/issues/:id/pending-questions", class: "open", test: QUESTIONS_TEST },
  { method: "GET", path: "/api/issues/:id/interactions", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/accept", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/reject", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/respond", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/verdicts", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/withdraw", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/dismiss", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/skip", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/cancel", class: "open", test: QUESTIONS_TEST },
  { method: "POST", path: "/api/issues/:id/interactions/:interactionId/resolve-from-comment", class: "run", test: QUESTIONS_TEST },

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

  // C4d-3 (PAR-13026): inbox, search, sidebar counts and inbox dismissals
  // (4.6: results only through 4.3). The inbox and both searches take the read
  // conditions; read state and inbox archive read the task first ("Issue not
  // found"); the sidebar counts use the conditions of their lists, and the
  // join-request count is 0 for him (AC-G7). Dismissals are his own rows.
  { method: "GET", path: "/api/companies/:companyId/inbox/mine", class: "open", test: INBOX_TEST },
  { method: "POST", path: "/api/issues/:id/read", class: "open", test: INBOX_TEST },
  { method: "DELETE", path: "/api/issues/:id/read", class: "open", test: INBOX_TEST },
  { method: "POST", path: "/api/issues/:id/inbox-archive", class: "open", test: INBOX_TEST },
  { method: "DELETE", path: "/api/issues/:id/inbox-archive", class: "open", test: INBOX_TEST },
  { method: "GET", path: "/api/companies/:companyId/search", class: "open", test: INBOX_TEST },
  { method: "GET", path: "/api/companies/:companyId/search/extract", class: "open", test: INBOX_TEST },
  { method: "GET", path: "/api/companies/:companyId/sidebar-badges", class: "open", test: INBOX_TEST },
  { method: "GET", path: "/api/companies/:companyId/inbox-dismissals", class: "open", test: INBOX_TEST },
  { method: "POST", path: "/api/companies/:companyId/inbox-dismissals", class: "open", test: INBOX_TEST },
  { method: "DELETE", path: "/api/companies/:companyId/inbox-dismissals/:itemKey", class: "open", test: INBOX_TEST },
  // Closed: the attention feed is the company's decision queue (decisions,
  // join requests, triage and their history across the company); the action
  // list denies the decision-queue actions.
  { method: "GET", path: "/api/companies/:companyId/attention", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/attention/summary", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/attention/tasks", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/attention/history", class: "closed" },

  // C4e-2 (PAR-12734): user directory, assets and execution workspaces. The
  // directory is reduced to id and display name where his person is
  // restricted. An image is filed under `issues/<id>` only for a task he can
  // read; an asset opens only through an object he can read, or as the company
  // logo. One workspace opens only when its source task passes his strict
  // `issue:read` ("not found" otherwise); its host fields are stripped later
  // by C4i-c (PAR-12951). Dashboard, costs, secrets, skills, settings and the
  // plugin config, logs and jobs pages have no row: closed.
  { method: "GET", path: "/api/companies/:companyId/user-directory", class: "open", test: WORKSPACES_TEST },
  { method: "POST", path: "/api/companies/:companyId/assets/images", class: "open", test: WORKSPACES_TEST },
  { method: "GET", path: "/api/assets/:assetId/content", class: "open", test: WORKSPACES_TEST },
  { method: "GET", path: "/api/execution-workspaces/:id", class: "open", test: WORKSPACES_TEST },
  { method: "GET", path: "/api/execution-workspaces/:id/close-readiness", class: "open", test: WORKSPACES_TEST },
  { method: "GET", path: "/api/execution-workspaces/:id/workspace-operations", class: "open", test: WORKSPACES_TEST },
  // Closed: the logo is changing the company; the lists run across the
  // company; the workspace write takes host command configuration, and the
  // runtime controls, branch reconcile and login handoff need `runtime:*`.
  { method: "POST", path: "/api/companies/:companyId/logo", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/execution-workspaces", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/workspace-overview", class: "closed" },
  { method: "PATCH", path: "/api/execution-workspaces/:id", class: "closed" },
  { method: "POST", path: "/api/execution-workspaces/:id/runtime-services/:action", class: "closed" },
  { method: "POST", path: "/api/execution-workspaces/:id/runtime-commands/:action", class: "closed" },
  { method: "POST", path: "/api/execution-workspaces/:id/reconcile-branch", class: "closed" },
  { method: "POST", path: "/api/execution-workspaces/:id/login-handoff", class: "closed" },
  // C4d-1 (PAR-13024): approvals (4.6 and S11: he reads those linked to a
  // task he can read and decides none). Every `/api/approvals/:id` handler
  // runs `router.param("id")` first, which reads the approval through
  // `approvalReadSqlCondition` ("not found"); under `enforce` that condition
  // also drops an approval linked to no task. The list is filtered by it; a
  // task's approvals read the task (`issue:read`) and then filter the same way.
  { method: "GET", path: "/api/companies/:companyId/approvals", class: "open", test: APPROVALS_TEST },
  { method: "GET", path: "/api/approvals/:id", class: "open", test: APPROVALS_TEST },
  { method: "GET", path: "/api/approvals/:id/issues", class: "open", test: APPROVALS_TEST },
  { method: "GET", path: "/api/approvals/:id/comments", class: "open", test: APPROVALS_TEST },
  { method: "GET", path: "/api/issues/:id/approvals", class: "open", test: APPROVALS_TEST },
  // Closed: deciding (it starts agents' runs, S11), creating, linking and
  // unlinking. Commenting is closed too: the 4.6 row says read-only.
  { method: "POST", path: "/api/companies/:companyId/approvals", class: "closed" },
  { method: "POST", path: "/api/approvals/:id/approve", class: "closed" },
  { method: "POST", path: "/api/approvals/:id/reject", class: "closed" },
  { method: "POST", path: "/api/approvals/:id/request-revision", class: "closed" },
  { method: "POST", path: "/api/approvals/:id/resubmit", class: "closed" },
  { method: "POST", path: "/api/approvals/:id/comments", class: "closed" },
  { method: "POST", path: "/api/issues/:id/approvals", class: "closed" },
  { method: "DELETE", path: "/api/issues/:id/approvals/:approvalId", class: "closed" },
  // C4c-1 (PAR-12736): agents, runs, chat and agent keys. The agent list
  // holds only the agents on his list, each with id, name, title, icon and
  // status; any other agent by id is "not found" (AC-G4). One run's detail,
  // log and events open only when the run works for him and its task passes
  // his strict `issue:read` (AC-G5). A chat opens only with an agent on his
  // list; the chat list is his own conversations through 4.3.
  { method: "GET", path: "/api/companies/:companyId/agents", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/agents/:id", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/heartbeat-runs/:runId", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/heartbeat-runs/:runId/events", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/heartbeat-runs/:runId/log", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/companies/:companyId/chats", class: "open", test: AGENTS_TEST },
  { method: "GET", path: "/api/companies/:companyId/chats/:agentRef", class: "open", test: AGENTS_TEST },
  { method: "POST", path: "/api/companies/:companyId/chats/:agentRef", class: "open", test: AGENTS_TEST },
  // C4c-3b (PAR-13135): a run's own identity (six fields for a run working for
  // him, AC-A2), its inbox (blockers he cannot read are counted, not named;
  // another person's inbox is empty) and its chat post (only an agent on his
  // list opens a chat).
  { method: "GET", path: "/api/agents/me", class: "run", test: AGENTS_TEST, shadows: "/api/agents/:id" },
  { method: "GET", path: "/api/agents/me/inbox-lite", class: "run", test: TASK_LIST_TEST },
  { method: "GET", path: "/api/agents/me/inbox/mine", class: "run", test: TASK_LIST_TEST },
  { method: "POST", path: "/api/agents/me/chat/messages", class: "run", test: AGENTS_TEST },
  // Closed (4.6): an agent's secrets and connector credentials; connector tools go through the plugin gate (C5-2).
  { method: "POST", path: "/api/agents/me/secret-proposals", class: "closed" },
  { method: "GET", path: "/api/agents/me/secret-proposals", class: "closed" },
  { method: "DELETE", path: "/api/agents/me/secret-proposals/:id", class: "closed" },
  { method: "GET", path: "/api/agents/me/secrets", class: "closed" },
  { method: "POST", path: "/api/agents/me/secrets/:key/value", class: "closed" },
  { method: "POST", path: "/api/agents/me/connections/:connectionId/start-authorization", class: "closed" },
  { method: "POST", path: "/api/agents/me/connections/:connectionId/token", class: "closed" },
  // Closed: the key routes never call `decide()`, so these rows alone close
  // them (H4); configuration, instructions, pausing, the org chart and the run
  // lists are company set-up or company-wide. Every other agent route has no row.
  { method: "GET", path: "/api/agents/:id/keys", class: "closed" },
  { method: "POST", path: "/api/agents/:id/keys", class: "closed" },
  { method: "DELETE", path: "/api/agents/:id/keys/:keyId", class: "closed" },
  { method: "GET", path: "/api/agents/:id/configuration", class: "closed" },
  { method: "GET", path: "/api/agents/:id/instructions-bundle", class: "closed" },
  { method: "POST", path: "/api/agents/:id/pause", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/org", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/heartbeat-runs", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/live-runs", class: "closed" },
  // C4g-4 (PAR-13473, decision PAR-13469 section 3): the agent pages. The avatar
  // artwork is preset art; the handler looks up no agent and no company. Closed
  // on purpose: built-in agents, budgets and AI connections are company set-up;
  // the resource-membership writes save a star or join on an id with no read
  // check (the answer would tell him whether a project exists), and a read-only
  // star list has no use.
  { method: "GET", path: "/api/agent-avatars/:version/:palette/:file", class: "open", test: AGENT_PAGES_TEST },
  { method: "GET", path: "/api/companies/:companyId/built-in-agents", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/budgets/overview", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/ai-connections", class: "closed" },
  { method: "GET", path: "/api/companies/:companyId/resource-memberships/me", class: "closed" },
  { method: "PUT", path: "/api/companies/:companyId/resource-memberships/me/projects/:projectId", class: "closed" },
  { method: "PUT", path: "/api/companies/:companyId/resource-memberships/me/agents/:agentId", class: "closed" },
  { method: "PUT", path: "/api/companies/:companyId/resource-memberships/me/documents/:documentId", class: "closed" },

  // C4g-3 (PAR-13263, decision PAR-13261 sections 1 to 3): what the app shell
  // reads on every page. For R at `enforce` health answers the anonymous body
  // and the general settings only `{ censorUsernameInLogs }`; a primary agent
  // off his list is null on read and "Agent not found" on write. The dev-server
  // restart, the full settings, every settings write, the lifecycle and task
  // drain routes have no row.
  { method: "GET", path: "/api/health", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/instance/settings/experimental", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/instance/settings/general", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/announcements/current", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/announcements/:id/image", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/announcements/:id/animation", class: "open", test: INSTANCE_TEST },
  { method: "POST", path: "/api/announcements/:id/dismiss", class: "open", test: INSTANCE_TEST },
  { method: "GET", path: "/api/companies/:companyId/primary-agent/me", class: "open", test: INSTANCE_TEST },
  { method: "PUT", path: "/api/companies/:companyId/primary-agent/me", class: "open", test: INSTANCE_TEST },

  // C5-1 (PAR-12740): the plugin call points of `routes/plugins.ts` (C13). Each
  // handler calls `assertPluginOpenForPerson` before the worker is called: a
  // plugin not on his list is 403 `MEMBER_RESTRICTED` (4.8). The API mount also
  // carries the plugin socket, whose upgrade is replayed through it (4.6a row 16).
  { method: "POST", path: "/api/plugins/:pluginId/bridge/data", class: "plugin" },
  { method: "POST", path: "/api/plugins/:pluginId/bridge/action", class: "plugin" },
  { method: "POST", path: "/api/plugins/:pluginId/data/:key", class: "plugin" },
  { method: "POST", path: "/api/plugins/:pluginId/actions/:key", class: "plugin" },
  { method: "GET", path: "/api/plugins/:pluginId/bridge/stream/:channel", class: "plugin" },
  { method: "USE", path: "/api/plugins/:pluginId/api", class: "plugin" },
  // C5-3 (PAR-12742): the Apps menu. The handler keeps only his open plugins
  // (`filterPluginsOpenForPerson`); without that filter this row would hand him
  // every plugin (PAR-13261).
  { method: "GET", path: "/api/plugins/ui-contributions", class: "plugin", test: "server/src/__tests__/member-restriction-ui-contributions.test.ts" },
  // PAR-13932 (Planning Canvas C3): every board route asks the canvas access
  // resolver (`services/planning-canvas-access.ts`), which gives a restricted
  // person his own personal boards and a project board he passes
  // `project:read` on, and nothing else (plan PAR-13925 section D).
  ...([
    ["GET", "/api/companies/:companyId/planning-canvases"],
    ["POST", "/api/companies/:companyId/planning-canvases"],
    ["GET", "/api/companies/:companyId/planning-canvases/:boardId"],
    ["PATCH", "/api/companies/:companyId/planning-canvases/:boardId"],
    ["DELETE", "/api/companies/:companyId/planning-canvases/:boardId"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/ops"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/import"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/archive"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/restore"],
    ["PATCH", "/api/companies/:companyId/planning-canvases/:boardId/sharing"],
    ["GET", "/api/companies/:companyId/planning-canvases/:boardId/agent-grants"],
    ["DELETE", "/api/companies/:companyId/planning-canvases/:boardId/agent-grants/:grantId"],
    // PAR-13935 (C6): comments. A mention also runs `restrictedTaskBody(..., "createIssue")` on the issue it would create.
    ["GET", "/api/companies/:companyId/planning-canvases/:boardId/comments"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/comments"],
    ["PATCH", "/api/companies/:companyId/planning-canvases/:boardId/comments/:commentId"],
    ["DELETE", "/api/companies/:companyId/planning-canvases/:boardId/comments/:commentId"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/comments/:commentId/resolve"],
    // PAR-13937 (C8): refs and query read only what the caller may read; a handoff runs `restrictedTaskBody(..., "createIssue")` per issue.
    ["GET", "/api/companies/:companyId/planning-canvases/:boardId/refs"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/query"],
    ["POST", "/api/companies/:companyId/planning-canvases/:boardId/handoff"],
    // PAR-13941 (C14): blueprint apply creates a personal board; each issue it makes runs `restrictedTaskBody(..., "createIssue")`.
    ["POST", "/api/companies/:companyId/planning-canvases/from-blueprint"],
  ] as const).map(([method, path]) => ({ method, path, class: "open" as const, test: PLANNING_CANVAS_TEST })),
];

/**
 * Routes under `/api/plugins/:pluginId/` that do not call the plugin gate, by
 * design (4.8). The scan fails the build when any other route there lacks the
 * call (AC-K7). Webhooks and jobs run with no person (P11); the set-up pages
 * (detail, lifecycle, health, logs, config, jobs, local folders, dashboard)
 * have no route-table row, so they are closed for him (4.6, correction 4).
 */
export const PLUGIN_GATE_NOT_GATED: ReadonlyArray<{ method: MemberRestrictionRouteMethod; path: string; reason: string }> = [
  { method: "POST", path: "/api/plugins/:pluginId/webhooks/:endpointKey", reason: "webhook: no person calls it" },
  ...([
    ["GET", ""], ["DELETE", ""], ["POST", "/enable"], ["POST", "/disable"], ["GET", "/health"], ["GET", "/logs"],
    ["POST", "/upgrade"], ["GET", "/config"], ["POST", "/config"], ["POST", "/config/test"], ["GET", "/jobs"],
    ["GET", "/jobs/:jobId/runs"], ["POST", "/jobs/:jobId/trigger"], ["GET", "/dashboard"],
    ["GET", "/companies/:companyId/local-folders"], ["GET", "/companies/:companyId/local-folders/:folderKey/status"],
    ["POST", "/companies/:companyId/local-folders/:folderKey/validate"], ["PUT", "/companies/:companyId/local-folders/:folderKey"],
  ] as const).map(([method, suffix]) => ({ method, path: `/api/plugins/:pluginId${suffix}`, reason: "set-up page: closed (4.6)" })),
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
 *
 * `shadows` tells the table that order: after the `closed` check, a hit whose
 * path another hit of the same method names in `shadows` is dropped, so
 * `/api/agents/me` (shadowing `/api/agents/:id`) answers with its own class.
 * A `closed` shadowed row still wins. The scan proves each `shadows` against
 * the routers (same method, the shadowed row catches the path, same file and
 * registered earlier).
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
          else {
            const kept = hits.filter((hit) => !hits.some((other) => other !== hit
              && other.entry.method === hit.entry.method && other.entry.shadows === hit.entry.path));
            // Two rows naming each other leave nothing: refuse (the scan fails on it).
            if (kept.length === 0 || kept.some((hit) => hit.entry.class !== kept[0]!.entry.class)) resolve({ kind: "refused", reason: "ambiguous" });
            else resolve({ kind: "matched", ...kept[0]! });
          }
        });
    });
  };
}

/**
 * The mount table of PAR-12608 section 4.6a: every registration on the Express
 * app in `app.ts` and every socket upgrade handler (an `upgrade` listener),
 * none of which the `/api` middleware of 4.6 sees. Default for a caller bound
 * by R: refused. The scan in `__tests__/member-restriction-mount-table.test.ts`
 * fails the build when a registration or upgrade handler has no row, a row
 * names one that no longer exists, or a "to prove" row names neither a test
 * nor the ticket that proves it.
 */
export interface MemberRestrictionMountEntry {
  /** Row of 4.6a; `null` for middleware that answers no request with data of its own, and for the `/api` router (4.6). */
  row: number | null;
  /**
   * The registrations as the scan reads them: for `app.ts` the method and the
   * leading name of each argument (`USE "/api/ready" readinessRoutes`,
   * `GET "/api/x" <inline>`); for a socket, `UPGRADE <file under server/src>`,
   * once per upgrade listener in that file.
   */
  mounts: readonly string[];
  /** The rule for R (the restricted person), in short. */
  rule: string;
  /** A "to prove" row: the test that proves it (it names `4.6a row <n>`), or the ticket that will. */
  toProve?: string;
  /**
   * Row 5: every route of the mounted routers, classified (4.6a: `run` or `closed`).
   * A `closed` route names the ticket or test that closes it for a run of a restricted person.
   */
  routes?: ReadonlyArray<{ method: string; path: string; class: "run" | "closed"; toProve?: string }>;
}

const MOUNT_TEST = "server/src/__tests__/member-restriction-mount-rows.test.ts";

export const MEMBER_RESTRICTION_MOUNT_TABLE: readonly MemberRestrictionMountEntry[] = [
  { row: null, rule: "middleware: request accounting, body parsing, logging, host and Cloud guards; the actor is resolved here",
    mounts: ["USE databaseOperationMiddleware", "USE idleAdmissionMiddleware", "USE COMPANY_IMPORT_API_PATH express.json",
      "USE \"/api/chat-webhooks\" createChatWebhookDiagnostics chatWebhookBodyParser",
      "USE \"/api/plugins/:pluginId/webhooks/:endpointKey\" pluginWebhookBodyParser", "USE dotPrincipalHttp.bodyParser",
      "USE <inline>", "USE \"/api\" apiCompression", "USE httpLogger", "USE privateHostnameGuard",
      "USE cloudRuntimeIdentityMiddleware", "USE cloudWarmStandbyMiddleware", "USE actorMiddleware",
      "USE cloudControlMiddleware", "USE skillAccessRequestContext", "USE errorHandler"] },
  { row: null, rule: "the `/api` router and its 404: the route table of 4.6", mounts: ["USE \"/api\" api", "USE \"/api\" <inline>"] },
  { row: 1, rule: "not bound: no company data", mounts: ["USE \"/api/liveness\" livenessRoutes", "USE \"/api/ready\" readinessRoutes"] },
  { row: 2, rule: "refused: only a managed-run bearer or a Cloud inspection permit, never a member's session or key",
    mounts: ["USE \"/api/customer-success/v1\" customerSuccessRoutes"], toProve: MOUNT_TEST },
  { row: 3, rule: "as row 4: an agent-purpose assistant connection", mounts: ["USE museTransportRoutes"] },
  { row: 4, rule: "every call resolves its actor in `actorForGrant` (C4f)",
    mounts: ["USE publicMcpIngress", "publicMcpIngress.USE dotPrincipalHttp.router", "publicMcpIngress.USE transfers.router",
      "publicMcpIngress.USE grokTransfers.router", "publicMcpIngress.USE publicMcpIngressRoutes",
      "publicMcpIngress.USE publicMcpIngressRoutes"] },
  { row: 5, rule: "a run's own run-bound token only; connection search and request and the MCP tools end in the dispatcher (4.8) " +
      "and the connector builder (4.9); the GitHub credentials route hands the run a company credential, so it is closed for a run " +
      "whose person is restricted (4.9, decision 4; PAR-13220)",
    mounts: ["USE runtimeConnectionIntentRoutes", "USE nativeRunMcpRoutes"], toProve: MOUNT_TEST,
    routes: [
      { method: "POST", path: "/runtime-tools/github/credentials", class: "closed", toProve: "PAR-13220" },
      { method: "GET", path: "/mcp/runtime-tools", class: "run" },
      { method: "POST", path: "/mcp/runtime-tools", class: "run" },
      { method: "POST", path: "/runtime-tools/connections/search", class: "run" },
      { method: "POST", path: "/runtime-tools/connections/request", class: "run" },
      { method: "ALL", path: "/mcp/native-runs/:runId", class: "run" },
    ] },
  { row: 6, rule: "an inbound call mapped to him is refused", mounts: ["USE voiceWebhookRoutes"], toProve: "PAR-13206" },
  { row: 7, rule: "no person; the run it starts is held to invariant A (4.7)", mounts: ["USE connectionEventWakeRoutes"] },
  { row: 8, rule: "open: sign-in, sign-out, own profile", mounts: ["USE \"/api/auth\" authRoutes", "ALL \"/api/auth/{*authPath}\" opts.betterAuthHandler"] },
  { row: 9, rule: "open: agent documentation with no company data", mounts: ["USE llmRoutes"], toProve: MOUNT_TEST },
  { row: 10, rule: "a mail mapped to him becomes no comment, task or wake", mounts: ["USE emailWebhookRoutes"], toProve: "PAR-13206" },
  { row: 11, rule: "a message from his linked identity is refused", mounts: ["USE chatWebhookRoutes"], toProve: "PAR-13206" },
  { row: 12, rule: "refused: finishing a GitHub set-up is `connections:configure`, which the action list denies",
    mounts: ["GET \"/api/chat-github/manifest/callback\" <inline>", "GET \"/api/chat-github/cloud/callback\" <inline>",
      "GET \"/api/chat-github/identity/callback\" <inline>"], toProve: MOUNT_TEST },
  { row: 13, rule: "connector tools refused (4.9), plugin tools through the dispatcher (4.8)", mounts: ["USE mcpGatewayProtocolRoutes"] },
  { row: 14, rule: "not gated: plugin code, no data (4.8)", mounts: ["USE pluginUiStaticRoutes"] },
  { row: 15, rule: "not bound: the screen's static files",
    mounts: ["USE staticUi", "staticUi.USE staticUiCompression", "staticUi.USE \"/assets\" staticUiFiles",
      "staticUi.USE \"/assets\" retained.serve", "staticUi.GET <expression> <inline>", "staticUi.USE staticUiFiles",
      "staticUi.USE staticUiFiles", "staticUi.GET /.*/ <inline>", "staticUi.GET /.*/ <inline>", "staticUi.USE vite.middlewares"] },
  // The second listener is the proxied connection's own upgrade to the plugin worker, inside the gated handler.
  { row: 16, rule: "the plugin gate at upgrade (4.8, C5-1)",
    mounts: ["UPGRADE realtime/plugin-api-ws.ts", "UPGRADE realtime/plugin-api-ws.ts"],
    toProve: "server/src/__tests__/member-restriction-plugin-gate.test.ts" },
  { row: 17, rule: "per event at delivery: task and project events through `decide()`, run events through the run rule",
    mounts: ["UPGRADE realtime/live-events-ws.ts"] },
  { row: 18, rule: "refused: the socket takes no session, only a token minted by " +
      "`POST /api/environment-custom-image-setup-sessions/:sessionId/terminal-session-token`, which needs an instance admin " +
      "(`assertCanAccessInstanceEnvironments`); R never binds one", mounts: ["UPGRADE realtime/environment-custom-image-terminal-ws.ts"] },
  { row: 19, rule: "not a person's entry: a registered run's own authority", mounts: ["UPGRADE realtime/runner-prp-ws.ts"], toProve: MOUNT_TEST },
];
