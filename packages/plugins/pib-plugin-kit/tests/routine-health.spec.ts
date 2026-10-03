import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { emptySnapshot, publishCockpitSnapshot, withRoutineHealth } from "../src/cockpit.js";
import {
  issueTemplateProblem,
  ROUTINE_EDIT_GRACE_MS,
  ROUTINE_ORIGIN_RULE,
  routineFailedCheck,
  routineHealth,
  routineLastRun,
  type RoutineRunState,
} from "../src/routine-health.js";

const FIRED = "2026-10-03T04:30:11.997Z";
const touched = (offsetMs: number) => new Date(Date.parse(FIRED) + offsetMs).toISOString();

/** A routine row as the host returns it after a firing that created no issue (the live "Run today's SEO"). */
const failedRow = (extra: Partial<RoutineRunState> = {}): RoutineRunState => ({
  status: "active",
  lastTriggeredAt: FIRED,
  lastEnqueuedAt: null,
  updatedAt: touched(640),
  activityGatePolicy: "always",
  ...extra,
});

describe("issue template rule", () => {
  it("allows no originId, and an originId only with plugin_operation", () => {
    expect(issueTemplateProblem(undefined)).toBeNull();
    expect(issueTemplateProblem({})).toBeNull();
    expect(issueTemplateProblem({ originId: null })).toBeNull();
    expect(issueTemplateProblem({ originId: "  " })).toBeNull();
    expect(issueTemplateProblem({ billingCode: "x" })).toBeNull();
    expect(issueTemplateProblem({ surfaceVisibility: "plugin_operation", originId: "routine:index-refresh" })).toBeNull();
  });

  it("names the routine's originId and visibility when the rule is broken", () => {
    expect(issueTemplateProblem({ originId: "routine:seo-run-today" })).toBe('issueTemplate.originId is "routine:seo-run-today" but surfaceVisibility is not set');
    expect(issueTemplateProblem({ originId: "routine:x", surfaceVisibility: "default" })).toBe('issueTemplate.originId is "routine:x" but surfaceVisibility is "default"');
  });

  it("states the rule in one place for the contract test and the health check", () => {
    expect(ROUTINE_ORIGIN_RULE).toContain('only together with surfaceVisibility "plugin_operation"');
    expect(ROUTINE_ORIGIN_RULE).toContain("invalid input syntax for type uuid");
  });
});

describe("routineLastRun", () => {
  it("flags a firing that created no issue (the live failed daily SEO routine)", () => {
    expect(routineLastRun(failedRow())).toEqual({ failed: true, at: FIRED });
  });

  it("is fine when the firing created or joined an issue", () => {
    expect(routineLastRun(failedRow({ lastEnqueuedAt: FIRED }))).toEqual({ failed: false, why: "ok" });
    // The host stamps both with the same instant; a second of skew is not a failure.
    expect(routineLastRun(failedRow({ lastEnqueuedAt: touched(-500) }))).toEqual({ failed: false, why: "ok" });
    expect(routineLastRun(failedRow({ lastEnqueuedAt: new Date(Date.parse(FIRED)) as unknown as string }))).toEqual({ failed: false, why: "ok" });
  });

  it("flags a failure after an older success (latest firing counts)", () => {
    expect(routineLastRun(failedRow({ lastEnqueuedAt: "2026-10-02T04:30:12.000Z" }))).toEqual({ failed: true, at: FIRED });
  });

  it("does not judge routines that are off, gated, never fired, or edited since the failure", () => {
    expect(routineLastRun(failedRow({ status: "paused" }))).toEqual({ failed: false, why: "off" });
    expect(routineLastRun(failedRow({ activityGatePolicy: "require_external_activity" }))).toEqual({ failed: false, why: "gated" });
    expect(routineLastRun({ status: "active", lastTriggeredAt: null, lastEnqueuedAt: null })).toEqual({ failed: false, why: "never-fired" });
    expect(routineLastRun(failedRow({ updatedAt: touched(ROUTINE_EDIT_GRACE_MS + 1000) }))).toEqual({ failed: false, why: "edited-since" });
    // The host touches the row a moment after firing: still the same firing.
    expect(routineLastRun(failedRow({ updatedAt: touched(ROUTINE_EDIT_GRACE_MS - 1000) }))).toEqual({ failed: true, at: FIRED });
  });

  it("reads Date objects as well as ISO text", () => {
    expect(routineLastRun({ status: "active", lastTriggeredAt: new Date(FIRED), lastEnqueuedAt: null, updatedAt: new Date(touched(100)) })).toEqual({ failed: true, at: FIRED });
  });
});

describe("routineFailedCheck", () => {
  it("names the plugin, the routine, the time and the likely cause when the template breaks the rule", () => {
    const check = routineFailedCheck({ routineKey: "seo-run-today", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r-1", at: FIRED, template: { originId: "routine:seo-run-today" }, declared: { originId: "routine:seo-run-today" } });
    expect(check).toMatchObject({ key: "routine:seo-run-today", status: "bad", href: "/routines/r-1", since: FIRED });
    expect(check.title).toBe('SEO routine "Run today\'s SEO" failed its last run');
    expect(check.detail).toContain("3 Oct 04:30 UTC");
    expect(check.detail).toContain('issueTemplate.originId is "routine:seo-run-today" but surfaceVisibility is not set');
    expect(check.detail).toContain("invalid input syntax for type uuid");
    expect(check.detail).toContain("Fix the plugin manifest");
  });

  it("says who may run it again, because the host answers 403 for any agent but the assignee", () => {
    const check = routineFailedCheck({ routineKey: "seo-run-today", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r-1", at: FIRED, assigneeAgentId: "agent-seo" });
    expect(check.detail).toContain("assigned to agent agent-seo");
    expect(check.fix).toContain("GET /api/routines/r-1/runs (any agent may)");
    expect(check.fix).toContain("only the routine's assignee (or the owner) may POST /api/routines/r-1/run");
    expect(check.fix).toContain('open an issue for the assignee: "Run Run today\'s SEO once now and report"');
    expect(check.fix).toContain("the role that owns code, or to the owner if the company has none");
    expect(check.fix).toContain("clears at its next scheduled run");
    // No role of ours ("the Developer") and no instruction to press Run now for a routine the reader may not run.
    expect(check.fix).not.toContain("Developer");
    expect(check.fix).not.toContain("Run now");
  });

  it("reads the cause from the stored template the host dispatches from, ahead of the manifest", () => {
    const base = { routineKey: "plan", title: "Weekly plan", pluginTitle: "Social", routineId: "r-p", at: FIRED };
    // The manifest was fixed but the routine still holds the old template: name that, and do not blame the manifest.
    const stale = routineFailedCheck({ ...base, template: { originId: "routine:plan-next-week" }, declared: {} });
    expect(stale.detail).toContain("the routine's stored issue template has this problem");
    expect(stale.detail).toContain('issueTemplate.originId is "routine:plan-next-week"');
    expect(stale.detail).toContain("manifest is already fixed");
    expect(stale.detail).not.toContain("Fix the plugin manifest");
    // A stored template that follows the rule is not the cause, whatever the manifest says.
    expect(routineFailedCheck({ ...base, template: { surfaceVisibility: "plugin_operation", originId: "routine:x" }, declared: { originId: "routine:x" } }).detail).not.toContain("Likely cause");
    expect(routineFailedCheck({ ...base, template: null, declared: { originId: "routine:x" } }).detail).not.toContain("Likely cause");
    // Binding unreadable: fall back to the manifest.
    expect(routineFailedCheck({ ...base, declared: { originId: "routine:x" } }).detail).toContain("Fix the plugin manifest");
  });

  it("says the reason is on the routine's page when the cause is not known", () => {
    const check = routineFailedCheck({ routineKey: "weekly", title: "Weekly retro", pluginTitle: "Cockpit", routineId: null, at: FIRED, template: { surfaceVisibility: "plugin_operation", originId: "routine:weekly" } });
    expect(check.detail).toContain("The reason is in the routine's run history");
    expect(check.detail).toContain("A paused project makes the host skip the routine's runs too");
    expect(check.detail).not.toContain("Likely cause");
    expect(check.href).toBe("/routines");
  });
});

interface FakeRoutine extends RoutineRunState {
  id: string;
  title: string;
}

function routineCtx(options: {
  declared?: Array<{ routineKey: string; title: string; issueTemplate?: unknown }> | null;
  rows?: Record<string, FakeRoutine | null>;
  failOn?: string;
  capability?: boolean;
  /** Project rows by id; a missing id throws like a refused call. Omit for a plugin without `projects.read`. */
  projects?: Record<string, { pausedAt: string | null }>;
}) {
  const emitted: Array<{ name: string; payload: any }> = [];
  const info = vi.fn();
  const declared = options.declared === null ? undefined : options.declared ?? [{ routineKey: "daily", title: "Daily" }];
  const ctx = {
    manifest: { id: "partnersinbiz.seo", displayName: "SEO", ...(declared ? { routines: declared } : {}) },
    ...(options.capability === false
      ? {}
      : {
          routines: {
            managed: {
              get: vi.fn(async (key: string) => {
                if (key === options.failOn) throw new Error("host unavailable");
                const row = options.rows?.[key] ?? null;
                return { routineId: row?.id ?? null, routine: row, status: row ? "resolved" : "missing" };
              }),
            },
          },
        }),
    ...(options.projects
      ? {
          projects: {
            get: vi.fn(async (id: string) => {
              const project = options.projects![id];
              if (!project) throw new Error("project refused");
              return { id, ...project };
            }),
          },
        }
      : {}),
    events: { emit: vi.fn(async (name: string, _companyId: string, payload: unknown) => void emitted.push({ name, payload })) },
    logger: { info },
  } as unknown as PluginContext;
  return { ctx, emitted, info };
}

describe("routineHealth", () => {
  it("returns a check per failing declared routine, none for healthy or missing ones", async () => {
    const { ctx } = routineCtx({
      declared: [
        { routineKey: "daily", title: "Run today's SEO", issueTemplate: { originId: "routine:seo-run-today" } },
        { routineKey: "weekly", title: "Weekly SEO review" },
        { routineKey: "absent", title: "Not created" },
      ],
      rows: {
        daily: { id: "r-d", title: "Run today's SEO", ...failedRow() },
        weekly: { id: "r-w", title: "Weekly SEO review", ...failedRow({ lastEnqueuedAt: FIRED }) },
      },
    });
    const checks = await routineHealth(ctx, "c1");
    expect(checks.map((c) => c.key)).toEqual(["routine:daily"]);
    expect(checks[0]!.title).toBe('SEO routine "Run today\'s SEO" failed its last run');
    expect(checks[0]!.detail).toContain("routine:seo-run-today");
  });

  it("names the stored template's cause and the assignee, and falls back to the manifest when the binding is not there", async () => {
    const { ctx } = routineCtx({
      declared: [
        { routineKey: "plan", title: "Weekly plan", issueTemplate: { surfaceVisibility: "plugin_operation" } },
        { routineKey: "run", title: "Run today", issueTemplate: { originId: "routine:run" } },
      ],
      rows: {
        plan: { id: "r-p", title: "Weekly plan", ...failedRow(), assigneeAgentId: "agent-gm", managedByPlugin: { defaultsJson: { issueTemplate: { originId: "routine:plan" } } } },
        run: { id: "r-r", title: "Run today", ...failedRow() },
      },
    });
    const [plan, run] = await routineHealth(ctx, "c1");
    expect(plan!.detail).toContain("stored issue template has this problem");
    expect(plan!.detail).toContain("assigned to agent agent-gm");
    expect(run!.detail).toContain("Fix the plugin manifest");
  });

  it("leaves out a routine whose project is paused (the host skips it), keeps it when the project is live or unreadable", async () => {
    const rows = { daily: { id: "r-d", title: "Daily", ...failedRow(), projectId: "p-1" } };
    expect(await routineHealth(routineCtx({ rows, projects: { "p-1": { pausedAt: "2026-10-01T00:00:00.000Z" } } }).ctx, "c1")).toEqual([]);
    expect((await routineHealth(routineCtx({ rows, projects: { "p-1": { pausedAt: null } } }).ctx, "c1")).map((c) => c.key)).toEqual(["routine:daily"]);
    // No projects client (no projects.read), or a refused call: not known to be paused, so it is reported.
    expect((await routineHealth(routineCtx({ rows }).ctx, "c1")).map((c) => c.key)).toEqual(["routine:daily"]);
    expect((await routineHealth(routineCtx({ rows, projects: {} }).ctx, "c1")).map((c) => c.key)).toEqual(["routine:daily"]);
  });

  it("gives nothing for a plugin with no routines or no routines capability, and survives a failing host call", async () => {
    expect(await routineHealth(routineCtx({ declared: null }).ctx, "c1")).toEqual([]);
    expect(await routineHealth(routineCtx({ declared: [] }).ctx, "c1")).toEqual([]);
    expect(await routineHealth(routineCtx({ capability: false }).ctx, "c1")).toEqual([]);
    const broken = routineCtx({ declared: [{ routineKey: "a", title: "A" }, { routineKey: "b", title: "B" }], rows: { b: { id: "r-b", title: "B", ...failedRow() } }, failOn: "a" });
    expect((await routineHealth(broken.ctx, "c1")).map((c) => c.key)).toEqual(["routine:b"]);
    expect(broken.info).toHaveBeenCalledWith("Routine health check skipped", { routineKey: "a", error: "host unavailable" });
  });
});

describe("publishing a snapshot carries the routine checks", () => {
  const failing = { daily: { id: "r-d", title: "Run today's SEO", ...failedRow() } };

  it("adds the routine failure to the snapshot every plugin publishes", async () => {
    const { ctx, emitted } = routineCtx({ rows: failing });
    const snapshot = emptySnapshot("partnersinbiz.seo", "SEO");
    snapshot.health.push({ key: "job:daily", title: "Daily SEO run", status: "ok" });
    await publishCockpitSnapshot(ctx, "c1", snapshot);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe("cockpit.snapshot");
    expect(emitted[0]!.payload.health.map((c: { key: string }) => c.key)).toEqual(["job:daily", "routine:daily"]);
    // The caller's snapshot is not mutated.
    expect(snapshot.health).toHaveLength(1);
  });

  it("keeps a check the plugin already reports and publishes as before when nothing fails", async () => {
    const own = routineCtx({ rows: failing });
    const snapshot = emptySnapshot("partnersinbiz.seo", "SEO");
    snapshot.health.push({ key: "routine:daily", title: "Mine", status: "warn" });
    expect((await withRoutineHealth(own.ctx, "c1", snapshot)).health).toEqual(snapshot.health);
    const healthy = routineCtx({ rows: { daily: { id: "r", title: "Daily", ...failedRow({ lastEnqueuedAt: FIRED }) } } });
    const plain = emptySnapshot("partnersinbiz.seo", "SEO");
    await publishCockpitSnapshot(healthy.ctx, "c1", plain);
    expect(healthy.emitted[0]!.payload.health).toEqual([]);
  });

  it("still publishes for a context with no manifest or routines client (older plugin tests)", async () => {
    const emitted: unknown[] = [];
    const ctx = { events: { emit: async (_n: string, _c: string, p: unknown) => void emitted.push(p) }, logger: { info: vi.fn() } } as unknown as PluginContext;
    await publishCockpitSnapshot(ctx, "c1", emptySnapshot("p", "P"));
    expect(emitted).toHaveLength(1);
  });
});
