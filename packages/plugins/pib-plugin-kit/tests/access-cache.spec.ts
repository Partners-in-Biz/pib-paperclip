import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AccessCache, accessCacheFor, cachedAccessFor, cachedActingPerson, noteAccessReceived } from "../src/access/cache.js";

const CO = "co-1";

function clock() {
  let t = 1_000;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

/** A plugin context with members, grants and run rows; each read is counted and can be made to fail. */
function fake() {
  const members = new Map<string, { status: string; role: string }>();
  const grants = new Map<string, unknown>();
  const runs: Array<{ responsible_user_id: string | null; status: string }> = [];
  const n = { members: 0, runs: 0 };
  const fail = { members: false, runs: false };
  const ctx = {
    access: {
      members: {
        list: async () => {
          n.members++;
          if (fail.members) throw new Error("members read failed");
          return [...members].map(([id, m]) => ({ principalType: "user", principalId: id, status: m.status, membershipRole: m.role }));
        },
      },
    },
    state: { get: async (s: { stateKey: string }) => grants.get(s.stateKey) ?? null },
    db: {
      query: async () => {
        n.runs++;
        if (fail.runs) throw new Error("run read failed");
        return runs;
      },
    },
  } as unknown as PluginContext;
  return { ctx, members, grants, runs, n, fail };
}

describe("AccessCache", () => {
  it("keeps an entry for 30 seconds and reads again after", async () => {
    const c = clock();
    const cache = new AccessCache({ now: c.now });
    let loads = 0;
    const read = () => cache.read(CO, "k", async () => ++loads);
    expect(await read()).toBe(1);
    c.tick(29_999);
    expect(await read()).toBe(1);
    c.tick(1);
    expect(await read()).toBe(2);
  });

  it("drops entries of a company on receive, and only of that company", async () => {
    const cache = new AccessCache();
    let loads = 0;
    await cache.read(CO, "k", async () => ++loads);
    await cache.read("co-2", "k", async () => ++loads);
    cache.received(CO);
    expect(await cache.read(CO, "k", async () => ++loads)).toBe(3);
    expect(await cache.read("co-2", "k", async () => ++loads)).toBe(2);
  });

  it("does not store a read that was under way during a receive", async () => {
    const cache = new AccessCache();
    let release!: () => void;
    const pending = cache.read(CO, "k", () => new Promise<string>((r) => (release = () => r("old"))));
    cache.received(CO);
    release();
    expect(await pending).toBe("old");
    expect(await cache.read(CO, "k", async () => "new")).toBe("new");
    expect(await cache.read(CO, "k", async () => "newer")).toBe("new");
  });

  it("does not store an error", async () => {
    const cache = new AccessCache();
    await expect(cache.read(CO, "k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    expect(await cache.read(CO, "k", async () => "ok")).toBe("ok");
  });

  it("holds at most the cap, dropping the oldest first", async () => {
    const cache = new AccessCache({ max: 3 });
    for (const k of ["a", "b", "c", "d"]) await cache.read(CO, k, async () => k);
    expect(cache.size).toBe(3);
    expect(await cache.read(CO, "a", async () => "a2")).toBe("a2");
    expect(await cache.read(CO, "d", async () => "d2")).toBe("d");
  });

  it("caps at 2,000 entries by default", async () => {
    const cache = new AccessCache();
    for (let i = 0; i < 2_005; i++) await cache.read(CO, `k${i}`, async () => i);
    expect(cache.size).toBe(2_000);
  });
});

describe("cachedAccessFor", () => {
  it("reads members once per person per 30 seconds", async () => {
    const f = fake();
    f.members.set("u1", { status: "active", role: "owner" });
    expect((await cachedAccessFor(f.ctx, CO, "u1")).bypass).toBe(true);
    expect((await cachedAccessFor(f.ctx, CO, "u1")).bypass).toBe(true);
    expect(f.n.members).toBe(1);
  });

  it("stores the status with the role: a suspended member is refused, also from the cache", async () => {
    const f = fake();
    f.members.set("u1", { status: "suspended", role: "admin" });
    const first = await cachedAccessFor(f.ctx, CO, "u1");
    const second = await cachedAccessFor(f.ctx, CO, "u1");
    for (const a of [first, second]) expect(a).toMatchObject({ bypass: false, grant: null, reason: "You are not an active member of this company" });
    expect(f.n.members).toBe(1);
  });

  it("gives a limited person his grant and a non-member nothing", async () => {
    const f = fake();
    f.members.set("u1", { status: "active", role: "operator" });
    f.grants.set("u:u1", { preset: "viewer" });
    expect((await cachedAccessFor(f.ctx, CO, "u1")).grant?.preset).toBe("viewer");
    expect(await cachedAccessFor(f.ctx, CO, "nobody")).toMatchObject({ bypass: false, grant: null });
  });

  it("denies on a failed read and stores nothing, so the next call reads again", async () => {
    const f = fake();
    f.members.set("u1", { status: "active", role: "owner" });
    f.fail.members = true;
    expect(await cachedAccessFor(f.ctx, CO, "u1")).toMatchObject({ bypass: false, reason: "Cannot verify your access" });
    f.fail.members = false;
    expect((await cachedAccessFor(f.ctx, CO, "u1")).bypass).toBe(true);
    expect(f.n.members).toBe(2);
  });

  it("reads again after a receive (a cleared grant takes effect at once)", async () => {
    const f = fake();
    f.members.set("u1", { status: "active", role: "operator" });
    f.grants.set("u:u1", { preset: "viewer" });
    expect((await cachedAccessFor(f.ctx, CO, "u1")).grant).not.toBeNull();
    f.grants.delete("u:u1");
    noteAccessReceived(f.ctx, CO);
    expect((await cachedAccessFor(f.ctx, CO, "u1")).grant).toBeNull();
  });
});

describe("cachedActingPerson", () => {
  const RUN = { companyId: "11111111-1111-4111-8111-111111111111", agentId: "33333333-3333-4333-8333-333333333333", runId: "00000000-0000-4000-8000-000000000001" };

  it("keeps a run's person per run and does not store a failed read", async () => {
    const f = fake();
    f.runs.push({ responsible_user_id: "u1", status: "running" });
    f.fail.runs = true;
    expect(await cachedActingPerson(f.ctx, RUN)).toEqual({ ok: false, reason: "read-failed" });
    f.fail.runs = false;
    expect(await cachedActingPerson(f.ctx, RUN)).toMatchObject({ ok: true, userId: "u1" });
    expect(await cachedActingPerson(f.ctx, RUN)).toMatchObject({ ok: true, userId: "u1" });
    expect(f.n.runs).toBe(2);
    // Another agent naming the same run is a separate entry, read on its own.
    await cachedActingPerson(f.ctx, { ...RUN, agentId: "44444444-4444-4444-8444-444444444444" });
    expect(f.n.runs).toBe(3);
  });

  it("uses one cache per plugin context", () => {
    const a = fake();
    const b = fake();
    expect(accessCacheFor(a.ctx)).toBe(accessCacheFor(a.ctx));
    expect(accessCacheFor(a.ctx)).not.toBe(accessCacheFor(b.ctx));
  });
});
