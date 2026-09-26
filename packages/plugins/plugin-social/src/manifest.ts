import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { buildInstanceConfigSchema, DEFAULT_TIMEZONE } from "./config.js";
import { PLAN_ROUTINE_KEY, PLUGIN_ID, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY } from "./platforms.js";
import { DESIRED_SKILLS, PLAN_ROUTINE_DESCRIPTION, SKILLS, SOCIAL_AGENT_INSTRUCTIONS } from "./skills.js";
import { SOCIAL_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Social",
  description:
    "Connect client social accounts (Meta, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon, Dribbble), draft and approve posts, and publish them on schedule with retries. " +
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
    "issues.wakeup",
    "issue.comments.create",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "jobs.schedule",
    "events.subscribe",
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
  ],
  agents: [
    {
      agentKey: SOCIAL_AGENT_KEY,
      displayName: "Social Media Manager",
      role: "general",
      title: "Social Media Manager",
      icon: "megaphone",
      capabilities:
        "Plans, drafts and schedules social posts for Partners in Biz clients across 12 platforms, fixes failed posts, and works the social inbox through the Social plugin tools.",
      adapterType: "hermes_local",
      adapterPreference: ["hermes_local", "claude_local"],
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
      description: "Social publishing work: failed posts, account reconnects and the weekly planning routine.",
      status: "in_progress",
      color: "#db2777",
    },
  ],
  routines: [
    {
      routineKey: PLAN_ROUTINE_KEY,
      title: "Plan next week's social",
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
