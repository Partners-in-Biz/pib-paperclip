/**
 * Drift guard: the Social hire role must match the kit's team registry
 * (`TEAM_ROLES`), which Setup → Team staffs it from.
 */
import { describe, expect, it } from "vitest";
import { TEAM_ROLES, teamRole, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { SOCIAL_HIRE_ROLE } from "../src/hire.js";
import { PLUGIN_ID } from "../src/platforms.js";
import { socialSetupStatus } from "../src/setup-status.js";
import { TEAM_ROLE } from "../src/ui/role-skills.js";
import plugin from "../src/worker.js";
import { fakeCtx } from "./helpers.js";

const noop = () => undefined;

describe("Social role matches TEAM_ROLES", () => {
  const role = teamRole(TEAM_ROLE);

  it("is the one Social role in the registry", () => {
    expect(TEAM_ROLES.filter((r) => r.pluginKey === PLUGIN_ID).map((r) => r.key)).toEqual([TEAM_ROLE]);
    expect(role.pagePath).toBe("/social");
  });

  it("same plugin and skills as the hire role", () => {
    expect(SOCIAL_HIRE_ROLE.pluginKey).toBe(role.pluginKey);
    expect(SOCIAL_HIRE_ROLE.skills.map((s) => s.key)).toEqual(role.skills);
  });

  it("the setup checklist item is the role's, linking to Setup → Team", async () => {
    const ctx = fakeCtx({
      config: { get: async () => ({}) },
      agents: { get: async () => null, list: async () => [], managed: { get: async () => ({ agentId: null, status: "resolved" }) } },
      routines: { managed: { get: async () => ({ status: "missing", routineId: null, routine: null }) } },
      events: { emit: async () => undefined, on: noop },
    });
    const status = await socialSetupStatus(ctx, "co", new Date("2026-09-26T10:00:00Z"));
    expect(status.items.find((i) => i.key === role.setupItemKey)).toMatchObject({ href: teamSetupPath(TEAM_ROLE), hrefLabel: "Open Team in Setup" });
  });

  it("every action Setup → Team calls is registered", async () => {
    const keys = new Set<string>();
    const ctx = fakeCtx({
      actions: { register: (key: string) => void keys.add(key) },
      tools: { register: noop },
      jobs: { register: noop },
      events: { on: noop, emit: async () => undefined },
    });
    await plugin.definition.setup(ctx);
    const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync];
    expect(names.every(Boolean)).toBe(true);
    for (const name of names) expect(keys.has(name!), name).toBe(true);
  });
});
