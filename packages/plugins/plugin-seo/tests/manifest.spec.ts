import { describe, expect, it } from "vitest";
import { HANDLERS } from "../src/dispatch.js";
import manifest from "../src/manifest.js";
import { SKILL_CANONICAL_KEY } from "../src/constants.js";
import { OUTRANK_DOC, SKILLS, TOOLS_DOC } from "../src/skills.js";
import { OUTRANK_90 } from "../src/templates/outrank-90.js";
import { SEO_TOOLS } from "../src/tools.js";

describe("manifest", () => {
  it("declares the capabilities every host call needs", () => {
    for (const cap of [
      "issues.create", "issues.read", "issues.update", "issues.wakeup", "issue.comments.create", "events.subscribe", "events.emit",
      "agents.managed", "agents.read", "projects.managed", "routines.managed", "skills.managed",
      "authorization.grants.read", "authorization.grants.write", "secrets.read-ref", "http.outbound",
      "api.routes.register", "jobs.schedule", "plugin.state.read", "plugin.state.write", "companies.read",
      "database.namespace.migrate", "database.namespace.read", "database.namespace.write", "agent.tools.register",
    ]) {
      expect(manifest.capabilities, cap).toContain(cap);
    }
    expect(manifest.database?.coreReadTables).toEqual(["heartbeat_runs"]);
  });

  it("schedules the daily and weekly jobs", () => {
    expect(manifest.jobs?.map((j) => [j.jobKey, j.schedule])).toEqual([["seo-daily", "5 * * * *"], ["seo-weekly", "0 5 * * 1"]]);
  });

  it("declares the OAuth, client-summary and setup-status routes with company resolution", () => {
    expect(manifest.apiRoutes).toEqual([
      expect.objectContaining({ routeKey: "oauth-start", method: "GET", path: "/oauth/start", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
      expect.objectContaining({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", auth: "board", companyResolution: { from: "body", key: "companyId" } }),
      expect.objectContaining({ routeKey: "client-summary", method: "GET", path: "/client-summary", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }),
      expect.objectContaining({ routeKey: "setup-status", method: "GET", path: "/setup-status", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
    ]);
    expect(manifest.version).toBe("0.6.1");
  });

  it("uses secret-ref fields without a type", () => {
    const props = (manifest.instanceConfigSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const key of ["encryptionKey", "pagespeedApiKey", "bingApiKey"]) {
      expect(props[key]!.format).toBe("secret-ref");
      expect(props[key]!.type).toBeUndefined();
    }
    const google = props.google as { properties: Record<string, Record<string, unknown>> };
    expect(google.properties.clientSecret!.format).toBe("secret-ref");
    expect(google.properties.clientSecret!.type).toBeUndefined();
    expect(props.timezone!.default).toBe("Africa/Johannesburg");
    expect(props.defaultAutopilotMode!.default).toBe("safe");
    expect(props.dailyHourLocal!.default).toBe(6);
  });

  it("declares the paused SEO Specialist with the skill synced", () => {
    const agent = manifest.agents![0]!;
    expect(SKILL_CANONICAL_KEY).toBe("plugin/partnersinbiz-seo/seo-sprint");
    expect(agent).toMatchObject({
      agentKey: "seo-specialist",
      displayName: "SEO Specialist",
      adapterType: "hermes_local",
      adapterPreference: ["hermes_local", "claude_local"],
      adapterConfig: { paperclipSkillSync: { desiredSkills: [SKILL_CANONICAL_KEY] } },
      status: "paused",
      budgetMonthlyCents: 0,
    });
    expect(agent.instructions?.entryFile).toBe("AGENTS.md");
    expect(manifest.projects).toEqual([expect.objectContaining({ projectKey: "seo", displayName: "SEO" })]);
  });

  it("declares paused routines with disabled SAST triggers", () => {
    const routines = manifest.routines!;
    expect(routines.map((r) => r.title)).toEqual(["Run today's SEO", "Weekly SEO review"]);
    for (const routine of routines) {
      expect(routine).toMatchObject({ status: "paused", concurrencyPolicy: "skip_if_active", catchUpPolicy: "skip_missed" });
      expect(routine.assigneeRef).toEqual({ resourceKind: "agent", resourceKey: "seo-specialist" });
      expect(routine.projectRef).toEqual({ resourceKind: "project", resourceKey: "seo" });
      expect(routine.triggers?.[0]).toMatchObject({ kind: "schedule", enabled: false, timezone: "Africa/Johannesburg" });
    }
    expect(routines[0]!.triggers![0]!.cronExpression).toBe("30 6 * * *");
    expect(routines[1]!.triggers![0]!.cronExpression).toBe("0 7 * * 1");
  });
});

describe("tools", () => {
  it("has a handler for every declared tool and nothing undeclared", () => {
    expect(SEO_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(HANDLERS).sort());
    expect(new Set(SEO_TOOLS.map((t) => t.name)).size).toBe(SEO_TOOLS.length);
    expect(manifest.tools).toEqual(SEO_TOOLS);
  });

  it("keeps the old tool names working", () => {
    for (const name of ["create-sprint", "record-rank", "record-audit", "open-task", "add-keyword", "add-page", "rank-history", "audit-summary"]) {
      expect(HANDLERS[name], name).toBeDefined();
    }
  });
});

describe("skill", () => {
  const skill = SKILLS[0]!;
  it("is the pib- prefixed multi-file skill", () => {
    expect(skill).toMatchObject({ skillKey: "seo-sprint", slug: "pib-seo-sprint" });
    expect(skill.markdown).toMatch(/^---\nname: pib-seo-sprint\nslug: pib-seo-sprint\n/);
    expect(skill.files?.map((f) => f.path)).toEqual(["references/outrank-90.md", "references/optimization-loop.md", "references/tools.md", "references/site-changes.md"]);
    expect(skill.markdown).toContain("complete-task");
    expect(skill.markdown).toContain("Never invent data");
  });

  it("has a playbook section for all 42 tasks and documents every tool", () => {
    for (const task of OUTRANK_90.tasks) {
      expect(OUTRANK_DOC).toContain(`### ${task.title}`);
      expect(OUTRANK_DOC).toContain(`\`${task.templateKey}\``);
    }
    for (const tool of SEO_TOOLS) expect(TOOLS_DOC).toContain(`### ${tool.name}`);
  });
});
