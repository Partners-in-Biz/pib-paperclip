import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/namespace.js";
import packageJson from "../package.json" with { type: "json" };

// Hardcoded valid list of plugin capabilities from @paperclipai/shared
const VALID_CAPABILITIES = [
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "execution.workspaces.read",
  "issues.read",
  "issue.relations.read",
  "issue.subtree.read",
  "issue.comments.read",
  "issue.interactions.read",
  "issue.attachments.read",
  "approvals.read",
  "issue.documents.read",
  "agents.read",
  "goals.read",
  "goals.create",
  "goals.update",
  "activity.read",
  "costs.read",
  "issues.orchestration.read",
  "access.members.read",
  "access.invites.read",
  "authorization.grants.read",
  "authorization.policies.read",
  "authorization.audit.read",
  "database.namespace.read",
  "issues.create",
  "issues.update",
  "issue.relations.write",
  "issues.checkout",
  "issues.wakeup",
  "issue.comments.create",
  "issue.comments.create_human_attributed",
  "issue.interactions.create",
  "issue.interactions.respond",
  "approvals.respond",
  "issue.documents.write",
  "projects.managed",
  "routines.managed",
  "skills.managed",
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agents.managed",
  "access.members.write",
  "access.invites.write",
  "authorization.grants.write",
  "authorization.policies.write",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  "database.namespace.migrate",
  "database.namespace.write",
  "external.objects.detect",
  "external.objects.read",
  "external.objects.write",
  "external.objects.refresh",
  "plugin.state.read",
  "plugin.state.write",
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "secrets.read-ref",
  "environment.drivers.register",
  "local.folders",
  "agent.tools.register",
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.commentAnnotation.register",
  "ui.action.register",
];

describe("CRM Telephony manifest", () => {
  it("version in manifest matches package.json", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("id matches namespace PLUGIN_ID", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
  });

  it("capabilities are subset of valid capabilities", () => {
    const invalid = manifest.capabilities?.filter((c) => !VALID_CAPABILITIES.includes(c)) ?? [];
    expect(invalid).toEqual([]);
  });

  it("webhooks have endpointKey, displayName, and description", () => {
    const webhooks = manifest.webhooks ?? [];
    for (const webhook of webhooks) {
      expect(webhook.endpointKey).toBeTruthy();
      expect(webhook.displayName).toBeTruthy();
      expect(webhook.description).toBeTruthy();
    }
  });

  it("jobs have jobKey, displayName, and schedule", () => {
    const jobs = manifest.jobs ?? [];
    for (const job of jobs) {
      expect(job.jobKey).toBeTruthy();
      expect(job.displayName).toBeTruthy();
      expect(job.schedule).toBeTruthy();
    }
  });

  it("database namespace is configured correctly", () => {
    expect(manifest.database?.namespaceSlug).toBe("crm_telephony");
    expect(manifest.database?.migrationsDir).toBe("migrations");
  });

  it("has no secrets in source code matching Twilio patterns", () => {
    // Regex to match Twilio credential patterns
    const acSidPattern = /AC[0-9a-f]{32}/g;
    const skPattern = /SK[0-9a-f]{32}/g;

    const sourceContent = JSON.stringify(manifest);
    const acMatches = sourceContent.match(acSidPattern) ?? [];
    const skMatches = sourceContent.match(skPattern) ?? [];

    expect(acMatches).toHaveLength(0);
    expect(skMatches).toHaveLength(0);
  });
});
