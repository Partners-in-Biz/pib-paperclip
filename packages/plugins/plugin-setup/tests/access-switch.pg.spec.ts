import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACCESS_EVENTS, GUARDED_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAccessGrant, saveAccessGrant } from "../src/access-grants.js";
import type { AccessUpdatedPayload } from "../src/access-publish.js";
import { getAccessSettings, recordAccessSync, setAccessMode } from "../src/access-store.js";
import { SWITCH_REFUSALS, setAccessSwitch } from "../src/access-switch.js";
import { ACCESS_PEERS, sendAccessAgain } from "../src/access-sync.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
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
const ADMIN = { type: "user", userId: "admin2" };
const NOW = "2026-11-17T10:00:00.000Z";

/** A ctx on the real database with in-memory config, state, members, activity and events. */
function world(opts: { saved?: boolean; activityFails?: boolean; revertFails?: boolean } = {}) {
  const activity: Array<{ message: string; metadata: Record<string, unknown> }> = [];
  const emitted: Array<{ name: string; payload: AccessUpdatedPayload }> = [];
  const state = new Map<string, unknown>();
  const key = (scope: { scopeId?: string; stateKey: string }) => `${scope.scopeId}:${scope.stateKey}`;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: (sql: string, params?: unknown[]) => pg.db.query(sql, params),
      execute: async (sql: string, params?: unknown[]) => {
        if (opts.revertFails && /^\s*UPDATE .* SET mode = \$3/s.test(sql)) throw new Error("db down");
        return pg.db.execute(sql, params);
      },
    },
    config: { get: async () => (opts.saved === false ? {} : { modules: {} }) },
    state: {
      get: async (scope: { scopeId?: string; stateKey: string }) => state.get(key(scope)) ?? null,
      set: async (scope: { scopeId?: string; stateKey: string }, value: unknown) => void state.set(key(scope), value),
      delete: async (scope: { scopeId?: string; stateKey: string }) => void state.delete(key(scope)),
    },
    access: {
      members: {
        list: async () => [
          { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
          { principalType: "user", principalId: "admin2", membershipRole: "admin", status: "active" },
          { principalType: "user", principalId: "u1", membershipRole: "member", status: "active" },
          { principalType: "user", principalId: "gone", membershipRole: "admin", status: "suspended" },
        ],
      },
    },
    activity: {
      log: async (entry: { message: string; metadata: Record<string, unknown> }) => {
        if (opts.activityFails) throw new Error("activity down");
        activity.push(entry);
      },
    },
    events: { emit: async (name: string, _companyId: string, payload: AccessUpdatedPayload) => void emitted.push({ name, payload }) },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, activity, emitted };
}

/** Every peer confirms `rev`; `skip` never reports anything. */
async function confirmAll(ctx: PluginContext, rev: number, skip: string[] = []) {
  for (const pluginKey of ACCESS_PEERS) {
    if (!skip.includes(pluginKey)) await recordAccessSync(ctx, { companyId: CO, pluginKey, rev, syncedAt: NOW });
  }
}

/** u1 has no grant, so he is on the enforce confirm list; these cases confirm him (the list has its own spec). */
const set = (ctx: PluginContext, mode: unknown, actor: unknown = OWNER, confirm: string[] = ["u1"]) => setAccessSwitch(ctx, { companyId: CO, actor: actor as never }, mode, confirm);

describe.skipIf(!available)("Setup access switch on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it("checks the 15 guarded plugins: Setup itself and the 14 that confirm by event", () => {
    expect(GUARDED_PLUGINS).toHaveLength(15);
    expect([...ACCESS_PEERS, PLUGIN_ID].sort()).toEqual([...GUARDED_PLUGINS].sort());
  });

  describe("owner or admin only", () => {
    it.each([
      ["a member", { type: "user", userId: "u1" }],
      ["a suspended admin", { type: "user", userId: "gone" }],
      ["a stranger", { type: "user", userId: "nobody" }],
      ["an agent", { type: "agent", userId: null }],
      ["the system", { type: "system" }],
      ["no caller", null],
    ])("%s is refused on every access action and nothing changes", async (_who, actor) => {
      const { ctx, activity, emitted } = world();
      for (const mode of ["off", "report", "enforce"]) {
        expect(await set(ctx, mode, actor)).toEqual({ ok: false, error: SWITCH_REFUSALS.notAdmin });
      }
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: actor as never }, { userId: "u1", preset: "viewer" })).toMatchObject({ ok: false });
      expect(await clearAccessGrant(ctx, { companyId: CO, actor: actor as never }, "u1")).toMatchObject({ ok: false });
      expect(await sendAccessAgain(ctx, CO, actor as never)).toMatchObject({ ok: false });
      expect(await getAccessSettings(ctx, CO)).toBeNull();
      expect(activity).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it("an admin may change it, and the entry names who did", async () => {
      const { ctx, activity } = world();
      expect(await set(ctx, "report", ADMIN)).toMatchObject({ ok: true, mode: "report", changed: true });
      expect(activity[0]!.metadata).toMatchObject({ changedBy: "admin2", before: { mode: "off" }, after: { mode: "report" } });
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "report", updatedBy: "admin2" });
    });
  });

  describe("off", () => {
    it("is always accepted: no saved settings, no plugin confirmed, from enforce", async () => {
      const { ctx, activity, emitted } = world({ saved: false });
      await setAccessMode(ctx, CO, "enforce", "owner", NOW);
      expect(await set(ctx, "off")).toMatchObject({ ok: true, mode: "off", rev: 2, changed: true, sent: true });
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "off", rev: 2, updatedBy: "owner" });
      expect(activity).toEqual([expect.objectContaining({ message: "Access switch changed from enforce to off" })]);
      expect(emitted.map((e) => [e.name, e.payload.mode, e.payload.rev])).toEqual([[ACCESS_EVENTS.updated, "off", 2]]);
    });

    it("off when already off changes nothing", async () => {
      const { ctx, activity, emitted } = world();
      expect(await set(ctx, "off")).toEqual({ ok: true, mode: "off", rev: 0, changed: false, sent: false });
      expect(await getAccessSettings(ctx, CO)).toBeNull();
      expect(activity).toEqual([]);
      expect(emitted).toEqual([]);
    });
  });

  describe("report", () => {
    it("is refused for a company with no saved Setup settings", async () => {
      const { ctx, activity, emitted } = world({ saved: false });
      expect(await set(ctx, "report")).toEqual({ ok: false, error: SWITCH_REFUSALS.noSettings });
      expect(await set(ctx, "enforce")).toEqual({ ok: false, error: SWITCH_REFUSALS.noSettings });
      expect(await getAccessSettings(ctx, CO)).toBeNull();
      expect(activity).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it("is saved, audited and sent once the settings are saved; no confirmations needed", async () => {
      const { ctx, activity, emitted } = world();
      expect(await set(ctx, "report")).toEqual({ ok: true, mode: "report", rev: 1, changed: true, sent: true });
      expect(activity).toEqual([
        { companyId: CO, message: "Access switch changed from off to report", entityType: "plugin_access", entityId: CO, metadata: { changedBy: "owner", before: { mode: "off" }, after: { mode: "report" }, rev: 1 } },
      ]);
      expect(emitted[0]!.payload).toMatchObject({ companyId: CO, mode: "report", rev: 1 });
    });
  });

  describe("enforce", () => {
    it("is refused while any one of the 14 has not confirmed the current rev", async () => {
      const { ctx, activity } = world();
      await set(ctx, "report");
      // Everyone confirmed rev 1 but CRM, which is still on rev 0.
      await confirmAll(ctx, 1, ["partnersinbiz.crm"]);
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", rev: 0, syncedAt: NOW });
      const result = await set(ctx, "enforce");
      expect(result).toMatchObject({ ok: false, unconfirmed: ["partnersinbiz.crm"] });
      expect(result.ok === false && result.error).toContain("partnersinbiz.crm");
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "report", rev: 1 });
      expect(activity).toHaveLength(1);
    });

    it("is refused for a plugin that never reported anything", async () => {
      const { ctx } = world();
      await set(ctx, "report");
      await confirmAll(ctx, 1, ["partnersinbiz.voice"]);
      expect(await set(ctx, "enforce")).toMatchObject({ ok: false, unconfirmed: ["partnersinbiz.voice"] });
      // Nothing reported at all: all 14 are listed.
      await pg.reset();
      expect(await set(ctx, "enforce")).toMatchObject({ ok: false, unconfirmed: [...ACCESS_PEERS] });
    });

    it("is saved once every one confirmed the current rev, from report or straight from off", async () => {
      const { ctx, activity, emitted } = world();
      await set(ctx, "report");
      await confirmAll(ctx, 1);
      expect(await set(ctx, "enforce")).toEqual({ ok: true, mode: "enforce", rev: 2, changed: true, sent: true });
      expect(activity.at(-1)!.message).toBe("Access switch changed from report to enforce");
      expect(emitted.at(-1)!.payload).toMatchObject({ mode: "enforce", rev: 2 });

      await pg.reset();
      await confirmAll(ctx, 0);
      expect(await set(ctx, "enforce")).toMatchObject({ ok: true, mode: "enforce", rev: 1 });
    });

    it("an older confirmation is not enough after a later change", async () => {
      const { ctx } = world();
      await set(ctx, "report");
      await confirmAll(ctx, 1);
      expect(await saveAccessGrant(ctx, { companyId: CO, actor: OWNER }, { userId: "u1", preset: "viewer" })).toMatchObject({ ok: true, rev: 2 });
      expect(await set(ctx, "enforce")).toMatchObject({ ok: false, unconfirmed: [...ACCESS_PEERS] });
    });

    it("a check made at one rev is not written over a change made since", async () => {
      const { ctx } = world();
      await set(ctx, "report");
      await confirmAll(ctx, 1);
      // A grant change lands between the check and the write.
      const real = ctx.db.execute.bind(ctx.db);
      let raced = false;
      (ctx.db as { execute: typeof real }).execute = async (sql, params) => {
        if (!raced && sql.includes(".rev = $5")) {
          raced = true;
          await pg.db.execute(`UPDATE ${NAMESPACE}.access_settings SET rev = rev + 1 WHERE company_id = $1`, [CO]);
        }
        return real(sql, params);
      };
      expect(await set(ctx, "enforce")).toEqual({ ok: false, error: SWITCH_REFUSALS.moved });
      expect(raced).toBe(true);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "report", rev: 2 });
    });
  });

  describe("audit failure", () => {
    it.each(["report", "enforce", "off"] as const)("to %s leaves no change and is refused", async (mode) => {
      const ok = world();
      if (mode === "off") await setAccessMode(ok.ctx, CO, "report", "owner", NOW);
      await confirmAll(ok.ctx, mode === "off" ? 1 : 0);
      const before = (await getAccessSettings(ok.ctx, CO))?.mode ?? "off";

      const { ctx, emitted } = world({ activityFails: true });
      expect(await set(ctx, mode)).toEqual({ ok: false, error: SWITCH_REFUSALS.notSaved });
      expect((await getAccessSettings(ctx, CO))?.mode).toBe(before);
      // The undo is sent too: a plugin that heard the unaudited mode in between gets the old one back.
      expect(emitted.at(-1)!.payload.mode).toBe(before);
    });

    it("says so when the undo also fails", async () => {
      const { ctx } = world({ activityFails: true, revertFails: true });
      expect(await set(ctx, "report")).toEqual({ ok: false, error: SWITCH_REFUSALS.notUndone });
    });
  });

  it("refuses an unknown mode and a missing company", async () => {
    const { ctx } = world();
    expect(await set(ctx, "on")).toMatchObject({ ok: false });
    expect(await setAccessSwitch(ctx, { companyId: " ", actor: OWNER }, "off")).toEqual({ ok: false, error: "A company is required" });
    expect(await getAccessSettings(ctx, CO)).toBeNull();
  });
});
