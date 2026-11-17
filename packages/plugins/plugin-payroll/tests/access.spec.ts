/**
 * Payroll's access guard (access stage A, spec PAR-12578 sections 4.4 to 4.6):
 * the kit's access check (4.5 items 1 to 6) on the real worker, the switch
 * `off` as a pass-through, and the page files reaching actions only through
 * the `withRefusal` file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ACCESS_TEST_IDS, assertPluginAccess } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { accessCompanyScope, isRefusal, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { PAYROLL_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const UI = fileURLToPath(new URL("../src/ui/", import.meta.url));
const T = ACCESS_TEST_IDS;

async function started() {
  const harness = createTestHarness({ manifest, config: {} });
  // The harness names its namespace test_<id>; Payroll's table names need plugin_<…> (db.ts).
  (harness.ctx.db as { namespace: string }).namespace = NAMESPACE;
  await plugin.definition.setup(harness.ctx);
  return harness;
}

async function setSwitch(harness: Awaited<ReturnType<typeof started>>, companyId: string, mode: "off" | "enforce") {
  await harness.ctx.state.set(accessCompanyScope(companyId), { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
}

describe("Payroll access guard", () => {
  it("passes the kit's access check: every action, tool and route through the guard and in the table, and its behaviour", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: PAYROLL_ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("with the switch off the guard is a pass-through: the same answer as with no switch, for a member with no grant", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [{ id: "m-op", companyId: T.off, principalType: "user", principalId: T.operator, status: "active", membershipRole: "member", grants: [] } as never] });
    await setSwitch(harness, T.off, "off");
    const asOperator = (companyId: string) => harness.performAction("payroll.rules", { taxYear: "2026/27" }, { companyId, actor: { type: "user", userId: T.operator } });
    const absent = await asOperator(T.absent);
    expect(isRefusal(absent)).toBe(false);
    expect(await asOperator(T.off)).toEqual(absent);
  });

  it("under enforce a member with no grant gets the refusal form, not the payroll data", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [{ id: "m-op", companyId: T.enforce, principalType: "user", principalId: T.operator, status: "active", membershipRole: "member", grants: [] } as never] });
    await setSwitch(harness, T.enforce, "enforce");
    const answer = await harness.performAction("payroll.load", {}, { companyId: T.enforce, actor: { type: "user", userId: T.operator } });
    expect(answer).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
  });

  it("no row is scoped: Payroll has no scopable resource and stays closed to an own-companies person", () => {
    for (const [key, entry] of Object.entries(PAYROLL_ACCESS_TABLE)) {
      if (typeof entry === "object" && "resource" in entry) {
        expect(entry.resource.startsWith("payroll."), key).toBe(true);
        expect(entry.scoped, key).toBeUndefined();
      }
    }
  });

  it("page files reach actions only through usePayrollAction (withRefusal), never usePluginAction directly", () => {
    const direct = readdirSync(UI)
      .filter((name) => /\.(ts|tsx)$/.test(name) && name !== "actions.ts")
      .filter((name) => /\busePluginAction\b/.test(readFileSync(UI + name, "utf8")));
    expect(direct).toEqual([]);
    expect(readFileSync(UI + "actions.ts", "utf8")).toMatch(/withRefusal\(usePluginAction\)/);
  });
});
