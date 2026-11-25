/**
 * Work that outlives its invocation (PAR-14009). The host ends a plugin call after 30 s and forgets its invocation id;
 * every host call made with that id afterwards is refused (`unknown_invocation`). In production `cockpit.load` ran
 * 33-44 s (`measure` ~22 s, `client-effort` 10-17 s), so `client-effort` went on after the timeout and read each CRM
 * client's project links (281 `state.get`), then the probe (`companies.get`) and the load's `agents.list`: all refused.
 *
 * The fake host below keeps the invocation in an AsyncLocalStorage, like the SDK does, and refuses every call made
 * under an ended invocation. Calls made outside any invocation are admitted for a company with saved settings only.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_LIMITS, extraChecks, OWN_CHECKS_INCOMPLETE_KEY, parseIncompleteParts } from "../src/checks.js";
import type { Env } from "../src/env.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { withTrigger } from "../src/run-trigger.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const CLIENTS = 281;

/** `client-effort` waits on `gate`, then reads one state row per CRM client, like the kit's `clientProjectIds`. */
const hooks = vi.hoisted(() => ({ gate: null as Promise<void> | null, reads: 0 }));

vi.mock("../src/client-cost.js", async (original) => {
  const real = await original<typeof import("../src/client-cost.js")>();
  return {
    ...real,
    clientEffortHealth: async (env: Env, companyId: string) => {
      if (hooks.gate) await hooks.gate;
      for (let i = 0; i < CLIENTS; i += 1) {
        await env.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "client-projects", stateKey: `company:${i}` }).catch(() => null);
        hooks.reads += 1;
      }
      return [{ key: "client_effort", title: "A client costs more than it pays", status: "warn" as const, detail: null, href: "/cockpit" }];
    },
  };
});

interface Invocation {
  alive: boolean;
}

const HOST_TIMEOUT_MS = 200;

async function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: [{ id: "op", companyId: A, name: "Olive", status: "active", role: "general", budgetMonthlyCents: 0, spentMonthlyCents: 0 }] });
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
  const notes: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger = fake.ctx.logger as unknown as { info: (message: string, meta?: Record<string, unknown>) => void };
  logger.info = (message, meta) => void notes.push({ message, meta });
  const env = createEnv(fake.ctx, fixedClock("2026-11-23T06:51:00.000Z").now);
  registerCockpit(fake.ctx, env);
  await saveTeam(env, A, { operatorAgentId: "op" }, "user-owner");

  // The host: the current invocation travels in an AsyncLocalStorage (as in the SDK's worker host).
  const invocation = new AsyncLocalStorage<Invocation>();
  const refusals: string[] = [];
  const saved = (id: unknown) => typeof id === "string" && Object.keys(fake.configs).includes(id);
  const companyOf = (args: unknown[]): string | null => {
    for (const arg of args) {
      if (arg && typeof arg === "object") {
        const o = arg as Record<string, unknown>;
        if (typeof o.companyId === "string") return o.companyId;
        if (o.scopeKind === "company" && typeof o.scopeId === "string") return o.scopeId;
      }
    }
    return null;
  };
  const gate = (path: string, fn: (...args: unknown[]) => unknown, target: object) => (...args: unknown[]) => {
    const current = invocation.getStore();
    if (current && !current.alive) {
      refusals.push(path);
      return Promise.reject(Object.assign(new Error(`Plugin is not allowed to perform "${path}": the worker referenced a missing, expired, or unknown invocation scope`), { code: -32005 }));
    }
    const company = companyOf(args);
    if (!current && company && !saved(company)) {
      refusals.push(path);
      return Promise.reject(Object.assign(new Error("unconfigured company"), { code: -32005 }));
    }
    return fn.apply(target, args);
  };
  const wrap = (target: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === "function") target[key] = gate(`${prefix}${key}`, value as (...args: unknown[]) => unknown, target);
      else if (depth > 0 && value && typeof value === "object") wrap(value as Record<string, unknown>, `${prefix}${key}.`, depth - 1);
    }
  };
  for (const [key, value] of Object.entries(fake.ctx as unknown as Record<string, unknown>)) {
    if (["logger", "jobs", "actions", "data", "tools", "events", "manifest"].includes(key)) continue;
    if (value && typeof value === "object") wrap(value as Record<string, unknown>, `${key}.`, 1);
  }

  /** One host call: the action runs under a fresh invocation; after it returns or times out the invocation is gone. */
  async function hostCall<T>(run: () => Promise<T>): Promise<{ timedOut: boolean; value?: T }> {
    const inv: Invocation = { alive: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), HOST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([invocation.run(inv, run).then((value) => ({ timedOut: false, value })), timeout]);
    } finally {
      clearTimeout(timer);
      inv.alive = false;
    }
  }

  const load = () => hostCall(() => fake.actions.get("cockpit.load")!({}, { companyId: A, actor: { type: "user", userId: "user-owner" } }) as Promise<{ own: { health: Array<{ key: string; detail?: string | null }> } }>);
  return { ...fake, env, notes, refusals, hostCall, load };
}

/** Lets `client-effort` go on, waits until it read every client, then lets what follows it (probe, later parts) run. */
async function release(open: () => void) {
  open();
  await vi.waitFor(() => expect(hooks.reads).toBe(CLIENTS), { timeout: 2_000, interval: 5 });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const finishedAfterCall = (s: Awaited<ReturnType<typeof setup>>) => s.notes.filter((n) => n.message === "Cockpit checks finished after the call").length;

const limits = { ...CALL_LIMITS };
afterEach(() => {
  Object.assign(CALL_LIMITS, limits);
  hooks.gate = null;
  hooks.reads = 0;
});

describe("checks that outlive the call (PAR-14009)", () => {
  it("a page load whose slow part runs past the call makes no refused host call; the part finishes into the cache", async () => {
    const s = await setup();
    CALL_LIMITS.waitMs = 40;
    let open!: () => void;
    hooks.gate = new Promise<void>((resolve) => (open = resolve));

    const first = await s.load();
    // The invocation is gone; the slow part goes on and reads every client. Before PAR-14009 each read was refused.
    await release(open);
    expect(s.refusals).toEqual([]);
    expect(finishedAfterCall(s)).toBe(1);
    // The load answered inside the host's limit, with the parts still running named in the incomplete row.
    expect(first.timedOut).toBe(false);
    const row = first.value!.own.health.find((h) => h.key === OWN_CHECKS_INCOMPLETE_KEY);
    expect(parseIncompleteParts(row?.detail)).toContain("client-effort");

    // The next load reads the part from the cache: its finding shows and nothing is incomplete.
    const second = await s.load();
    expect(second.timedOut).toBe(false);
    const keys = second.value!.own.health.map((h) => h.key);
    expect(keys).toContain("client_effort");
    expect(keys).not.toContain(OWN_CHECKS_INCOMPLETE_KEY);
    expect(s.refusals).toEqual([]);
  });

  it("a second load while the parts still run waits on the same run instead of starting another", async () => {
    const s = await setup();
    CALL_LIMITS.waitMs = 40;
    let open!: () => void;
    hooks.gate = new Promise<void>((resolve) => (open = resolve));
    await s.load();
    await s.load();
    await release(open);
    expect(s.refusals).toEqual([]);
    // One run: the client links were read once, not twice.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hooks.reads).toBe(CLIENTS);
    expect(finishedAfterCall(s)).toBe(1);
  });

  it("a job still waits for every part, however long it takes", async () => {
    const s = await setup();
    CALL_LIMITS.waitMs = 10;
    let open!: () => void;
    hooks.gate = new Promise<void>((resolve) => (open = resolve));
    setTimeout(() => open(), 60);
    const checks = await withTrigger("job", () => extraChecks(s.env, A));
    expect(checks.health.map((h) => h.key)).toContain("client_effort");
    expect(checks.run?.filter((r) => r.state === "notRun")).toEqual([]);
    expect(finishedAfterCall(s)).toBe(0);
  });
});
