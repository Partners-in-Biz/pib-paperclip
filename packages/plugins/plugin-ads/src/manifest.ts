import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { buildInstanceConfigSchema } from "./config.js";
import { ADS_PROJECT_KEY, PLUGIN_ID, PLUGIN_VERSION } from "./platforms.js";
import { SKILLS } from "./skills.js";
import { ADS_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Paid ads",
  description:
    "Reads Meta and Google Ads performance into daily rollups and an append-only spend ledger for PiB's own ads and each client's, with monthly budget caps, pacing and anomaly alerts. " +
    "Every campaign or budget change is a proposal with the numbers that goes to the Reviewer and then a person (and the client, through the CRM, where the scope asks): nothing that spends money runs without a recorded human approval, and changes are off until a person switches them on for the company and the scope. " +
    "OAuth redirect URI for Meta and Google (shown on the Ads page): <publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html",
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
    "agents.read",
    "projects.managed",
    "projects.read",
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
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "ads", migrationsDir: "migrations" },
  tools: ADS_TOOLS,
  jobs: [
    {
      jobKey: "sync-insights",
      displayName: "Read ad numbers",
      description: "Reads campaigns and the last days of spend, impressions, clicks and conversions from Meta and Google Ads (read-only), updates the daily rollups and the spend ledger, then looks for spend spikes, no delivery, cost per result over target and budget caps nearly used. Never changes an ad.",
      schedule: "11 */3 * * *",
    },
    {
      jobKey: "refresh-connections",
      displayName: "Keep sign-ins alive",
      description: "Renews tokens before they lapse (Meta's long-lived token within 10 days of the end, Google's access token within minutes), flags a sign-in that must be done again, resolves old alerts.",
      schedule: "37 * * * *",
    },
    {
      jobKey: "setup-status",
      displayName: "Report setup status",
      description: "Tells the Setup plugin what Paid ads still needs and sends the Cockpit snapshot for each company; expires proposals nobody decided in 7 days; brings the ads skill up to date for every company.",
      schedule: "23 * * * *",
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
    // Read by the Setup plugin: this company's setup checklist (kit SetupStatus).
    { ...SETUP_STATUS_ROUTE },
    // Read by the Cockpit plugin: this company's ads snapshot (kit CockpitSnapshot).
    { ...COCKPIT_ROUTE },
  ],
  projects: [
    {
      projectKey: ADS_PROJECT_KEY,
      displayName: "Paid ads",
      description: "PiB's own paid-ads work: anomaly alerts, change proposals awaiting a decision, and approved changes to run. A client's ads issues open in the client's own project.",
      status: "in_progress",
      color: "#7c3aed",
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
      { type: "page", id: "ads-page", displayName: "Paid ads", exportName: "AdsPage", routePath: "ads" },
      { type: "sidebar", id: "ads-sidebar", displayName: "Paid ads", exportName: "AdsSidebar", order: 44 },
    ],
  },
};

export default manifest;
