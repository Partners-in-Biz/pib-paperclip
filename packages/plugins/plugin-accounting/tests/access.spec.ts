/**
 * Accounting's access guard (access stage A, spec PAR-12578 sections 4.4 to 4.6):
 * the kit's access check (4.5 items 1 to 6) on the real worker, the switch
 * `off` as a pass-through, and the page files reaching actions only through
 * the `withRefusal` file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginAccessMember } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ACCESS_TEST_IDS, assertPluginAccess } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { accessCompanyScope, accessGrantScope, isRefusal, PERMISSION_DENIED, permissionKey } from "@partnersinbiz/pib-plugin-kit";
import { ACCOUNTING_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const UI = fileURLToPath(new URL("../src/ui/", import.meta.url));
const T = ACCESS_TEST_IDS;
const RESOURCES = ["accounting.ledger", "accounting.reports", "accounting.settings", "accounting.bank", "accounting.assets"];

async function started() {
  const harness = createTestHarness({ manifest, config: {} });
  // The harness names its namespace test_<id>; Accounting's table names need plugin_<…> (db.ts).
  (harness.ctx.db as { namespace: string }).namespace = NAMESPACE;
  await plugin.definition.setup(harness.ctx);
  return harness;
}

/** A plain member of the company with no host grants. */
function member(companyId: string, userId: string): PluginAccessMember {
  const at = new Date().toISOString();
  return { id: `m-${companyId}-${userId}`, companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member", grants: [], createdAt: at, updatedAt: at };
}

async function setSwitch(harness: Awaited<ReturnType<typeof started>>, companyId: string, mode: "off" | "enforce") {
  await harness.ctx.state.set(accessCompanyScope(companyId), { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
}

describe("Accounting access guard", () => {
  it("passes the kit's access check: every action, tool and route through the guard and in the table, and its behaviour", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCOUNTING_ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("with the switch off the guard is a pass-through: the same answer as with no switch, for a member with no grant", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.off, T.operator)] });
    await setSwitch(harness, T.off, "off");
    const asOperator = (companyId: string) => harness.performAction("accounting.decisions", {}, { companyId, actor: { type: "user", userId: T.operator } });
    const absent = await asOperator(T.absent);
    expect(isRefusal(absent)).toBe(false);
    expect(await asOperator(T.off)).toEqual(absent);
  });

  it("under enforce a member with no grant gets the refusal form, not the books", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.enforce, T.operator)] });
    await setSwitch(harness, T.enforce, "enforce");
    const answer = await harness.performAction("accounting.load", {}, { companyId: T.enforce, actor: { type: "user", userId: T.operator } });
    expect(answer).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
  });

  it("under enforce bank view opens the bank lines but not the ledger, bank edit or the Bookkeeper", async () => {
    const harness = await started();
    harness.seed({ accessMembers: [member(T.enforce, T.granted)] });
    await setSwitch(harness, T.enforce, "enforce");
    await harness.ctx.state.set(accessGrantScope(T.enforce, T.granted), { allow: [permissionKey("accounting.bank", "view")], scopeOverrides: { "accounting.bank": "all" } });
    const asGranted = (key: string) => harness.performAction(key, {}, { companyId: T.enforce, actor: { type: "user", userId: T.granted } });
    for (const key of ["accounting.load", "accounting.journals", "accounting.decisions", "accounting.save-rule", "accounting.approve-reconciliation", "accounting.start-hire"]) {
      expect(await asGranted(key), key).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
    }
    // The grant itself works: a bank read is not refused (the harness has no books, so it may fail further on).
    const bank = await asGranted("accounting.bank-lines").catch((error: unknown) => error);
    expect(isRefusal(bank)).toBe(false);
  });

  it("every row names an Accounting catalog resource or is owner/admin only; none is scoped", () => {
    for (const [key, entry] of Object.entries(ACCOUNTING_ACCESS_TABLE)) {
      if (typeof entry === "object" && "resource" in entry) {
        expect(RESOURCES, key).toContain(entry.resource);
        expect(entry.scoped, key).toBeUndefined();
      } else {
        expect(entry, key).toBe("ADMIN_ONLY");
      }
    }
    // The two resources this stage added are both used.
    const used = new Set(Object.values(ACCOUNTING_ACCESS_TABLE).flatMap((e) => (typeof e === "object" && "resource" in e ? [e.resource] : [])));
    expect(used.has("accounting.bank")).toBe(true);
    expect(used.has("accounting.assets")).toBe(true);
  });

  it("page files reach actions only through useAccountingAction (withRefusal), never usePluginAction directly", () => {
    const direct = readdirSync(UI)
      .filter((name) => /\.(ts|tsx)$/.test(name) && name !== "actions.ts")
      .filter((name) => /\busePluginAction\b/.test(readFileSync(UI + name, "utf8")));
    expect(direct).toEqual([]);
    expect(readFileSync(UI + "actions.ts", "utf8")).toMatch(/withRefusal\(usePluginAction\)/);
  });
});
