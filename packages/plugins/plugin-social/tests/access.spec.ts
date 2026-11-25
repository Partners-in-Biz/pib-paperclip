/**
 * The access guard of Social (access stage A, spec PAR-12578 section 4.5; PAR-12677): the kit's test helper on the real
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

/** What goes out to the public or signs a post off (changing who must sign off can complete pending approvals): never with edit or settings alone. */
const OUTGOING = [
  "social.approve",
  "social.schedule",
  "social.retry-post",
  "social.reply-inbox",
  "social.record-client-approval",
  "social.set-approval-policy",
  "social.set-approval-delegate",
  "my-social.approve",
  "tool:schedule-post",
  "tool:bulk-schedule",
  "tool:retry-post",
  "tool:reply-inbox",
  "tool:approve-post-as-delegate",
  "tool:record-review-verdict",
] as const;

/** Hiring, linking and the skill sync stay with owners and admins. */
const ADMIN_KEYS = ["social.hire-options", "social.start-hire", "social.link-agent", "social.unlink-agent", "social.activate-agent", "social.sync-skills", "social.preferences-save"] as const;

describe("Social access guard", () => {
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
      expect(entry.resource, key).toMatch(/^social\.(posts|accounts|settings)$/);
      expect(entry.scoped, key).toBeUndefined();
    }
  });

  it("publishing, replying and signing off need social.posts approve; hiring and preferences are owner or admin only", () => {
    for (const key of OUTGOING) expect(ACCESS_TABLE[key], key).toEqual({ resource: "social.posts", action: "approve" });
    for (const key of ADMIN_KEYS) expect(ACCESS_TABLE[key], key).toBe("ADMIN_ONLY");
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
