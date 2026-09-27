/**
 * Drift guard: the Account Manager hire role must match the kit's team
 * registry (`TEAM_ROLES`), which Setup → Team staffs it from.
 */
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { COMPANY_OS_HIRE_SKILL } from "@partnersinbiz/pib-plugin-kit";
import { TEAM_ROLES, teamRole, teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { ACCOUNT_MANAGER_ROLE } from "../src/agent.js";
import { SKILLS } from "../src/skills.js";
import { setupStatus } from "../src/setup-status.js";
import { EXTRA_SKILLS, ROLE_SKILLS, TEAM_ROLE } from "../src/ui/role-skills.js";
import plugin from "../src/worker.js";

const emptyDb = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };

/** A company with nothing set up yet: no settings, no clients, no Account Manager. */
function emptyCompany(): PluginContext {
  return {
    db: emptyDb,
    config: { get: async () => ({}) },
    state: { get: async () => null, set: async () => undefined },
    agents: { get: async () => null, list: async () => [] },
    issues: { get: async () => null },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
}

describe("Account Manager role matches TEAM_ROLES", () => {
  const role = teamRole(TEAM_ROLE);

  it("is the one CRM role in the registry", () => {
    expect(TEAM_ROLES.filter((r) => r.pluginKey === PLUGIN_ID).map((r) => r.key)).toEqual([TEAM_ROLE]);
    expect(role.pagePath).toBe("/crm");
    expect(ACCOUNT_MANAGER_ROLE.roleKey).toBe(TEAM_ROLE);
  });

  it("same plugin and skills as the hire role, ending with the company operating manual", () => {
    expect(ACCOUNT_MANAGER_ROLE.pluginKey).toBe(role.pluginKey);
    expect(ACCOUNT_MANAGER_ROLE.skills.map((s) => s.key)).toEqual(role.skills);
    expect(ACCOUNT_MANAGER_ROLE.skills.at(-1)).toEqual(COMPANY_OS_HIRE_SKILL);
  });

  it("the page attaches the same skills, and the role's extra skills", () => {
    expect(ROLE_SKILLS.map((s) => s.key)).toEqual(role.skills);
    expect(ROLE_SKILLS.map((s) => s.slug)).toEqual(ACCOUNT_MANAGER_ROLE.skills.map((s) => s.slug));
    expect(EXTRA_SKILLS).toEqual(role.extraSkills);
  });

  it("the hire role's CRM skills are the ones the plugin ships", () => {
    const shipped = SKILLS.map((s) => [`plugin/partnersinbiz-crm/${s.skillKey}`, s.slug]);
    for (const skill of ACCOUNT_MANAGER_ROLE.skills.slice(0, -1)) expect(shipped).toContainEqual([skill.key, skill.slug]);
  });

  it("covers the CRM, Billing, Campaigns, Mailbox and Partners tools with a name no other role uses", () => {
    expect(ACCOUNT_MANAGER_ROLE.toolPlugins).toEqual(["partnersinbiz.crm", "partnersinbiz.billing", "partnersinbiz.campaigns", "partnersinbiz.mailbox", "partnersinbiz.partners"]);
    const otherTitles = TEAM_ROLES.filter((r) => r.key !== TEAM_ROLE).map((r) => r.title.toLowerCase());
    expect(otherTitles).not.toContain(ACCOUNT_MANAGER_ROLE.displayName.toLowerCase());
  });

  it("the setup checklist item is the role's, linking to Setup → Team", async () => {
    const status = await setupStatus(emptyCompany(), "co-1");
    expect(status.items.find((i) => i.key === role.setupItemKey)).toMatchObject({ href: teamSetupPath(TEAM_ROLE), hrefLabel: "Open Team in Setup", required: true });
  });

  it("every action Setup → Team calls is registered", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    const keys = new Set<string>();
    await plugin.definition.setup({ ...harness.ctx, db: emptyDb, actions: { register: (key: string) => void keys.add(key) } } as unknown as PluginContext);
    const names = [role.actions.options, role.actions.start, role.actions.link, role.actions.unlink, role.actions.resync];
    expect(names.every(Boolean)).toBe(true);
    for (const name of names) expect(keys.has(name!), name).toBe(true);
  });
});
