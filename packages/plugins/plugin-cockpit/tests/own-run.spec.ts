/**
 * The one log line per run of the Cockpit's own checks (PAR-11071 stage 1a-i,
 * PAR-11231): each part and section with its state and time, what started the
 * run (job, brief, call) and the worker's boot id. Measurement only: a part
 * that throws is recorded as failed and the run goes on as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCompanyData } from "../src/brief.js";
import { extraChecks } from "../src/checks.js";
import { JOBS } from "../src/constants.js";
import type { Env } from "../src/env.js";
import { ownSnapshot } from "../src/own.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { BOOT_ID, isJobHandler } from "../src/run-trigger.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";

/** Toggles for the module mocks below. */
const hooks = vi.hoisted(() => ({ credentialsThrow: false }));

// One part made to throw on demand; the credentials job runs the own checks so its line can be read.
vi.mock("../src/credentials.js", async (original) => {
  const real = await original<typeof import("../src/credentials.js")>();
  return {
    ...real,
    credentialHealth: async (...args: Parameters<typeof real.credentialHealth>) => {
      if (hooks.credentialsThrow) throw new Error("credentials unreadable");
      return real.credentialHealth(...args);
    },
    credentialsCheck: async (env: Env) => {
      await ownSnapshot(env, A);
      return { checked: 0 };
    },
  };
});
// The owner's digest rides on the askDeadlines job and reads the brief's company data (digest.ts buildOwnerDigest).
vi.mock("../src/digest.js", async (original) => ({
  ...(await original<typeof import("../src/digest.js")>()),
  ownerDigestTick: async (env: Env) => {
    await loadCompanyData(env, A, 1, 24);
    return { posted: 0, skipped: 0, failed: 0 };
  },
}));

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
  return { ...fake, env, clock, lines, failures, registered: () => registered };
}

const entries = (value: unknown) => String(value).split(",").map((entry) => entry.split(":"));

beforeEach(() => {
  hooks.credentialsThrow = false;
});

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
