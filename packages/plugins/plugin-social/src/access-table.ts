/**
 * Who may do what in Social (access stage A, spec PAR-12578 sections 4.4 and 4.7; PAR-12677).
 * Keys: action key, `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person
 * needs the permission named here. With the company switch `off` (the default) nothing is checked.
 *
 * - `social.posts`: posts, media, templates, the inbox, analytics and reports (the catalog has no
 *   separate Social reports resource), the Growth Lab's work. `approve` is anything that goes out
 *   or signs off: approving, scheduling and re-publishing a post, replying in the inbox, a review
 *   verdict, deciding an experiment.
 * - `social.accounts`: connected accounts, the connect flow, manual accounts.
 * - `social.settings`: who approves, RSS feeds, the growth programme, playbook and focus, cadence,
 *   the weekly routine's report.
 * - `ADMIN_ONLY`: hiring and linking the Social agent, the skill sync, company preferences (the kit
 *   already refuses everyone else there), and re-announcing the whole media library to Studio.
 *
 * My Social (`my-social.*`) uses the same resources: it is Social use in this company, so a limited
 * person needs a grant for it like for the company page. No entry is `scoped` yet: handlers do not
 * filter by the person's companies until stage B2, so an own-companies grant opens nothing here.
 */
import { ADMIN_ONLY, COCKPIT_ROUTE, SETUP_STATUS_ROUTE, type AccessTable, type PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

type Action = PermissionEntry["action"];
const posts = (action: Action): PermissionEntry => ({ resource: "social.posts", action });
const accounts = (action: Action): PermissionEntry => ({ resource: "social.accounts", action });
const settings = (action: Action): PermissionEntry => ({ resource: "social.settings", action });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions: posts ──
  "social.load": posts("view"),
  "social.clients": posts("view"),
  "social.get-post": posts("view"),
  "social.validate-post": posts("view"),
  "social.change-notes": posts("view"),
  "social.approval-status": posts("view"),
  "social.review-outcomes": posts("view"),
  "social.list-templates": posts("view"),
  "social.post-analytics": posts("view"),
  "social.growth-load": posts("view"),
  "social.get-cadence": posts("view"),
  "social.create-post": posts("create"),
  "social.create-template": posts("create"),
  "social.media-presign": posts("create"),
  "social.create-media-asset": posts("create"),
  "social.import-media": posts("create"),
  "social.request-inbox-draft": posts("create"),
  "social.hook-give-prepare": posts("create"),
  "social.update-post": posts("edit"),
  "social.attach": posts("edit"),
  "social.detach": posts("edit"),
  "social.review": posts("edit"),
  "social.back-to-draft": posts("edit"),
  "social.request-client-approval": posts("edit"),
  "social.unschedule": posts("edit"),
  "social.mark-posted": posts("edit"),
  "social.mark-destination-posted": posts("edit"),
  "social.skip-destination": posts("edit"),
  "social.mark-inbox-read": posts("edit"),
  "social.mark-inbox-replied": posts("edit"),
  "social.correct-triage": posts("edit"),
  "social.growth-abandon-experiment": posts("edit"),
  "social.delete-post": posts("delete"),
  "social.approve": posts("approve"),
  "social.request-changes": posts("approve"),
  "social.record-client-approval": posts("approve"),
  "social.schedule": posts("approve"),
  "social.retry-post": posts("approve"),
  "social.reply-inbox": posts("approve"),
  "social.growth-approve-experiment": posts("approve"),
  "social.growth-reject-experiment": posts("approve"),
  // ── page actions: accounts ──
  "social.oauth-start": accounts("create"),
  "social.oauth-pending": accounts("create"),
  "social.oauth-confirm": accounts("create"),
  "social.connect-bluesky": accounts("create"),
  "social.add-manual-account": accounts("create"),
  "social.update-account": accounts("edit"),
  "social.refresh-account": accounts("edit"),
  "social.disconnect-account": accounts("edit"),
  "social.delete-account": accounts("delete"),
  // ── page actions: settings ──
  "social.approval-policy": settings("view"),
  "social.set-approval-policy": settings("edit"),
  "social.set-approval-delegate": settings("edit"),
  "social.create-rss-feed": settings("edit"),
  "social.set-rss-active": settings("edit"),
  "social.growth-update-program": settings("edit"),
  "social.growth-save-playbook": settings("edit"),
  "social.growth-set-focus": settings("edit"),
  "social.growth-decide-change": settings("edit"),
  "social.growth-retire-question": settings("edit"),
  "social.set-cadence": settings("edit"),
  "social.routine-report": settings("edit"),
  // ── owner or admin only ──
  "social.hire-options": ADMIN_ONLY,
  "social.start-hire": ADMIN_ONLY,
  "social.link-agent": ADMIN_ONLY,
  "social.unlink-agent": ADMIN_ONLY,
  "social.activate-agent": ADMIN_ONLY,
  "social.sync-skills": ADMIN_ONLY,
  "social.announce-media": ADMIN_ONLY,
  "social.preferences-load": ADMIN_ONLY,
  "social.preferences-save": ADMIN_ONLY,
  // ── My Social ──
  "my-social.accounts": accounts("view"),
  "my-social.disconnect-account": accounts("edit"),
  "my-social.posts": posts("view"),
  "my-social.create-draft": posts("create"),
  "my-social.update-draft": posts("edit"),
  "my-social.delete-draft": posts("delete"),
  "my-social.approve": posts("approve"),

  // ── agent tools: the same permission as the matching page action ──
  "tool:list-clients": posts("view"),
  "tool:get-post": posts("view"),
  "tool:list-posts": posts("view"),
  "tool:validate-post": posts("view"),
  "tool:get-approval-status": posts("view"),
  "tool:review-outcomes": posts("view"),
  "tool:media-compliance": posts("view"),
  "tool:list-templates": posts("view"),
  "tool:list-media-assets": posts("view"),
  "tool:list-issue-attachments": posts("view"),
  "tool:list-inbox": posts("view"),
  "tool:post-analytics": posts("view"),
  "tool:get-cadence": posts("view"),
  "tool:hook-board": posts("view"),
  "tool:performance-review": posts("view"),
  "tool:get-playbook": posts("view"),
  "tool:list-experiments": posts("view"),
  "tool:create-post": posts("create"),
  "tool:create-personal-draft": posts("create"),
  "tool:request-creative": posts("create"),
  "tool:create-template": posts("create"),
  "tool:create-media-asset": posts("create"),
  "tool:import-media-from-url": posts("create"),
  "tool:import-media-from-attachment": posts("create"),
  "tool:store-rendered-asset": posts("create"),
  "tool:propose-feature-question": posts("create"),
  "tool:propose-playbook-change": posts("create"),
  "tool:propose-experiment": posts("create"),
  "tool:update-post": posts("edit"),
  "tool:attach-destination": posts("edit"),
  "tool:detach-destination": posts("edit"),
  "tool:request-review": posts("edit"),
  "tool:request-client-approval": posts("edit"),
  "tool:unschedule-post": posts("edit"),
  "tool:unarchive-post": posts("edit"),
  "tool:record-inbox-item": posts("edit"),
  "tool:mark-inbox-read": posts("edit"),
  "tool:record-post-metrics": posts("edit"),
  "tool:recollect-post-metrics": posts("edit"),
  "tool:archive-post": posts("delete"),
  "tool:record-review-verdict": posts("approve"),
  "tool:approve-post-as-delegate": posts("approve"),
  "tool:return-post-as-delegate": posts("approve"),
  "tool:schedule-post": posts("approve"),
  "tool:bulk-schedule": posts("approve"),
  "tool:retry-post": posts("approve"),
  "tool:reply-inbox": posts("approve"),
  "tool:approve-experiment": posts("approve"),
  "tool:reject-experiment": posts("approve"),
  "tool:list-connected-accounts": accounts("view"),
  "tool:account-analytics": accounts("view"),
  "tool:connect-account": accounts("create"),
  "tool:refresh-account": accounts("edit"),
  "tool:get-approval-policy": settings("view"),
  "tool:list-rss-feeds": settings("view"),
  "tool:create-rss-feed": settings("edit"),
  "tool:pause-rss-feed": settings("edit"),
  "tool:resume-rss-feed": settings("edit"),
  "tool:set-focus": settings("edit"),
  "tool:decide-playbook-change": settings("edit"),

  // ── API routes ──
  "api:oauth-complete": accounts("create"),
  "api:client-summary": posts("view"),
  [`api:${SETUP_STATUS_ROUTE.routeKey}`]: settings("view"),
  [`api:${COCKPIT_ROUTE.routeKey}`]: posts("view"),
});
