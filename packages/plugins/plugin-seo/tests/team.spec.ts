/**
 * Drift guard: the SEO hire role must match the kit's team registry
 * (`TEAM_ROLES`), which Setup → Team staffs it from.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { TEAM_ROLES, teamRole, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { SEO_ROLE } from "../src/service/hire.js";
import { seoSetupStatus } from "../src/service/setup-status.js";
import { TEAM_ROLE } from "../src/ui/role-skills.js";
import plugin from "../src/worker.js";

/** A company with nothing set up yet: no sprints, no agent, no settings. */
function emptyCompany(): PluginContext {
  return {
    db: { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) },
    config: { get: async () => ({}) },
    secrets: { resolve: async () => "" },
    companies: { get: async () => ({ id: "co-1", issuePrefix: "PIB" }), list: async () => [{ id: "co-1" }] },
    agents: { get: async () => null, list: async () => [], managed: { get: async () => ({ agentId: null, agent: null }) } },
    issues: { get: async () => null },
    events: { emit: async () => undefined, on: () => undefined },
    logger: { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined },
    state: { get: async () => null, set: async () => undefined },
  } as unknown as PluginContext;
}

/** The action keys the worker registers. */
async function registeredActions(): Promise<Set<string>> {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
  const keys = new Set<string>();
  const ctx = {
    ...harness.ctx,
    db: { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) },
    actions: { register: (key: string) => void keys.add(key) },
  } as unknown as PluginContext;
  await plugin.definition.setup(ctx);
  return keys;
}

describe("SEO role matches TEAM_ROLES", () => {
  const role = teamRole(TEAM_ROLE);

  it("is the one SEO role in the registry", () => {
    expect(TEAM_ROLES.filter((r) => r.pluginKey === PLUGIN_ID).map((r) => r.key)).toEqual([TEAM_ROLE]);
    expect(role.pagePath).toBe("/seo");
  });

  it("same plugin and skills as the hire role", () => {
    expect(SEO_ROLE.pluginKey).toBe(role.pluginKey);
    expect(SEO_ROLE.skills.map((s) => s.key)).toEqual(role.skills);
  });

  it("the setup checklist item is the role's, linking to Setup → Team", async () => {
    const env = createEnv(emptyCompany(), { now: () => new Date("2026-09-26T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never });
    const status = await seoSetupStatus(env, "co-1");
    const item = status.items.find((i) => i.key === role.setupItemKey);
    expect(item).toMatchObject({ href: teamSetupPath(TEAM_ROLE), hrefLabel: "Open Team in Setup" });
  });

  it("every action Setup → Team calls is registered", async () => {
    const keys = await registeredActions();
    const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync];
    expect(names.every(Boolean)).toBe(true);
    for (const name of names) expect(keys.has(name!), name).toBe(true);
  });
});
