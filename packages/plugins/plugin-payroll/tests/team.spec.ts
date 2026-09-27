/**
 * Drift guard: the Payroll Clerk hire role must match the kit's team
 * registry (`TEAM_ROLES`), which Setup → Team staffs it from.
 */
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { TEAM_ROLES, teamRole, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { CLERK_ROLE } from "../src/hire.js";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { createEnv } from "../src/service/env.js";
import { setupStatus } from "../src/service/setup.js";
import { TEAM_ROLE } from "../src/ui/role-skills.js";
import plugin from "../src/worker.js";

const emptyDb = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };

describe("Payroll Clerk role matches TEAM_ROLES", () => {
  const role = teamRole(TEAM_ROLE);

  it("is the one Payroll role in the registry, and optional", () => {
    expect(TEAM_ROLES.filter((r) => r.pluginKey === PLUGIN_ID).map((r) => r.key)).toEqual([TEAM_ROLE]);
    expect(role).toMatchObject({ pagePath: "/payroll", required: false });
  });

  it("same plugin and skills as the hire role", () => {
    expect(CLERK_ROLE.pluginKey).toBe(role.pluginKey);
    expect(CLERK_ROLE.roleKey).toBe(TEAM_ROLE);
    expect(CLERK_ROLE.skills.map((s) => s.key)).toEqual(role.skills);
  });

  it("the setup checklist item is the role's, linking to Setup → Team", async () => {
    const ctx = {
      db: emptyDb,
      config: { get: async () => ({}) },
      state: { get: async () => null, set: async () => undefined },
      agents: { get: async () => null, list: async () => [] },
      logger: { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined },
    } as unknown as PluginContext;
    const env = createEnv(ctx, { now: () => new Date("2026-09-20T08:00:00Z"), config: async () => { throw new Error("no settings"); } });
    const status = await setupStatus(env, "company-1");
    expect(status.items.find((i) => i.key === role.setupItemKey)).toMatchObject({ href: teamSetupPath(TEAM_ROLE), hrefLabel: "Open Team in Setup", required: role.required });
    const { cockpitSnapshot } = await import("../src/service/cockpit.js");
    // The Cockpit snapshot reports the role, so routeWork can find the Clerk.
    expect((await cockpitSnapshot(env, "company-1")).team).toEqual([{ role: TEAM_ROLE, agentId: null, status: null }]);
  });

  it("every action Setup → Team calls is registered", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    const keys = new Set<string>();
    await plugin.definition.setup({ ...harness.ctx, db: emptyDb, actions: { register: (key: string) => void keys.add(key) } } as unknown as PluginContext);
    const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync];
    expect(names.every(Boolean)).toBe(true);
    for (const name of names) expect(keys.has(name!), name).toBe(true);
  });
});
