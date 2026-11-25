/**
 * The Cockpit's access guard (PAR-12700; PAR-12578 plan 4.4 and 4.5). The kit's helper runs the build-failing checks:
 * every action and tool through the guard and in the table, no stale rows, no data handlers, every manifest route with
 * an `api:` row, no direct `.register` call in src/, and the behaviour of items 4 to 6. The last cases run real
 * handlers on the sdk harness (F19), so "today's result" is what the Cockpit really answers.
 */
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, ADMIN_ONLY, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { describe, expect, it } from "vitest";
import { COCKPIT_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const COMPANY = "a1700000-0000-4000-8000-000000000001";
const OWNER = "a1700000-0000-4000-8000-000000000011";
const OPERATOR = "a1700000-0000-4000-8000-000000000012";

describe("Cockpit access guard (PAR-12700)", () => {
  it("registers every action, tool and route through the guard, matches its table and passes the behaviour checks", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({ harness, setup: plugin.definition.setup, onApiRequest: plugin.definition.onApiRequest, manifest, table: COCKPIT_ACCESS_TABLE, srcDir: SRC });
  }, 60_000);

  it("has no data handlers and an api: row for each of its 8 manifest routes", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toBeUndefined();
    const routes = (manifest.apiRoutes ?? []).map((r) => `api:${r.routeKey}`).sort();
    expect(routes).toHaveLength(8);
    expect(Object.keys(COCKPIT_ACCESS_TABLE).filter((key) => key.startsWith("api:")).sort()).toEqual(routes);
  });

  it("uses only the Cockpit's own catalog resources, none scoped, and keeps owner-only work ADMIN_ONLY", () => {
    for (const entry of Object.values(COCKPIT_ACCESS_TABLE)) {
      if (typeof entry === "object" && "resource" in entry) {
        expect(entry.resource).toMatch(/^cockpit\.(dashboards|settings|paper)$/);
        expect(entry.scoped).toBeUndefined();
      }
    }
    for (const key of ["cockpit.attest", "goals.confirm", "ownerDefaults.save", "ownerDigest.post", "tool:access-grant", "api:access-inventory", "api:owner-push"]) {
      expect(COCKPIT_ACCESS_TABLE[key]).toBe(ADMIN_ONLY);
    }
    expect(COCKPIT_ACCESS_TABLE["paper.save"]).toEqual({ resource: "cockpit.paper", action: "edit" });
  });

  describe("real handlers", () => {
    async function cockpit(mode?: "off" | "enforce") {
      const harness = createTestHarness({ manifest });
      const at = new Date().toISOString();
      const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
      harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] });
      await plugin.definition.setup(harness.ctx);
      if (mode) await harness.ctx.state.set(accessCompanyScope(COMPANY), { mode, rev: 1, userIds: [], receivedAt: at });
      const as = (userId: string) => ({ companyId: COMPANY, actor: { type: "user" as const, userId } });
      return { harness, as };
    }

    it("switch absent or off: an operator gets today's answer", async () => {
      for (const mode of [undefined, "off"] as const) {
        const { harness, as } = await cockpit(mode);
        await expect(harness.performAction("paper.month", { month: "May" }, as(OPERATOR))).rejects.toThrow("month must be YYYY-MM");
      }
    });

    it("enforce: an operator with no grant gets the refusal form; the owner gets today's answer", async () => {
      const { harness, as } = await cockpit("enforce");
      expect(await harness.performAction("paper.month", { month: "May" }, as(OPERATOR))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      expect(await harness.performAction("ownerDigest.post", {}, as(OPERATOR))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      await expect(harness.performAction("paper.month", { month: "May" }, as(OWNER))).rejects.toThrow("month must be YYYY-MM");
    });

    it("enforce: an agent tool with no run is refused with the tool error the agent can pass on", async () => {
      const { harness } = await cockpit("enforce");
      const out = await harness.executeTool("governor-state", {}, { agentId: "a1700000-0000-4000-8000-000000000021", runId: "", companyId: COMPANY });
      expect(out.error).toMatch(/^Access refused: the person this run works for may not do this/);
    });

    it("enforce: an operator's API route call gets a 403 refusal; the owner reaches the handler", async () => {
      // The worker answers routes for the context it was set up with last: this one.
      await cockpit("enforce");
      const route = (userId: string) => plugin.definition.onApiRequest!({ routeKey: "repairs-create", method: "POST", path: "/repairs", params: {}, query: {}, body: {}, actor: { actorType: "user", actorId: userId, userId }, companyId: COMPANY, headers: {} });
      expect(await route(OPERATOR)).toMatchObject({ status: 403, body: { refused: true, code: PERMISSION_DENIED } });
      expect(await route(OWNER)).toEqual({ status: 400, body: { error: "companyId is required and must be a non-empty string" } });
    });
  });
});
