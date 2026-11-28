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
import { ACTING_PERSON_SQL, PERMISSION_DENIED, accessCompanyScope, accessGrantScope, guardProbes, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";

/** Signing off a change and running one spend money: they need `ads.work` approve, not edit. */
const MONEY_KEYS = ["ads.approve", "ads.execute", "tool:execute-ad-change"] as const;

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

  it("no table row names another plugin's resource; only ads.work rows are scoped (stage B2, own-scope.pg.spec.ts)", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^ads\.(work|settings)$/);
      if (entry.resource === "ads.settings") expect(entry.scoped, key).toBeUndefined();
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

  it("the money paths need ads.work approve: the table says so", () => {
    for (const key of MONEY_KEYS) expect(ACCESS_TABLE[key], key).toMatchObject({ resource: "ads.work", action: "approve" });
  });

  it("under enforce, an operator with every permission but ads.work approve is refused on the money paths; with approve he passes", async () => {
    const id = (n: number) => `a4ad0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const [company, editor, approver, agent, runEditor, runApprover] = [1, 2, 3, 4, 5, 6].map(id);
    const all = ["ads.work:view", "ads.work:edit", "ads.work:create", "ads.settings:view", "ads.settings:edit"];
    const scopeOverrides = { "ads.work": "all", "ads.settings": "all" };
    const key = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;
    const rows = new Map<string, unknown>([
      [key(accessCompanyScope(company)), { mode: "enforce", rev: 1, userIds: [], receivedAt: new Date().toISOString() }],
      [key(accessGrantScope(company, editor)), { allow: all, scopeOverrides }],
      [key(accessGrantScope(company, approver)), { allow: [...all, "ads.work:approve"], scopeOverrides }],
    ]);
    const runs = new Map([[runEditor, editor], [runApprover, approver]]);
    const harness = createTestHarness({ manifest });
    const at = new Date().toISOString();
    harness.seed({
      accessMembers: [editor, approver].map((userId) => ({ id: `m-${userId}`, companyId: company, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: "member", grants: [], createdAt: at, updatedAt: at })),
    });
    await plugin.definition.setup(harness.ctx);
    const { get } = harness.ctx.state;
    const { query } = harness.ctx.db;
    harness.ctx.state.get = async (scope) => (rows.has(key(scope)) ? rows.get(key(scope)) : get.call(harness.ctx.state, scope));
    harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (sql !== ACTING_PERSON_SQL) return query.call(harness.ctx.db, sql, params);
      const user = runs.get(params?.[0] as string);
      return user && params?.[1] === company && params?.[2] === agent ? [{ responsible_user_id: user, status: "running" }] : [];
    }) as typeof harness.ctx.db.query;
    const reached: string[] = [];
    guardProbes().set(manifest.id, { hidden: new Set(), reached: (k) => (reached.push(k), { content: "reached", status: 200, body: null }) });
    const outcome = async (k: (typeof MONEY_KEYS)[number], userId: string, runId: string) => {
      reached.length = 0;
      const result = k.startsWith("tool:")
        ? await harness.executeTool(k.slice(5), {}, { agentId: agent, runId, companyId: company })
        : await harness.performAction(k, {}, { companyId: company, actor: { type: "user", userId } });
      if (reached.length) return "pass";
      const r = result as { error?: unknown } | null;
      if (isRefusal(r) && r.code === PERMISSION_DENIED) return "refused";
      if (typeof r?.error === "string" && r.error.startsWith("Access refused")) return "refused";
      return `unexpected: ${JSON.stringify(result)}`;
    };
    try {
      for (const k of MONEY_KEYS) {
        expect(await outcome(k, editor, runEditor), `${k}, operator with edit only`).toBe("refused");
        expect(await outcome(k, approver, runApprover), `${k}, operator with approve`).toBe("pass");
      }
    } finally {
      guardProbes().delete(manifest.id);
    }
  });
});
