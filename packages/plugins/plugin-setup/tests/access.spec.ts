/**
 * Setup's access guard (access stage A, spec PAR-12578 sections 4.4 to 4.6):
 * the kit's access check (4.5 items 1 to 6) on the real worker, the switch
 * `off` as a pass-through, the switch read from Setup's own table, `setup.load`
 * open to every member with no secret in it, and the page files reaching
 * actions only through the `withRefusal` file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginAccessMember } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ACCESS_TEST_IDS, assertPluginAccess } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { accessCompanyScope, isRefusal, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { SETUP_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const UI = fileURLToPath(new URL("../src/ui/", import.meta.url));
const T = ACCESS_TEST_IDS;
const SETTINGS_SQL = /FROM \S+\.access_settings WHERE company_id = \$1/;

type Harness = ReturnType<typeof createTestHarness>;

async function started(): Promise<Harness> {
  const harness = createTestHarness({ manifest, config: {} });
  // The harness names its namespace test_<id>; Setup's table names need plugin_<…> (namespace.ts).
  (harness.ctx.db as { namespace: string }).namespace = NAMESPACE;
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function member(companyId: string, userId: string, role = "member"): PluginAccessMember {
  const at = new Date().toISOString();
  return { id: `m-${companyId}-${userId}`, companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role, grants: [], createdAt: at, updatedAt: at };
}

/** Setup's `access_settings` row for `companyId` (the harness db answers nothing else). */
function settingsRow(harness: Harness, companyId: string, row: { mode: string } | "throws") {
  const query = harness.ctx.db.query;
  harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
    if (!SETTINGS_SQL.test(sql) || params?.[0] !== companyId) return query.call(harness.ctx.db, sql, params);
    if (row === "throws") throw new Error("db down");
    return [{ company_id: companyId, mode: row.mode, rev: 3, granted_user_ids: "[]", updated_at: new Date(), updated_by: T.owner }];
  }) as typeof harness.ctx.db.query;
}

const as = (harness: Harness, key: string, companyId: string, userId: string, params: Record<string, unknown> = {}) =>
  harness.performAction(key, params, { companyId, actor: { type: "user", userId } });

describe("Setup access guard", () => {
  it("passes the kit's access check: every action, tool and route through the guard and in the table, and its behaviour", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: SETUP_ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("with the switch off the guard is a pass-through: the same answer as with no switch, for a member with no grant", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.off, T.operator), member(T.absent, T.operator)] });
    await harness.ctx.state.set(accessCompanyScope(T.off), { mode: "off", rev: 1, userIds: [], receivedAt: new Date().toISOString() });
    const absent = await as(harness, "setup.new-company", T.absent, T.operator);
    expect(isRefusal(absent)).toBe(false);
    expect(await as(harness, "setup.new-company", T.off, T.operator)).toEqual(absent);
  });

  it("reads the switch from its own access_settings table: enforce refuses a member with no grant, the owner passes", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.enforce, T.operator), member(T.enforce, T.owner, "owner")] });
    settingsRow(harness, T.enforce, { mode: "enforce" });
    expect(await as(harness, "setup.access.people", T.enforce, T.operator)).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
    expect(await as(harness, "setup.new-company", T.enforce, T.operator)).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
    expect(isRefusal(await as(harness, "setup.new-company", T.enforce, T.owner))).toBe(false);
  });

  it("a settings row of off passes a member with no grant; a failed table read fails closed", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.off, T.operator), member(T.enforce, T.operator)] });
    settingsRow(harness, T.off, { mode: "off" });
    expect(isRefusal(await as(harness, "setup.new-company", T.off, T.operator))).toBe(false);
    settingsRow(harness, T.enforce, "throws");
    expect(await as(harness, "setup.new-company", T.enforce, T.operator)).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
  });

  it("setup.load stays open under enforce to a member with no grant and returns no secret", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.enforce, T.operator)] });
    settingsRow(harness, T.enforce, { mode: "enforce" });
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: T.enforce, namespace: "setup", stateKey: `drive-binding:${T.enforce}` },
      { companyId: T.enforce, connected: true, bound: true, sharedDriveId: "d1", serviceAccountEmail: "sa@x.iam", serviceAccountIsMember: true, candidates: [], privateKey: "PRIVATE", token: "TOKEN" },
    );
    const load = await as(harness, "setup.load", T.enforce, T.operator, { installed: { "partnersinbiz.crm": { id: "p1", status: "ready", apiKey: "KEY" } } });
    expect(isRefusal(load)).toBe(false);
    expect(Object.keys(load as object).sort()).toEqual(
      ["bootstrap", "drive", "entitled", "finishIssueId", "installed", "modules", "plan", "settingsSaved", "statuses", "summary", "updatedAt", "updatedBy"],
    );
    const text = JSON.stringify(load);
    expect(text).not.toMatch(/PRIVATE|TOKEN|KEY|secret|password|privateKey|apiKey/i);
  });

  it("every access action is owner or admin only, and no row is scoped", () => {
    for (const [key, entry] of Object.entries(SETUP_ACCESS_TABLE)) {
      if (key.startsWith("setup.access.")) expect(entry, key).toBe("ADMIN_ONLY");
      if (typeof entry === "object" && "resource" in entry) {
        expect(entry.resource, key).toBe("setup.settings");
        expect(entry.scoped, key).toBeUndefined();
      }
    }
  });

  it("page files reach actions only through useSetupAction (withRefusal), never usePluginAction directly", () => {
    const direct = readdirSync(UI)
      .filter((name) => /\.(ts|tsx)$/.test(name) && name !== "actions.ts")
      .filter((name) => /\busePluginAction\(/.test(readFileSync(UI + name, "utf8")) || /import \{[^}]*\busePluginAction\b/.test(readFileSync(UI + name, "utf8")));
    expect(direct).toEqual([]);
    expect(readFileSync(UI + "actions.ts", "utf8")).toMatch(/withRefusal\(usePluginAction\)/);
  });
});
