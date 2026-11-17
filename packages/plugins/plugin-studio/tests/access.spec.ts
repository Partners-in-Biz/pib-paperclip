/**
 * Studio's access guard (PAR-12687; PAR-12578 plan 4.4 and 4.5). The kit's helper runs the build-failing checks:
 * every action and tool through the guard and in the table, no stale rows, only the 9 named data handlers, no direct
 * `.register` call in src/, and the behaviour of items 4 to 6 (Studio has no API routes). The last cases run real
 * handlers, so "today's result" is what Studio really answers.
 */
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { describe, expect, it } from "vitest";
import { STUDIO_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const COMPANY = "a1600000-0000-4000-8000-000000000001";
const OWNER = "a1600000-0000-4000-8000-000000000011";
const OPERATOR = "a1600000-0000-4000-8000-000000000012";

describe("Studio access guard (PAR-12687)", () => {
  it("registers every action and tool through the guard, matches its table and passes the behaviour checks", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({ harness, setup: plugin.definition.setup, manifest, table: STUDIO_ACCESS_TABLE, srcDir: SRC });
  });

  it("keeps its 9 data handlers (S13) and has no API routes", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toHaveLength(9);
    expect(manifest.apiRoutes ?? []).toEqual([]);
    expect(Object.keys(STUDIO_ACCESS_TABLE).some((key) => key.startsWith("api:"))).toBe(false);
  });

  it("gives no row access.members.write and no row is scoped yet", () => {
    for (const entry of Object.values(STUDIO_ACCESS_TABLE)) {
      if (typeof entry === "object" && "resource" in entry) {
        expect(entry.resource).toMatch(/^studio\.(work|settings)$/);
        expect(entry.scoped).toBeUndefined();
      }
    }
  });

  describe("real handlers", () => {
    async function studio(mode?: "off" | "enforce") {
      const harness = createTestHarness({ manifest });
      const at = new Date().toISOString();
      const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
      harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] });
      await plugin.definition.setup(harness.ctx);
      if (mode) await harness.ctx.state.set(accessCompanyScope(COMPANY), { mode, rev: 1, userIds: [], receivedAt: at });
      const as = (userId: string) => ({ companyId: COMPANY, actor: { type: "user" as const, userId } });
      return { harness, as };
    }

    it("switch absent or off: an operator gets today's answer, Studio's own refusal included", async () => {
      for (const mode of [undefined, "off"] as const) {
        const { harness, as } = await studio(mode);
        expect(await harness.performAction("me", {}, as(OPERATOR))).toMatchObject({ role: "member", canGenerate: true, isOwner: false });
        expect(await harness.performAction("set-cap", { scopeKey: "company", monthlyCredits: 5 }, as(OPERATOR))).toEqual({
          ok: false,
          refused: true,
          code: "forbidden",
          message: "Only a company owner can change a credit cap.",
        });
      }
    });

    it("enforce: an operator with no grant gets the refusal form; the owner gets today's answer", async () => {
      const { harness, as } = await studio("enforce");
      expect(await harness.performAction("set-cap", { scopeKey: "company", monthlyCredits: 5 }, as(OPERATOR))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      expect(await harness.performAction("asset-url", { assetId: "x" }, as(OPERATOR))).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      // `me` is open to every member: the page reads the caller's own role first.
      expect(await harness.performAction("me", {}, as(OPERATOR))).toMatchObject({ role: "member" });
      expect(await harness.performAction("me", {}, as(OWNER))).toMatchObject({ role: "owner", isOwner: true });
    });

    it("enforce: an agent tool with no run is refused with the tool error the agent can pass on", async () => {
      const { harness } = await studio("enforce");
      const out = await harness.executeTool("studio-usage", {}, { agentId: "a1600000-0000-4000-8000-000000000021", runId: "", companyId: COMPANY });
      expect(out.error).toMatch(/^Access refused: the person this run works for may not do this/);
    });
  });
});
