import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { ACCESS_EVENTS, ACCESS_REFUSAL_EVENT, GUARDED_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccessUpdatedPayload } from "../src/access-publish.js";
import { getAccessLost, getAccessSettings, listAccessRefusals, listAccessSync, recordAccessSync, setAccessMode } from "../src/access-store.js";
import {
  ACCESS_PEERS,
  ACCESS_RESEND_WINDOW_MS,
  onAccessRequest,
  onAccessSynced,
  registerAccessSync,
  resendAccessHourly,
  resendAllAccess,
  resendRecentAccess,
  sendAccessAgain,
} from "../src/access-sync.js";
import { PLUGIN_ID } from "../src/namespace.js";
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
const OTHER = "co-2";
const ADS = "partnersinbiz.ads";
const CRM = "partnersinbiz.crm";
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A ctx on the real database with in-memory events, config, members and activity. */
function world(opts: { saved?: string[]; activityFails?: boolean } = {}) {
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();
  const emitted: Array<{ name: string; companyId: string; payload: AccessUpdatedPayload }> = [];
  const activity: Array<{ companyId: string; message: string }> = [];
  const saved = new Set(opts.saved ?? [CO, OTHER]);
  const ctx = {
    db: pg.db,
    events: {
      on: (name: string, fn: (event: PluginEvent) => Promise<void>) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: AccessUpdatedPayload) => {
        emitted.push({ name, companyId, payload });
      },
    },
    config: { get: async (companyId: string) => (saved.has(companyId) ? { modules: {} } : {}) },
    state: { get: async () => null },
    access: {
      members: {
        list: async () => [
          { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
          { principalType: "user", principalId: "m1", membershipRole: "member", status: "active" },
        ],
      },
    },
    activity: {
      log: async (entry: { companyId: string; message: string }) => {
        if (opts.activityFails) throw new Error("activity.log.write not granted");
        activity.push(entry);
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  const event = (companyId: string, payload: Record<string, unknown>) => ({ eventId: "e", eventType: "x", occurredAt: iso(T0), companyId, payload }) as unknown as PluginEvent;
  const sent = () => emitted.map((e) => [e.companyId, e.payload.mode, e.payload.rev]);
  return { ctx, handlers, emitted, activity, event, sent };
}

async function confirmAll(ctx: PluginContext, companyId: string, rev: number, except: string[] = []) {
  for (const pluginKey of ACCESS_PEERS) {
    if (!except.includes(pluginKey)) await recordAccessSync(ctx, { companyId, pluginKey, rev, syncedAt: iso(T0) });
  }
}

describe.skipIf(!available)("Setup access sync on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it("listens to the exact names of the other 14 guarded plugins, never Setup's own or a wildcard", () => {
    const { ctx, handlers } = world();
    registerAccessSync(ctx);
    expect(ACCESS_PEERS).toHaveLength(14);
    expect(ACCESS_PEERS).not.toContain(PLUGIN_ID);
    expect(GUARDED_PLUGINS).toContain(PLUGIN_ID);
    const expected = ACCESS_PEERS.flatMap((key) => [ACCESS_EVENTS.synced, ACCESS_EVENTS.request, ACCESS_REFUSAL_EVENT].map((name) => pluginEvent(key, name)));
    expect([...handlers.keys()].sort()).toEqual(expected.sort());
    expect([...handlers.keys()].some((name) => name.includes("*"))).toBe(false);
  });

  describe("access.request", () => {
    it("answers at once from the handler, also off at rev 0 for a company with no settings", async () => {
      const { ctx, handlers, emitted, sent, event, activity } = world();
      registerAccessSync(ctx);
      await handlers.get(pluginEvent(ADS, ACCESS_EVENTS.request))![0]!(event(CO, { companyId: CO, pluginKey: ADS, rev: 0 }));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ name: ACCESS_EVENTS.updated, companyId: CO, payload: { companyId: CO, mode: "off", rev: 0, userIds: [], part: 1, parts: 1, grants: {} } });
      // Answered even where the company's Setup settings are not saved (the handler may emit for the event's company).
      const unsaved = world({ saved: [] });
      await onAccessRequest(unsaved.ctx, CRM, unsaved.event(OTHER, { rev: 0 }));
      expect(unsaved.sent()).toEqual([[OTHER, "off", 0]]);
      expect(activity).toHaveLength(0);
      expect(await getAccessSettings(ctx, CO)).toBeNull();
    });

    it("answers with the current state of a company with settings", async () => {
      const { ctx, sent, event } = world();
      await setAccessMode(ctx, CO, "report", "owner", iso(T0));
      await onAccessRequest(ctx, ADS, event(CO, { companyId: CO, pluginKey: ADS, rev: 0 }));
      expect(sent()).toEqual([[CO, "report", 1]]);
    });

    it("drops a payload that names another company or plugin", async () => {
      const { ctx, emitted, event } = world();
      await onAccessRequest(ctx, ADS, event(CO, { companyId: OTHER, rev: 0 }));
      await onAccessRequest(ctx, ADS, event(CO, { pluginKey: CRM, rev: 0 }));
      expect(emitted).toHaveLength(0);
    });

    it("a rev held for a company with no settings: switch lost, one activity entry, the next save starts above it", async () => {
      const { ctx, sent, event, activity } = world();
      await onAccessRequest(ctx, ADS, event(CO, { rev: 4 }), () => T0);
      await onAccessRequest(ctx, CRM, event(CO, { rev: 6 }), () => T0);
      await onAccessSynced(ctx, CRM, event(CO, { rev: 6 }), () => T0);
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ companyId: CO, message: expect.stringContaining("Choose the switch again") });
      expect(await getAccessLost(ctx, CO)).toMatchObject({ rev: 6, firstPluginKey: ADS });
      // Setup does not invent a mode: no settings row, and the answer stays off at 0 (the plugin keeps its higher rev).
      expect(await getAccessSettings(ctx, CO)).toBeNull();
      expect(sent()).toEqual([
        [CO, "off", 0],
        [CO, "off", 0],
      ]);
      expect(await setAccessMode(ctx, CO, "off", "owner", iso(T0))).toBe(7);
    });

    it("a failed activity write leaves the note open, so the next report writes it", async () => {
      const failing = world({ activityFails: true });
      await onAccessRequest(failing.ctx, ADS, failing.event(CO, { rev: 3 }), () => T0);
      expect(await getAccessLost(failing.ctx, CO)).toMatchObject({ rev: 3, notedAt: null });
      const { ctx, event, activity } = world();
      await onAccessRequest(ctx, ADS, event(CO, { rev: 3 }), () => T0);
      expect(activity).toHaveLength(1);
      expect(await getAccessLost(ctx, CO)).toMatchObject({ notedAt: iso(T0) });
    });
  });

  describe("access.synced", () => {
    it("records the confirmation per plugin", async () => {
      const { ctx, event, emitted } = world();
      await setAccessMode(ctx, CO, "report", "owner", iso(T0));
      await onAccessSynced(ctx, ADS, event(CO, { companyId: CO, pluginKey: ADS, rev: 1 }), () => T0);
      await onAccessSynced(ctx, CRM, event(CO, { rev: "1" }), () => T0);
      expect(await listAccessSync(ctx, CO)).toEqual([{ companyId: CO, pluginKey: ADS, rev: 1, syncedAt: iso(T0) }]);
      expect(emitted).toHaveLength(0);
    });

    it("a plugin with a higher rev makes Setup raise its own above it and send", async () => {
      const { ctx, event, sent } = world();
      await setAccessMode(ctx, CO, "report", "owner", iso(T0));
      await onAccessSynced(ctx, ADS, event(CO, { rev: 9 }), () => T0 + 1000);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "report", rev: 10, updatedAt: iso(T0 + 1000) });
      expect(sent()).toEqual([[CO, "report", 10]]);
      // A request carrying a higher rev does the same, and sends once.
      await onAccessRequest(ctx, CRM, event(CO, { rev: 12 }), () => T0 + 2000);
      expect(sent()).toEqual([
        [CO, "report", 10],
        [CO, "report", 13],
      ]);
    });
  });

  it("access.refusal is kept in the company's store", async () => {
    const { ctx, handlers, event } = world();
    registerAccessSync(ctx);
    const fire = handlers.get(pluginEvent(CRM, ACCESS_REFUSAL_EVENT))![0]!;
    await fire(event(CO, { userId: "m1", key: "crm.contacts.list", permission: "crm.contacts:view", viaAgentId: "agent-1" }));
    await fire(event(CO, { userId: "m1" }));
    expect(await listAccessRefusals(ctx, CO)).toEqual([
      { companyId: CO, pluginKey: CRM, userId: "m1", key: "crm.contacts.list", permission: "crm.contacts:view", viaAgentId: "agent-1", createdAt: expect.any(String) },
    ]);
  });

  describe("re-send jobs", () => {
    it("minute job: sends again until every plugin confirmed, or 15 minutes passed", async () => {
      const { ctx, sent, emitted } = world({ saved: [CO] });
      await setAccessMode(ctx, CO, "report", "owner", iso(T0));
      await setAccessMode(ctx, OTHER, "report", "owner", iso(T0));
      await confirmAll(ctx, CO, 1, [ADS]);
      // OTHER has no saved Setup settings: a job may not emit for it.
      expect(await resendRecentAccess(ctx, () => T0 + 60_000)).toEqual({ sent: 1, skipped: 1, failed: 0 });
      expect(sent()).toEqual([[CO, "report", 1]]);
      expect(await resendRecentAccess(ctx, () => T0 + ACCESS_RESEND_WINDOW_MS)).toEqual({ sent: 0, skipped: 0, failed: 0 });
      emitted.length = 0;
      await recordAccessSync(ctx, { companyId: CO, pluginKey: ADS, rev: 1, syncedAt: iso(T0) });
      expect(await resendRecentAccess(ctx, () => T0 + 120_000)).toEqual({ sent: 0, skipped: 1, failed: 0 });
      expect(emitted).toHaveLength(0);
    });

    it("hourly job: every company not on off, and one on off until all confirmed", async () => {
      const { ctx, sent } = world();
      await setAccessMode(ctx, CO, "report", "owner", iso(T0));
      await confirmAll(ctx, CO, 1);
      await setAccessMode(ctx, OTHER, "off", "owner", iso(T0));
      await confirmAll(ctx, OTHER, 1, [CRM]);
      expect(await resendAccessHourly(ctx)).toEqual({ sent: 2, skipped: 0, failed: 0 });
      expect(sent()).toEqual([
        [CO, "report", 1],
        [OTHER, "off", 1],
      ]);
      await recordAccessSync(ctx, { companyId: OTHER, pluginKey: CRM, rev: 1, syncedAt: iso(T0) });
      expect(await resendAccessHourly(ctx)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    });

    it("worker start sends every company once; a failed send is counted, the others still go", async () => {
      const { ctx, sent } = world();
      await setAccessMode(ctx, CO, "off", "owner", iso(T0));
      await setAccessMode(ctx, OTHER, "report", "owner", iso(T0));
      await confirmAll(ctx, CO, 1);
      expect(await resendAllAccess(ctx)).toEqual({ sent: 2, skipped: 0, failed: 0 });
      expect(sent()).toEqual([
        [CO, "off", 1],
        [OTHER, "report", 1],
      ]);
      const failing = world();
      (failing.ctx.events as { emit: unknown }).emit = async (_name: string, companyId: string) => {
        if (companyId === CO) throw new Error("emit refused");
      };
      expect(await resendAllAccess(failing.ctx)).toEqual({ sent: 1, skipped: 0, failed: 1 });
    });
  });

  it("Send again: an owner sends now; a member is refused", async () => {
    const { ctx, sent } = world();
    await setAccessMode(ctx, CO, "report", "owner", iso(T0));
    expect(await sendAccessAgain(ctx, CO, { type: "user", userId: "m1" })).toEqual({ ok: false, error: expect.stringContaining("owner or admin") });
    expect(await sendAccessAgain(ctx, CO, undefined)).toMatchObject({ ok: false });
    expect(await sendAccessAgain(ctx, CO, { type: "user", userId: "owner" })).toEqual({ ok: true, rev: 1, parts: 1 });
    expect(sent()).toEqual([[CO, "report", 1]]);
  });
});
