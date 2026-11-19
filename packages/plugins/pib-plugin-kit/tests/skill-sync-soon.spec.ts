/**
 * A tool call or a page load never waits long for the managed-skill sync
 * (the host can take more than 30 seconds for it), and a failed sync is not
 * tried again on every call.
 */
import { describe, expect, it } from "vitest";
import { SKILL_SYNC_RETRY_MS, SKILL_SYNC_WAIT_MS, createPibOnlySkillSyncer, createSkillSyncGuard, createSkillSyncer, knownCompanyIds, type SkillSyncResult } from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

type Sync = SkillSyncResult[];

function setup(ensure: () => Promise<Sync>) {
  let now = Date.parse("2026-11-13T06:20:00.000Z");
  const calls: string[] = [];
  const logs: string[] = [];
  const soon = createSkillSyncGuard((companyId) => (calls.push(companyId), ensure()), {
    now: () => now,
    logger: { info: (text) => void logs.push(text) },
  });
  return { soon, calls, logs, advance: (ms: number) => (now += ms) };
}

describe("createSkillSyncGuard", () => {
  it("waits for a sync that answers at once", async () => {
    let done = false;
    const s = setup(async () => ((done = true), [{ skillKey: "operator", action: "reconcile" }]));
    await s.soon("c1");
    expect(done).toBe(true);
    await s.soon("c1");
    expect(s.calls).toEqual(["c1", "c1"]);
  });

  it("goes on after a moment when the host is slow, and lets the sync finish behind it", async () => {
    let finish!: (value: Sync) => void;
    const s = setup(() => new Promise<Sync>((resolve) => (finish = resolve)));
    const started = Date.now();
    await s.soon("c1", 30);
    expect(Date.now() - started).toBeLessThan(1000);
    finish([{ skillKey: "operator", action: "reconcile" }]);
  });

  it("does not try again for five minutes after a failed sync, for that company only", async () => {
    let mode: "failed" | "throw" | "ok" = "failed";
    const s = setup(async () => {
      if (mode === "throw") throw new Error("skills.managed.reset timed out after 30000ms");
      return [{ skillKey: "operator", action: mode === "failed" ? "failed" : "reconcile" }];
    });
    await s.soon("c1");
    await s.soon("c1");
    await s.soon("c2");
    expect(s.calls).toEqual(["c1", "c2"]);
    s.advance(SKILL_SYNC_RETRY_MS);
    mode = "throw";
    await s.soon("c1");
    expect(s.calls).toEqual(["c1", "c2", "c1"]);
    expect(s.logs).toContain("Managed skill sync failed");
    await s.soon("c1");
    expect(s.calls).toHaveLength(3);
    s.advance(SKILL_SYNC_RETRY_MS);
    mode = "ok";
    await s.soon("c1");
    await s.soon("c1");
    expect(s.calls).toHaveLength(5);
  });

  it("a sync that fails behind the caller still starts the five minutes", async () => {
    let fail!: (error: Error) => void;
    const s = setup(() => new Promise<Sync>((_resolve, reject) => (fail = reject)));
    await s.soon("c1", 10);
    fail(new Error("skills.managed.reconcile timed out after 30000ms"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.soon("c1");
    expect(s.calls).toEqual(["c1"]);
  });

  it("never throws, whatever ensure or the logger does", async () => {
    const thrown = createSkillSyncGuard(
      () => {
        throw new Error("not a promise");
      },
      {
        logger: {
          info: () => {
            throw new Error("logger down");
          },
        },
      },
    );
    await expect(thrown("c1")).resolves.toBeUndefined();
    const odd = createSkillSyncGuard(async () => undefined as unknown as Sync);
    await expect(odd("c1")).resolves.toBeUndefined();
  });
});

const SKILLS = [{ skillKey: "crm-records", markdown: "one" }];

describe("createSkillSyncer().soon", () => {
  it("waits two seconds by default", () => {
    expect(SKILL_SYNC_WAIT_MS).toBe(2_000);
    expect(SKILL_SYNC_RETRY_MS).toBe(5 * 60_000);
  });

  it("syncs the company's skills and remembers the company, like ensure", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    await expect(syncer.soon("co-1")).resolves.toBeUndefined();
    expect(fake.resets).toEqual([{ key: "crm-records", companyId: "co-1" }]);
    expect(await knownCompanyIds(fake.ctx)).toEqual(["co-1"]);
    // The sync is done for this process: ensure answers from memory, nothing is reset twice.
    expect((await syncer.ensure("co-1")).map((r) => r.action)).toEqual(["reset"]);
    expect(fake.resets).toHaveLength(1);
  });

  it("returns while the host is still busy, joins the running sync, and ensure still waits for it", async () => {
    const fake = fakeCtx();
    let release!: () => void;
    let resets = 0;
    fake.ctx.skills.managed.reset = (async () => {
      resets += 1;
      await new Promise<void>((resolve) => (release = resolve));
      return {};
    }) as never;
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    await syncer.soon("co-1", 20);
    await syncer.soon("co-1", 20);
    expect(resets).toBe(1);
    const waiting = syncer.ensure("co-1");
    release();
    expect((await waiting).map((r) => r.action)).toEqual(["reset"]);
    expect(resets).toBe(1);
  });

  it("leaves a failed sync alone for five minutes; ensure and force are not held back", async () => {
    let now = 1_000_000;
    const fake = fakeCtx();
    let calls = 0;
    let broken = true;
    fake.ctx.skills.managed.reset = (async () => {
      calls += 1;
      if (broken) throw new Error("skills.managed.reset timed out after 30000ms");
      return {};
    }) as never;
    const syncer = createSkillSyncer(fake.ctx, SKILLS, { now: () => now });
    await syncer.soon("co-1");
    await syncer.soon("co-1");
    await syncer.soon("co-1");
    expect(calls).toBe(1);
    // A caller that needs the result still tries at once.
    expect((await syncer.ensure("co-1")).map((r) => r.action)).toEqual(["failed"]);
    expect(calls).toBe(2);
    now += SKILL_SYNC_RETRY_MS;
    broken = false;
    await syncer.soon("co-1");
    expect(calls).toBe(3);
    await syncer.soon("co-1");
    expect(calls).toBe(3);
  });
});

describe("createPibOnlySkillSyncer().soon", () => {
  const COMPANIES = { par: { name: "Partners in Biz", issuePrefix: "PAR" }, client: { name: "Client", issuePrefix: "CLI" } };
  const OWN = [{ skillKey: "pib-seo-own", markdown: "own" }];

  it("syncs PAR and touches nothing for another company", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    const syncer = createPibOnlySkillSyncer(fake.ctx, OWN);
    await syncer.soon("client");
    expect(fake.resets).toEqual([]);
    await syncer.soon("par");
    expect(fake.resets).toEqual([{ key: "pib-seo-own", companyId: "par" }]);
  });

  it("does not wait for a slow company lookup", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    fake.ctx.companies.get = (() => new Promise(() => {})) as never;
    const syncer = createPibOnlySkillSyncer(fake.ctx, OWN);
    const started = Date.now();
    await syncer.soon("par", 20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.resets).toEqual([]);
  });
});
