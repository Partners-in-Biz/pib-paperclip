/**
 * Setup's access table (access stage A, spec PAR-12578 sections 4.4 and 4.8).
 * Every page action, agent tool and API route the worker registers has one row
 * here; `tests/access.spec.ts` fails on a missing or stale row.
 *
 * Catalog resource: `setup.settings` (view, edit), not scopable, so no row is
 * `scoped`: Setup is not in the Client manager preset.
 *
 * - The access actions (People tab, switch, Send again) are owner or admin only (4.8).
 * - Hiring and bootstrapping a company change its agents: owner or admin only,
 *   like every other plugin's hire actions. Entitlements are the operator's.
 * - `setup.load` and the `modules` route are open to every member: every
 *   plugin page reads the module switches, and the Cockpit page calls
 *   `setup.load` (4.4, "Calls from another plugin's page"). Neither returns a
 *   secret; `tests/access.spec.ts` holds that.
 */
import { ADMIN_ONLY, ANY_MEMBER, type AccessTable, type PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const settings = (action: PermissionAction) => ({ resource: "setup.settings", action });

export const SETUP_ACCESS_TABLE: AccessTable = Object.freeze({
  // People tab, the switch and its status, Send again.
  "setup.access.send-again": ADMIN_ONLY,
  "setup.access.set-mode": ADMIN_ONLY,
  "setup.access.status": ADMIN_ONLY,
  "setup.access.people": ADMIN_ONLY,
  "setup.access.save-grant": ADMIN_ONLY,
  "setup.access.clear-grant": ADMIN_ONLY,

  "setup.load": ANY_MEMBER("The Cockpit page and every Setup surface read the module switches and the setup count; no secret in it"),
  // The handler also checks owner or admin (of this company or of ours).
  "setup.save-modules": settings("edit"),
  // Only an owner or admin of the operator company may set a plan; the handler checks that too.
  "setup.set-entitlements": ADMIN_ONLY,
  // Opens or updates the Finish setup issue.
  "setup.refresh-issue": settings("edit"),
  // The Setup page reports what it just read on load (Company wiki, live statuses).
  "setup.report-memory": settings("view"),
  "setup.report-statuses": settings("view"),
  "setup.drive-bind": settings("edit"),

  // New company: reading the state is view; every step that hires or grants is owner or admin.
  "setup.new-company": settings("view"),
  "setup.bootstrap-company": ADMIN_ONLY,
  "setup.bootstrap-record": ADMIN_ONLY,
  "setup.template-draft": ADMIN_ONLY,
  "setup.start-template-hire": ADMIN_ONLY,
  "setup.approve-starter-pack": ADMIN_ONLY,
  "setup.starter-pack-import": ADMIN_ONLY,

  // The team template pack: read-only, no secret.
  "tool:template-list": settings("view"),
  "tool:template-get": settings("view"),
  "tool:template-preview": settings("view"),

  "api:modules": ANY_MEMBER("Every plugin page and widget reads the company's module switches (kit moduleState)"),
  // The ops scripts read the rendered template pack.
  "api:templates": settings("view"),
});
