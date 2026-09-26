import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { JOBS, PLUGIN_KEY, ROUTINES, ROUTINE_TITLES, SKILL_SLUGS, VERSION } from "./constants.js";
import { SKILLS } from "./skills.js";
import { COCKPIT_TOOLS, TOOL_NAMES } from "./tools.js";

export { JOBS, VERSION };

const tool = (name: string) => `${PLUGIN_KEY}:${name}`;

export const DAILY_ROUTINE_DESCRIPTION = `Daily operations review. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)}.
2. Health first: follow each problem's fix; hand broken work to the agent that owns it and wake it. Comment what you did on the System health issue.
3. Unblock agents: answer from context, reassign, or hand off. Only a real grant or decision goes to the owner.
4. Check everything waiting on the owner. If an agent could do it, hand it to that agent.
5. Make sure today's important work has an agent and is not blocked.
6. Post the Daily brief with ${tool(TOOL_NAMES.postBrief)}: done yesterday, waiting on you (with links), risks, today's plan. Short.
7. Close this issue with one line: fixed, handed off, waiting on the owner.

Never approve money or legal items, never change budgets, never send or publish anything yourself.`;

export const WEEKLY_ROUTINE_DESCRIPTION = `Weekly retro. Follow the ${SKILL_SLUGS.operator} skill.

1. Call ${tool(TOOL_NAMES.brief)} with windowHours 168, and ${tool(TOOL_NAMES.scorecards)}.
2. Post a "Weekly retro" with ${tool(TOOL_NAMES.postBrief)}: what worked, what failed, one scorecard line per agent (runs, failures, spend vs budget, key quality metric), and at most 3 proposals (mark the ones that need the owner's yes).
3. Carry out the proposals that do not need the owner, then close this issue.`;

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Cockpit settings",
  description:
    "The Cockpit page saves this for you the first time you save the team. Saving is what lets the hourly jobs keep the System health issue and the team roles up to date for this company.",
  properties: {
    healthIssue: {
      type: "boolean",
      title: "System health issue",
      description: "Keep one open issue listing current problems (bad checks, plugins not reporting, agents in error or at 80% of budget). It closes itself when all is ok.",
      default: true,
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: VERSION,
  displayName: "Cockpit",
  description:
    "One place to run the company: what waits on you, what the agents did, money, pipeline, marketing, delivery, agent cost and quality, and system health. Owns the Operator (chief of staff) and Reviewer roles.",
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
      description: "Every hour, re-sends each company's Operator, Reviewer and owner to the other plugins (events can be lost), and links hires whose agent appeared.",
      schedule: "10 * * * *",
    },
    {
      jobKey: JOBS.healthAlerts,
      displayName: "System health check",
      description: "Every hour: opens, updates or closes one System health issue per company (bad checks, plugins not reporting, agents in error or at 80% of budget).",
      schedule: "20 * * * *",
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
      { type: "dashboardWidget", id: "cockpit-today", displayName: "Company today", exportName: "CompanyTodayWidget" },
    ],
  },
};

export default manifest;
