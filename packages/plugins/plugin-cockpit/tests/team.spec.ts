/**
 * Drift guard: the Cockpit's hire roles (Operator, Reviewer) must match the
 * kit's team registry (`TEAM_ROLES`), which Setup → Team staffs them from.
 */
import { describe, expect, it } from "vitest";
import { COMPANY_OS_HIRE_SKILL, hireTaskDraft, matchesRole } from "@partnersinbiz/pib-plugin-kit";
import { COMPANY_OS_SKILL_KEY, TEAM_ROLES, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { PAPERCLIP_SKILL, PLUGIN_KEY } from "../src/constants.js";
import { HIRE_MATCH_ROLES, HIRE_ROLES } from "../src/hire.js";
import { operatorCheck, ownSetupStatus, ownSnapshot, reviewerCheck } from "../src/own.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { grantPluginTools, saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";

function setup() {
  const fake = fakeCtx({
    savedConfigs: { [A]: { healthIssue: true } },
    agents: [
      { id: "op", companyId: A, name: "Olive", status: "active" },
      { id: "rev", companyId: A, name: "Rex", status: "paused" },
    ],
  });
  const env = createEnv(fake.ctx, fixedClock("2026-09-26T10:00:00.000Z").now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env };
}

describe("Cockpit roles match TEAM_ROLES", () => {
  const roles = TEAM_ROLES.filter((role) => role.pluginKey === PLUGIN_KEY);

  it("owns the Operator and the Reviewer", () => {
    expect(roles.map((role) => [role.key, role.cockpitRole])).toEqual([["operator", "operator"], ["reviewer", "reviewer"]]);
  });

  for (const role of roles) {
    it(`${role.key}: plugin, skills, setup item and actions agree`, async () => {
      const hire = HIRE_ROLES[role.cockpitRole!];
      expect(hire.pluginKey).toBe(role.pluginKey);
      expect(hire.roleKey).toBe(role.cockpitRole);
      // The PiB skills match the registry (ending with the company operating manual); the upstream paperclip skill comes with them.
      expect(hire.skills.map((skill) => skill.key).filter((key) => key !== PAPERCLIP_SKILL.key)).toEqual(role.skills);
      expect(hire.skills.at(-1)).toEqual(COMPANY_OS_HIRE_SKILL);
      expect(role.skills.at(-1)).toBe(COMPANY_OS_SKILL_KEY);
      expect(hire.skills.map((skill) => skill.key)).toContain("paperclipai/paperclip/paperclip");
      const draft = hireTaskDraft(hire).description;
      for (const slug of [role.key === "operator" ? "pib-operator" : "pib-reviewer", "paperclip", "pib-company-os"]) expect(draft).toContain(`\`${slug}\``);
      expect(draft).not.toMatch(/Peet/);

      const { env, actions } = setup();
      const status = await ownSetupStatus(env, A);
      const item = status.items.find((i) => i.key === role.setupItemKey);
      expect(item, role.setupItemKey).toBeDefined();
      expect(item!.href).toBe(teamSetupPath(role.key));

      const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync].filter((name): name is string => !!name);
      expect(names.length).toBeGreaterThanOrEqual(2);
      for (const name of names) expect(actions.has(name), name).toBe(true);
    });
  }

  it("links a new agent only on the role's own skill: the shared skills are on every hire", () => {
    const sharedOnly = { name: "Sam", title: "SEO Specialist", adapterConfig: { paperclipSkillSync: { desiredSkills: [COMPANY_OS_SKILL_KEY, "paperclipai/paperclip/paperclip", "plugin/partnersinbiz-seo/seo-sprint"] } } };
    expect(matchesRole(sharedOnly, HIRE_MATCH_ROLES.operator)).toBe(false);
    expect(matchesRole(sharedOnly, HIRE_MATCH_ROLES.reviewer)).toBe(false);
    expect(matchesRole({ name: "Olive", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/operator", COMPANY_OS_SKILL_KEY] } } }, HIRE_MATCH_ROLES.operator)).toBe(true);
    expect(matchesRole({ name: "Operator" }, HIRE_MATCH_ROLES.operator)).toBe(true);
    for (const kind of ["operator", "reviewer"] as const) {
      expect(HIRE_MATCH_ROLES[kind]).toMatchObject({ roleKey: HIRE_ROLES[kind].roleKey, pluginKey: PLUGIN_KEY, displayName: HIRE_ROLES[kind].displayName });
      expect(HIRE_MATCH_ROLES[kind].skills).toHaveLength(1);
    }
  });

  it("keeps the actions Setup → Team calls", () => {
    const { actions } = setup();
    for (const name of ["cockpit.load", "cockpit.save-team", "cockpit.hire-options", "cockpit.start-hire", "cockpit.agents"]) expect(actions.has(name), name).toBe(true);
  });
});

describe("role health on the Overview", () => {
  const agent = (status: string) => ({ id: "a1", name: "Olive", status });

  it("sends an empty, paused, unapproved or failing Operator to Setup → Team", () => {
    expect(operatorCheck(null)).toMatchObject({ status: "warn", href: "/setup?section=team#team-operator", detail: "No Operator yet, so nobody reviews the company each morning." });
    for (const status of ["paused", "pending_approval", "error"]) {
      expect(operatorCheck(agent(status)), status).toMatchObject({ status: "warn", href: "/setup?section=team#team-operator" });
    }
    expect(operatorCheck(agent("pending_approval")).detail).toBe("Olive (pending approval), so the company is not reviewed each morning.");
    expect(operatorCheck(agent("idle"))).toEqual({ key: "operator", title: "Operator", status: "ok", detail: "Olive (idle).", href: "/agents/a1", fix: null });
  });

  it("flags a linked Reviewer only when it is gone or not working", () => {
    expect(reviewerCheck(agent("active"), true)).toBeNull();
    expect(reviewerCheck(agent("paused"), true)).toMatchObject({ key: "reviewer", status: "warn", href: "/setup?section=team#team-reviewer", detail: "Olive (paused). Outward-facing work waits for its review." });
    expect(reviewerCheck(null, false)).toMatchObject({ status: "warn", href: "/setup?section=team#team-reviewer", detail: "The Reviewer agent was terminated or removed." });
  });

  it("the snapshot carries both checks", async () => {
    const { env } = setup();
    expect((await ownSnapshot(env, A)).health.find((h) => h.key === "reviewer")).toBeUndefined();
    await saveTeam(env, A, { operatorAgentId: "op", reviewerAgentId: "rev", reviewOutward: true }, "user-1");
    const health = (await ownSnapshot(env, A)).health;
    expect(health.find((h) => h.key === "operator")).toMatchObject({ status: "ok", href: "/agents/op" });
    expect(health.find((h) => h.key === "reviewer")).toMatchObject({ status: "warn", detail: "Rex (paused). Outward-facing work waits for its review.", href: "/setup?section=team#team-reviewer" });
  });
});

describe("plugin tool access when an agent is linked (one tools grant per agent)", () => {
  it("adds, keeps, widens or leaves a limited grant for a person", async () => {
    const { env, grants } = setup();
    // None yet: added.
    expect(await grantPluginTools(env, A, "op", "user-1")).toEqual({ state: "added", detail: null });
    expect(grants.get("op")).toEqual([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
    // Unscoped already covers plugin tools: nothing saved.
    grants.set("rev", [{ permissionKey: "tools:use", scope: null }, { permissionKey: "issues:write", scope: null }]);
    expect(await grantPluginTools(env, A, "rev", "user-1")).toEqual({ state: "already_present", detail: null });
    expect(grants.get("rev")).toHaveLength(2);
    // Limited to another provider type: widened, never a second tools grant.
    grants.set("rev", [{ permissionKey: "tools:use", scope: { providerType: "mcp" } }]);
    expect((await grantPluginTools(env, A, "rev", "user-1")).state).toBe("added");
    expect(grants.get("rev")).toEqual([{ permissionKey: "tools:use", scope: { providerTypes: ["mcp", "paperclip_plugin"] } }]);
    // Limited some other way (one app): left alone, and the person is told.
    grants.set("rev", [{ permissionKey: "tools:use", scope: { appId: "gmail" } }]);
    const conflict = await grantPluginTools(env, A, "rev", "user-1");
    expect(conflict.state).toBe("conflict");
    expect(conflict.detail).toMatch(/limited to/);
    expect(grants.get("rev")).toEqual([{ permissionKey: "tools:use", scope: { appId: "gmail" } }]);
    const steps = await saveTeam(env, A, { reviewerAgentId: "rev" }, "user-1");
    expect(steps.steps.join("\n")).toContain("Plugin tool access was not changed: The agent's tools grant is limited to");
  });
});
