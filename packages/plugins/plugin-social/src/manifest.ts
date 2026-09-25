import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { SOCIAL_PUBLISH_SKILL } from "./skills.js";
import { SOCIAL_TOOLS } from "./tools.js";
import { ALL_PLATFORMS, PLATFORM_LABELS } from "./oauth/types.js";

function platformSchema(clientLabel: string): JsonSchema {
  return {
    type: "object",
    title: clientLabel,
    properties: {
      clientId: { type: "string", title: "Client ID / App ID" },
      clientSecret: { type: "string", title: "Client secret (or app password)" },
      extra: {
        type: "object",
        title: "Extra options (per platform)",
        description: "mastodon: instance (e.g. https://mastodon.social)",
        additionalProperties: { type: "string" },
      },
    },
  };
}

const platformsProps: Record<string, JsonSchema> = {};
for (const platform of ALL_PLATFORMS) {
  platformsProps[platform] = platformSchema(PLATFORM_LABELS[platform]);
}

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Social integrations",
  description:
    "OAuth app credentials for each platform you want to connect. The authorization callback URL to register in each developer console is: <this-instance>/social/oauth/callback. Client secrets are stored in the plugin config; account tokens are encrypted at rest.",
  properties: {
    social: {
      type: "object",
      properties: {
        publicBaseUrl: {
          type: "string",
          title: "Public base URL",
          description: "e.g. https://paperclip.65.108.146.144.sslip.io (optional; auto-detected from requests).",
        },
        encryptionSecret: {
          type: "string",
          title: "Token encryption secret",
          description: "A strong passphrase used to encrypt stored OAuth tokens. Changing it invalidates stored tokens.",
        },
        platforms: { type: "object", title: "Platform app credentials", properties: platformsProps },
      },
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Social",
  description: "Draft, review, and publish posts to org or personal accounts.",
  author: "Partners in Biz",
  categories: ["automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
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
      description: "Publishes due scheduled posts to each connected destination via the platform API.",
      schedule: "*/5 * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "oauth-start",
      method: "GET",
      path: "/oauth/:platform/start",
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
  ],
  skills: [
    {
      skillKey: "social-publish",
      displayName: "Social publish",
      slug: "social-publish",
      description: "Draft, review, and schedule posts across connected platforms.",
      markdown: SOCIAL_PUBLISH_SKILL,
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "social-page", displayName: "Social", exportName: "SocialPage", routePath: "social" },
      { type: "sidebar", id: "social-sidebar", displayName: "Social", exportName: "SocialSidebar", order: 41 },
    ],
  },
};

export default manifest;
