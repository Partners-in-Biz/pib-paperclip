import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACCESS_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAccessGrant, saveAccessGrant } from "../src/access-grants.js";
import { ACCESS_PART_MAX_BYTES, buildAccessPayloads, publishAccess, type AccessUpdatedPayload } from "../src/access-publish.js";
import { getAccessSettings } from "../src/access-store.js";
import { NAMESPACE } from "../src/namespace.js";
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

/** A ctx on the real database with in-memory state, members, activity and events, logging every write in order. */
function world(opts: { members?: number; auditFails?: boolean; stateReadFails?: boolean } = {}) {
  const log: string[] = [];
  const state = new Map<string, unknown>();
  const emitted: Array<{ name: string; companyId: string; payload: AccessUpdatedPayload }> = [];
  const members = [
    { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
    { principalType: "user", principalId: "admin2", membershipRole: "admin", status: "active" },
    ...Array.from({ length: opts.members ?? 3 }, (_, i) => ({ principalType: "user", principalId: `u${i + 1}`, membershipRole: "member", status: "active" })),
  ];
  const key = (scope: { scopeId?: string; namespace?: string; stateKey: string }) => `${scope.scopeId}:${scope.namespace}:${scope.stateKey}`;
  const sqlVerb = (sql: string) => {
    const s = sql.replace(/\s+/g, " ");
    if (s.includes("granted_user_ids || ")) return "db:add-id";
    if (s.includes("granted_user_ids - ")) return "db:remove-id+rev";
    if (s.includes("rev = rev + 1")) return "db:rev";
    return `db:${s.slice(0, 20)}`;
  };
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: (sql: string, params?: unknown[]) => pg.db.query(sql, params),
      execute: async (sql: string, params?: unknown[]) => {
        log.push(sqlVerb(sql));
        return pg.db.execute(sql, params);
      },
    },
    state: {
      get: async (scope: { scopeId?: string; namespace?: string; stateKey: string }) => {
        if (opts.stateReadFails && scope.stateKey.startsWith("u:")) throw new Error("state down");
        return state.get(key(scope)) ?? null;
      },
      set: async (scope: { scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        log.push(`state:set ${scope.stateKey}`);
        state.set(key(scope), value);
      },
      delete: async (scope: { scopeId?: string; namespace?: string; stateKey: string }) => {
        log.push(`state:delete ${scope.stateKey}`);
        state.delete(key(scope));
      },
    },
    access: { members: { list: async () => members } },
    activity: {
      log: async () => {
        if (opts.auditFails) throw new Error("activity down");
        log.push("activity");
      },
    },
    events: {
      emit: async (name: string, companyId: string, payload: AccessUpdatedPayload) => {
        log.push("emit");
        emitted.push({ name, companyId, payload });
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, log, state, emitted };
}

describe.skipIf(!available)("Setup access grants and send on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  describe("save and clear", () => {
    it("save: the id goes on the list first, the grant after, then rev + 1 and the send", async () => {
      const { ctx, log, emitted } = world();
      const result = await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer" });
      expect(result).toMatchObject({ ok: true, rev: 1, sent: true });
      expect(log).toEqual(["db:add-id", "state:set u:u1", "activity", "db:rev", "emit"]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.name).toBe(ACCESS_EVENTS.updated);
      expect(emitted[0]!.payload).toMatchObject({ companyId: CO, rev: 1, mode: "off", userIds: ["u1"], part: 1, parts: 1, grants: { u1: { preset: "viewer" } } });

      // A second save of the same person is one more change.
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "manager" })).toMatchObject({ ok: true, rev: 2 });
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ rev: 2, grantedUserIds: ["u1"] });
    });

    it("clear: the grant goes first, then the id with rev + 1, and the send no longer lists the person", async () => {
      const { ctx, log, emitted } = world();
      await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer" });
      await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u2", preset: "viewer" });
      log.length = 0;
      emitted.length = 0;
      expect(await clearAccessGrant(ctx, { companyId: CO, actor: OWNER }, "u1")).toMatchObject({ ok: true, grant: null, rev: 3, sent: true });
      expect(log).toEqual(["state:delete u:u1", "activity", "db:remove-id+rev", "emit"]);
      expect(emitted[0]!.payload).toMatchObject({ rev: 3, userIds: ["u2"], grants: { u2: { preset: "viewer" } } });
      expect(Object.keys(emitted[0]!.payload.grants)).toEqual(["u2"]);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ rev: 3, grantedUserIds: ["u2"] });
    });

    it("a non-admin writes nothing", async () => {
      const { ctx, log } = world();
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: { type: "user", userId: "u1" } }, { userId: "u2", preset: "viewer" })).toEqual({ ok: false, error: "Only a company owner or admin can manage access" });
      expect(await clearAccessGrant(ctx, { companyId: CO, actor: { type: "agent" } }, "u2")).toMatchObject({ ok: false });
      expect(log).toEqual([]);
      expect(await getAccessSettings(ctx, CO)).toBeNull();
    });

    it("a refused grant leaves only a harmless id: rev unchanged, nothing sent", async () => {
      const { ctx, log, emitted } = world();
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "admin2", preset: "viewer" })).toMatchObject({ ok: false });
      expect(log).toEqual(["db:add-id"]);
      expect(emitted).toEqual([]);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ rev: 0, grantedUserIds: ["admin2"] });
      // The id with no grant is skipped when the payload is built.
      expect((await buildAccessPayloads(ctx, CO))[0]).toMatchObject({ rev: 0, userIds: [], grants: {} });
    });

    it("a failed audit undoes the grant and does not raise rev", async () => {
      const { ctx, state, emitted } = world({ auditFails: true });
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer" })).toMatchObject({ ok: false });
      expect(state.size).toBe(0);
      expect(emitted).toEqual([]);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ rev: 0 });
    });
  });

  describe("publish", () => {
    it("splits a payload over 150 KB into parts of one rev, each with every userId", async () => {
      const { ctx, emitted } = world({ members: 30 });
      const linked = Array.from({ length: 200 }, (_, i) => `crm-company-0000000000000000000000-${i}`);
      for (let i = 1; i <= 30; i++) {
        expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: `u${i}`, preset: "clientManager", linkedCompanyIds: linked })).toMatchObject({ ok: true });
      }
      emitted.length = 0;
      expect(await publishAccess(ctx, CO)).toEqual({ rev: 30, parts: emitted.length });
      const payloads = emitted.map((e) => e.payload);
      const all = Array.from({ length: 30 }, (_, i) => `u${i + 1}`);
      expect(payloads.length).toBeGreaterThan(1);
      const seen: string[] = [];
      payloads.forEach((payload, index) => {
        expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(ACCESS_PART_MAX_BYTES);
        expect(payload).toMatchObject({ companyId: CO, rev: 30, mode: "off", part: index + 1, parts: payloads.length, userIds: all });
        seen.push(...Object.keys(payload.grants));
      });
      expect(seen).toEqual(all);
    }, 60_000);

    it("sends nothing when a grant cannot be read", async () => {
      const { ctx } = world();
      await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer" });
      const broken = world({ stateReadFails: true });
      await expect(publishAccess(broken.ctx, CO)).rejects.toThrow("state down");
      expect(broken.emitted).toEqual([]);
    });

    it("a company with no row sends off at rev 0", async () => {
      const { ctx } = world();
      expect(await buildAccessPayloads(ctx, CO)).toEqual([{ companyId: CO, rev: 0, mode: "off", userIds: [], part: 1, parts: 1, grants: {} }]);
    });
  });
});
