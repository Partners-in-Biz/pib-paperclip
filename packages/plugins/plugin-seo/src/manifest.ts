import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { instanceConfigSchema } from "./config.js";
import {
  AGENT_CAPABILITIES,
  AGENT_DISPLAY_NAME,
  AGENT_KEY,
  DAILY_JOB_KEY,
  DAILY_ROUTINE_KEY,
  PROJECT_KEY,
  SKILL_CANONICAL_KEY,
  WEEKLY_JOB_KEY,
  WEEKLY_ROUTINE_KEY,
} from "./constants.js";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { SEO_TOOLS } from "./tools.js";

export const AGENT_INSTRUCTIONS = `# SEO Specialist — Partners in Biz

You run 90-day SEO sprints for Partners in Biz's own sites and for its clients (one sprint per site). A client is a CRM company or a CRM contact (sole trader); a sprint without a client is PiB's own. Your skill **pib-seo-sprint** holds the operating procedure, the playbook for every task and the tool reference. Read it before your first run and follow it.

How work reaches you:
- The SEO plugin opens a Paperclip issue for every sprint task on the day it is due (a sub-issue of "SEO sprint: <site> (<client>)" in the SEO project) and wakes you for the ones assigned to you. The description has the goal, steps, tools and definition of done, plus the sprintId and taskId.
- The "Run today's SEO" routine asks you to sweep every active sprint; "Weekly SEO review" asks you to review optimization proposals.

Non-negotiables:
- Run the sprint end to end yourself. Code and content tasks open in the site's repo project: branch, PR, checks, preview verification, and merge SEO-scope changes when \`check-change-scope\` says merge. Search Console runs through the service account (\`gsc-verification-token\` → repo → \`gsc-verify-site\`), crawling through \`request-indexing\`, Bing through its API.
- A person is only for a true one-time grant or judgement. Those go on the sprint's weekly **Needs you** issue (\`block-task\` / \`needs-you-add\`) with exact steps, links and copy-ready text — never "ask the owner to connect it".
- Use the \`partnersinbiz.seo\` tools for every record. Close tasks with \`complete-task\` and real evidence (PR, commit, check output).
- Never invent rankings, volumes, DR or traffic numbers.
- Keep each sprint in its scope: pass the sprint's \`client\` on, and never reuse one client's data, copy or accounts for another client or for PiB's own sites.
- In safe autopilot, anything that publishes, sends or changes the live site on a sign-off task goes to the owner for approval first.
- Post a digest on each sprint root issue you worked (\`post-digest\`).
`;

const DAILY_ROUTINE_DESCRIPTION = `Run today's SEO work across every active sprint.

Procedure:
1. Call partnersinbiz.seo:today with no sprintId. It lists every active sprint with due, in-progress and blocked tasks (with issue ids), proposals, integration status and next steps.
2. For each sprint, in order of the oldest due week: work the agent tasks assigned to you using each issue's playbook (skill pib-seo-sprint, references/outrank-90.md). Finish in-progress tasks before starting new ones.
3. Close each finished task with partnersinbiz.seo:complete-task (summary, PR/commit links, check output). Only for a true one-time grant or judgement call partnersinbiz.seo:block-task with a precise humanAsk (review: true for sign-off); it lands on the sprint's weekly Needs you issue. Do not redo tasks already waiting there.
4. Follow each sprint's next steps from today: verify Search Console yourself with the service account, link the site repo if you know its project (link-site), request indexing, set up Bing. Items already on Needs you close on their own once done.
5. Never invent numbers. Positions update automatically from GSC each morning.
6. For each sprint you touched, call partnersinbiz.seo:post-digest with what you did, what moved (real numbers) and what waits on whom.
7. Close this routine issue with a one-line summary per sprint.`;

const WEEKLY_ROUTINE_DESCRIPTION = `Weekly SEO review across active sprints (the seo-weekly job ran the detectors at 07:00 SAST).

Procedure:
1. partnersinbiz.seo:list-sprints status active (and compounding).
2. For each sprint: partnersinbiz.seo:list-optimizations status proposed, then partnersinbiz.seo:detect-signals (propose false) for context.
3. Check each proposal's evidence yourself (gsc-query, crawler-sim, run-pagespeed, list-keywords). Comment your recommendation (approve / reject and why) on the proposal's approval issue.
4. Approve with partnersinbiz.seo:approve-optimization only when the sprint's autopilot is full; otherwise leave the decision to the owner.
5. Review measured optimizations (list-optimizations status measured) and note wins and losses in a post-digest on the sprint root issue.
6. Close this routine issue with a summary: proposals per sprint, your recommendations, results measured this week.`;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.6.1",
  displayName: "SEO",
  description: "90-day SEO sprints: the Outrank-90 plan as Paperclip issues, Search Console rankings, site checks, audits and an optimization loop, worked by an SEO Specialist agent hired through a normal Paperclip task.",
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
    "agents.read",
    "agents.managed",
    "projects.read",
    "project.workspaces.read",
    "projects.managed",
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
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "seo", migrationsDir: "migrations", coreReadTables: ["heartbeat_runs"] },
  tools: SEO_TOOLS,
  jobs: [
    {
      jobKey: DAILY_JOB_KEY,
      displayName: "Daily SEO run",
      description: "Hourly check; once per sprint per day after the configured local hour: sprint clock, Search Console/PageSpeed/Bing pulls, audit snapshots, due task issues, measurements, issue sync.",
      schedule: "5 * * * *",
    },
    {
      jobKey: WEEKLY_JOB_KEY,
      displayName: "Weekly SEO review",
      description: "Mondays 07:00 SAST: detectors, health, capped optimization proposals and one approval issue per sprint.",
      schedule: "0 5 * * 1",
    },
  ],
  apiRoutes: [
    {
      routeKey: "oauth-start",
      method: "GET",
      path: "/oauth/start",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "oauth-complete",
      method: "POST",
      path: "/oauth/complete",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      // Read by the CRM client workspace: `?companyId=&kind=company|contact&id=<crm id>`.
      routeKey: "client-summary",
      method: "GET",
      path: "/client-summary",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    // Read by the Setup plugin: this company's setup checklist (kit SetupStatus).
    { ...SETUP_STATUS_ROUTE },
  ],
  // Kept so agents activated before hiring moved to tasks (host-managed) are
  // still found. New agents are hired through a task; see service/hire.ts.
  agents: [
    {
      agentKey: AGENT_KEY,
      displayName: AGENT_DISPLAY_NAME,
      role: "general",
      title: AGENT_DISPLAY_NAME,
      icon: "search",
      capabilities: AGENT_CAPABILITIES,
      adapterType: "hermes_local",
      adapterPreference: ["hermes_local", "claude_local"],
      adapterConfig: { paperclipSkillSync: { desiredSkills: [SKILL_CANONICAL_KEY] } },
      permissions: { pluginTools: [PLUGIN_ID, "partnersinbiz.social", "partnersinbiz.crm"] },
      status: "paused",
      budgetMonthlyCents: 0,
      instructions: { entryFile: "AGENTS.md", content: AGENT_INSTRUCTIONS },
    },
  ],
  projects: [
    {
      projectKey: PROJECT_KEY,
      displayName: "SEO",
      description: "90-day SEO sprints. Each sprint has a root issue; every due sprint task is a sub-issue.",
      status: "in_progress",
      color: "#16a34a",
    },
  ],
  routines: [
    {
      routineKey: DAILY_ROUTINE_KEY,
      title: "Run today's SEO",
      description: DAILY_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "medium",
      assigneeRef: { resourceKind: "agent", resourceKey: AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        { kind: "schedule", label: "Daily 06:30 SAST", enabled: false, cronExpression: "30 6 * * *", timezone: "Africa/Johannesburg", signingMode: null, replayWindowSec: null },
      ],
    },
    {
      routineKey: WEEKLY_ROUTINE_KEY,
      title: "Weekly SEO review",
      description: WEEKLY_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "medium",
      assigneeRef: { resourceKind: "agent", resourceKey: AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        { kind: "schedule", label: "Mondays 07:00 SAST", enabled: false, cronExpression: "0 7 * * 1", timezone: "Africa/Johannesburg", signingMode: null, replayWindowSec: null },
      ],
    },
  ],
  skills: SKILLS,
  ui: {
    slots: [
      { type: "page", id: "seo-page", displayName: "SEO", exportName: "SeoPage", routePath: "seo" },
      { type: "sidebar", id: "seo-sidebar", displayName: "SEO", exportName: "SeoSidebar", order: 44 },
    ],
  },
};

export default manifest;
