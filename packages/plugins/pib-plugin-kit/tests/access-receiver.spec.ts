import { describe, expect, it } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ACCESS_ASK_INTERVAL_MS, ACCESS_UPDATED_EVENT, accessCompanyScope, createAccessGuard, onAccessReceived, readAccessSwitch, registerAccessReceiver, type AccessUpdatedPayload } from "../src/access/index.js";
import { SETUP_PLUGIN } from "../src/setup.js";
import { fixtureManifest } from "./fixtures/access/base.js";
import { loadGrant } from "../src/permissions.js";
import { CO, PLUGIN, ROW, accessFake as fake, grantKey } from "./helpers/access-fake.js";

const grant = (preset: string) => ({ preset, allow: [], deny: [], linkedCompanyIds: [], scopeOverrides: {}, updatedBy: "owner", updatedAt: "2026-11-17T00:00:00.000Z" });

function send(handler: (e: PluginEvent) => Promise<void>, payload: Partial<AccessUpdatedPayload>) {
  return handler({
    eventId: "e",
    eventType: "plugin.partnersinbiz.setup.access.updated",
    occurredAt: new Date().toISOString(),
    companyId: CO,
    payload: { companyId: CO, mode: "report", userIds: [], part: 1, parts: 1, grants: {}, ...payload },
  });
}

const synced = (f: ReturnType<typeof fake>) => f.named("access.synced");

describe("access receiver", () => {
  it("subscribes to Setup's access.updated only", () => {
    const f = fake();
    registerAccessReceiver(f.ctx, PLUGIN);
    expect([...f.handlers.keys()]).toEqual(["plugin.partnersinbiz.setup.access.updated"]);
  });

  it("writes grants under u:<userId> so loadGrant reads them, the company row last, then confirms", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    const cleared: string[] = [];
    onAccessReceived(f.ctx, (companyId) => void cleared.push(companyId));
    await send(handle, { rev: 3, mode: "enforce", userIds: ["u1", "u2"], grants: { u1: grant("viewer"), u2: grant("manager") } });
    expect(f.writes).toEqual([`set ${grantKey("u1")}`, `set ${grantKey("u2")}`, `set ${ROW}`]);
    expect((await loadGrant(f.ctx, CO, "u1"))?.preset).toBe("viewer");
    expect(f.store.get(ROW)).toMatchObject({ mode: "enforce", rev: 3, userIds: ["u1", "u2"] });
    expect(cleared).toEqual([CO]);
    expect(synced(f)).toEqual([{ name: "access.synced", companyId: CO, payload: { companyId: CO, rev: 3, pluginKey: PLUGIN } }]);
  });

  it("drops a lower or equal rev; an equal rev writes only the company row and re-confirms", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 5, userIds: ["u1"], grants: { u1: grant("viewer") } });
    f.writes.length = 0;
    await send(handle, { rev: 4, mode: "off", userIds: [] });
    expect(f.writes).toEqual([]);
    await send(handle, { rev: 5, mode: "off", userIds: [] });
    expect(f.writes).toEqual([`set ${ROW}`]);
    expect(f.store.has(grantKey("u1"))).toBe(true);
    expect(f.store.get(ROW)).toMatchObject({ mode: "report", rev: 5, userIds: ["u1"] });
    expect(synced(f).map((e) => e.payload.rev)).toEqual([5, 5]);
    await send(handle, { rev: 6, mode: "off", userIds: [] });
    expect(f.store.get(ROW)).toMatchObject({ mode: "off", rev: 6 });
  });

  it("an equal rev refreshes a stale receivedAt, so the switch stops asking", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    const old = "2026-01-01T00:00:00.000Z";
    f.store.set(ROW, { mode: "report", rev: 5, userIds: ["u1"], receivedAt: old });
    expect((await readAccessSwitch(f.ctx, CO, PLUGIN)).asked).toBe(true);
    f.emitted.length = 0;
    await send(handle, { rev: 5, mode: "report", userIds: ["u1"] });
    const row = f.store.get(ROW) as { receivedAt: string };
    expect(Date.parse(row.receivedAt)).toBeGreaterThan(Date.parse(old));
    expect(row).toMatchObject({ mode: "report", rev: 5, userIds: ["u1"] });
    // Past the once-a-minute limit, so only a stale row could make it ask.
    const later = Date.now() + ACCESS_ASK_INTERVAL_MS + 1;
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => later })).toMatchObject({ mode: "report", asked: false });
    expect(f.named("access.request")).toEqual([]);
  });

  it("stores rev 0 from Setup's answer for a company with no settings when it has no row", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 0, mode: "off" });
    expect(f.store.get(ROW)).toMatchObject({ mode: "off", rev: 0, userIds: [] });
  });

  it("applies two parts of one rev together", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    const base = { rev: 2, mode: "enforce" as const, userIds: ["u1", "u2"], parts: 2 };
    await send(handle, { ...base, part: 2, grants: { u2: grant("manager") } });
    expect(f.writes).toEqual([]);
    await send(handle, { ...base, part: 1, grants: { u1: grant("viewer") } });
    expect((await loadGrant(f.ctx, CO, "u1"))?.preset).toBe("viewer");
    expect((await loadGrant(f.ctx, CO, "u2"))?.preset).toBe("manager");
    expect(synced(f)).toHaveLength(1);
  });

  it("one part lost: no write and no confirmation; a newer rev replaces the partial one", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 2, userIds: ["u1", "u2"], parts: 2, part: 1, grants: { u1: grant("viewer") } });
    expect(f.writes).toEqual([]);
    expect(synced(f)).toEqual([]);
    await send(handle, { rev: 3, userIds: ["u1"], parts: 1, part: 1, grants: { u1: grant("manager") } });
    expect((await loadGrant(f.ctx, CO, "u1"))?.preset).toBe("manager");
    // The late second part of rev 2 cannot complete anything any more.
    await send(handle, { rev: 2, userIds: ["u1", "u2"], parts: 2, part: 2, grants: { u2: grant("viewer") } });
    expect(f.store.has(grantKey("u2"))).toBe(false);
    expect(synced(f).map((e) => e.payload.rev)).toEqual([3]);
  });

  it("stored-row read throws mid-receive: nothing deleted, nothing written, nothing confirmed", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 1, userIds: ["u1"], grants: { u1: grant("viewer") } });
    f.writes.length = 0;
    f.fail.get = (k) => k === ROW;
    await send(handle, { rev: 2, mode: "enforce", userIds: [], grants: {} });
    expect(f.writes).toEqual([]);
    expect(f.store.has(grantKey("u1"))).toBe(true);
    expect(synced(f).map((e) => e.payload.rev)).toEqual([1]);
  });

  it("a write that fails half-way leaves the old company row and sends no confirmation", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 1, mode: "off" });
    f.fail.set = (k) => k === grantKey("u2");
    await send(handle, { rev: 2, mode: "enforce", userIds: ["u1", "u2"], grants: { u1: grant("viewer"), u2: grant("viewer") } });
    expect(f.store.get(ROW)).toMatchObject({ mode: "off", rev: 1 });
    expect(synced(f).map((e) => e.payload.rev)).toEqual([1]);
  });

  it("a cleared grant is removed on re-send, also a listed person with no grant", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { rev: 1, userIds: ["u1", "u2", "u3"], grants: { u1: grant("viewer"), u2: grant("viewer"), u3: grant("viewer") } });
    f.writes.length = 0;
    await send(handle, { rev: 2, userIds: ["u1", "u3"], grants: { u1: grant("manager") } });
    expect(f.writes).toEqual([`set ${grantKey("u1")}`, `delete ${grantKey("u3")}`, `delete ${grantKey("u2")}`, `set ${ROW}`]);
    expect(await loadGrant(f.ctx, CO, "u2")).toBeNull();
    expect(await loadGrant(f.ctx, CO, "u3")).toBeNull();
  });

  it("ignores a payload that names another company or is malformed", async () => {
    const f = fake();
    const handle = registerAccessReceiver(f.ctx, PLUGIN);
    await send(handle, { companyId: "co-2", rev: 9 });
    await send(handle, { rev: -1 });
    await send(handle, { rev: 1, mode: "open" as never });
    await send(handle, { rev: 1, part: 3, parts: 2 });
    expect(f.writes).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it("registering the receiver asks nothing at worker start", () => {
    const f = fake();
    registerAccessReceiver(f.ctx, PLUGIN);
    expect(f.emitted).toEqual([]);
    expect(f.reads()).toBe(0);
  });
});

/** PAR-15008: no plugin called `registerAccessReceiver`, so nothing confirmed. The guard now does. */
describe("access receiver through the guard", () => {
  const harnessFor = (id: string) => {
    const harness = createTestHarness({ manifest: fixtureManifest(id) });
    const subscribed: string[] = [];
    const on = harness.ctx.events.on;
    harness.ctx.events.on = ((name: string, ...rest: unknown[]) => {
      subscribed.push(name);
      return (on as (...a: unknown[]) => () => void).call(harness.ctx.events, name, ...rest);
    }) as PluginContext["events"]["on"];
    return { harness, subscribed };
  };

  it("createAccessGuard subscribes the receiver once per ctx, and a send is stored and confirmed", async () => {
    const { harness, subscribed } = harnessFor(PLUGIN);
    createAccessGuard(harness.ctx, { pluginKey: PLUGIN, table: {} });
    expect(registerAccessReceiver(harness.ctx, PLUGIN)).toBeTypeOf("function");
    expect(subscribed).toEqual([ACCESS_UPDATED_EVENT]);
    const confirmed: unknown[] = [];
    harness.ctx.events.on(`plugin.${PLUGIN}.access.synced`, async (e) => void confirmed.push(e.payload));
    await harness.emit(ACCESS_UPDATED_EVENT, { companyId: CO, rev: 2, mode: "off", userIds: [], part: 1, parts: 1, grants: {} }, { companyId: CO });
    expect(await harness.ctx.state.get(accessCompanyScope(CO))).toMatchObject({ mode: "off", rev: 2 });
    expect(confirmed).toEqual([{ companyId: CO, rev: 2, pluginKey: PLUGIN }]);
  });

  it("Setup's own guard runs no receiver: it is the source and counts itself confirmed", () => {
    const { harness, subscribed } = harnessFor(SETUP_PLUGIN);
    createAccessGuard(harness.ctx, { pluginKey: SETUP_PLUGIN, table: {} });
    expect(subscribed).toEqual([]);
  });
});
