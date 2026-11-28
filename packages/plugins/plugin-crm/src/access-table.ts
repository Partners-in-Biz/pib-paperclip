/**
 * Who may do what in the CRM (access stage A, spec PAR-12578 sections 4.4 and 4.5; PAR-12679). Keys: action key,
 * `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person needs the permission named here.
 * With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - One client's records: `crm.companies`, `crm.contacts`, `crm.deals`, `crm.projects`, and the client's websites
 *   (`crm.sites`, incl. lead forms and site event keys), signing (`crm.esign`), care (`crm.care`: reports, support,
 *   client requests, feedback), Drive files (`crm.drive`), the sales desk (`crm.desk`) and sequences (`crm.sequences`).
 *   A read or write that spans record kinds (find, activities, field history) is `crm.companies`.
 * - Company-wide (closed to an own-companies person, Q16 of the spec): `crm.settings` (pipelines, products, extra
 *   fields, saved views, the Drive binding, the data-processing register) and `crm.reports`.
 * - `ADMIN_ONLY`: hiring and linking the CRM agents, skill sync and resync, maintenance runs, the canary journeys and
 *   the Partners share route (a record shared with another company).
 *
 * A tool that is also a page action (`crm.<name>`) has one row for both, so they cannot differ.
 *
 * `scoped` (stage B-2, PAR-15204; plan PAR-12581 B-D3, B-D4): the handler filters by the person's own companies (the
 * guard's `linked` decision reaches `viewerFor`, see `access-scope.ts`, and every list and record check reads
 * `visibleSets`). Only companies, contacts, deals, the desk and their lists are scoped here. Unscoped, so closed to an
 * own-companies person: creates, deletes, merges, shares and hand-offs to an agent, reports, settings, sequences, and
 * the client rows of sites, e-sign, care, Drive and projects (stage B-3). The two Drive data handlers (`drive-folder`,
 * `drive-files`) carry no caller and stay as they are until stage B-3.
 *
 * This file takes nothing but types from the kit.
 */
import type { AccessTable, AccessTableEntry, ADMIN_ONLY as KIT_ADMIN_ONLY, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ADMIN_ONLY: typeof KIT_ADMIN_ONLY = "ADMIN_ONLY";
const p = (resource: string) => (action: PermissionAction): AccessTableEntry => ({ resource, action });
const companies = p("crm.companies");
const contacts = p("crm.contacts");
const deals = p("crm.deals");
const projects = p("crm.projects");
const reports = p("crm.reports");
const settings = p("crm.settings");
const desk = p("crm.desk");
const sequences = p("crm.sequences");
const sites = p("crm.sites");
const esign = p("crm.esign");
const care = p("crm.care");
const drive = p("crm.drive");
const rows = (entry: AccessTableEntry, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, entry]));
/** The handler filters by the person's own companies (stage B). */
const scoped = (entry: AccessTableEntry): AccessTableEntry => (typeof entry === "object" && "resource" in entry ? { ...entry, scoped: true } : entry);

/** Names that are both an agent tool and a page action `crm.<name>`: one row each, used for both keys. */
export const SHARED_ROWS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  // companies, contacts and their records
  ...rows(scoped(companies("view")), ["find-records"]),
  "create-company": companies("create"),
  // Also page actions for Campaigns' Add people (PAR-9242).
  "import-contacts": contacts("create"),
  "bulk-tag-contacts": scoped(contacts("edit")),
  ...rows(scoped(companies("edit")), ["update-company", "update-client-profile", "log-activity"]),
  ...rows(companies("edit"), ["extract-brand-from-site", "start-new-client", "share-record", "set-client-sensitivity", "record-channel-cost"]),
  "create-contact": contacts("create"),
  ...rows(scoped(contacts("edit")), ["update-contact", "link-contact", "set-email-status", "score-contact"]),
  ...rows(contacts("edit"), ["record-consent", "record-lead-outcome"]),
  "list-client-leads": contacts("view"),
  "export-person-data": scoped(contacts("export")),
  "request-erasure": scoped(contacts("delete")),
  // deals and the product catalog
  "create-deal": deals("create"),
  ...rows(scoped(deals("edit")), ["move-deal", "update-deal"]),
  ...rows(settings("edit"), ["create-product", "update-product"]),
  "list-data-processing": settings("view"),
  // the sales desk and sequences
  "call-list": scoped(desk("view")),
  ...rows(scoped(desk("edit")), ["log-outcome", "set-next-action"]),
  "create-sequence": sequences("create"),
  "set-sequence-delivery": sequences("edit"),
  // client projects
  "link-client-project": projects("edit"),
  // websites, lead forms, site events and the WordPress Connector
  ...rows(sites("view"), ["site-changes", "list-lead-sources", "list-event-keys", "site-monitoring", "wp-health", "wp-log"]),
  ...rows(sites("create"), ["create-lead-endpoint", "create-event-key"]),
  ...rows(sites("edit"), [
    "save-client-site", "connect-client-site", "check-client-site", "rotate-lead-key", "update-lead-source", "update-event-key",
    "rotate-event-key", "set-site-monitoring", "wp-seo", "wp-schema", "wp-redirects", "wp-robots", "wp-sitemap", "wp-plugins",
    "wp-media", "wp-content", "wp-verify", "wp-archive", "wp-connector", "wp-undo",
  ]),
  ...rows(reports("view"), ["attribution-report", "site-events-report"]),
  // e-sign
  ...rows(esign("view"), ["sign-templates", "list-sign-documents", "get-sign-document", "verify-sign-document"]),
  "create-sign-document": esign("create"),
  "send-for-signature": esign("edit"),
  "void-sign-document": esign("delete"),
  // client care: reports, support, client requests, feedback
  ...rows(care("view"), ["list-client-reports", "list-support-cases", "client-health", "list-client-actions"]),
  ...rows(care("create"), ["build-client-report", "record-client-signal", "open-support-case", "request-feedback", "record-feedback", "create-client-action"]),
  ...rows(care("edit"), ["set-report-narrative", "send-client-report", "skip-client-report", "update-support-case", "move-support-case", "update-client-action"]),
  "delete-client-signal": care("delete"),
  // the acceptance agent's canary journeys
  ...rows(ADMIN_ONLY, ["create-canary-client", "cleanup-canary"]),
});

/** Page actions with no tool of the same name. */
const ACTION_ROWS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  ...rows(scoped(companies("view")), ["crm.load", "crm.client-workspace", "crm.activities"]),
  // Company and contact cards on a planning canvas (PAR-14416): the same reads as the page's find and client workspace.
  ...rows(scoped(companies("view")), ["canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related"]),
  ...rows(scoped(companies("edit")), ["crm.set-human-owned"]),
  "crm.delete-company": companies("delete"),
  "crm.desk": scoped(desk("view")),
  "crm.give-prepare": desk("view"),
  "crm.give-record": desk("edit"),
  "crm.sequence-detail": sequences("view"),
  "crm.enroll": sequences("edit"),
  "crm.delete-client-site": sites("delete"),
  "crm.make-lead-secret": sites("edit"),
  "crm.unlink-client-project": projects("edit"),
  ...rows(esign("edit"), ["crm.enable-esign", "crm.disable-esign"]),
  "crm.settings-status": settings("view"),
  ...rows(ADMIN_ONLY, [
    "crm.reports-drive-catchup", "crm.resync", "crm.sync-skills", "crm.run-services-check", "crm.normalize-services",
    "crm.hire-options", "crm.start-hire", "crm.link-agent", "crm.unlink-agent", "crm.resync-agent",
    // "Managed by" decides a limited person's own companies (stage B, PAR-12581); the handler checks the role too.
    "crm.set-managers",
  ]),
});

/** Agent tools with no page action of the same name. */
const TOOL_ROWS: Readonly<Record<string, AccessTableEntry>> = Object.freeze({
  ...rows(scoped(companies("view")), ["get-company", "get-client-profile", "field-history"]),
  ...rows(scoped(contacts("view")), ["get-contact", "contact-graph", "find-duplicates"]),
  "merge-contacts": contacts("delete"),
  "export-contacts": scoped(contacts("export")),
  ...rows(scoped(deals("view")), ["list-deals", "list-stages", "list-deal-products"]),
  "add-deal-product": scoped(deals("edit")),
  "pipeline-forecast": reports("view"),
  ...rows(settings("view"), ["list-saved-views", "drive_binding_status"]),
  ...rows(settings("edit"), ["create-pipeline", "define-field", "create-saved-view", "delete-saved-view", "drive_binding_discover", "drive_binding_set"]),
  "list-sequences": sequences("view"),
  "enroll-contact": sequences("edit"),
  "list-client-sites": sites("view"),
  "list-client-projects": projects("view"),
  ...rows(drive("view"), ["drive_folder_resolve", "drive_project_kind_list", "drive_transfer_status", "drive_file_fetch", "drive_files_list"]),
  ...rows(drive("create"), ["drive_folder_ensure", "drive_file_save", "drive_project_kind_set"]),
  "drive_file_trash": drive("delete"),
});

const prefixed = (prefix: string, entries: Readonly<Record<string, AccessTableEntry>>) =>
  Object.fromEntries(Object.entries(entries).map(([name, entry]) => [`${prefix}${name}`, entry]));

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  ...prefixed("crm.", SHARED_ROWS),
  ...ACTION_ROWS,

  // ── agent tools: the same row as the page action of the same name ──
  ...prefixed("tool:", SHARED_ROWS),
  ...prefixed("tool:", TOOL_ROWS),

  // ── API routes ──
  "api:record-grant": ADMIN_ONLY,
  "api:setup-status": settings("view"),
  "api:cockpit": reports("view"),
});
