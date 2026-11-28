/**
 * Campaigns' access table (PAR-12578 plan 4.4, ticket PAR-12684): which permission each page action, agent tool and
 * API route needs when a company's access switch is `report` or `enforce`. With the switch `off` (every company
 * today) the guard passes every call on unchanged. `tests/access.spec.ts` fails on a missing or stale row.
 *
 * Catalog resources: `campaigns.campaigns` (view, create, edit, delete, approve; scopable) and `campaigns.settings`
 * (view, edit). The rows only add a gate in front of the handlers; the handlers keep their own checks (only a person
 * approves a launch, only the owner decides a client's campaign).
 *
 * Stage B2 (PAR-15209): a `scoped` row is open to a person limited to his own companies, and its handler keeps him to
 * their campaigns (`own-scope.ts`, one rule per scoped key). Every other row stays closed to him: templates, sender
 * identities, the page preferences, own brands, moving a draft, the Growth Lab, canvas cards, Cockpit and Setup.
 *
 * Rule of thumb: reading is `view`; a new campaign or template is `create`; changing a draft, an enrollment or a
 * suppression is `edit`; anything that starts or restarts sending, or decides an approval, is `approve`. A tool has the
 * permission of the matching page action. The sender identities and the page preferences are `campaigns.settings`.
 */
import type { AccessTable, AccessTableEntry, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const campaigns = (action: PermissionAction): AccessTableEntry => ({ resource: "campaigns.campaigns", action });
const settings = (action: PermissionAction): AccessTableEntry => ({ resource: "campaigns.settings", action });
const VIEW = campaigns("view");
const CREATE = campaigns("create");
const EDIT = campaigns("edit");
const APPROVE = campaigns("approve");

const rows = (entry: AccessTableEntry, keys: string[]) => Object.fromEntries(keys.map((key) => [key, entry]));

/** Open to a limited person, within his own companies' campaigns (stage B2). */
const SCOPED = new Set([
  "campaigns.load", "campaigns.detail", "campaigns.results", "campaigns.stats", "campaigns.ab-suggestion", "campaigns.create-campaign",
  "campaigns.audience-preview", "campaigns.audience-members", "campaigns.audience-import", "campaigns.audience-add",
  "campaigns.add-step", "campaigns.request-approval", "campaigns.pause", "campaigns.complete", "campaigns.enroll", "campaigns.declare-winner",
  "campaigns.launch", "campaigns.resume", "campaigns.approve", "campaigns.send-back", "campaigns.set-mode", "campaigns.client-summary",
  "tool:list-campaigns", "tool:campaign-stats", "tool:preflight-campaign", "tool:export-person-data", "tool:campaign-funnel",
  "tool:campaign-step-analytics", "tool:campaign-results", "tool:suggest-ab-winner", "tool:create-campaign",
  "tool:update-campaign", "tool:add-campaign-step", "tool:pause-campaign", "tool:complete-campaign", "tool:enroll-contact",
  "tool:stop-enrollment", "tool:suppress-address", "tool:suppress-phone", "tool:record-channel-consent", "tool:log-reply",
  "tool:request-campaign-approval", "tool:create-ab-variant", "tool:record-step-event", "tool:set-step-html",
  "tool:edit-campaign-step", "tool:declare-ab-winner", "tool:launch-campaign", "tool:resume-campaign",
  "tool:review-campaign-approval", "tool:set-campaign-mode",
  "api:client-summary",
]);

/** Marks the stage B2 rows `scoped`; every other row stays as written. */
function withScoped(table: Record<string, AccessTableEntry>): AccessTable {
  const mark = (key: string, entry: AccessTableEntry): AccessTableEntry =>
    SCOPED.has(key) && typeof entry === "object" && "resource" in entry ? { ...entry, scoped: true as const } : entry;
  return Object.freeze(Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, mark(key, entry)])));
}

export const CAMPAIGNS_ACCESS_TABLE: AccessTable = withScoped({
  // Page actions.
  ...rows(VIEW, ["campaigns.load", "campaigns.detail", "campaigns.results", "campaigns.stats", "campaigns.ab-suggestion", "campaigns.growth-load"]),
  // Planning Canvas entity cards (PAR-14423): reading, so `view`, as the page's detail and list.
  ...rows(VIEW, ["canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related"]),
  "campaigns.create-campaign": CREATE,
  // Adding people (Stage 4c): the preview and a list's reach are reading; adding or tagging people changes the audience.
  ...rows(VIEW, ["campaigns.audience-preview", "campaigns.audience-members"]),
  ...rows(EDIT, ["campaigns.audience-import", "campaigns.audience-add", "campaigns.audience-tick"]),
  ...rows(EDIT, ["campaigns.add-step", "campaigns.request-approval", "campaigns.pause", "campaigns.complete", "campaigns.enroll", "campaigns.declare-winner", "campaigns.move"]),
  // Launching or resuming sends to people; approving, sending back, a campaign's mode and the Growth Lab decisions are decisions.
  ...rows(APPROVE, [
    "campaigns.launch", "campaigns.resume", "campaigns.approve", "campaigns.send-back", "campaigns.set-mode",
    "campaigns.growth-approve-experiment", "campaigns.growth-reject-experiment", "campaigns.growth-decide-change",
  ]),
  "campaigns.preferences-load": settings("view"),
  "campaigns.client-summary": campaigns("view"),
  "campaigns.preferences-save": settings("edit"),
  "campaigns.sync-skills": settings("edit"),
  // Marking a brand writes the page preference and changes whether a client's yes is needed: a settings change.
  "campaigns.set-own-brand": settings("edit"),

  // Agent tools.
  ...rows(VIEW, [
    "tool:list-campaigns", "tool:campaign-stats", "tool:preflight-campaign", "tool:export-person-data", "tool:campaign-funnel", "tool:campaign-step-analytics", "tool:campaign-results",
    "tool:list-campaign-templates", "tool:suggest-ab-winner", "tool:performance-review", "tool:get-playbook", "tool:list-experiments",
  ]),
  ...rows(CREATE, ["tool:create-campaign", "tool:seed-canary-results-fixture", "tool:create-campaign-template", "tool:create-campaign-from-template", "tool:create-feed-digest", "tool:propose-experiment"]),
  ...rows(EDIT, [
    "tool:update-campaign", "tool:add-campaign-step", "tool:pause-campaign", "tool:complete-campaign", "tool:enroll-contact",
    "tool:stop-enrollment", "tool:suppress-address", "tool:suppress-phone", "tool:record-channel-consent", "tool:log-reply",
    "tool:request-campaign-approval", "tool:create-ab-variant", "tool:record-step-event", "tool:set-step-html",
    "tool:edit-campaign-step", "tool:declare-ab-winner", "tool:propose-playbook-change",
  ]),
  ...rows(APPROVE, [
    "tool:launch-campaign", "tool:resume-campaign", "tool:review-campaign-approval", "tool:set-campaign-mode",
    "tool:decide-playbook-change", "tool:approve-experiment", "tool:reject-experiment",
  ]),
  "tool:list-sender-identities": settings("view"),
  ...rows(settings("edit"), ["tool:set-sender-identity", "tool:remove-sender-identity"]),

  // API routes: the CRM client workspace's campaign counts, Setup's checklist and the Cockpit's Campaigns numbers.
  "api:client-summary": VIEW,
  "api:setup-status": settings("view"),
  "api:cockpit": VIEW,
});
