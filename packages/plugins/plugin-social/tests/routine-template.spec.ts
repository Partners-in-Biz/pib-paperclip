/**
 * 0.7.2: the weekly routine's stored issue template.
 *
 * Live bug: the host opens a routine's issue as `routine_execution` with the
 * template's `originId` (else the routine's own uuid) and then looks the run up
 * with that id in a uuid column. `routine:plan-next-week` is not a uuid, so every
 * Monday dispatch failed. The manifest no longer declares a template, and the
 * binding the host stored with the old one is repaired by a reconcile.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyBootstrap } from "../src/company.js";
import manifest from "../src/manifest.js";
import { PLAN_ROUTINE_KEY } from "../src/platforms.js";
import { healPlanRoutine, staleRoutineTemplate } from "../src/routine-template.js";
import { fakeCtx } from "./helpers.js";

const ROUTINE_ID = "1f4b4a64-033f-43cf-ba05-8e5171fe4f57";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The binding the live host holds for the 0.7.1 routine (plugin_managed_resources.defaults_json, trimmed). */
const OLD_BINDING = { title: "Weekly social review & plan", status: "active", issueTemplate: { originId: "routine:plan-next-week" } };

/** The host's dispatch rule for a routine's issue origin (server/src/services/routines.ts, dispatchRoutineRun). */
function hostIssueOrigin(defaults: Record<string, unknown> | null, routineId: string, pluginKey: string): { kind: string; id: string } {
  const t = defaults?.issueTemplate;
  const template = t && typeof t === "object" ? (t as Record<string, unknown>) : null;
  const surface = typeof template?.surfaceVisibility === "string" ? template.surfaceVisibility : null;
  const originId = typeof template?.originId === "string" && template.originId.trim() ? template.originId.trim() : null;
  return { kind: surface === "plugin_operation" ? `plugin:${pluginKey}:operation` : "routine_execution", id: originId ?? routineId };
}

/** What the host does on `routines.managed.reconcile` for an existing routine: rewrite the binding from the manifest. */
function manifestBinding(): Record<string, unknown> {
  const declaration = manifest.routines!.find((r) => r.routineKey === PLAN_ROUTINE_KEY)!;
  return { title: declaration.title, status: declaration.status, issueTemplate: declaration.issueTemplate ?? null };
}

function host(opts: { stored: Record<string, unknown> | null; hasRoutine?: boolean; hostHasNewManifest?: boolean; getThrows?: boolean }) {
  let defaults = opts.stored;
  const hasRoutine = opts.hasRoutine ?? true;
  const get = vi.fn(async () => {
    if (opts.getThrows) throw new Error("Plugin settings are not saved for this company");
    return { routineId: hasRoutine ? ROUTINE_ID : null, routine: hasRoutine ? { id: ROUTINE_ID, status: "active", managedByPlugin: { defaultsJson: defaults } } : null };
  });
  const reconcile = vi.fn(async () => {
    if (hasRoutine && opts.hostHasNewManifest !== false) defaults = manifestBinding();
    return get();
  });
  const logs: string[] = [];
  const ctx = fakeCtx({
    routines: { managed: { get, reconcile } },
    logger: { info: (message: string) => void logs.push(message), warn: () => undefined, error: () => undefined, debug: () => undefined },
  });
  return { ctx, get, reconcile, logs, stored: () => defaults };
}

afterEach(() => vi.useRealTimers());

describe("why the weekly routine failed", () => {
  it("the old binding makes the host look a uuid column up with a string; the manifest's own does not", () => {
    const old = hostIssueOrigin(OLD_BINDING, ROUTINE_ID, "partnersinbiz.social");
    expect(old).toEqual({ kind: "routine_execution", id: "routine:plan-next-week" });
    expect(UUID.test(old.id)).toBe(false);
    const fixed = hostIssueOrigin(manifestBinding(), ROUTINE_ID, "partnersinbiz.social");
    expect(fixed).toEqual({ kind: "routine_execution", id: ROUTINE_ID });
    expect(UUID.test(fixed.id)).toBe(true);
  });
});

describe("staleRoutineTemplate", () => {
  it("is true only for an origin the host cannot dispatch", () => {
    expect(staleRoutineTemplate(OLD_BINDING, ROUTINE_ID)).toBe(true);
    expect(staleRoutineTemplate({ issueTemplate: { originId: "routine:x", surfaceVisibility: "default" } }, ROUTINE_ID)).toBe(true);
    // A plugin_operation origin is fine for the host; the routine's own id is fine too.
    expect(staleRoutineTemplate({ issueTemplate: { originId: "routine:x", surfaceVisibility: "plugin_operation" } }, ROUTINE_ID)).toBe(false);
    expect(staleRoutineTemplate({ issueTemplate: { originId: ROUTINE_ID } }, ROUTINE_ID)).toBe(false);
    // No template, an empty one, or one without an origin id.
    expect(staleRoutineTemplate({ issueTemplate: null }, ROUTINE_ID)).toBe(false);
    expect(staleRoutineTemplate({}, ROUTINE_ID)).toBe(false);
    expect(staleRoutineTemplate({ issueTemplate: { billingCode: "x" } }, ROUTINE_ID)).toBe(false);
    expect(staleRoutineTemplate({ issueTemplate: { originId: "  " } }, ROUTINE_ID)).toBe(false);
    expect(staleRoutineTemplate(undefined, null)).toBe(false);
    expect(staleRoutineTemplate("nonsense", null)).toBe(false);
  });
});

describe("healPlanRoutine", () => {
  it("reconciles a binding that still holds the old template, then reads it back", async () => {
    const h = host({ stored: OLD_BINDING });
    expect(await healPlanRoutine(h.ctx, "co")).toBe("healed");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledWith(PLAN_ROUTINE_KEY, "co");
    expect(hostIssueOrigin(h.stored(), ROUTINE_ID, "partnersinbiz.social")).toEqual({ kind: "routine_execution", id: ROUTINE_ID });
    expect(h.logs).toContain("Social weekly routine issue template repaired");
  });

  it("does nothing to a binding that is already right (safe to run on every start)", async () => {
    const h = host({ stored: manifestBinding() });
    expect(await healPlanRoutine(h.ctx, "co")).toBe("current");
    expect(await healPlanRoutine(h.ctx, "co")).toBe("current");
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("never creates the routine: a company without one is left alone", async () => {
    const h = host({ stored: null, hasRoutine: false });
    expect(await healPlanRoutine(h.ctx, "co")).toBe("none");
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("reports stale when the host has not loaded this release's manifest yet, so it is tried again", async () => {
    const h = host({ stored: OLD_BINDING, hostHasNewManifest: false });
    expect(await healPlanRoutine(h.ctx, "co")).toBe("stale");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.logs).toContain("Social weekly routine still holds the old issue template");
  });

  it("never throws (settings not saved, host hiccup)", async () => {
    const h = host({ stored: OLD_BINDING, getThrows: true });
    expect(await healPlanRoutine(h.ctx, "co")).toBe("stale");
    expect(h.logs).toContain("Social weekly routine check skipped");
    // A context without the routines client at all (older tests, a plugin host without it).
    expect(await healPlanRoutine(fakeCtx(), "co")).toBe("stale");
  });
});

describe("company bootstrap", () => {
  function bootstrapWith(h: ReturnType<typeof host>) {
    return createCompanyBootstrap(h.ctx);
  }

  it("repairs the binding on the first touch of a company, and not again once it is right", async () => {
    const h = host({ stored: OLD_BINDING });
    const bootstrap = bootstrapWith(h);
    await bootstrap.ensure("co");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const reads = h.get.mock.calls.length;
    await bootstrap.ensure("co");
    await bootstrap.ensure("co");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls.length).toBe(reads);
    expect(hostIssueOrigin(h.stored(), ROUTINE_ID, "partnersinbiz.social").id).toBe(ROUTINE_ID);
  });

  it("tries again after ten minutes when the repair did not stick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T08:00:00Z"));
    const h = host({ stored: OLD_BINDING, hostHasNewManifest: false });
    const bootstrap = bootstrapWith(h);
    await bootstrap.ensure("co");
    await bootstrap.ensure("co");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-03T08:11:00Z"));
    await bootstrap.ensure("co");
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("checks each company on its own", async () => {
    const h = host({ stored: manifestBinding() });
    const bootstrap = bootstrapWith(h);
    await bootstrap.ensure("co-a");
    await bootstrap.ensure("co-b");
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.get.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["co-a", "co-b"]);
  });
});
