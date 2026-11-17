/**
 * The access guard of the Mailbox (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12682): the kit's test
 * helper on the real plugin (registration, table, source, behaviour, agent and API route checks), the one-file rule
 * for `usePluginAction`, a tool and its page action need the same permission, and today's answers with the switch off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ADMIN_ONLY } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { MAILBOX_TOOLS } from "../src/tools.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
const harnessOf = () => createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });

describe("Mailbox access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    await assertPluginAccess({
      harness: harnessOf(),
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

  it("no entry is scoped, every row names a Mailbox resource, and the table's ADMIN_ONLY is the kit's", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^mailbox\.(mail|accounts|settings)$/);
      expect(entry.scoped, key).toBeUndefined();
    }
    expect(ACCESS_TABLE["mailbox.preferences-save"]).toBe(ADMIN_ONLY);
    expect(Object.values(ACCESS_TABLE).some((e) => typeof e === "object" && "anyMember" in e)).toBe(false);
  });

  it("a tool needs the same permission as the page action of the same name", () => {
    const pairs = MAILBOX_TOOLS.map((t) => t.name).filter((name) => ACCESS_TABLE[`mailbox.${name}`]);
    expect(pairs.length).toBeGreaterThan(5);
    for (const name of pairs) expect(ACCESS_TABLE[`tool:${name}`], name).toEqual(ACCESS_TABLE[`mailbox.${name}`]);
    // Different names, same work.
    expect(ACCESS_TABLE["tool:check-sender-domain"]).toEqual(ACCESS_TABLE["mailbox.check-domain"]);
    expect(ACCESS_TABLE["tool:map-client-mail"]).toEqual(ACCESS_TABLE["mailbox.add-client-map"]);
    expect(ACCESS_TABLE["tool:remove-client-mail-map"]).toEqual(ACCESS_TABLE["mailbox.remove-client-map"]);
    expect(ACCESS_TABLE["tool:list-sending-domains"]).toEqual(ACCESS_TABLE["mailbox.sending-domains"]);
  });

  it("with the switch off an operator's page action answers as today (the real handler, no refusal)", async () => {
    const harness = harnessOf();
    await plugin.definition.setup(harness.ctx);
    const person = { companyId: ACCESS_TEST_IDS.off, actor: { type: "user" as const, userId: ACCESS_TEST_IDS.operator } };
    // The handler itself runs: a missing parameter is its own error, not the guard's.
    await expect(harness.performAction("mailbox.get-message", {}, person)).rejects.toThrow(/messageId/);
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const harness = harnessOf();
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
    expect(answer).toEqual({ status: 404, body: { error: "Unknown route" } });
  });
});
