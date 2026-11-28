/**
 * The access test helper's behaviour checks (plan 4.5 items 4 to 6) on fixture
 * plugins: the correct one passes with one call; each mistake fails with its line.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { assertPluginAccess, checkPluginAccess } from "../src/access/testing.js";
import { guardProbes } from "../src/access/guard.js";
import { BEHAVIOUR_FIXTURES } from "./fixtures/access/behaviour.js";

async function check(name: keyof typeof BEHAVIOUR_FIXTURES, withRoutes = true) {
  const f = BEHAVIOUR_FIXTURES[name];
  const harness = createTestHarness({ manifest: f.manifest });
  const input = { harness, setup: f.setup, manifest: f.manifest, table: f.table, onApiRequest: withRoutes ? f.onApiRequest : undefined };
  return { harness, problems: await checkPluginAccess(input), input };
}

describe("access test helper: behaviour, agent and API route checks", () => {
  it("a correct plugin passes items 1 to 6 with one call, and the real handlers run again afterwards", async () => {
    const f = BEHAVIOUR_FIXTURES.good;
    const harness = createTestHarness({ manifest: f.manifest });
    await assertPluginAccess({ harness, setup: f.setup, manifest: f.manifest, table: f.table, onApiRequest: f.onApiRequest });
    expect(guardProbes().size).toBe(0);
    expect(await harness.performAction("save", {}, { companyId: "a1500000-0000-4000-8000-000000000001" })).toEqual({ ok: true });
  });

  it("item 4, switch absent and off: a switch that cannot be read enforces, so calls are refused", async () => {
    const { problems } = await check("no-state-read");
    expect(problems).toContain('action "save", switch absent, operator with no grant: expected today\'s result (the call reaches its handler), got the refusal form ("Cannot verify your access")');
    expect(problems).toContain('action "save", switch off, operator with no grant: expected today\'s result (the call reaches its handler), got the refusal form ("Cannot verify your access")');
  });

  it("item 4, no grant: a guard given a looser table than the exported one lets the operator through", async () => {
    expect((await check("table-mismatch")).problems).toEqual([
      'action "save", enforce, operator with no grant: expected the refusal form, got today\'s result (the call reached its handler)',
    ]);
  });

  it("item 4, owner: members that cannot be read refuse the owner", async () => {
    const { problems } = await check("no-members-read");
    expect(problems).toContain('action "save", enforce, owner: expected today\'s result (the call reaches its handler), got the refusal form ("Cannot verify your access")');
  });

  it("item 4, row missing: a guard that is not this plugin's own skips every check", async () => {
    const { problems } = await check("wrong-plugin-key");
    expect(problems).toContain(
      'action "save" missing from the table, enforce, operator granted every permission: expected the refusal form, got {"ok":true}, not through the access guard of fixture.wrong-plugin-key (is createAccessGuard given pluginKey "fixture.wrong-plugin-key"?)',
    );
  });

  it("item 5: a run that cannot be read refuses a run working for the owner", async () => {
    const { problems } = await check("no-run-read");
    expect(problems).toContain(
      'tool "look", enforce, run working for the owner: expected today\'s result (the call reaches its handler), got the refusal form ("Access refused: the person this run works for may not do this (Cannot verify the run of this call). An owner can change it in Setup under People.")',
    );
    expect(problems.filter((p) => p.startsWith("action "))).toEqual([]);
  });

  it("item 6: routes answered outside the guard are not refused", async () => {
    const { problems } = await check("route-bypass");
    expect(problems.every((p) => p.startsWith("API route") || p.startsWith("unknown API route"))).toBe(true);
    expect(problems).toHaveLength(9);
    expect(problems.slice(4, 7)).toEqual([
      'API route "items", enforce, operator with no grant: expected the refusal form, got {"status":200,"body":[]}, not through the access guard of fixture.route-bypass (is createAccessGuard given pluginKey "fixture.route-bypass"?)',
      'API route "items", enforce, agent on a run working for an operator with no grant: expected the refusal form, got {"status":200,"body":[]}, not through the access guard of fixture.route-bypass (is createAccessGuard given pluginKey "fixture.route-bypass"?)',
      'unknown API route key, enforce, owner: expected the refusal form, got {"status":200,"body":[]}, not through the access guard of fixture.route-bypass (is createAccessGuard given pluginKey "fixture.route-bypass"?)',
    ]);
    // Item 7 (H3): the host's restricted mark with no row, and a key with no run.
    expect(problems.slice(7)).toEqual([
      'API route "items", switch absent, operator marked restricted by core: expected the refusal form, got {"status":200,"body":[]}, not through the access guard of fixture.route-bypass (is createAccessGuard given pluginKey "fixture.route-bypass"?)',
      'API route "items", enforce, agent key with no run working for the owner (host\'s person): expected today\'s result (the call reaches its handler), got {"status":200,"body":[]}, not through the access guard of fixture.route-bypass (is createAccessGuard given pluginKey "fixture.route-bypass"?)',
    ]);
  });

  it("item 1.5: a plugin whose setup does not subscribe to Setup's access.updated fails", async () => {
    expect((await check("no-receiver")).problems).toEqual([
      'setup does not subscribe to "plugin.partnersinbiz.setup.access.updated", so Setup\'s access is never received or confirmed (createAccessGuard registers the receiver; is it given the plugin\'s ctx?)',
    ]);
  });

  it("item 1.5: a receiver that cannot store the row, or cannot confirm, fails", async () => {
    const send = "Setup's \"plugin.partnersinbiz.setup.access.updated\" (rev 2)";
    expect((await check("no-state-write")).problems).toEqual([
      `${send}: expected the company row at rev 2 in the plugin's state, got null`,
      `${send}: expected "access.synced" {"companyId":"a1500000-0000-4000-8000-000000000004","rev":2,"pluginKey":"fixture.no-state-write"}, got no confirmation`,
    ]);
    expect((await check("no-emit")).problems).toEqual([
      `${send}: expected "access.synced" {"companyId":"a1500000-0000-4000-8000-000000000004","rev":2,"pluginKey":"fixture.no-emit"}, got no confirmation`,
    ]);
  });

  it("item 1.5: a correct plugin stores Setup's send and confirms it", async () => {
    const { harness, problems } = await check("good");
    expect(problems).toEqual([]);
    expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: "a1500000-0000-4000-8000-000000000004", namespace: "access", stateKey: "company" })).toMatchObject({ mode: "off", rev: 2 });
  });

  it("a plugin with API routes and no onApiRequest given is told so", async () => {
    expect((await check("good", false)).problems).toEqual([
      "the manifest has API routes but no onApiRequest was given to the access check (pass plugin.definition.onApiRequest)",
    ]);
  });

  it("the harness's own state and db reads are back in place afterwards", async () => {
    const { harness } = await check("good");
    expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: "a1500000-0000-4000-8000-000000000003", namespace: "access", stateKey: "company" })).toBeNull();
    expect(await harness.ctx.db.query("SELECT 1", [])).toEqual([]);
  });
});
