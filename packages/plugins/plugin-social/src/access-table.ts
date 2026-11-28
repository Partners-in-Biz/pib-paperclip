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
 * person needs a grant for it like for the company page.
 *
 * Stage B2 (PAR-15210): a `scoped` row (`ownPosts`, `ownAccounts`) is open to a person limited to his own companies,
 * and its handler keeps him to their clients (`own-scope.ts`, one rule per scoped key). Every other row stays closed
 * to him: own-brand work, templates, settings (RSS feeds, approvers, cadence, the Growth Lab), connecting accounts,
 * uploads, My Social, the agent, Cockpit and setup.
 */
import { ADMIN_ONLY, COCKPIT_ROUTE, SETUP_STATUS_ROUTE, type AccessTable, type PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

type Action = PermissionEntry["action"];
const posts = (action: Action): PermissionEntry => ({ resource: "social.posts", action });
const accounts = (action: Action): PermissionEntry => ({ resource: "social.accounts", action });
const settings = (action: Action): PermissionEntry => ({ resource: "social.settings", action });
/** Open to a person limited to his own companies, within their clients (stage B2, a rule each in `own-scope.ts`). */
const ownPosts = (action: Action): PermissionEntry => ({ resource: "social.posts", action, scoped: true });
const ownAccounts = (action: Action): PermissionEntry => ({ resource: "social.accounts", action, scoped: true });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions: posts ──
  "social.load": ownPosts("view"),
  "social.clients": ownPosts("view"),
  "social.get-post": ownPosts("view"),
  "social.validate-post": ownPosts("view"),
  "social.change-notes": ownPosts("view"),
  "social.approval-status": ownPosts("view"),
  "social.review-outcomes": ownPosts("view"),
  "social.list-templates": posts("view"),
  "social.post-analytics": ownPosts("view"),
  "social.growth-load": posts("view"),
  "social.get-cadence": posts("view"),
  // Planning Canvas post cards (PAR-14389 B3a): reading posts, so `view`.
  "canvas.cards.resolve": ownPosts("view"),
  "canvas.cards.search": ownPosts("view"),
  "canvas.cards.related": ownPosts("view"),
  "social.create-post": ownPosts("create"),
  "social.create-template": posts("create"),
  "social.media-presign": posts("create"),
  "social.create-media-asset": posts("create"),
  "social.import-media": ownPosts("create"),
  "social.request-inbox-draft": ownPosts("create"),
  "social.hook-give-prepare": posts("create"),
  "social.update-post": ownPosts("edit"),
  "social.attach": ownPosts("edit"),
  "social.detach": ownPosts("edit"),
  "social.review": ownPosts("edit"),
  "social.back-to-draft": ownPosts("edit"),
  "social.request-client-approval": ownPosts("edit"),
  "social.unschedule": ownPosts("edit"),
  "social.mark-posted": ownPosts("edit"),
  "social.mark-destination-posted": ownPosts("edit"),
  "social.skip-destination": ownPosts("edit"),
  "social.mark-inbox-read": ownPosts("edit"),
  "social.mark-inbox-replied": ownPosts("edit"),
  "social.correct-triage": ownPosts("edit"),
  "social.growth-abandon-experiment": posts("edit"),
  "social.delete-post": ownPosts("delete"),
  "social.approve": ownPosts("approve"),
  "social.request-changes": ownPosts("approve"),
  "social.record-client-approval": ownPosts("approve"),
  "social.schedule": ownPosts("approve"),
  "social.retry-post": ownPosts("approve"),
  "social.reply-inbox": ownPosts("approve"),
  "social.growth-approve-experiment": posts("approve"),
  "social.growth-reject-experiment": posts("approve"),
  // ── page actions: accounts ──
  "social.oauth-start": accounts("create"),
  "social.oauth-pending": accounts("create"),
  "social.oauth-confirm": accounts("create"),
  "social.connect-bluesky": accounts("create"),
  "social.add-manual-account": ownAccounts("create"),
  "social.update-account": ownAccounts("edit"),
  "social.refresh-account": ownAccounts("edit"),
  "social.disconnect-account": ownAccounts("edit"),
  "social.delete-account": ownAccounts("delete"),
  // ── page actions: settings ──
  "social.approval-policy": settings("view"),
  "social.set-approval-policy": posts("approve"),
  "social.set-approval-delegate": posts("approve"),
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
  "tool:list-clients": ownPosts("view"),
  "tool:get-post": ownPosts("view"),
  "tool:list-posts": ownPosts("view"),
  "tool:validate-post": ownPosts("view"),
  "tool:get-approval-status": ownPosts("view"),
  "tool:review-outcomes": ownPosts("view"),
  "tool:media-compliance": ownPosts("view"),
  "tool:list-templates": posts("view"),
  "tool:list-media-assets": ownPosts("view"),
  "tool:list-issue-attachments": posts("view"),
  "tool:list-inbox": ownPosts("view"),
  "tool:post-analytics": ownPosts("view"),
  "tool:get-cadence": posts("view"),
  "tool:hook-board": posts("view"),
  "tool:performance-review": posts("view"),
  "tool:get-playbook": posts("view"),
  "tool:list-experiments": posts("view"),
  "tool:create-post": ownPosts("create"),
  "tool:create-personal-draft": posts("create"),
  "tool:request-creative": ownPosts("create"),
  "tool:create-template": posts("create"),
  "tool:create-media-asset": posts("create"),
  "tool:import-media-from-url": ownPosts("create"),
  "tool:import-media-from-attachment": posts("create"),
  "tool:store-rendered-asset": posts("create"),
  "tool:propose-feature-question": posts("create"),
  "tool:propose-playbook-change": posts("create"),
  "tool:propose-experiment": posts("create"),
  "tool:update-post": ownPosts("edit"),
  "tool:attach-destination": ownPosts("edit"),
  "tool:detach-destination": ownPosts("edit"),
  "tool:request-review": ownPosts("edit"),
  "tool:request-client-approval": ownPosts("edit"),
  "tool:unschedule-post": ownPosts("edit"),
  "tool:unarchive-post": ownPosts("edit"),
  "tool:record-inbox-item": ownPosts("edit"),
  "tool:mark-inbox-read": ownPosts("edit"),
  "tool:record-post-metrics": ownPosts("edit"),
  "tool:recollect-post-metrics": posts("edit"),
  "tool:archive-post": ownPosts("delete"),
  "tool:record-review-verdict": ownPosts("approve"),
  "tool:approve-post-as-delegate": ownPosts("approve"),
  "tool:return-post-as-delegate": ownPosts("approve"),
  "tool:schedule-post": ownPosts("approve"),
  "tool:bulk-schedule": ownPosts("approve"),
  "tool:retry-post": ownPosts("approve"),
  "tool:reply-inbox": ownPosts("approve"),
  "tool:approve-experiment": posts("approve"),
  "tool:reject-experiment": posts("approve"),
  "tool:list-connected-accounts": ownAccounts("view"),
  "tool:account-analytics": ownAccounts("view"),
  "tool:connect-account": accounts("create"),
  "tool:refresh-account": ownAccounts("edit"),
  "tool:get-approval-policy": settings("view"),
  "tool:list-rss-feeds": settings("view"),
  "tool:create-rss-feed": settings("edit"),
  "tool:pause-rss-feed": settings("edit"),
  "tool:resume-rss-feed": settings("edit"),
  "tool:set-focus": settings("edit"),
  "tool:decide-playbook-change": settings("edit"),

  // ── API routes ──
  "api:oauth-complete": accounts("create"),
  "api:client-summary": ownPosts("view"),
  [`api:${SETUP_STATUS_ROUTE.routeKey}`]: settings("view"),
  [`api:${COCKPIT_ROUTE.routeKey}`]: posts("view"),
});
