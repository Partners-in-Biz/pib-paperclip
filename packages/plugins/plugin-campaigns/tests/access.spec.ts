/**
 * Campaigns' access guard (PAR-12684; PAR-12578 plan 4.4 to 4.6). The kit's helper runs the build-failing checks:
 * every action, tool and API route through the guard and in the table, no stale rows, no data handlers, no direct
 * `.register` call in src/, and the behaviour of 4.5 items 4 to 6. The last cases run real handlers, so "today's
 * result" is what Campaigns really answers, and the switch `off` is a pass-through.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { ACCESS_TEST_IDS, assertPluginAccess, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { AccessRefused, unwrapRefusal } from "@partnersinbiz/pib-plugin-ui";
import { describe, expect, it } from "vitest";
import { CAMPAIGNS_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const T = ACCESS_TEST_IDS;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe("Campaigns access guard (PAR-12684)", () => {
  it("registers every action, tool and route through the guard, matches its table and passes the behaviour checks", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({ harness, setup: plugin.definition.setup, onApiRequest: plugin.definition.onApiRequest!, manifest, table: CAMPAIGNS_ACCESS_TABLE, srcDir: SRC });
  });

  it("has no data handlers and a row for each of its 3 API routes", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toBeUndefined();
    expect((manifest.apiRoutes ?? []).map((route) => `api:${route.routeKey}`).sort()).toEqual(
      Object.keys(CAMPAIGNS_ACCESS_TABLE).filter((key) => key.startsWith("api:")).sort(),
    );
  });

  it("uses only the Campaigns resources, never access.members.write, and only campaigns.campaigns rows are scoped (stage B2)", () => {
    for (const [key, entry] of Object.entries(CAMPAIGNS_ACCESS_TABLE)) {
      expect(typeof entry === "object" && "resource" in entry, key).toBe(true);
      if (typeof entry === "object" && "resource" in entry) {
        expect(entry.resource, key).toMatch(/^campaigns\.(campaigns|settings)$/);
        if (entry.scoped !== undefined) expect([entry.resource, entry.scoped], key).toEqual(["campaigns.campaigns", true]);
      }
    }
  });

  it("page (PAR-12685): only src/ui/actions.ts imports usePluginAction; page and sidebar sit behind the access gate", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
    const actions = readFileSync(join(SRC, "ui", "actions.ts"), "utf8");
    expect(actions).toMatch(/withRefusal\(usePluginAction\)/);
    const page = readFileSync(join(SRC, "ui", "index.tsx"), "utf8");
    expect(page).toMatch(/<AccessGate state=\{access\} kind="page"[^>]*>\s*<CampaignsPageBody/);
    expect(page).toMatch(/<AccessGate state=\{access\} kind="sidebar">\s*<CampaignsSidebarEntry/);
  });

  describe("real handlers", () => {
    async function campaigns(mode?: "off" | "enforce") {
      const harness = createTestHarness({ manifest });
      const at = new Date().toISOString();
      const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: T.enforce, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
      harness.seed({ accessMembers: [member(T.owner, "owner"), member(T.operator, "member")] });
      await plugin.definition.setup(harness.ctx);
      if (mode) await harness.ctx.state.set(accessCompanyScope(T.enforce), { mode, rev: 1, userIds: [], receivedAt: at });
      const as = (userId: string) => ({ companyId: T.enforce, actor: { type: "user" as const, userId } });
      const route = (userId: string, routeKey: string) =>
        plugin.definition.onApiRequest!({ routeKey, method: "GET", path: `/${routeKey}`, params: {}, query: {}, body: null, actor: { actorType: "user", actorId: userId, userId }, companyId: T.enforce, headers: {} });
      return { harness, as, route };
    }

    it("switch absent or off: an operator with no grant gets today's answer, Campaigns' own errors included", async () => {
      for (const mode of [undefined, "off"] as const) {
        const { harness, as, route } = await campaigns(mode);
        await expect(harness.performAction("campaigns.detail", {}, as(T.operator))).rejects.toThrow(/campaignId/);
        expect(await route(T.operator, "client-summary")).toMatchObject({ status: 400 });
        // An unknown route key keeps today's 404.
        expect(await route(T.operator, "no-such-route")).toEqual({ status: 404, body: { error: "Not found" } });
      }
    });

    it("enforce: an operator with no grant gets the refusal form; the owner gets today's answer", async () => {
      const { harness, as, route } = await campaigns("enforce");
      expect(await harness.performAction("campaigns.detail", {}, as(T.operator))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      expect(await harness.performAction("campaigns.launch", { campaignId: "x" }, as(T.operator))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      await expect(harness.performAction("campaigns.detail", {}, as(T.owner))).rejects.toThrow(/campaignId/);
      expect(await route(T.operator, "client-summary")).toMatchObject({ status: 403, body: { refused: true, code: PERMISSION_DENIED } });
      expect(await route(T.owner, "client-summary")).toMatchObject({ status: 400 });
      expect(await route(T.owner, "no-such-route")).toMatchObject({ status: 403, body: { refused: true } });
    });

    it("enforce: an agent tool with no run is refused with the tool error the agent can pass on", async () => {
      const { harness } = await campaigns("enforce");
      const out = await harness.executeTool("suggest-ab-winner", { campaignId: "x" }, { agentId: T.agent, runId: "", companyId: T.enforce });
      expect(out.error).toMatch(/^Access refused: the person this run works for may not do this/);
    });

    it("page (PAR-12685): a refusal answer reaches the page as AccessRefused with the worker's message", async () => {
      const { harness, as } = await campaigns("enforce");
      const answer = await harness.performAction("campaigns.load", {}, as(T.operator));
      expect(() => unwrapRefusal(answer)).toThrow(AccessRefused);
      expect(() => unwrapRefusal(answer)).toThrow((answer as { message: string }).message);
    });
  });
});
