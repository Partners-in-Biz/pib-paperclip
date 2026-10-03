import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, MEMORY_TOOLS, secretField, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { JOBS, PLUGIN_KEY, ROUTINES, ROUTINE_TITLES, SKILL_SLUGS, VERSION } from "./constants.js";
import { SKILLS } from "./skills.js";
import { COCKPIT_TOOLS, TOOL_NAMES } from "./tools.js";
import { OPS_TOOL_NAMES } from "./ops-tool-declarations.js";

export { JOBS, VERSION };

const tool = (name: string) => `${PLUGIN_KEY}:${name}`;

export const DAILY_ROUTINE_DESCRIPTION = `Daily operations review. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)}.
2. Health first: follow each problem's fix; hand broken work to the agent that owns it and wake it. Comment what you did on the System health issue. The checks include agent drift (skills, tool access, run profile), spend and the plan limit, review coverage, client effort, credential expiry, owner confirmations and the Needs-you backlog: the skill's references say what to do for each.
3. Check the team: routines on, roles staffed (Setup → Team), questions to the owner answered (\`asks\`, oldest first on the brief).
4. Route every unassigned issue (\`unassigned\`) to the agent in the role that owns the work.
5. Unblock agents: answer from context, reassign, or hand off. Only a real grant or decision goes to the owner, with ${tool(TOOL_NAMES.askOwner)}.
6. Work the stuck stages (\`stuckFlows\`): wake or hand off to the agent each one waits on; one waiting on a person goes on the brief.
7. Check everything waiting on the owner. If an agent could do it, hand it to that agent.
8. Make sure today's important work has an agent and is not blocked.
9. Look at \`improvements\` (overdue first) and any close-out review or business review issue assigned to you: do them, or hand the change to the agent that owns it.
10. Post the Daily brief with ${tool(TOOL_NAMES.postBrief)}: done yesterday, waiting on you (questions first, with links), risks, today's plan. Short.
11. Close this issue with one line: fixed, handed off, waiting on the owner.

Never approve money or legal items, never change budgets, never send or publish anything yourself.`;

export const WEEKLY_ROUTINE_DESCRIPTION = `Weekly retro. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)} with windowHours 168, and ${tool(TOOL_NAMES.scorecards)}.
2. Call ${tool(OPS_TOOL_NAMES.measure)} (windowHours 168, parts agents, projects, trees, review, limits, clients): what the work cost (notional USD, tokens), how long runs take, retries and cancellations, cost per finished issue, code-review coverage and latency, runs that hit the plan limit, and each customer's effort against what they paid.
3. Call ${tool(MEMORY_TOOLS.review)}. Merge likely duplicates (keep the better one, mark the other superseded), fix or archive noisy and wrong facts, move company-wide facts that name a client to that client, record each pinned fact that describes a tool (\`skillCandidates\`) as an improvement, and note how briefs did. Feedback coverage low or zero is NO SIGNAL: say so, never count it as good news.
4. Call ${tool(OPS_TOOL_NAMES.improvementList)} (open) and the brief's \`improvements\`: for each one past its re-check date record the number or drop it; say which recent ones improved, did not change or got worse.
5. Post a "Weekly retro" with ${tool(TOOL_NAMES.postBrief)}: what worked, what failed (from the measure report, not only failed runs), one scorecard line per agent (runs, failures, notional spend, cost per finished issue, key quality metric), one line on company memory (facts, briefs, feedback coverage), one line on improvements, one line on goals, and at most 3 proposals (mark the ones that need the owner's yes). Record every proposal with ${tool(OPS_TOOL_NAMES.improvementPropose)}: the number it should move, where it stands, the target, the re-check date.
6. Carry out the proposals that do not need the owner, then close this issue.`;

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Cockpit settings",
  description:
    "Save this once for each company. Saving is what lets the Cockpit act for that company on its own: the hourly System health issue and team roles, answers to agents' questions, client onboarding, and the CRM client list company memory uses.",
  properties: {
    healthIssue: {
      type: "boolean",
      title: "System health issue",
      description: "Keep one open issue listing current problems (bad checks, plugins not reporting, agents in error or at 80% of budget, failing routines and runs, issues blocked or stalled). It closes itself when all is ok.",
      default: true,
    },
    notionalDailyUsd: {
      type: "number",
      title: "Daily AI spend limit (notional USD, optional)",
      description:
        "Claude runs on a flat plan, so agent budgets never fill: they count billed cents and the plan bills none. The Cockpit measures notional USD instead (what the same tokens would cost at list price) and raises a health alert when the last 24 hours reach this number. Leave blank for no daily limit. A sudden jump to more than twice the usual is flagged either way.",
      minimum: 0,
    },
    notionalWeeklyUsd: {
      type: "number",
      title: "Weekly AI spend limit (notional USD, optional)",
      description: "A health alert when the last 7 days of notional spend reach this number. Leave blank for no weekly limit.",
      minimum: 0,
    },
    usdRate: {
      type: "number",
      title: "Rand per US dollar",
      description: "Only used to set the agents' notional spend on a client against what that client paid (invoices are in rand). A planning figure, not a quote. Default 18.",
      minimum: 0,
    },
    effortAlertRatio: {
      type: "number",
      title: "Client effort alert (share of what they paid)",
      description: "Warn when a customer's notional AI spend over 30 days is at least this share of what they paid in the same time (default 0.5, half).",
      minimum: 0,
    },
    credentialSeed: {
      type: "boolean",
      title: "Load Partners in Biz's own credentials list (owner company only)",
      description:
        "Tick this ONLY on Partners in Biz's own company. It fills the credentials register with PiB's own 22 starting entries (the GitHub, Cloudflare, Resend and Claude tokens, the server keys and the backup key: names and where they live, never a value) and warns about the exposed ones. Leave it off for every client company: their register then starts empty and you or the Operator record only their own credentials.",
      default: false,
    },
    credentialChecks: {
      type: "object",
      title: "Credential checks (optional)",
      description:
        "Pick a company secret for each provider and the daily check calls it once (one cheap read, never storing or showing the value) to see whether the credential is still accepted and, for GitHub and Cloudflare, when it expires. Without one the register still warns before an expiry date you recorded.",
      properties: {
        github: secretField("GitHub token", "The company secret holding the GitHub token agents push with (read-only check: GET /user)."),
        cloudflare: secretField("Cloudflare API token", "A Cloudflare API token (checked with the token verify call)."),
        resend: secretField("Resend API key", "The Resend key (checked with a read-only call; a sending-only key counts as live)."),
      },
    },
    jev: {
      ...jevConfigSchema(),
      title: "Smart matching for company memory (optional)",
      description:
        "An AI service (Jev, from TypeSafe) picks which remembered facts each task needs, so agents get a short, relevant brief. Only the task's title and description and the candidate facts are sent. Without a key, briefs use keyword and recency matching (same size limit). Pick the same Paperclip secret you use in the other PiB plugins.",
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: VERSION,
  displayName: "Cockpit",
  description:
    "One place to run the company: what waits on you (questions from agents first), what the agents did, money, pipeline, marketing, delivery, agent cost and quality, and system health. Owns the Operator (chief of staff) and Reviewer roles, the company operating manual and profile, and the company memory every agent reads (a short, filtered brief per task).",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "issue.comments.read",
    "approvals.read",
    "agents.read",
    "routines.managed",
    "skills.managed",
    "authorization.grants.read",
    "authorization.grants.write",
    // Company goals mirrored to the host's goals, and the company's members (the single-admin check).
    "goals.read",
    "goals.create",
    "goals.update",
    "access.members.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    // Reads the harness task's `output` document itself when it grades a golden scenario (skill-eval record), so the agent that ran it cannot say what came back.
    "issue.documents.read",
    "agent.tools.register",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "api.routes.register",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "cockpit", migrationsDir: "migrations", coreReadTables: ["issues", "heartbeat_runs", "issue_relations", "projects"] },
  tools: COCKPIT_TOOLS,
  jobs: [
    {
      jobKey: JOBS.reemitRoles,
      displayName: "Re-send team roles",
      description: "Every hour, re-sends each company's team (Operator, Reviewer, owner, and every role's agent and status) to the other plugins (events can be lost), and links hires whose agent appeared.",
      schedule: "10 * * * *",
    },
    {
      jobKey: JOBS.healthAlerts,
      displayName: "System health check",
      description: "Every hour: opens, updates or closes one System health issue per company (bad checks, warnings older than a day, plugins not reporting, agents in error or at 80% of budget, routines that failed their last run, agents that fail too often or the same way, issues that keep failing, issues blocked or stalled with nobody to move them), and settles questions to the owner whose reply was missed.",
      schedule: "20 * * * *",
    },
    {
      jobKey: JOBS.memoryUpkeep,
      displayName: "Company memory upkeep",
      description: "Daily: archives facts past their expiry date, and keeps each client and area under its cap by archiving the least useful unpinned facts (never deleted).",
      schedule: "30 1 * * *",
    },
    {
      jobKey: JOBS.closeoutSweep,
      displayName: "Close-out reviews",
      description: "Daily: opens one close-out review for the Operator for each finished project (after a quiet spell), closed epic or evergreen milestone the events missed, at most three per company a day. Each review carries the numbers already gathered.",
      schedule: "20 4 * * *",
    },
    {
      jobKey: JOBS.improvementsRecheck,
      displayName: "Improvements re-check",
      description: "Daily: measures again every improvement whose re-check date has come and records improved, no change or worse with both numbers; opens an improvement for a pinned fact that describes how a tool behaves.",
      schedule: "40 4 * * *",
    },
    {
      jobKey: JOBS.credentialsCheck,
      displayName: "Credentials check",
      description: "Daily: calls each provider it has a company secret for (one read-only request, never storing the value) and settles the expiry alerts: 30 days, 7 days, expired, refused. Loads Partners in Biz's own starting entries only for the company that ticked \"Load Partners in Biz's own credentials list\".",
      schedule: "50 3 * * *",
    },
    {
      jobKey: JOBS.acceptanceNightly,
      displayName: "Nightly acceptance request",
      description: "Every night, for each company that staffed an Acceptance agent: opens one request for it to work the nightly journey (a lead captured and qualified on the canary client). Does nothing for a company with no Acceptance agent.",
      schedule: "40 2 * * *",
    },
    {
      jobKey: JOBS.businessReview,
      displayName: "Weekly business review",
      description: "Mondays before the Weekly retro: records each active goal's number and opens one business review issue for the Operator comparing the week's actuals to the targets.",
      schedule: "30 4 * * 1",
    },
  ],
  apiRoutes: [
    // Read by the Cockpit page itself and the Setup plugin (kit contracts).
    { ...COCKPIT_ROUTE },
    { ...SETUP_STATUS_ROUTE },
  ],
  routines: [
    {
      routineKey: ROUTINES.daily,
      title: ROUTINE_TITLES[ROUTINES.daily],
      description: DAILY_ROUTINE_DESCRIPTION,
      status: "active",
      priority: "high",
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        { kind: "schedule", label: "Daily 07:00 SAST", enabled: true, cronExpression: "0 7 * * *", timezone: "Africa/Johannesburg", signingMode: null, replayWindowSec: null },
      ],
    },
    {
      routineKey: ROUTINES.weekly,
      title: ROUTINE_TITLES[ROUTINES.weekly],
      description: WEEKLY_ROUTINE_DESCRIPTION,
      status: "active",
      priority: "medium",
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        { kind: "schedule", label: "Mondays 08:00 SAST", enabled: true, cronExpression: "0 8 * * 1", timezone: "Africa/Johannesburg", signingMode: null, replayWindowSec: null },
      ],
    },
  ],
  skills: SKILLS,
  ui: {
    slots: [
      { type: "page", id: "cockpit-page", displayName: "Cockpit", exportName: "CockpitPage", routePath: "cockpit" },
      { type: "sidebar", id: "cockpit-sidebar", displayName: "Cockpit", exportName: "CockpitSidebar", order: 5 },
      // Grouped navigation (pib-plugin-ui NAV_GROUPS): member plugins hide their own rows while these exist.
      { type: "sidebar", id: "pib-nav-clients", displayName: "Clients", exportName: "ClientsNav", order: 6 },
      { type: "sidebar", id: "pib-nav-marketing", displayName: "Marketing", exportName: "MarketingNav", order: 7 },
      { type: "sidebar", id: "pib-nav-finance", displayName: "Finance", exportName: "FinanceNav", order: 8 },
      { type: "dashboardWidget", id: "cockpit-today", displayName: "Company today", exportName: "CompanyTodayWidget" },
    ],
  },
};

export default manifest;
