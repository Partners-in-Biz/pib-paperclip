/**
 * Drift guard: the Bookkeeper hire role must match the kit's team registry
 * (`TEAM_ROLES`), which Setup → Team staffs it from.
 */
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { TEAM_ROLES, teamRole, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { BOOKKEEPER_ROLE } from "../src/service/agent.js";
import { setupStatus } from "../src/service/setup.js";
import { TEAM_ROLE } from "../src/ui/role-skills.js";
import plugin from "../src/worker.js";

const emptyDb = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };

/** A company with nothing set up yet: no settings, no book, no Bookkeeper. */
function emptyCompany(): PluginContext {
  return {
    db: emptyDb,
    config: { get: async () => ({}) },
    state: { get: async () => null, set: async () => undefined },
    agents: { get: async () => null, list: async () => [] },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
}

describe("Bookkeeper role matches TEAM_ROLES", () => {
  const role = teamRole(TEAM_ROLE);

  it("is the one Accounting role in the registry", () => {
    expect(TEAM_ROLES.filter((r) => r.pluginKey === PLUGIN_ID).map((r) => r.key)).toEqual([TEAM_ROLE]);
    expect(role.pagePath).toBe("/accounting");
  });

  it("same plugin and skills as the hire role", () => {
    expect(BOOKKEEPER_ROLE.pluginKey).toBe(role.pluginKey);
    expect(BOOKKEEPER_ROLE.skills.map((s) => s.key)).toEqual(role.skills);
  });

  it("the setup checklist item is the role's, linking to Setup → Team, and as required as the role", async () => {
    const status = await setupStatus(emptyCompany(), "co-1");
    expect(status.items.find((i) => i.key === role.setupItemKey)).toMatchObject({ href: teamSetupPath(TEAM_ROLE), hrefLabel: "Open Team in Setup", required: role.required, status: "missing" });
    expect(role.required).toBe(true);
  });

  it("the Cockpit snapshot reports the role (for routeWork)", async () => {
    const { cockpitSnapshot } = await import("../src/service/cockpit.js");
    const snap = await cockpitSnapshot(emptyCompany(), "co-1");
    expect(snap.team).toEqual([{ role: TEAM_ROLE, agentId: null, status: null }]);
  });

  it("every action Setup → Team calls is registered", async () => {
    const harness = createTestHarness({ manifest, config: { legalName: "PiB", vatNumber: "4000000000", vatCategory: "B", financialYearEndMonth: 2 } });
    const keys = new Set<string>();
    await plugin.definition.setup({ ...harness.ctx, db: emptyDb, actions: { register: (key: string) => void keys.add(key) } } as unknown as PluginContext);
    const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync];
    expect(names.every(Boolean)).toBe(true);
    for (const name of names) expect(keys.has(name!), name).toBe(true);
  });
});
