/**
 * The Cockpit's access guard (PAR-12700; PAR-12578 plan 4.4 and 4.5). The kit's helper runs the build-failing checks:
 * every action and tool through the guard and in the table, no stale rows, no data handlers, every manifest route with
 * an `api:` row, no direct `.register` call in src/, and the behaviour of items 4 to 6. The last cases run real
 * handlers on the sdk harness (F19), so "today's result" is what the Cockpit really answers. Part 2 (PAR-12701, 4.6):
 * the page gate on every page, sidebar row and widget, and `withRefusal` on every page action.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, ADMIN_ONLY, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { AccessRefused, checkAccess, unwrapRefusal } from "@partnersinbiz/pib-plugin-ui";
import { describe, expect, it } from "vitest";
import { COCKPIT_ACCESS_TABLE } from "../src/access-table.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
/**
 * The grouped sidebar rows (Clients, Marketing, Finance, Hosted) lead to other modules, each of which gates its own
 * page; member plugins hide their own rows while a group exists, so gating a group on the Cockpit would hide a module
 * the person may use. Their Cockpit counts come from guarded actions, so a closed person sees no counts.
 */
const NAV_GROUP_EXPORTS = ["ClientsNav", "MarketingNav", "FinanceNav", "HostedClientsNav"];
const COMPANY = "a1700000-0000-4000-8000-000000000001";
const OWNER = "a1700000-0000-4000-8000-000000000011";
const OPERATOR = "a1700000-0000-4000-8000-000000000012";

describe("Cockpit access guard (PAR-12700, PAR-12701)", () => {
  it("registers every action, tool and route through the guard, matches its table and passes the behaviour checks", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({ harness, setup: plugin.definition.setup, onApiRequest: plugin.definition.onApiRequest, manifest, table: COCKPIT_ACCESS_TABLE, srcDir: SRC });
  }, 60_000);

  it("has no data handlers and an api: row for each of its 9 manifest routes", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toBeUndefined();
    const routes = (manifest.apiRoutes ?? []).map((r) => `api:${r.routeKey}`).sort();
    expect(routes).toHaveLength(9);
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

  it("only src/ui/actions.ts imports usePluginAction, and its page hook is the UI kit's withRefusal (4.6, PAR-12701)", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
    expect(readFileSync(join(SRC, "ui", "actions.ts"), "utf8")).toMatch(/export const useCockpitAction = withRefusal\(usePluginAction\);/);
  });

  it("every page, sidebar and widget slot in the manifest is behind the page gate, except the named nav groups (4.6, PAR-12701)", () => {
    const index = readFileSync(join(SRC, "ui", "index.tsx"), "utf8");
    const nav = readFileSync(join(SRC, "ui", "nav.tsx"), "utf8");
    const slots = manifest.ui?.slots ?? [];
    expect(slots.map((slot) => slot.exportName).filter((name) => NAV_GROUP_EXPORTS.includes(name)).sort()).toEqual([...NAV_GROUP_EXPORTS].sort());
    for (const slot of slots) {
      if (NAV_GROUP_EXPORTS.includes(slot.exportName)) {
        expect(nav, slot.exportName).toMatch(new RegExp(`export function ${slot.exportName}\\b`));
        continue;
      }
      const kind = slot.type === "sidebar" ? "sidebar" : slot.type === "dashboardWidget" ? "widget" : "page";
      // `export const X = withHelp(Y)` gates in Y; otherwise X itself is the gate.
      const inner = new RegExp(`export const ${slot.exportName} = withHelp\\((\\w+)\\)`).exec(index)?.[1] ?? slot.exportName;
      const gate = new RegExp(`function ${inner}\\(props: \\w+\\) \\{\\n  const access = useAccess\\(useAccessMe\\(\\), props\\.context\\.companyId\\);\\n  return \\(\\n    <AccessGate state=\\{access\\} kind="${kind}"`);
      expect(index, slot.exportName).toMatch(gate);
    }
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

    it("page gate: open with the switch absent or off and for the owner; closed for an operator with no grant under enforce", async () => {
      const gate = async (mode: "off" | "enforce" | undefined, userId: string) => {
        const { harness, as } = await cockpit(mode);
        return checkAccess((params) => harness.performAction("access.me", params, as(userId)), COMPANY);
      };
      expect(await gate(undefined, OPERATOR)).toBe("open");
      expect(await gate("off", OPERATOR)).toBe("open");
      expect(await gate("enforce", OWNER)).toBe("open");
      expect(await gate("enforce", OPERATOR)).toBe("closed");
    });

    it("a page action's refusal throws AccessRefused with the worker's message instead of reading as success (withRefusal)", async () => {
      const { harness, as } = await cockpit("enforce");
      for (const [key, params] of [["paper.month", { month: "2026-11" }], ["outward-send.dismiss", { key: "outward-send:x" }]] as const) {
        const answer = await harness.performAction(key, params, as(OPERATOR));
        expect(() => unwrapRefusal(answer), key).toThrow(AccessRefused);
        expect(() => unwrapRefusal(answer), key).toThrow((answer as { message: string }).message);
      }
      const me = await harness.performAction("access.me", {}, as(OWNER));
      expect(unwrapRefusal(me)).toBe(me);
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
