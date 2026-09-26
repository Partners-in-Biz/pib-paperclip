import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { buildInstanceConfigSchema, DEFAULT_TIMEZONE } from "./config.js";
import { SOCIAL_AGENT_CAPABILITIES, SOCIAL_AGENT_ICON, SOCIAL_AGENT_NAME, SOCIAL_HIRE_ROLE } from "./hire.js";
import { PLAN_ROUTINE_KEY, PLUGIN_ID, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY } from "./platforms.js";
import { DESIRED_SKILLS, PLAN_ROUTINE_DESCRIPTION, PLAN_ROUTINE_TITLE, SKILLS, SOCIAL_AGENT_INSTRUCTIONS } from "./skills.js";
import { SOCIAL_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.5.1",
  displayName: "Social",
  description:
    "Connect social accounts for PiB's own work or for one CRM client (company or contact) at a time (Meta, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon, Dribbble), draft and approve posts, and publish them on schedule with retries. Jev inbox triage; Growth Lab scores, experiments and playbook. " +
    "OAuth redirect URI for every provider (shown on the Social page): <publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html",
  author: "Partners in Biz",
  categories: ["connector", "automation", "ui"],
  instanceConfigSchema: buildInstanceConfigSchema(),
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "agents.managed",
    "agents.read",
    "projects.managed",
    "routines.managed",
    "authorization.grants.read",
    "authorization.grants.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "social",
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs"],
  },
  tools: SOCIAL_TOOLS,
  jobs: [
    {
      jobKey: "publish-due",
      displayName: "Publish due posts",
      description: "Publishes scheduled posts to each destination, retrying failures after 1, 5, 15 and 60 minutes.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "refresh-tokens",
      displayName: "Refresh account tokens",
      description: "Refreshes tokens that expire within 48 hours (10 days for long-lived Meta tokens) and flags accounts that need reconnecting.",
      schedule: "7 * * * *",
    },
    {
      jobKey: "collect-metrics",
      displayName: "Collect post metrics",
      description: "Snapshots engagement 1 hour, 24 hours, 7 days and 30 days after publishing.",
      schedule: "12,42 * * * *",
    },
    {
      jobKey: "poll-inbox",
      displayName: "Poll social inbox",
      description: "Pulls comments on recent posts and mentions into the social inbox.",
      schedule: "3,18,33,48 * * * *",
    },
    {
      jobKey: "poll-rss",
      displayName: "Poll RSS feeds",
      description: "Turns new RSS/Atom items into draft posts for review.",
      schedule: "9,24,39,54 * * * *",
    },
    {
      jobKey: "score-posts",
      displayName: "Score posts (Growth Lab)",
      description: "Scores each post's 7-day engagement against the account's trailing 30-day median and tags post features (in code, plus one Jev call per post when a key is set).",
      schedule: "25 3 * * *",
    },
    {
      jobKey: "measure-experiments",
      displayName: "Measure experiments (Growth Lab)",
      description: "Measures running experiments once each arm has its 7-day scores (or after 21 days), updates the scoreboard and drafts playbook changes.",
      schedule: "50 3 * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "oauth-complete",
      method: "POST",
      path: "/oauth/complete",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      // Read by the CRM client workspace: ?companyId=&kind=company|contact&id=<crm id>.
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
  // Kept so agents activated before hiring moved to tasks are still found
  // (ctx.agents.managed.get). New agents are hired through a task (src/hire.ts);
  // the plugin never calls managed.reconcile.
  agents: [
    {
      agentKey: SOCIAL_AGENT_KEY,
      displayName: SOCIAL_AGENT_NAME,
      role: "general",
      title: SOCIAL_AGENT_NAME,
      icon: SOCIAL_AGENT_ICON,
      capabilities: SOCIAL_AGENT_CAPABILITIES,
      adapterType: "hermes_local",
      adapterPreference: SOCIAL_HIRE_ROLE.adapterPreference,
      adapterConfig: {
        paperclipSkillSync: { desiredSkills: DESIRED_SKILLS },
      },
      permissions: { pluginTools: [PLUGIN_ID, "partnersinbiz.crm"] },
      status: "paused",
      budgetMonthlyCents: 0,
      instructions: { entryFile: "AGENTS.md", content: SOCIAL_AGENT_INSTRUCTIONS },
    },
  ],
  projects: [
    {
      projectKey: SOCIAL_PROJECT_KEY,
      displayName: "Social",
      description: "Social publishing work: failed posts, account reconnects, inbox replies, Growth Lab approvals and the weekly review routine.",
      status: "in_progress",
      color: "#db2777",
    },
  ],
  routines: [
    {
      routineKey: PLAN_ROUTINE_KEY,
      title: PLAN_ROUTINE_TITLE,
      description: PLAN_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "medium",
      assigneeRef: { resourceKind: "agent", resourceKey: SOCIAL_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: SOCIAL_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        {
          kind: "schedule",
          label: "Mondays 07:00",
          enabled: false,
          cronExpression: "0 7 * * 1",
          timezone: DEFAULT_TIMEZONE,
          signingMode: null,
          replayWindowSec: null,
        },
      ],
      issueTemplate: { originId: "routine:plan-next-week" },
    },
  ],
  skills: SKILLS.map((skill) => ({
    skillKey: skill.skillKey,
    displayName: skill.displayName,
    slug: skill.slug,
    description: skill.description,
    markdown: skill.markdown,
    files: skill.files,
  })),
  ui: {
    slots: [
      { type: "page", id: "social-page", displayName: "Social", exportName: "SocialPage", routePath: "social" },
      { type: "sidebar", id: "social-sidebar", displayName: "Social", exportName: "SocialSidebar", order: 41 },
    ],
  },
};

export default manifest;
