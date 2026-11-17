/**
 * The access guard of Paid ads (access stage A, spec PAR-12578 section 4.5; PAR-12645): the kit's test helper on the real
 * plugin (registration, table, source, behaviour, agent and API route checks), the one-file rule for `usePluginAction`, and
 * today's answers with the switch off.
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

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe("Paid ads access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("only src/ui/actions.ts imports usePluginAction; every other page file uses the wrapped hook", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("no entry is scoped yet, and no table row names another plugin's resource", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^ads\.(work|settings)$/);
      expect(entry.scoped, key).toBeUndefined();
    }
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const harness = createTestHarness({ manifest });
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
