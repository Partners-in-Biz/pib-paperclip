import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, MEMORY_TOOLS, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { JOBS, PLUGIN_KEY, ROUTINES, ROUTINE_TITLES, SKILL_SLUGS, VERSION } from "./constants.js";
import { SKILLS } from "./skills.js";
import { COCKPIT_TOOLS, TOOL_NAMES } from "./tools.js";

export { JOBS, VERSION };

const tool = (name: string) => `${PLUGIN_KEY}:${name}`;

export const DAILY_ROUTINE_DESCRIPTION = `Daily operations review. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)}.
2. Health first: follow each problem's fix; hand broken work to the agent that owns it and wake it. Comment what you did on the System health issue.
3. Check the team: routines on, roles staffed (Setup → Team), questions to the owner answered (\`asks\`, oldest first on the brief).
4. Route every unassigned issue (\`unassigned\`) to the agent in the role that owns the work.
5. Unblock agents: answer from context, reassign, or hand off. Only a real grant or decision goes to the owner, with ${tool(TOOL_NAMES.askOwner)}.
6. Check everything waiting on the owner. If an agent could do it, hand it to that agent.
7. Make sure today's important work has an agent and is not blocked.
8. Post the Daily brief with ${tool(TOOL_NAMES.postBrief)}: done yesterday, waiting on you (questions first, with links), risks, today's plan. Short.
9. Close this issue with one line: fixed, handed off, waiting on the owner.

Never approve money or legal items, never change budgets, never send or publish anything yourself.`;

export const WEEKLY_ROUTINE_DESCRIPTION = `Weekly retro. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)} with windowHours 168, and ${tool(TOOL_NAMES.scorecards)}.
2. Call ${tool(MEMORY_TOOLS.review)}. Merge likely duplicates (keep the better one, mark the other superseded), fix or archive noisy and wrong facts, move company-wide facts that name a client to that client, and note how briefs did.
3. Post a "Weekly retro" with ${tool(TOOL_NAMES.postBrief)}: what worked, what failed, one scorecard line per agent (runs, failures, spend vs budget, key quality metric), one line on company memory (facts, briefs, feedback), and at most 3 proposals (mark the ones that need the owner's yes).
4. Carry out the proposals that do not need the owner, then close this issue.`;

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Cockpit settings",
  description:
    "Save this once for each company. Saving is what lets the Cockpit act for that company on its own: the hourly System health issue and team roles, answers to agents' questions, client onboarding, and the CRM client list company memory uses.",
  properties: {
    healthIssue: {
      type: "boolean",
      title: "System health issue",
      description: "Keep one open issue listing current problems (bad checks, plugins not reporting, agents in error or at 80% of budget). It closes itself when all is ok.",
      default: true,
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
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
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
  database: { namespaceSlug: "cockpit", migrationsDir: "migrations", coreReadTables: ["issues", "heartbeat_runs"] },
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
      description: "Every hour: opens, updates or closes one System health issue per company (bad checks, warnings older than a day, plugins not reporting, agents in error or at 80% of budget), and settles questions to the owner whose reply was missed.",
      schedule: "20 * * * *",
    },
    {
      jobKey: JOBS.memoryUpkeep,
      displayName: "Company memory upkeep",
      description: "Daily: archives facts past their expiry date, and keeps each client and area under its cap by archiving the least useful unpinned facts (never deleted).",
      schedule: "30 1 * * *",
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
