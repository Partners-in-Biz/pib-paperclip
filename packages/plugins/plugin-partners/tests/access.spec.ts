/**
 * The access guard of Partners (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12681): the kit's test helper
 * on the real plugin (registration, table, source, behaviour, agent and API route checks), the one-file rule for
 * `usePluginAction`, and real answers on the fake database: today's result with the switch absent, the refusal form
 * under `enforce` with nothing changed, and the owner passing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, ADMIN_ONLY } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS as T } from "@partnersinbiz/pib-plugin-kit/access-testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { NAMESPACE } from "../src/namespace.js";
import { createFakeDb, type Row, type Store } from "./helpers/fake-db.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe("Partners access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = createTestHarness({ manifest, config: { requireOwnerForGrants: true } });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("only src/ui/actions.ts imports usePluginAction; every other page file uses the wrapped hooks", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("every row names partners.grants or is ADMIN_ONLY, none is scoped, and the skill sync is ADMIN_ONLY", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (entry === ADMIN_ONLY) continue;
      expect(typeof entry === "object" && "resource" in entry, key).toBe(true);
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toBe("partners.grants");
      expect(entry.scoped, key).toBeUndefined();
    }
    expect(ACCESS_TABLE["partners.sync-skills"]).toBe(ADMIN_ONLY);
    // A tool needs the same permission as the page action that does the same.
    for (const name of ["propose-link", "propose-grant", "revoke-grant"]) expect(ACCESS_TABLE[`tool:${name}`], name).toEqual(ACCESS_TABLE[`partners.${name}`]);
  });
});

describe("Partners answers through the guard (fake database)", () => {
  const grant = (companyId: string): Row => ({
    id: "g-1", link_id: "l-1", record_type: "company", record_id: "crm-1", source_company_id: companyId, grantee_company_id: "co-9", status: "active", created_at: "2026-11-01T10:00:00Z",
  });
  const link = (companyId: string): Row => ({
    id: "l-1", company_a_id: companyId, company_b_id: "co-9", accepted_a: true, accepted_b: true, status: "active", created_at: "2026-11-01T09:00:00Z",
  });

  async function boot(companyId: string, mode: "enforce" | null) {
    const store: Store = { links: [link(companyId)], grants: [grant(companyId)] };
    const harness = createTestHarness({ manifest, config: { requireOwnerForGrants: true } });
    const at = new Date().toISOString();
    const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
    harness.seed({ accessMembers: [member(T.owner, "owner"), member(T.operator, "member")] } as never);
    (harness.ctx as unknown as { db: unknown }).db = createFakeDb(store, { namespace: NAMESPACE });
    if (mode) await harness.ctx.state.set(accessCompanyScope(companyId), { mode, rev: 1, userIds: [], receivedAt: at });
    await plugin.definition.setup(harness.ctx);
    const as = (userId: string) => ({ companyId, actor: { type: "user" as const, userId } });
    return { harness, store, as };
  }

  it("switch absent: an operator with no grant revokes a grant as today", async () => {
    const { harness, store, as } = await boot(T.absent, null);
    await expect(harness.performAction("partners.revoke-grant", { grantId: "g-1" }, as(T.operator))).resolves.toMatchObject({ grantId: "g-1", status: "revoked" });
    expect(store.grants?.[0]?.status).toBe("revoked");
  });

  it("enforce: an operator with no grant gets the refusal form and nothing changes; the owner revokes as today", async () => {
    const { harness, store, as } = await boot(T.enforce, "enforce");
    await expect(harness.performAction("partners.revoke-grant", { grantId: "g-1" }, as(T.operator))).resolves.toMatchObject({ ok: false, refused: true, code: "PERMISSION_DENIED" });
    expect(store.grants?.[0]?.status).toBe("active");
    await expect(harness.performAction("partners.revoke-grant", { grantId: "g-1" }, as(T.owner))).resolves.toMatchObject({ grantId: "g-1", status: "revoked" });
    expect(store.grants?.[0]?.status).toBe("revoked");
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const { as } = await boot(T.off, null);
    void as;
    const answer = await plugin.definition.onApiRequest!({
      routeKey: "no-such-route",
      method: "GET",
      path: "/no-such-route",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: T.operator, userId: T.operator },
      companyId: T.off,
      headers: {},
    });
    expect(answer).toEqual({ status: 404, body: { error: "Not found" } });
  });
});
