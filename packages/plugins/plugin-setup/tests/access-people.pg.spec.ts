import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GUARDED_PLUGINS, PERMISSION_CATALOG } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveAccessGrant } from "../src/access-grants.js";
import { accessAreas, accessPeople, saveGrantParams } from "../src/access-people.js";
import { recordAccessLost, recordAccessRefusal, setAccessMode } from "../src/access-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { grantPayload, setArea } from "../src/ui/people.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const CO = "co-1";
const OWNER = { type: "user", userId: "owner" };

function world() {
  const activity: Array<{ entityType: string; entityId: string; metadata: Record<string, unknown> }> = [];
  const state = new Map<string, unknown>();
  const key = (scope: { scopeId?: string; stateKey: string }) => `${scope.scopeId}:${scope.stateKey}`;
  const members = [
    { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
    { principalType: "user", principalId: "op", membershipRole: "operator", status: "active" },
    { principalType: "user", principalId: "u1", membershipRole: "member", status: "active" },
  ];
  const ctx = {
    db: { namespace: NAMESPACE, query: (sql: string, params?: unknown[]) => pg.db.query(sql, params), execute: (sql: string, params?: unknown[]) => pg.db.execute(sql, params) },
    state: {
      get: async (scope: { scopeId?: string; stateKey: string }) => state.get(key(scope)) ?? null,
      set: async (scope: { scopeId?: string; stateKey: string }, value: unknown) => void state.set(key(scope), value),
      delete: async (scope: { scopeId?: string; stateKey: string }) => void state.delete(key(scope)),
    },
    access: { members: { list: async () => members } },
    activity: { log: async (entry: (typeof activity)[number]) => void activity.push(entry) },
    events: { emit: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, activity };
}

describe("accessAreas", () => {
  it("covers every catalog key once, grouped by area", () => {
    const keys = accessAreas().flatMap((area) => area.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(PERMISSION_CATALOG.reduce((n, r) => n + r.actions.length, 0));
    expect(accessAreas()[0]).toMatchObject({ area: "crm" });
  });
});

describe.skipIf(!available)("the People tab view on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it("an operator is refused and nothing is read", async () => {
    const { ctx } = world();
    expect(await accessPeople(ctx, CO, { type: "user", userId: "op" })).toEqual({ ok: false, error: "Only a company owner or admin can manage access" });
    expect(await accessPeople(ctx, CO, { type: "agent" })).toMatchObject({ ok: false });
  });

  it("saving a grant shows the new rev and writes one activity entry", async () => {
    const { ctx, activity } = world();
    const before = await accessPeople(ctx, CO, OWNER);
    expect(before).toMatchObject({ ok: true, mode: "off", rev: 0, switchLost: false, refusals: [] });
    const saved = await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer", deny: ["crm.contacts:view"] });
    expect(saved).toMatchObject({ ok: true, rev: 1 });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ entityType: "plugin_access", entityId: "u1", metadata: { changedBy: "owner", before: null, after: { preset: "viewer" } } });

    const view = await accessPeople(ctx, CO, OWNER);
    if (!view.ok) throw new Error(view.error);
    expect(view.rev).toBe(1);
    // Owners and admins are not rows to edit; the operator and the member are.
    expect(view.people.map((row) => row.userId)).toEqual(["op", "u1"]);
    expect(view.people[1]!.grant).toMatchObject({ preset: "viewer", deny: ["crm.contacts:view"], linkedCompanyIds: [] });
    expect(view.plugins).toHaveLength(GUARDED_PLUGINS.length);
    expect(view.presets.map((p) => p.id)).toContain("clientManager");
  });

  it("a save from the tab keeps the scope overrides and own companies it does not edit", async () => {
    const { ctx } = world();
    await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer", linkedCompanyIds: ["client-1"], scopeOverrides: { crm: "linked" } });
    const before = await accessPeople(ctx, CO, OWNER);
    if (!before.ok) throw new Error(before.error);
    const grant = before.people.find((row) => row.userId === "u1")!.grant!;
    // The tab path: the row's draft with billing denied, the payload Save sends, the worker's params parse.
    const billing = accessAreas().find((a) => a.area === "billing")!.keys;
    const draft = setArea({ preset: grant.preset, allow: grant.allow, deny: grant.deny }, billing, "deny");
    const params: Record<string, unknown> = { companyId: CO, ...grantPayload("u1", grant, draft) };
    expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, saveGrantParams(params))).toMatchObject({ ok: true, rev: 2 });
    const after = await accessPeople(ctx, CO, OWNER);
    if (!after.ok) throw new Error(after.error);
    expect(after.people.find((row) => row.userId === "u1")!.grant).toMatchObject({ preset: "viewer", deny: billing, linkedCompanyIds: ["client-1"], scopeOverrides: { crm: "linked" } });
  });

  it("lists refusals newest first, with the agent they went through", async () => {
    const { ctx } = world();
    await setAccessMode(ctx, CO, "report", "owner", "2026-11-17T09:00:00.000Z");
    await recordAccessRefusal(ctx, { companyId: CO, pluginKey: "partnersinbiz.billing", userId: "u1", key: "billing.list", permission: "billing.invoices:view", viaAgentId: "agent-1", createdAt: "2026-11-17T10:00:00.000Z" });
    await recordAccessRefusal(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", userId: "u1", key: "crm.list", permission: null, viaAgentId: null, createdAt: "2026-11-17T11:00:00.000Z" });
    const view = await accessPeople(ctx, CO, OWNER);
    if (!view.ok) throw new Error(view.error);
    expect(view.refusals.map((r) => [r.pluginKey, r.viaAgentId])).toEqual([["partnersinbiz.crm", null], ["partnersinbiz.billing", "agent-1"]]);
  });

  it("switch lost: a plugin reported a rev and Setup has no row; choosing the switch clears it", async () => {
    const { ctx } = world();
    await recordAccessLost(ctx, CO, "partnersinbiz.ads", 4, "2026-11-17T10:00:00.000Z");
    expect(await accessPeople(ctx, CO, OWNER)).toMatchObject({ ok: true, switchLost: true, mode: "off" });
    await setAccessMode(ctx, CO, "off", "owner", "2026-11-17T10:01:00.000Z");
    expect(await accessPeople(ctx, CO, OWNER)).toMatchObject({ ok: true, switchLost: false, rev: 5 });
  });
});
