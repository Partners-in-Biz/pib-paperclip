/**
 * Who may do what in SEO (access stage A, spec PAR-12578 sections 4.4 and 4.6; PAR-12676). Keys: action key,
 * `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person needs the permission named here.
 * With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - `seo.work`: sprints, tasks, keywords, content, checks and reports. `create` adds a record, `edit` changes or runs
 *   one, `delete` archives a sprint, `approve` decides what reaches a live site or a client (page applies, previews,
 *   fact sheets, optimizations, playbook changes, experiments).
 * - `seo.settings`: connections (Search Console, Bing, GA4, the linked site), switches, pacing and sign-off mode.
 * - `ADMIN_ONLY`: hiring and linking the SEO agent, the skill sync, and the company preferences (the kit checks
 *   owner or admin there already).
 *
 * The page reaches the 98 dispatch handlers through `seo.call*`: one guarded action per permission, so the guard
 * decides the handler's own permission and not one wide row. `seoCallAction` names the action for a handler; the
 * worker refuses a handler sent through the wrong one. A tool has the permission of its page handler.
 *
 * No entry is `scoped` yet: handlers do not filter by the person's companies until stage B2, so an own-companies
 * grant opens nothing here in stage A.
 *
 * This file is imported by the page (`ui/actions.ts`), so it takes nothing but types from the kit.
 */
import type { AccessTable, AccessTableEntry, ADMIN_ONLY as KIT_ADMIN_ONLY, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ADMIN_ONLY: typeof KIT_ADMIN_ONLY = "ADMIN_ONLY";
const work = (action: PermissionAction): AccessTableEntry => ({ resource: "seo.work", action });
const settings = (action: PermissionAction): AccessTableEntry => ({ resource: "seo.settings", action });
const rows = (entry: AccessTableEntry, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, entry]));

/** Each dispatch handler (agent tool or page-only button) by the permission it needs. */
const HANDLER_ROWS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  ...rows(work("view"), [
    "list-sprints", "get-sprint", "get-switches", "today", "list-tasks", "get-client-facts", "list-previews",
    "list-keywords", "keyword-history", "discover-keywords", "list-backlinks", "list-content",
    "check-robots", "check-sitemap", "check-meta", "page-diff", "page-for-keyword", "check-canonical", "validate-schema",
    "internal-link-audit", "crawler-sim", "check-soft404", "check-thin-content", "check-byline", "run-pagespeed",
    "gsc-query", "gsc-inspect-url", "get-site-link", "check-change-scope", "needs-you", "setup-checklist",
    "audit-summary", "list-ai-mentions", "list-ga4-summary", "list-optimizations", "get-playbook",
  ]),
  ...rows(work("create"), [
    "create-sprint", "add-task", "split-task", "request-build", "create-preview", "draft-progress-report",
    "propose-client-facts", "add-keywords", "record-position", "add-backlink", "add-content", "needs-you-add",
    "record-finding", "record-ai-mentions", "propose-playbook-change", "add-redesign",
  ]),
  ...rows(work("edit"), [
    "update-sprint", "change-plan", "pause-sprint", "resume-sprint", "post-digest", "start-task", "attach-task-issue", "complete-task",
    "block-task", "compact-task-thread", "skip-task", "start-tasks-now", "review-preview", "cancel-previews",
    "update-keyword", "retire-keyword", "update-backlink", "update-content", "link-social-post", "gsc-pull",
    "gsc-submit-sitemap", "request-indexing", "bing-submit", "needs-you-resolve", "needs-you-give", "run-audit-snapshot",
    "resolve-finding", "geo-audit", "detect-signals",
  ]),
  "archive-sprint": work("delete"),
  ...rows(work("approve"), [
    "approve-page-apply", "revoke-page-apply", "confirm-client-facts", "set-client-facts", "approve-optimization",
    "reject-optimization", "decide-playbook-change", "approve-site-writes", "decide-preview", "undo-preview-decision",
    "confirm-preview-approval",
  ]),
  ...rows(settings("view"), ["gsc-properties", "gsc-check-access", "gsc-verification-token", "indexnow-key", "list-site-projects"]),
  ...rows(settings("edit"), [
    "gsc-connect-url", "gsc-verify-site", "gsc-set-property", "bing-add-site", "bing-verify-site", "link-site",
    "connect-ga4", "set-autopilot", "set-switch", "set-pacing", "set-signoff-mode", "set-release-through",
  ]),
});

/** The page's call actions, one per permission a handler can need. `seo.call` keeps today's key for reads. */
export const SEO_CALL_ACTIONS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  "seo.call": work("view"),
  "seo.call-create": work("create"),
  "seo.call-edit": work("edit"),
  "seo.call-delete": work("delete"),
  "seo.call-approve": work("approve"),
  "seo.call-settings-view": settings("view"),
  "seo.call-settings": settings("edit"),
});

const sameEntry = (a: AccessTableEntry, b: AccessTableEntry) =>
  typeof a === "object" && typeof b === "object" && "resource" in a && "resource" in b ? a.resource === b.resource && a.action === b.action : a === b;

/** The `seo.call*` action that carries a dispatch handler, or null for a name with no row. */
export function seoCallAction(handler: string): string | null {
  const entry = Object.hasOwn(HANDLER_ROWS, handler) ? HANDLER_ROWS[handler] : undefined;
  if (!entry) return null;
  return Object.entries(SEO_CALL_ACTIONS).find(([, e]) => sameEntry(e, entry))?.[0] ?? null;
}

/** The dispatch handlers that are also agent tools, plus the kit Growth tools; `tool:<name>` rows are built from them. */
const KIT_GROWTH_TOOLS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  "performance-review": work("view"),
  "list-experiments": work("view"),
  "propose-experiment": work("create"),
  "approve-experiment": work("approve"),
  "reject-experiment": work("approve"),
});

/** Handlers the page reaches but no agent tool has (`dispatch.ts` UI_ONLY_HANDLERS). */
export const PAGE_ONLY_HANDLERS = Object.freeze([
  "approve-site-writes", "add-redesign", "set-client-facts", "set-switch", "set-pacing", "set-signoff-mode",
  "set-release-through", "needs-you-give", "decide-preview", "undo-preview-decision", "confirm-preview-approval",
]);

const TOOL_ROWS = Object.fromEntries(
  Object.entries({ ...HANDLER_ROWS, ...KIT_GROWTH_TOOLS })
    .filter(([name]) => !PAGE_ONLY_HANDLERS.includes(name))
    .map(([name, entry]) => [`tool:${name}`, entry]),
);

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  ...rows(work("view"), ["seo.load", "seo.clients", "seo.sprint", "seo.routine-report", "seo.growth-experiments"]),
  ...SEO_CALL_ACTIONS,
  "seo.create-sprint": work("create"),
  ...rows(work("edit"), ["seo.upgrade-legacy", "seo.run-daily", "seo.run-weekly", "seo.growth-abandon-experiment"]),
  ...rows(work("approve"), ["seo.growth-approve-experiment", "seo.growth-reject-experiment"]),
  ...rows(settings("edit"), ["seo.gsc-start", "seo.gsc-disconnect", "seo.integration"]),
  ...rows(ADMIN_ONLY, [
    "seo.preferences-load", "seo.preferences-save", "seo.hire-options", "seo.start-hire", "seo.link-agent",
    "seo.unlink-agent", "seo.activate-agent", "seo.sync-skills",
  ]),

  // ── agent tools: the same permission as the page handler ──
  ...TOOL_ROWS,

  // ── API routes ──
  ...rows(settings("edit"), ["api:oauth-start", "api:oauth-complete"]),
  "api:client-summary": work("view"),
  "api:setup-status": settings("view"),
  "api:cockpit": work("view"),
});
