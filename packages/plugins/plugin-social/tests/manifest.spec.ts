import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { SKILLS, DESIRED_SKILLS } from "../src/skills.js";
import { SOCIAL_TOOLS } from "../src/tools.js";

type SafeParse = { safeParse(value: unknown): { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

/** The host's own manifest schema (read-only, loaded at runtime so tsc keeps its rootDir). */
async function hostManifestSchema(): Promise<SafeParse> {
  const url = new URL("../../../shared/src/validators/plugin.ts", import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ url)) as { pluginManifestV1Schema: SafeParse };
  return mod.pluginManifestV1Schema;
}

describe("manifest", () => {
  it("passes the host manifest validator", async () => {
    const result = (await hostManifestSchema()).safeParse(manifest);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });

  it("declares every capability the worker uses", () => {
    for (const cap of [
      "secrets.read-ref", "issues.create", "issues.read", "issues.wakeup", "issue.comments.create", "agents.managed", "agents.read",
      "authorization.grants.read", "authorization.grants.write", "projects.managed", "routines.managed", "skills.managed",
      "plugin.state.read", "plugin.state.write", "http.outbound", "events.subscribe", "events.emit", "companies.read", "api.routes.register",
    ]) {
      expect(manifest.capabilities).toContain(cap);
    }
  });

  it("registers the OAuth completion, client summary and setup status routes, and no start route", () => {
    expect(manifest.apiRoutes).toEqual([
      expect.objectContaining({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", auth: "board", companyResolution: { from: "body", key: "companyId" } }),
      expect.objectContaining({
        routeKey: "client-summary",
        method: "GET",
        path: "/client-summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      }),
      expect.objectContaining({ routeKey: "setup-status", method: "GET", path: "/setup-status", auth: "board", companyResolution: { from: "query", key: "companyId" } }),
    ]);
    expect(manifest.version).toBe("0.5.1");
  });

  it("requires the public base URL and uses secret-ref fields without a type", () => {
    const schema = manifest.instanceConfigSchema as Record<string, any>;
    expect(schema.required).toContain("publicBaseUrl");
    expect(schema.properties.encryptionKey).toMatchObject({ format: "secret-ref" });
    expect(schema.properties.encryptionKey.type).toBeUndefined();
    expect(schema.properties.platforms.properties.facebook.properties.clientSecret).toMatchObject({ format: "secret-ref" });
    expect(schema.properties.r2.properties.secretAccessKey.type).toBeUndefined();
    expect(Object.keys(schema.properties.platforms.properties)).toHaveLength(12);
    expect(schema.description).toContain("/_plugins/<plugin installation id>/ui/oauth-callback.html");
  });

  it("declares the managed agent with the canonical skill keys", () => {
    expect(DESIRED_SKILLS).toEqual(["plugin/partnersinbiz-social/social-publish", "plugin/partnersinbiz-social/social-content"]);
    const agent = manifest.agents![0]!;
    expect(agent).toMatchObject({ agentKey: "social-media-manager", adapterType: "hermes_local", status: "paused", budgetMonthlyCents: 0 });
    expect(agent.adapterPreference).toEqual(["hermes_local", "claude_local"]);
    expect((agent.adapterConfig as any).paperclipSkillSync.desiredSkills).toEqual(DESIRED_SKILLS);
    expect(manifest.routines![0]).toMatchObject({ routineKey: "plan-next-week", status: "paused" });
    expect(manifest.routines![0]!.triggers![0]).toMatchObject({ enabled: false, cronExpression: "0 7 * * 1", timezone: "Africa/Johannesburg" });
    expect(manifest.projects![0]!.projectKey).toBe("social");
  });

  it("ships pib- prefixed skills with frontmatter and the platform reference", () => {
    expect(SKILLS.map((s) => s.slug)).toEqual(["pib-social-publish", "pib-social-content"]);
    for (const skill of SKILLS) expect(skill.markdown.startsWith(`---\nname: ${skill.slug}\nslug: ${skill.slug}\n`)).toBe(true);
    expect(SKILLS[1]!.files?.[0]?.path).toBe("references/platforms.md");
    const publish = SKILLS[0]!.markdown;
    for (const tool of SOCIAL_TOOLS) expect(publish, tool.name).toContain(tool.name);
  });

  it("ships the 0.5.0 Growth Lab and Jev settings", () => {
    const schema = manifest.instanceConfigSchema as Record<string, any>;
    expect(schema.properties.jev.properties.apiKey).toMatchObject({ format: "secret-ref" });
    expect(schema.properties.jev.properties.apiKey.type).toBeUndefined();
    expect(manifest.capabilities).toContain("issues.update");
    expect(manifest.routines![0]).toMatchObject({ routineKey: "plan-next-week", title: "Weekly social review & plan" });
    expect(manifest.routines![0]!.description).toContain("performance-review");
    for (const tool of ["performance-review", "get-playbook", "propose-playbook-change", "decide-playbook-change", "list-experiments", "propose-experiment", "approve-experiment", "reject-experiment", "propose-feature-question"]) {
      expect(manifest.tools!.map((t) => t.name)).toContain(tool);
    }
    const content = SKILLS[1]!.markdown;
    expect(content).toContain("## Weekly social review & plan");
    expect(content).toContain("get-playbook");
    const create = manifest.tools!.find((t) => t.name === "create-post")!;
    expect(Object.keys((create.parametersSchema as any).properties)).toEqual(expect.arrayContaining(["experimentId", "arm"]));
  });

  it("schedules every job", () => {
    expect(manifest.jobs!.map((j) => j.jobKey)).toEqual(["publish-due", "refresh-tokens", "collect-metrics", "poll-inbox", "poll-rss", "score-posts", "measure-experiments"]);
  });
});
