/**
 * The access guard of CRM Telephony (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12683): the kit's test
 * helper on the real plugin through the sdk harness (registration, table, source, behaviour and agent checks), the
 * one-file rule for `usePluginAction`, and today's answers with the switch off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { assertPluginAccess, ACCESS_TEST_IDS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { TELEPHONY_TOOLS } from "../src/tools.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
const harnessOf = () => createTestHarness({ manifest });

describe("CRM Telephony access guard", () => {
  it("every action and tool goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 5)", async () => {
    const harness = harnessOf();
    await assertPluginAccess({ harness, setup: plugin.definition.setup, manifest, table: ACCESS_TABLE, srcDir: SRC });
  });

  it("has no API routes, so no api: rows (4.5 item 2, and item 6 has nothing to ask)", () => {
    expect(manifest.apiRoutes ?? []).toEqual([]);
    expect(Object.keys(ACCESS_TABLE).filter((k) => k.startsWith("api:"))).toEqual([]);
  });

  it("only src/ui/actions.ts imports usePluginAction; every other page file uses the wrapped hook", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("every row names a telephony permission, none is scoped, and each tool has a row", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      expect(typeof entry === "object" && "resource" in entry, key).toBe(true);
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(`${entry.resource}:${entry.action}`, key).toMatch(/^telephony\.(calls:(view|create)|settings:(view|edit))$/);
      expect(entry.scoped, key).toBeUndefined();
    }
    for (const tool of TELEPHONY_TOOLS) expect(ACCESS_TABLE[`tool:${tool.name}`], tool.name).toBeDefined();
  });

  it("with the switch off an action answers as before: the plugin's own dialer check still runs after the guard", async () => {
    const harness = harnessOf();
    await plugin.definition.setup(harness.ctx);
    const operator = { companyId: ACCESS_TEST_IDS.off, actor: { type: "user" as const, userId: ACCESS_TEST_IDS.operator } };
    // No `voiceAllowedUserIds` set: today's answer from src/access.ts, not the guard's refusal form.
    await expect(harness.performAction("telephony.unmatched", {}, operator)).resolves.toEqual({ status: 403, error: "Calling is not enabled for any user" });
  });
});
