/**
 * Who may do what in Paid ads (access stage A, spec PAR-12578 sections 4.4 and 4.7; PAR-12645).
 * Keys: action key, `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person
 * needs the permission named here. With the company switch `off` (the default) nothing is checked.
 *
 * - `ads.work`: the numbers, alerts and change proposals. `approve` runs money: signing off a change
 *   and running an approved one.
 * - `ads.settings`: connections, ad accounts, caps, the changes switch, sign-offs and scope rules.
 * - `ADMIN_ONLY`: hiring and linking the ads agent, and the skill sync after a release.
 *
 * No entry is `scoped` yet: handlers do not filter by the person's companies until stage B2, so an
 * own-companies grant opens nothing here in stage A.
 */
import { ADMIN_ONLY, COCKPIT_ROUTE, SETUP_STATUS_ROUTE, type AccessTable, type PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

const work = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "ads.work", action });
const settings = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "ads.settings", action });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  "ads.load": work("view"),
  "ads.performance": work("view"),
  "ads.campaign-caps": work("view"),
  "ads.proposals": work("view"),
  "ads.proposal": work("view"),
  "ads.agent": work("view"),
  "ads.sync": work("edit"),
  "ads.ack-alert": work("edit"),
  "ads.cancel-proposal": work("edit"),
  "ads.mark-done": work("edit"),
  "ads.approve": work("approve"),
  "ads.execute": work("approve"),
  "ads.discover-accounts": settings("view"),
  "ads.oauth-start": settings("edit"),
  "ads.connect-token": settings("edit"),
  "ads.connect-mock": settings("edit"),
  "ads.disconnect": settings("edit"),
  "ads.register-account": settings("edit"),
  "ads.remove-account": settings("edit"),
  "ads.set-cap": settings("edit"),
  "ads.set-campaign-cap": settings("edit"),
  "ads.set-allow-writes": settings("edit"),
  "ads.set-signoffs": settings("edit"),
  "ads.set-rules": settings("edit"),
  "ads.hire-options": ADMIN_ONLY,
  "ads.start-hire": ADMIN_ONLY,
  "ads.link-agent": ADMIN_ONLY,
  "ads.unlink-agent": ADMIN_ONLY,
  "ads.resync-agent": ADMIN_ONLY,
  "ads.sync-skills": ADMIN_ONLY,

  // ── agent tools: the same permission as the matching page action ──
  "tool:list-ad-accounts": work("view"),
  "tool:get-ads-summary": work("view"),
  "tool:list-ad-campaigns": work("view"),
  "tool:diagnose-google-campaign": work("view"),
  "tool:list-campaigns-without-cap": work("view"),
  "tool:get-spend-ledger": work("view"),
  "tool:get-budget-status": work("view"),
  "tool:list-ad-alerts": work("view"),
  "tool:check-ad-creative": work("view"),
  "tool:list-ad-proposals": work("view"),
  "tool:list-variants": work("view"),
  "tool:get-ad-proposal": work("view"),
  "tool:sync-ad-account": work("edit"),
  "tool:acknowledge-ad-alert": work("edit"),
  "tool:upload-ad-media": work("create"),
  "tool:propose-ad-change": work("create"),
  "tool:revise-ad-proposal": work("edit"),
  "tool:record-ad-review": work("edit"),
  "tool:record-client-request": work("edit"),
  "tool:cancel-ad-proposal": work("edit"),
  "tool:execute-ad-change": work("approve"),
  "tool:list-ad-connections": settings("view"),
  "tool:register-ad-account": settings("edit"),
  "tool:set-ad-scope-rules": settings("edit"),

  // ── API routes ──
  "api:oauth-complete": settings("edit"),
  [`api:${SETUP_STATUS_ROUTE.routeKey}`]: settings("view"),
  [`api:${COCKPIT_ROUTE.routeKey}`]: work("view"),
});
