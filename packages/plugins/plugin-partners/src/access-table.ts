/**
 * Who may do what in Partners (access stage A, spec PAR-12578 sections 4.4 and 4.6; PAR-12681). Keys: action key,
 * `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person needs the permission named here.
 * With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - `partners.grants`: partner links and the named records shared through them. `view` reads them, `create`
 *   proposes a link or a grant, `edit` accepts one (an accepted grant opens the record to the partner), `delete`
 *   revokes a grant.
 * - `ADMIN_ONLY`: the skill sync.
 *
 * A tool has the permission of the page action that does the same. No entry is `scoped`: a link or grant belongs to
 * the whole company, not to one client, so an own-companies grant opens nothing here in stage A.
 *
 * This file is imported by tests and may be read by the page, so it takes nothing but types from the kit.
 */
import type { AccessTable, AccessTableEntry, ADMIN_ONLY as KIT_ADMIN_ONLY, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ADMIN_ONLY: typeof KIT_ADMIN_ONLY = "ADMIN_ONLY";
const grants = (action: PermissionAction): AccessTableEntry => ({ resource: "partners.grants", action });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  "partners.load": grants("view"),
  "partners.propose-link": grants("create"),
  "partners.accept-link": grants("edit"),
  "partners.propose-grant": grants("create"),
  "partners.accept-grant": grants("edit"),
  "partners.revoke-grant": grants("delete"),
  "partners.sync-skills": ADMIN_ONLY,

  // ── agent tools: the same permission as the page action ──
  "tool:list-links": grants("view"),
  "tool:list-grants": grants("view"),
  "tool:propose-link": grants("create"),
  "tool:propose-grant": grants("create"),
  "tool:revoke-grant": grants("delete"),

  // ── API routes (kit SETUP_STATUS_ROUTE and COCKPIT_ROUTE) ──
  "api:setup-status": grants("view"),
  "api:cockpit": grants("view"),
});
