/**
 * The access guard of the CRM (access stage A, spec PAR-12578 sections 4.4 and 4.5; PAR-12679): the kit's test helper on
 * the real plugin (registration, table, source, behaviour, agent and API route checks), the table's own rules, today's
 * answer with the switch off, and a real handler behind the guard under `enforce`.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, ADMIN_ONLY, isRefusal, PERMISSION_CATALOG, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE, SHARED_ROWS } from "../src/access-table.js";
import { boot, CO } from "./helpers/crm.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

describe("CRM access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("the data handlers are only the two named Drive ones (they stay until stage B)", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toEqual(["drive-folder", "drive-files"]);
  });

  it("every row names a CRM catalog resource and one of its actions; none is scoped yet", () => {
    const catalog = new Map(PERMISSION_CATALOG.map((r) => [r.id, r]));
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^crm\./);
      expect(catalog.get(entry.resource)?.actions, key).toContain(entry.action);
      expect(entry.scoped, key).toBeUndefined();
    }
  });

  it("names the rows the spec fixes: client-workspace is companies view; hiring, maintenance and the partner share are ADMIN_ONLY", () => {
    expect(ACCESS_TABLE["crm.client-workspace"]).toEqual({ resource: "crm.companies", action: "view" });
    for (const key of ["crm.hire-options", "crm.start-hire", "crm.link-agent", "crm.unlink-agent", "crm.resync-agent", "crm.sync-skills", "crm.resync", "api:record-grant", "tool:cleanup-canary"]) {
      expect(ACCESS_TABLE[key], key).toBe(ADMIN_ONLY);
    }
  });

  it("a tool and the page action of the same name have the same row", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (!key.startsWith("tool:")) continue;
      const action = `crm.${key.slice(5)}`;
      if (Object.hasOwn(ACCESS_TABLE, action)) expect(ACCESS_TABLE[action], action).toEqual(entry);
    }
    for (const name of Object.keys(SHARED_ROWS)) {
      expect(ACCESS_TABLE[`crm.${name}`], name).toBeDefined();
      expect(ACCESS_TABLE[`tool:${name}`], name).toBeDefined();
    }
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    await plugin.definition.setup(harness.ctx);
    const answer = await plugin.definition.onApiRequest!({
      routeKey: "no-such-route",
      method: "GET",
      path: "/no-such-route",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: ACCESS_TEST_IDS.operator, userId: ACCESS_TEST_IDS.operator },
      companyId: ACCESS_TEST_IDS.off,
      headers: {},
    });
    expect(answer).toEqual({ status: 404, body: { error: "Not found" } });
  });
});

describe("a real CRM handler behind the guard", () => {
  const OWNER = "a1500000-0000-4000-8000-00000000c011";
  const OPERATOR = "a1500000-0000-4000-8000-00000000c012";

  it("switch absent: today's answer; enforce: the owner gets the same answer and a member with no grant the refusal form", async () => {
    const { harness } = await boot();
    const at = new Date().toISOString();
    const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
    harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] });
    const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId } });
    const today = await harness.performAction("crm.settings-status", {}, as(OPERATOR));
    expect(isRefusal(today)).toBe(false);

    await harness.ctx.state.set(accessCompanyScope(CO), { mode: "enforce", rev: 1, userIds: [], receivedAt: at });
    await expect(harness.performAction("crm.settings-status", {}, as(OWNER))).resolves.toEqual(today);
    const refused = await harness.performAction("crm.settings-status", {}, as(OPERATOR));
    expect(isRefusal(refused) && refused.code).toBe(PERMISSION_DENIED);
  });
});
