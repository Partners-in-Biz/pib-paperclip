/**
 * The one log line per run of the Cockpit's own checks (PAR-11071 stage 1a-i,
 * PAR-11231): each part and section with its state and time, what started the
 * run (job, brief, call) and the worker's boot id. A part that throws is
 * recorded as failed and the run goes on.
 *
 * Stage 1a-ii (PAR-11232): a refused company read stops the run, parts are
 * cached one by one, and an incomplete run shows one row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCompanyData } from "../src/brief.js";
import { extraChecks, formatIncompleteParts, forgetChecks, OWN_CHECKS_INCOMPLETE_KEY, parseIncompleteParts, type ExtraChecks } from "../src/checks.js";
import { JOBS } from "../src/constants.js";
import type { Env } from "../src/env.js";
import { ownSnapshot } from "../src/own.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { BOOT_ID, isJobHandler } from "../src/run-trigger.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";

/** Toggles for the module mocks below. A hooked part can `throw`, or `die`: the invocation ends while it runs, so every company read after it is refused. */
const hooks = vi.hoisted(() => ({
  credentialsThrow: false,
  modes: {} as Record<string, "throw" | "die" | undefined>,
  calls: {} as Record<string, number>,
  /** Company reads are refused (the plugin call has ended). */
  dead: false,
  realDigest: false,
  digestResult: null as unknown,
  lastSnapshot: null as unknown,
}));

/** Runs a hooked part: counts it, then throws or ends the invocation as set. */
async function hooked<T>(name: string, run: () => Promise<T>): Promise<T> {
  hooks.calls[name] = (hooks.calls[name] ?? 0) + 1;
  if (hooks.modes[name] === "throw") throw new Error(`${name} unreadable`);
  if (hooks.modes[name] === "die") hooks.dead = true;
  return run();
}

// Two parts made to throw or die on demand; the credentials job runs the own checks so its line can be read.
vi.mock("../src/credentials.js", async (original) => {
  const real = await original<typeof import("../src/credentials.js")>();
  return {
    ...real,
    credentialHealth: async (...args: Parameters<typeof real.credentialHealth>) => {
      if (hooks.credentialsThrow) throw new Error("credentials unreadable");
      return hooked("credentials", () => real.credentialHealth(...args));
    },
    credentialsCheck: async (env: Env) => {
      hooks.lastSnapshot = await ownSnapshot(env, A);
      return { checked: 0 };
    },
  };
});
vi.mock("../src/goals.js", async (original) => {
  const real = await original<typeof import("../src/goals.js")>();
  return { ...real, goalViews: async (...args: Parameters<typeof real.goalViews>) => hooked("goals", () => real.goalViews(...args)) };
});
// The owner's digest rides on the askDeadlines job and reads the brief's company data (digest.ts buildOwnerDigest).
vi.mock("../src/digest.js", async (original) => {
  const real = await original<typeof import("../src/digest.js")>();
  return {
    ...real,
    ownerDigestTick: async (env: Env) => {
      if (hooks.realDigest) return (hooks.digestResult = await real.ownerDigestTick(env));
      await loadCompanyData(env, A, 1, 24);
      return { posted: 0, skipped: 0, failed: 0 };
    },
  };
});

const PARTS = [
  "role-drift", "run-profile", "model-key", "grants", "roles-copy", "approvals", "review-routing", "proof", "acceptance", "backlog",
  "unhandled-asks", "client-sends", "skill-sync", "measure", "client-effort", "credentials", "custody", "improvements", "goals", "memory-signal",
];
const SECTIONS = ["job-health", "routine-health", "watch", "memory", "roles", "asks", "activity", "flows"];

type Line = Record<string, unknown>;

async function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: [{ id: "op", companyId: A, name: "Olive", status: "active", role: "general", budgetMonthlyCents: 0, spentMonthlyCents: 0 }] });
  // The fake database answers only the reads other specs route; here every other read is empty, so each part runs to its end.
  const db = fake.ctx.db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    try {
      return await query(sql, params);
    } catch (error) {
      if (String((error as Error).message).includes("needs a route")) return [];
      throw error;
    }
  };
  const lines: Line[] = [];
  const failures: Line[] = [];
  const logger = fake.ctx.logger as unknown as { info: (message: string, meta?: Line) => void };
  logger.info = (message, meta) => {
    if (message === "Cockpit own checks") lines.push(meta ?? {});
    if (message === "Cockpit check failed") failures.push(meta ?? {});
  };
  // Count what reaches the host's job registry.
  let registered = 0;
  const jobs = fake.ctx.jobs as unknown as { register: (key: string, fn: () => Promise<void>) => void };
  const register = jobs.register.bind(jobs);
  jobs.register = (key, fn) => {
    registered += 1;
    register(key, fn);
  };
  const clock = fixedClock("2026-09-26T10:00:00.000Z");
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  await saveTeam(env, A, { operatorAgentId: "op" }, "user-owner");
  // A company read is refused once the invocation is dead, with the host's scope-refusal code.
  const companies = fake.ctx.companies as unknown as { get: (id: string) => Promise<unknown> };
  const getCompany = companies.get.bind(companies);
  companies.get = async (id) => {
    if (hooks.dead) throw Object.assign(new Error("unknown invocation scope"), { code: -32005 });
    return getCompany(id);
  };
  // Every host call, counted (two levels deep: ctx.issues.get, ctx.routines.managed.get); the logger and registries are not host reads.
  let hostCalls = 0;
  const count = (target: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === "function") {
        const fn = value as (...args: unknown[]) => unknown;
        target[key] = (...args: unknown[]) => ((hostCalls += 1), fn.apply(target, args));
      } else if (depth > 0 && value && typeof value === "object") count(value as Record<string, unknown>, depth - 1);
    }
  };
  for (const [key, value] of Object.entries(fake.ctx as unknown as Record<string, unknown>)) {
    if (["logger", "jobs", "actions", "data", "tools", "events", "manifest", "config"].includes(key)) continue;
    if (value && typeof value === "object") count(value as Record<string, unknown>, 1);
  }
  return { ...fake, env, clock, lines, failures, registered: () => registered, hostCalls: () => hostCalls };
}

const entries = (value: unknown) => String(value).split(",").map((entry) => entry.split(":"));

beforeEach(() => {
  hooks.credentialsThrow = false;
  hooks.modes = {};
  hooks.calls = {};
  hooks.dead = false;
  hooks.realDigest = false;
  hooks.digestResult = null;
  hooks.lastSnapshot = null;
});

/** Each part's state in a run record, by name. */
const states = (checks: ExtraChecks) => Object.fromEntries((checks.run ?? []).map((r) => [r.name, r.state]));
const incompleteRow = (health: Array<{ key: string; detail?: string | null }>) => health.find((h) => h.key === OWN_CHECKS_INCOMPLETE_KEY);
/** A new plugin call: the invocation is alive again. */
const newCall = () => {
  hooks.dead = false;
};
const CRED = PARTS.indexOf("credentials");

describe("the own-checks run line", () => {
  it("records a throwing part as failed with its time, the others as ran, and the run goes on", async () => {
    const s = await setup();
    hooks.credentialsThrow = true;
    const snapshot = await ownSnapshot(s.env, A);
    expect(snapshot.flows).toBeDefined();
    expect(s.lines).toHaveLength(1);
    const parts = entries(s.lines[0]!.parts);
    expect(parts.map(([name]) => name)).toEqual(PARTS);
    for (const [name, state, ms] of parts) {
      expect(state).toBe(name === "credentials" ? "failed" : "ran");
      expect(Number(ms)).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(Number(ms))).toBe(true);
    }
    // Today's behaviour kept: the failure is still logged on its own, and the parts after it ran.
    expect(s.failures).toEqual([expect.objectContaining({ check: "credentials", error: "credentials unreadable" })]);
  });

  it("logs no line for a second call inside 10 minutes (whole-result cache hit)", async () => {
    const s = await setup();
    await ownSnapshot(s.env, A);
    s.clock.set("2026-09-26T10:09:00.000Z");
    await ownSnapshot(s.env, A);
    expect(s.lines).toHaveLength(1);
    // The hit is the same result, without a record.
    const hit = await extraChecks(s.env, A);
    expect(hit.run).toBeUndefined();
    expect((await extraChecks(s.env, A, { fresh: true })).run).toHaveLength(20);
  });

  it("carries only scalar values, no error key, 20 parts in run order and every section", async () => {
    const s = await setup();
    await ownSnapshot(s.env, A);
    const line = s.lines[0]!;
    for (const value of Object.values(line)) expect(["string", "number", "boolean"]).toContain(typeof value);
    expect(line).not.toHaveProperty("error");
    expect(Object.keys(line).sort()).toEqual(["boot", "companyId", "incomplete", "lostPart", "parts", "sections", "sectionsMs", "stopCode", "totalMs", "trigger"]);
    expect(line).toMatchObject({ companyId: A, incomplete: false, lostPart: "", stopCode: 0 });
    expect(entries(line.parts)).toHaveLength(20);
    expect(entries(line.parts).map(([name]) => name)).toEqual(PARTS);
    expect(entries(line.sections).map(([name]) => name)).toEqual(SECTIONS);
    const sections = entries(line.sections);
    const before = sections.slice(0, 6).reduce((sum, [, , ms]) => sum + Number(ms), 0);
    // Each section is rounded on its own, the sum once: they differ by at most half a ms per section.
    expect(Math.abs(Number(line.sectionsMs) - before)).toBeLessThanOrEqual(3);
    expect(Number(line.totalMs)).toBeGreaterThanOrEqual(Number(line.sectionsMs));
  });

  it("shares one boot id across calls in the same worker", async () => {
    const first = await setup();
    await ownSnapshot(first.env, A);
    const second = await setup();
    await ownSnapshot(second.env, A);
    expect(first.lines[0]!.boot).toBe(BOOT_ID);
    expect(second.lines[0]!.boot).toBe(BOOT_ID);
    expect(BOOT_ID).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("the trigger label", () => {
  it("wraps every handler passed to ctx.jobs.register", async () => {
    const s = await setup();
    expect(s.registered()).toBe(14);
    expect(s.jobs.size).toBe(14);
    expect([...s.jobs.values()].filter(isJobHandler)).toHaveLength(14);
  });

  it("is job for the healthAlerts and credentialsCheck job handlers", async () => {
    const health = await setup();
    await health.jobs.get(JOBS.healthAlerts)!();
    expect(health.lines.map((l) => l.trigger)).toEqual(["job"]);
    const credentials = await setup();
    await credentials.jobs.get(JOBS.credentialsCheck)!();
    expect(credentials.lines.map((l) => l.trigger)).toEqual(["job"]);
  });

  it("is brief on the brief path, and stays job for the brief reached from the askDeadlines job", async () => {
    const brief = await setup();
    await loadCompanyData(brief.env, A);
    expect(brief.lines.map((l) => l.trigger)).toEqual(["brief"]);
    const digest = await setup();
    await digest.jobs.get(JOBS.askDeadlines)!();
    expect(digest.lines.map((l) => l.trigger)).toEqual(["job"]);
  });

  it("is call for the cockpit.load action", async () => {
    const s = await setup();
    await s.actions.get("cockpit.load")!({}, { companyId: A, actor: { type: "user", userId: "user-owner" } });
    expect(s.lines.map((l) => l.trigger)).toEqual(["call"]);
  });
});

describe("stop on a refused company read, cache per part, the incomplete row (PAR-11232)", () => {
  it("stops at the part whose probe is refused: before it ran and stored, it lost, the rest not run, no host call after the refusal", async () => {
    const s = await setup();
    hooks.modes.credentials = "die";
    let atRefusal = -1;
    const companies = s.ctx.companies as unknown as { get: (id: string) => Promise<unknown> };
    const get = companies.get;
    companies.get = async (id) => {
      try {
        return await get(id);
      } catch (error) {
        atRefusal = s.hostCalls();
        throw error;
      }
    };
    const checks = await extraChecks(s.env, A);
    expect(atRefusal).toBeGreaterThan(0);
    expect(s.hostCalls()).toBe(atRefusal);
    const st = states(checks);
    PARTS.slice(0, CRED).forEach((p) => expect(st[p]).toBe("ran"));
    expect(st.credentials).toBe("lost");
    PARTS.slice(CRED + 1).forEach((p) => expect(st[p]).toBe("notRun"));
    expect(checks.stop).toEqual({ lostPart: "credentials", code: -32005 });
    // The row and the line, through the snapshot (a new call that dies the same way).
    forgetChecks(s.env, A);
    newCall();
    const snapshot = await ownSnapshot(s.env, A);
    const row = incompleteRow(snapshot.health)!;
    expect(row).toMatchObject({ status: "warn", title: "Cockpit checks incomplete" });
    expect(parseIncompleteParts(row.detail)).toEqual(PARTS.slice(CRED));
    expect(s.lines.at(-1)).toMatchObject({ incomplete: true, lostPart: "credentials", stopCode: -32005 });
    expect(entries(s.lines.at(-1)!.parts).map(([name, state]) => `${name}:${state}`)).toContain("credentials:lost");
  });

  it("carries on from the cache in the next call: earlier parts cached, the rest ran, no row", async () => {
    const s = await setup();
    hooks.modes.credentials = "die";
    await extraChecks(s.env, A);
    hooks.modes = {};
    newCall();
    const snapshot = await ownSnapshot(s.env, A);
    const st = Object.fromEntries(entries(s.lines.at(-1)!.parts).map(([name, state]) => [name, state]));
    PARTS.slice(0, CRED).forEach((p) => expect(st[p]).toBe("cached"));
    PARTS.slice(CRED).forEach((p) => expect(st[p]).toBe("ran"));
    expect(incompleteRow(snapshot.health)).toBeUndefined();
    expect(s.lines.at(-1)).toMatchObject({ incomplete: false, lostPart: "", stopCode: 0 });
  });

  it("stores a throwing part as failed and does not run it again inside 10 minutes; no row, later parts run", async () => {
    const s = await setup();
    hooks.modes.credentials = "throw";
    const first = await extraChecks(s.env, A);
    expect(states(first).credentials).toBe("failed");
    expect(states(first).custody).toBe("ran");
    expect(first.stop).toBeUndefined();
    s.clock.set("2026-09-26T10:09:00.000Z");
    const snapshot = await ownSnapshot(s.env, A);
    expect(hooks.calls.credentials).toBe(1);
    expect(incompleteRow(snapshot.health)).toBeUndefined();
    s.clock.set("2026-09-26T10:11:00.000Z");
    await extraChecks(s.env, A);
    expect(hooks.calls.credentials).toBe(2);
  });

  it("holds a part lost twice in a row: later calls skip it, run the parts after it and show the row; at most two starts in five calls", async () => {
    const s = await setup();
    hooks.modes.credentials = "die";
    const rows: Array<{ detail?: string | null } | undefined> = [];
    for (let i = 0; i < 5; i += 1) {
      newCall();
      s.clock.set(new Date(Date.parse("2026-09-26T10:00:00.000Z") + i * 60_000).toISOString());
      rows.push(incompleteRow((await ownSnapshot(s.env, A)).health));
    }
    // One line per call (none is fully cached: the held part is not).
    expect(s.lines).toHaveLength(5);
    const runs = s.lines.map((line) => Object.fromEntries(entries(line.parts).map(([name, state]) => [name, state])));
    expect(hooks.calls.credentials).toBe(2);
    expect(runs.map((run) => run.credentials)).toEqual(["lost", "lost", "held", "held", "held"]);
    // The third call runs the parts after the held one; later calls serve them from the cache.
    PARTS.slice(CRED + 1).forEach((p) => expect(runs[2]![p]).toBe("ran"));
    PARTS.slice(CRED + 1).forEach((p) => expect(runs[4]![p]).toBe("cached"));
    for (const row of rows) expect(row).toBeDefined();
    expect(parseIncompleteParts(rows[4]!.detail)).toEqual(["credentials"]);
    expect(s.lines[4]).toMatchObject({ incomplete: true, lostPart: "", stopCode: 0 });
  });

  it("refused before any part (a job for a company without saved settings): no part reads, the row says the due checks could not run, the digest tick completes", async () => {
    const s = await setup();
    hooks.dead = true;
    const before = s.hostCalls();
    const checks = await extraChecks(s.env, A);
    // The one refused probe, nothing else.
    expect(s.hostCalls() - before).toBe(1);
    expect(hooks.calls).toEqual({});
    expect(new Set(Object.values(states(checks)))).toEqual(new Set(["notRun"]));
    expect(checks.stop).toEqual({ lostPart: "", code: -32005 });
    const snapshot = await ownSnapshot(s.env, A);
    const row = incompleteRow(snapshot.health)!;
    expect(row.detail).toContain("The checks that were due could not run");
    expect(parseIncompleteParts(row.detail)).toEqual(PARTS);
    // The owner's digest from the askDeadlines job at 16:30 SAST: it completes and posts (or skips) as before.
    hooks.realDigest = true;
    s.clock.set("2026-09-26T14:30:00.000Z");
    forgetChecks(s.env, A);
    await s.jobs.get(JOBS.askDeadlines)!();
    expect(hooks.digestResult).toMatchObject({ failed: 0 });
    const result = hooks.digestResult as { posted: number; skipped: number };
    expect(result.posted + result.skipped).toBe(1);
    expect(s.lines.at(-1)).toMatchObject({ trigger: "job", incomplete: true, lostPart: "", stopCode: -32005 });
  });

  it("serves every part from the cache with no host read, no line and no row, even when the company read would be refused", async () => {
    const s = await setup();
    const first = await extraChecks(s.env, A);
    const { run: _run, ...value } = first;
    for (const dead of [false, true]) {
      hooks.dead = dead;
      const lines = s.lines.length;
      const before = s.hostCalls();
      const again = await extraChecks(s.env, A);
      expect(s.hostCalls()).toBe(before);
      expect(again.run).toBeUndefined();
      expect(again.stop).toBeUndefined();
      expect(again).toEqual(value);
      const snapshot = await ownSnapshot(s.env, A);
      expect(incompleteRow(snapshot.health)).toBeUndefined();
      expect(s.lines.length).toBe(lines);
    }
  });

  it("keeps the cached parts with their values when the first probe is refused; the row names only the parts not run", async () => {
    const s = await setup();
    hooks.modes.credentials = "die";
    const first = await extraChecks(s.env, A);
    hooks.modes = {};
    hooks.dead = true;
    const second = await extraChecks(s.env, A);
    const st = states(second);
    PARTS.slice(0, CRED).forEach((p) => expect(st[p]).toBe("cached"));
    PARTS.slice(CRED).forEach((p) => expect(st[p]).toBe("notRun"));
    expect(second.stop).toEqual({ lostPart: "", code: -32005 });
    expect({ ...second, run: undefined, stop: undefined }).toEqual({ ...first, run: undefined, stop: undefined });
    expect(second.kpis.map((k) => k.key)).toContain("ai_spend_7d");
    const snapshot = await ownSnapshot(s.env, A);
    expect(parseIncompleteParts(incompleteRow(snapshot.health)!.detail)).toEqual(PARTS.slice(CRED));
  });

  it("fresh runs a held and a failed part again inside 10 minutes", async () => {
    const s = await setup();
    hooks.modes = { credentials: "die", goals: "throw" };
    await extraChecks(s.env, A);
    newCall();
    await extraChecks(s.env, A);
    newCall();
    const third = await extraChecks(s.env, A);
    expect(states(third)).toMatchObject({ credentials: "held", goals: "failed" });
    expect(await extraChecks(s.env, A)).toMatchObject({ run: expect.arrayContaining([expect.objectContaining({ name: "goals", state: "cached" })]) });
    hooks.modes = {};
    const calls = { ...hooks.calls };
    const fresh = await extraChecks(s.env, A, { fresh: true });
    expect(hooks.calls.credentials).toBe(calls.credentials! + 1);
    expect(hooks.calls.goals).toBe(calls.goals! + 1);
    expect(new Set(Object.values(states(fresh)))).toEqual(new Set(["ran"]));
  });

  it("forgetChecks clears parts, failures and holds", async () => {
    const s = await setup();
    hooks.modes = { credentials: "die", goals: "throw" };
    await extraChecks(s.env, A);
    newCall();
    await extraChecks(s.env, A);
    newCall();
    expect(states(await extraChecks(s.env, A))).toMatchObject({ credentials: "held", goals: "failed" });
    forgetChecks(s.env, A);
    hooks.modes = {};
    const after = await extraChecks(s.env, A);
    expect(new Set(Object.values(states(after)))).toEqual(new Set(["ran"]));
    // A loss after forgetting counts from one again: lost, not held.
    forgetChecks(s.env, A);
    hooks.modes = { credentials: "die" };
    newCall();
    expect(states(await extraChecks(s.env, A)).credentials).toBe("lost");
  });

  it("a job with every read admitted: complete, no row, trigger job", async () => {
    const s = await setup();
    await s.jobs.get(JOBS.credentialsCheck)!();
    expect(s.lines.at(-1)).toMatchObject({ trigger: "job", incomplete: false, lostPart: "", stopCode: 0 });
    expect(incompleteRow((hooks.lastSnapshot as { health: Array<{ key: string }> }).health)).toBeUndefined();
  });

  it("formats and reads back the part names", () => {
    for (const names of [PARTS, SECTIONS, ["credentials"], []]) {
      expect(parseIncompleteParts(formatIncompleteParts(names))).toEqual(names);
      expect(parseIncompleteParts(formatIncompleteParts(names, { notStarted: true }))).toEqual(names);
    }
    expect(parseIncompleteParts(null)).toEqual([]);
    expect(parseIncompleteParts("Some other text: a, b.")).toEqual([]);
  });
});
