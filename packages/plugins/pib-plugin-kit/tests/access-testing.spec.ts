/**
 * The access test helper (plan 4.5 items 1 to 3) on fixture plugins: one
 * correct, one per way to get past the guard or out of step with the table.
 * Each fixture runs on the sdk's own harness, as a plugin spec will.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { assertPluginAccess, checkPluginAccess, NAMED_DATA_HANDLERS, sourceProblems } from "../src/access/testing.js";
import type { Fixture } from "./fixtures/access/base.js";

const NAMES = ["good", "unmapped-action", "stale-row", "direct-register", "direct-plugin-ctx", "direct-call", "extra-data-handler", "missing-api-entry"] as const;
const srcDir = (name: string) => fileURLToPath(new URL(`./fixtures/access/${name}/src`, import.meta.url));

async function check(name: (typeof NAMES)[number]) {
  const { fixture } = (await import(`./fixtures/access/${name}/src/worker.ts`)) as { fixture: Fixture };
  const harness = createTestHarness({ manifest: fixture.manifest });
  const input = { ctx: harness.ctx, setup: fixture.setup, manifest: fixture.manifest, table: fixture.table, srcDir: srcDir(name) };
  return { harness, input, problems: await checkPluginAccess(input) };
}

describe("access test helper: registration, table and source checks", () => {
  it("a correct plugin passes, and its handlers still reach the harness", async () => {
    const { harness, problems } = await check("good");
    expect(problems).toEqual([]);
    expect(await harness.performAction("save", {})).toEqual({ ok: true });
    expect(await harness.getData("status")).toEqual({ ok: true });
    expect(await harness.executeTool("look", {}, { companyId: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ content: "looked" });
  });

  it("an action with no table row is an unmapped action", async () => {
    expect((await check("unmapped-action")).problems).toEqual(['action "export" has no row in the access table (unmapped action)']);
  });

  it("a row for an action or tool that is not registered is stale", async () => {
    expect((await check("stale-row")).problems).toEqual([
      'table row "removed" names no registered action (stale row)',
      'table row "tool:removed" names no registered tool (stale row)',
    ]);
  });

  it.each([
    ["direct-register", "raw", 'ctx.actions.register("raw", handler);'],
    ["direct-plugin-ctx", "voice-token", 'pluginCtx.actions.register("voice-token", handler);'],
    ["direct-call", "set-limit", "ctx.actions.register.call(ctx.actions, key, fn);"],
  ] as const)("%s: a direct register call fails at runtime and in the source", async (name, key, line) => {
    const { problems } = await check(name);
    expect(problems[0]).toBe(`action "${key}" is registered directly, not through the access guard (use guard.action)`);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toMatch(/^worker\.ts:\d+ calls \.actions\.register directly: /);
    expect(problems[1]).toContain(line);
  });

  it("a data handler outside the named list is extra, at runtime and in the source", async () => {
    const { problems } = await check("extra-data-handler");
    expect(problems[0]).toMatch(/^data handler "rows" is not one of the named data handlers of fixture\.extra-data-handler \(extra data handler/);
    expect(problems[1]).toMatch(/^worker\.ts:\d+ calls \.data\.register directly: ctx\.data\.register\("rows", handler\);$/);
    expect(problems).toHaveLength(2);
  });

  it("a manifest API route with no api: row fails", async () => {
    expect((await check("missing-api-entry")).problems).toEqual(['manifest API route "export" has no row "api:export" in the access table']);
  });

  it("an api: row with no manifest route is stale; a named data handler not registered is reported", async () => {
    const { input } = await check("good");
    const harness = createTestHarness({ manifest: input.manifest });
    const problems = await checkPluginAccess({
      ...input,
      ctx: harness.ctx,
      table: { ...input.table, "api:old": { resource: "crm.contacts", action: "view" } },
      setup: (ctx) => input.setup({ ...ctx, data: { register: () => undefined } } as typeof ctx),
    });
    expect(problems).toContain('table row "api:old" names no manifest API route (stale row)');
    expect(problems).toContain('named data handler "status" of partnersinbiz.voice was not registered (remove it from NAMED_DATA_HANDLERS)');
  });

  it("a plugin with no guard is told so; assertPluginAccess throws one readable error", async () => {
    const { input } = await check("good");
    const harness = createTestHarness({ manifest: input.manifest });
    const setup = (ctx: typeof harness.ctx) => void ctx.actions.register("save", async () => ({}));
    await expect(assertPluginAccess({ ...input, ctx: harness.ctx, setup, srcDir: undefined })).rejects.toThrow(
      /^Access check failed for partnersinbiz\.voice:\n- no access guard was created in setup[\s\S]*\n- action "save" is registered directly/,
    );
  });

  it("the named data handlers are Studio 9, Voice 2, CRM 2 and no other plugin", () => {
    expect(Object.fromEntries(Object.entries(NAMED_DATA_HANDLERS).map(([k, v]) => [k, v.length]))).toEqual({ "partnersinbiz.studio": 9, "partnersinbiz.voice": 2 });
  });

  it("the source check skips the agent.tools.register capability string and comment lines", () => {
    expect(sourceProblems("partnersinbiz.voice", srcDir("good"))).toEqual([]);
    const other = sourceProblems("fixture.other", srcDir("good"));
    expect(other).toHaveLength(2);
    expect(other.every((p) => p.startsWith("worker.ts:") && p.includes("calls .data.register directly"))).toBe(true);
  });
});
