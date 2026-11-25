import { describe, expect, it } from "vitest";
import { ACCESS_ASK_INTERVAL_MS, ACCESS_STALE_MS, readAccessSwitch } from "../src/access/index.js";
import { CO, PLUGIN, ROW, accessFake } from "./helpers/access-fake.js";

describe("access switch (plan 4.3)", () => {
  const T0 = Date.parse("2026-11-17T10:00:00.000Z");
  const row = (mode: string, receivedAt = new Date(T0).toISOString()) => ({ mode, rev: 4, userIds: [], receivedAt });
  const asks = (f: ReturnType<typeof accessFake>) => f.named("access.request");

  it("absent: passes (off) and asks Setup once, not again within a minute", async () => {
    const f = accessFake();
    let now = T0;
    const s = await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => now });
    expect(s).toMatchObject({ mode: "off", source: "absent", asked: true });
    expect(asks(f)).toEqual([{ name: "access.request", companyId: CO, payload: { companyId: CO, pluginKey: PLUGIN, rev: 0 } }]);
    now += ACCESS_ASK_INTERVAL_MS - 1;
    expect((await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => now })).asked).toBe(false);
    expect(asks(f)).toHaveLength(1);
    now += 1;
    expect((await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => now })).asked).toBe(true);
    expect(asks(f)).toHaveLength(2);
  });

  it("off: passes, one state read and no other host call, even when old", async () => {
    const f = accessFake();
    f.store.set(ROW, row("off", "2020-01-01T00:00:00.000Z"));
    const s = await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => T0 });
    expect(s).toMatchObject({ mode: "off", source: "row", asked: false });
    expect(f.reads()).toBe(1);
    expect(f.emitted).toEqual([]);
  });

  it("report and enforce come through; a fresh row makes no ask", async () => {
    for (const mode of ["report", "enforce"]) {
      const f = accessFake();
      f.store.set(ROW, row(mode));
      expect(await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => T0 + ACCESS_STALE_MS })).toMatchObject({ mode, source: "row", asked: false });
      expect(f.emitted).toEqual([]);
    }
  });

  it("enforce with a row older than 10 minutes asks once, carrying the stored rev", async () => {
    const f = accessFake();
    f.store.set(ROW, row("enforce"));
    const now = T0 + ACCESS_STALE_MS + 1;
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => now })).toMatchObject({ mode: "enforce", asked: true });
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => now + 1000 })).toMatchObject({ mode: "enforce", asked: false });
    expect(asks(f).map((e) => e.payload)).toEqual([{ companyId: CO, pluginKey: PLUGIN, rev: 4 }]);
  });

  it("report with a row older than 10 minutes asks too", async () => {
    const f = accessFake();
    f.store.set(ROW, row("report"));
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => T0 + ACCESS_STALE_MS + 1 })).toMatchObject({ mode: "report", asked: true });
  });

  it("read throws: enforce, and no ask", async () => {
    const f = accessFake();
    f.fail.get = () => true;
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN)).toMatchObject({ mode: "enforce", source: "read-failed", asked: false });
    expect(f.emitted).toEqual([]);
  });

  it("an unreadable row is enforce and asks for a fresh one", async () => {
    const f = accessFake();
    f.store.set(ROW, { mode: "maybe", rev: 1 });
    expect(await readAccessSwitch(f.ctx, CO, PLUGIN)).toMatchObject({ mode: "enforce", source: "invalid", asked: true });
  });

  it("the ask limit is per company", async () => {
    const f = accessFake();
    await readAccessSwitch(f.ctx, CO, PLUGIN, { now: () => T0 });
    await readAccessSwitch(f.ctx, "co-2", PLUGIN, { now: () => T0 });
    expect(asks(f).map((e) => e.companyId)).toEqual([CO, "co-2"]);
  });
});
