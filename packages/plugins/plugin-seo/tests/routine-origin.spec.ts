/**
 * 0.22.0: the managed routines fired but the host failed every dispatch ("Run today's SEO" 5 of 5). A routine
 * declaring `issueTemplate.originId` without `surfaceVisibility: "plugin_operation"` has its issue filed as a routine
 * execution, and the heartbeat then reads that origin id back as the routine's uuid. The declarations dropped the
 * origin id; routines that already exist carry it in the host's binding row until a reconcile rewrites it.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { brokenIssueTemplate, healRoutineTemplates } from "../src/service/routines.js";
import plugin from "../src/worker.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("the declared routines", () => {
  it("carry no issue template origin id the host cannot dispatch", () => {
    for (const routine of manifest.routines ?? []) {
      expect(brokenIssueTemplate(routine.issueTemplate), routine.routineKey).toBe(false);
      // The host falls back to the routine's own uuid; a custom id is only safe on a plugin operation.
      if (routine.issueTemplate?.originId) {
        expect(routine.issueTemplate.surfaceVisibility, routine.routineKey).toBe("plugin_operation");
      }
      expect(routine.issueTemplate?.originId == null || UUID.test(routine.issueTemplate.originId) || routine.issueTemplate.surfaceVisibility === "plugin_operation").toBe(true);
    }
  });

  it("are still the two shipped routines (nothing else changed in them)", () => {
    expect((manifest.routines ?? []).map((r) => r.routineKey)).toEqual(["seo-run-today", "seo-weekly-review"]);
  });
});

describe("brokenIssueTemplate", () => {
  it("flags an origin id without plugin_operation and nothing else", () => {
    expect(brokenIssueTemplate({ originId: "routine:seo-run-today" })).toBe(true);
    expect(brokenIssueTemplate({ originId: "routine:x", surfaceVisibility: "normal" })).toBe(true);
    expect(brokenIssueTemplate({ originId: "routine:x", surfaceVisibility: "plugin_operation" })).toBe(false);
    expect(brokenIssueTemplate({ originId: "  " })).toBe(false);
    expect(brokenIssueTemplate({ billingCode: "x" })).toBe(false);
    expect(brokenIssueTemplate(null)).toBe(false);
    expect(brokenIssueTemplate(undefined)).toBe(false);
    expect(brokenIssueTemplate("routine:x")).toBe(false);
  });
});

type Stored = Record<string, unknown> | null | undefined;

/**
 * A host whose binding rows hold `stored[key]` until `reconcile` rewrites them from the manifest (which declares none).
 * Like the real host, `reconcile` answers with the state it read BEFORE the rewrite; only a later `get` shows the repair.
 */
function host(stored: Record<string, Stored>, options: { failReconcile?: string[]; keepBroken?: string[]; missing?: string[] } = {}) {
  const state = { ...stored };
  const resolution = (key: string) => {
    if (options.missing?.includes(key)) return { routineId: null, routine: null, status: "missing" };
    const defaults = state[key] === undefined ? undefined : { issueTemplate: state[key] };
    return { routineId: `r-${key}`, status: "resolved", routine: { id: `r-${key}`, status: "active", assigneeAgentId: "agent-1", managedByPlugin: defaults ? { defaultsJson: defaults } : null } };
  };
  const managed = {
    get: vi.fn(async (key: string) => resolution(key)),
    reconcile: vi.fn(async (key: string) => {
      if (options.failReconcile?.includes(key)) throw new Error("host refused");
      const before = resolution(key);
      if (!options.keepBroken?.includes(key)) state[key] = null;
      return before;
    }),
    reset: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const env = createEnv({ routines: { managed }, logger } as unknown as PluginContext, { now: () => new Date(), fetch: vi.fn() as never, site: vi.fn() as never });
  return { env, managed, logger };
}

describe("healRoutineTemplates", () => {
  const broken = { originId: "routine:seo-run-today" };

  it("reconciles a routine whose stored template has the old origin id, once, and confirms it by reading it again", async () => {
    const h = host({ "seo-run-today": broken, "seo-weekly-review": { originId: "routine:seo-weekly-review" } });
    expect(await healRoutineTemplates(h.env, "co-1")).toEqual(["seo-run-today", "seo-weekly-review"]);
    expect(h.managed.reconcile).toHaveBeenCalledTimes(2);
    // A good repair is not reported as a failure (reconcile's own answer is the pre-write state: never judged on).
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith("SEO routine issue template repaired", expect.objectContaining({ key: "seo-run-today" }));
    // Read before (the broken check), then again after the reconcile (the confirmation), per routine.
    expect(h.managed.get).toHaveBeenCalledTimes(4);
    // No overrides: the routine exists, so its assignee and status are left alone.
    expect(h.managed.reconcile).toHaveBeenCalledWith("seo-run-today", "co-1");
    expect(h.managed.update).not.toHaveBeenCalled();
    expect(h.managed.reset).not.toHaveBeenCalled();
    // Idempotent: the second hourly run finds nothing to repair.
    expect(await healRoutineTemplates(h.env, "co-1")).toEqual([]);
    expect(h.managed.reconcile).toHaveBeenCalledTimes(2);
  });

  it("leaves a clean routine, a missing routine and one the host did not describe alone", async () => {
    const h = host({ "seo-run-today": null, "seo-weekly-review": undefined }, { missing: ["seo-weekly-review"] });
    expect(await healRoutineTemplates(h.env, "co-1")).toEqual([]);
    expect(h.managed.reconcile).not.toHaveBeenCalled();
    const unknown = host({ "seo-run-today": undefined, "seo-weekly-review": undefined });
    expect(await healRoutineTemplates(unknown.env, "co-1")).toEqual([]);
    expect(unknown.managed.reconcile).not.toHaveBeenCalled();
  });

  it("keeps a plugin_operation template (a custom origin id is safe there)", async () => {
    const h = host({ "seo-run-today": { originId: "routine:x", surfaceVisibility: "plugin_operation" }, "seo-weekly-review": null });
    expect(await healRoutineTemplates(h.env, "co-1")).toEqual([]);
    expect(h.managed.reconcile).not.toHaveBeenCalled();
  });

  it("does not claim a repair the host did not make (a stale manifest rewrites the same template), and never throws", async () => {
    const h = host({ "seo-run-today": broken, "seo-weekly-review": { originId: "routine:seo-weekly-review" } }, { keepBroken: ["seo-run-today"], failReconcile: ["seo-weekly-review"] });
    await expect(healRoutineTemplates(h.env, "co-1")).resolves.toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith("SEO routine template still broken after reconcile", expect.objectContaining({ key: "seo-run-today" }));
    expect(h.logger.info).not.toHaveBeenCalledWith("SEO routine issue template repaired", expect.anything());
    // It tries again on the next hourly run (nothing is remembered as fixed).
    await healRoutineTemplates(h.env, "co-1");
    expect(h.managed.reconcile.mock.calls.filter(([key]) => key === "seo-run-today")).toHaveLength(2);
  });

  it("repairs one routine and reports the other when only one is stale", async () => {
    const h = host({ "seo-run-today": broken, "seo-weekly-review": { originId: "routine:seo-weekly-review" } }, { keepBroken: ["seo-weekly-review"] });
    await expect(healRoutineTemplates(h.env, "co-1")).resolves.toEqual(["seo-run-today"]);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith("SEO routine template still broken after reconcile", expect.objectContaining({ key: "seo-weekly-review" }));
  });
});

describe("the hourly SEO job", () => {
  it("repairs a routine created by an older version, once", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    const db = {
      namespace: NAMESPACE,
      async query(sql: string) {
        return /DISTINCT company_id/.test(sql) ? [{ company_id: "co-1" }] : [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    };
    const stored: Record<string, unknown> = { "seo-run-today": { originId: "routine:seo-run-today" }, "seo-weekly-review": { originId: "routine:seo-weekly-review" } };
    const get = vi.fn(async (key: string) => ({ routineId: `r-${key}`, status: "resolved", routine: { id: `r-${key}`, status: "active", assigneeAgentId: "a", updatedByUserId: "u", managedByPlugin: { defaultsJson: { issueTemplate: stored[key] } } } }));
    // The real host answers with the state read before the rewrite.
    const reconcile = vi.fn(async (key: string) => {
      const before = await get(key);
      stored[key] = null;
      return before;
    });
    const ctx = { ...harness.ctx, db, routines: { managed: { ...harness.ctx.routines.managed, get, reconcile } } } as unknown as PluginContext;
    await plugin.definition.setup(ctx);
    await harness.runJob("seo-daily");
    expect(reconcile.mock.calls.map(([key]) => key).sort()).toEqual(["seo-run-today", "seo-weekly-review"]);
    await harness.runJob("seo-daily");
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
    // The confirmation reads the routine again, so a good repair is not logged as a failure.
    expect(harness.logs.filter((l) => /still broken/.test(l.message))).toEqual([]);
  });
});
