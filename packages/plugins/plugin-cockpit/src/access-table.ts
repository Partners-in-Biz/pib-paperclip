/**
 * The Cockpit's access table (PAR-12578 plan 4.4, ticket PAR-12700): which permission each page action, agent tool and
 * API route needs when a company's access switch is `report` or `enforce`. With the switch `off` (every company today)
 * the guard passes every call on unchanged. `tests/access-guard.spec.ts` fails on a missing or stale row.
 *
 * Catalog resources: `cockpit.dashboards` (view, export), `cockpit.settings` (view, edit) and `cockpit.paper` (view,
 * create, edit, approve). None is scopable, so no row is `scoped`. No preset gives a limited person the Cockpit in stage A
 * (stage E does); owners, admins and agents on their runs pass every row.
 *
 * Rule of thumb: reading what the Cockpit shows (dashboard, health, asks, memory, numbers) is `dashboards:view`, taking it
 * out (memory export) `dashboards:export`. Reading the company's set-up (profile, team, credentials, policies) is
 * `settings:view`; changing how the company runs (team, hires, profile, memory, goals, improvements, credentials) is
 * `settings:edit`. The Daily Paper is `cockpit.paper`. What only the owner may do (confirm, the owner's standing policy,
 * the owner's digest, granting access) is `ADMIN_ONLY`. A tool has the permission of the matching page action.
 * `ANY_MEMBER` rows are a person's own push devices and the steps every agent takes inside its own task; each says why.
 */
import { ADMIN_ONLY, ANY_MEMBER, type AccessTable, type AccessTableEntry, type PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const dashboards = (action: PermissionAction): AccessTableEntry => ({ resource: "cockpit.dashboards", action });
const settings = (action: PermissionAction): AccessTableEntry => ({ resource: "cockpit.settings", action });
const paper = (action: PermissionAction): AccessTableEntry => ({ resource: "cockpit.paper", action });
const VIEW = dashboards("view");
const SETTINGS_VIEW = settings("view");
const SETTINGS_EDIT = settings("edit");

const rows = (entry: AccessTableEntry, keys: string[]) => Object.fromEntries(keys.map((key) => [key, entry]));

const OWN_DEVICES = ANY_MEMBER("a person's own push devices: each action needs a signed-in person and acts only on that person's subscriptions");
const OWN_TASK_STEP = ANY_MEMBER("a step every agent takes inside its own task: it writes about that task and reads nothing of the company back");

export const COCKPIT_ACCESS_TABLE: AccessTable = Object.freeze({
  // Page actions.
  ...rows(VIEW, [
    "cockpit.load", "cockpit.agents", "cockpit.refresh-health", "hosted-usage.load", "maintenance.load", "ownerDigest.preview",
    "memory.overview", "memory.list", "memory.brief", "memory.preview", "memory.review",
  ]),
  "memory.export": dashboards("export"),
  ...rows(SETTINGS_VIEW, ["cockpit.hire-options", "cockpit.skill-policy-plan", "profile.load", "ownerDefaults.load", "browser.status"]),
  ...rows(SETTINGS_EDIT, [
    "cockpit.save-team", "cockpit.start-hire", "cockpit.link-agent", "cockpit.unlink-agent", "cockpit.resync-agent",
    "acceptance.request", "profile.save", "outward-send.dismiss",
    "memory.add", "memory.update", "memory.feedback", "memory.import",
  ]),
  // Only the owner confirms, sets the standing policy and posts the owner's digest (the handlers check it too).
  ...rows(ADMIN_ONLY, ["cockpit.attest", "goals.confirm", "ownerDefaults.save", "ownerDigest.post"]),
  // The Decide queue is the owner's (the handler checks it, an agent is refused): owner or admin only.
  ...rows(ADMIN_ONLY, ["decide.queue"]),
  // Watch live and take over (PAR-14514 S3, S4): owner or admin of the owner company, a signed-in person only (the
  // handlers refuse agents too).
  ...rows(ADMIN_ONLY, ["browser.live.ticket", "browser.live.status", "browser.live.sessions", "browser.takeover.done", "browser.takeover.stop", "browser.takeover.waiting"]),
  ...rows(OWN_DEVICES, ["cockpit.push.publicKey", "cockpit.push.subscribe", "cockpit.push.devices", "cockpit.push.mute", "cockpit.push.unsubscribe", "cockpit.push.test"]),
  ...rows(paper("view"), ["paper.load", "paper.month"]),
  ...rows(paper("edit"), ["paper.save", "paper.reset"]),
  ...rows(paper("create"), ["paper.write-now", "paper.compile-now"]),

  // Agent tools.
  ...rows(VIEW, [
    "tool:company-brief", "tool:health-issues", "tool:waiting-on-owner", "tool:agent-scorecards", "tool:repairs-list",
    "tool:governor-state", "tool:watchdog-findings", "tool:hosted-usage-list", "tool:memory-recall", "tool:memory-search",
    "tool:memory-review", "tool:measure-report", "tool:improvement-list", "tool:goal-list", "tool:growth-ledger",
    "tool:acceptance-report", "tool:skill-eval",
  ]),
  ...rows(SETTINGS_VIEW, ["tool:company-profile", "tool:credential-list", "tool:access-check"]),
  ...rows(SETTINGS_EDIT, [
    "tool:update-company-profile", "tool:memory-add", "tool:memory-update", "tool:memory-feedback", "tool:open-closeout-review",
    "tool:improvement-propose", "tool:improvement-resolve", "tool:goal-set", "tool:credential-record", "tool:record-metric",
    "tool:ledger-upsert", "tool:acceptance-run", "tool:propose-skill-change",
  ]),
  // Carries out a decision on access: only for a run working for an owner or admin.
  "tool:access-grant": ADMIN_ONLY,
  ...rows(OWN_TASK_STEP, [
    "tool:ask-owner", "tool:evidence-record", "tool:evidence-save", "tool:review-finding-record", "tool:review-outcome-set", "tool:access-request",
  ]),
  "tool:post-daily-brief": paper("create"),
  "tool:paper-assignment": paper("view"),
  "tool:paper-publish": paper("create"),
  "tool:paper-settings": paper("edit"),

  // API routes: the Cockpit's own numbers, Setup's checklist, and the server scripts' routes.
  "api:cockpit": VIEW,
  "api:setup-status": SETTINGS_VIEW,
  "api:repairs-list": VIEW,
  "api:hosted-usage": VIEW,
  "api:repairs-create": SETTINGS_EDIT,
  "api:governor-rehearse": SETTINGS_EDIT,
  ...rows(ADMIN_ONLY, ["api:access-inventory", "api:owner-push", "api:browser-live"]),
});
