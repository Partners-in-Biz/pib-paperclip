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
 * Stage B2 (PAR-12582): a `scoped` row is open to a person limited to his own companies, and its handler
 * keeps him to their scopes (`own-scope.ts`, one rule per scoped key). Every other row stays closed to him:
 * the settings, the campaign caps list, the agent and the company-wide routes.
 */
import { ADMIN_ONLY, COCKPIT_ROUTE, SETUP_STATUS_ROUTE, type AccessTable, type PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

const work = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "ads.work", action });
/** Open to a limited person, within his own companies' scopes. */
const own = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "ads.work", action, scoped: true });
const settings = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "ads.settings", action });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  "ads.load": own("view"),
  "ads.performance": own("view"),
  "ads.campaign-caps": work("view"),
  "ads.proposals": own("view"),
  "ads.proposal": own("view"),
  "ads.agent": work("view"),
  "ads.sync": own("edit"),
  "ads.ack-alert": own("edit"),
  "ads.cancel-proposal": own("edit"),
  "ads.mark-done": own("edit"),
  "ads.approve": own("approve"),
  "ads.execute": own("approve"),
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
  "tool:list-ad-accounts": own("view"),
  "tool:get-ads-summary": own("view"),
  "tool:list-ad-campaigns": own("view"),
  "tool:diagnose-google-campaign": own("view"),
  "tool:list-campaigns-without-cap": work("view"),
  "tool:get-spend-ledger": own("view"),
  "tool:get-budget-status": own("view"),
  "tool:list-ad-alerts": own("view"),
  "tool:check-ad-creative": own("view"),
  "tool:list-ad-proposals": own("view"),
  "tool:list-variants": own("view"),
  "tool:get-ad-proposal": own("view"),
  "tool:sync-ad-account": own("edit"),
  "tool:acknowledge-ad-alert": own("edit"),
  "tool:upload-ad-media": own("create"),
  "tool:propose-ad-change": own("create"),
  "tool:revise-ad-proposal": own("edit"),
  "tool:record-ad-review": own("edit"),
  "tool:record-client-request": own("edit"),
  "tool:cancel-ad-proposal": own("edit"),
  "tool:execute-ad-change": own("approve"),
  "tool:list-ad-connections": settings("view"),
  "tool:register-ad-account": settings("edit"),
  "tool:set-ad-scope-rules": settings("edit"),

  // ── API routes ──
  "api:oauth-complete": settings("edit"),
  [`api:${SETUP_STATUS_ROUTE.routeKey}`]: settings("view"),
  [`api:${COCKPIT_ROUTE.routeKey}`]: work("view"),
});
