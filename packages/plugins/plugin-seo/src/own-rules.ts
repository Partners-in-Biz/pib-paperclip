/**
 * Which SEO keys a person limited to his own companies may reach (stage B2-4, PAR-15211), by how a call names its
 * records. Data only: the access table marks these keys `scoped` and `own-scope.ts` enforces each rule, so the two
 * cannot drift (`tests/own-scope.pg.spec.ts`). Imported by the page through the access table, so it imports nothing.
 *
 * - `record`: the call names at least one record (a sprint, or a child: task, preview, keyword, ...).
 * - `client`: the call names one of his clients.
 * - `either`: a record or a client.
 * - `load` / `sprint`: the page load and the sprint page.
 * - `call`: a `seo.call*` page action; the rule of the handler it carries.
 */
export type HandlerRule = "record" | "client" | "either";
export type OwnRule = HandlerRule | "load" | "sprint" | "call";

/** Each dispatch handler (or kit Growth tool) a limited person may reach, by how its records are named. */
export const HANDLER_RULES: Readonly<Record<string, HandlerRule>> = Object.freeze({
  ...Object.fromEntries(
    [
      // Reads
      "get-sprint", "list-tasks", "get-client-facts", "list-previews", "list-keywords", "keyword-history",
      "discover-keywords", "list-backlinks", "list-content", "check-robots", "check-sitemap", "check-meta", "page-diff",
      "page-for-keyword", "check-canonical", "validate-schema", "internal-link-audit", "crawler-sim", "check-soft404",
      "check-thin-content", "check-byline", "run-pagespeed", "gsc-query", "gsc-inspect-url", "get-site-link",
      "check-change-scope", "needs-you", "setup-checklist", "audit-summary", "list-ai-mentions", "list-ga4-summary",
      "list-optimizations",
      // Writes on a sprint or one of its records
      "add-task", "split-task", "request-build", "create-preview", "draft-progress-report", "propose-client-facts",
      "add-keywords", "record-position", "add-backlink", "add-content", "needs-you-add", "record-finding",
      "record-ai-mentions", "propose-playbook-change", "add-redesign", "update-sprint", "change-plan", "pause-sprint",
      "resume-sprint", "post-digest", "start-task", "complete-task", "block-task", "skip-task", "start-tasks-now",
      "review-preview", "set-rehearsal-preview", "cancel-previews", "update-keyword", "retire-keyword", "update-backlink",
      "update-content", "link-social-post", "gsc-pull", "gsc-submit-sitemap", "request-indexing", "bing-submit",
      "needs-you-resolve", "needs-you-give", "run-audit-snapshot", "resolve-finding", "geo-audit", "detect-signals",
      "archive-sprint", "approve-page-apply", "revoke-page-apply", "confirm-client-facts", "set-client-facts",
      "approve-optimization", "reject-optimization", "decide-playbook-change", "approve-site-writes", "decide-preview",
      "undo-preview-decision", "confirm-preview-approval",
      // Kit Growth tools: an experiment by id
      "approve-experiment", "reject-experiment",
    ].map((name) => [name, "record" as const]),
  ),
  "list-sprints": "client",
  "create-sprint": "client",
  "propose-experiment": "client",
  "performance-review": "client",
  "list-experiments": "client",
  today: "either",
  "get-switches": "either",
  "get-playbook": "either",
});

/** Page actions and API routes open to him; every agent tool of a handler above is open to him too. */
export const PAGE_RULES: Readonly<Record<string, OwnRule>> = Object.freeze({
  "seo.load": "load",
  "seo.sprint": "sprint",
  "seo.create-sprint": "client",
  "seo.run-daily": "record",
  "seo.run-weekly": "record",
  "seo.growth-experiments": "record",
  "seo.growth-approve-experiment": "record",
  "seo.growth-reject-experiment": "record",
  "seo.growth-abandon-experiment": "record",
  ...Object.fromEntries(["seo.call", "seo.call-create", "seo.call-edit", "seo.call-delete", "seo.call-approve"].map((key) => [key, "call" as const])),
  "api:client-summary": "client",
});
