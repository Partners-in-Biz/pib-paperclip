import { afterEach, describe, expect, it, vi } from "vitest";
import { cockpitSnapshot } from "../src/cockpit.js";
import { parseRoutineReport, routineReport, saveRoutineReport, scheduleTriggersOn } from "../src/routine-state.js";
import { keepProposedTime, reasonText, whenText } from "../src/schedule.js";
import { ROUTINE_SWITCH_ON_PATH, routineItem } from "../src/setup-status.js";
import { parseRoutine, routineReportParams, routineRunning, scheduleOn, switchOnRoutine } from "../src/ui/routine-client.js";
import { timeLabel } from "../src/ui/time.js";
import { fakeCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("weekly routine: active and its trigger on", () => {
  const routine = { id: "r1", status: "active", assigneeAgentId: "a1" };

  it("the setup item is done only when the page saw the trigger on", () => {
    expect(routineItem({ ok: true, routine, triggersOn: true, agentLinked: true })).toMatchObject({ status: "done", href: "/routines/r1" });
    expect(routineItem({ ok: true, routine, triggersOn: false, agentLinked: true })).toMatchObject({ status: "missing", href: ROUTINE_SWITCH_ON_PATH, hrefLabel: "Switch it on" });
    expect(routineItem({ ok: true, routine, triggersOn: null, agentLinked: true })).toMatchObject({ status: "unknown", href: "/social" });
    expect(routineItem({ ok: true, routine: { ...routine, status: "paused" }, triggersOn: true, agentLinked: true })).toMatchObject({ status: "missing", href: ROUTINE_SWITCH_ON_PATH });
    expect(routineItem({ ok: true, routine: null, triggersOn: null, agentLinked: false })).toMatchObject({ status: "blocked", blockedBy: ["agent"] });
    expect(routineItem({ ok: false, error: "boom", routine: null, triggersOn: null, agentLinked: true })).toMatchObject({ status: "unknown" });
  });

  it("the worker keeps the page's report for the routine it manages only", async () => {
    const state = new Map<string, unknown>();
    const ctx = fakeCtx({
      state: { get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v) },
      routines: { managed: { get: vi.fn(async () => ({ routineId: "r1", routine: { id: "r1", status: "active" } })) } },
    });
    const triggers = [{ id: "t1", kind: "schedule", enabled: true, archived: false }, { id: "t2", kind: "schedule", enabled: false, archived: true }];
    const report = await saveRoutineReport(ctx, "co", "plan-next-week", { routineId: "r1", status: "active", triggers });
    expect(report).toMatchObject({ routineId: "r1", status: "active", triggersOn: true });
    expect(await routineReport(ctx, "co", "plan-next-week", "r1")).toMatchObject({ triggersOn: true });
    // A report about an older routine does not count.
    expect(await routineReport(ctx, "co", "plan-next-week", "r2")).toBeNull();
    await expect(saveRoutineReport(ctx, "co", "plan-next-week", { routineId: "someone-else", triggers })).rejects.toThrow(/not the Social plugin's routine/);
    expect(() => parseRoutineReport({ triggers: [] })).toThrow(/routineId/);
    expect(scheduleTriggersOn([])).toBe(false);
    expect(scheduleTriggersOn([{ kind: "webhook", enabled: true, archived: false }])).toBe(false);
  });
});

describe("routine client (page, as the board user)", () => {
  const detail = { id: "r1", status: "paused", triggers: [{ id: "t1", kind: "schedule", enabled: false, archived: false }, { id: "t0", kind: "schedule", enabled: false, archived: true }] };

  it("parses the host's routine detail", () => {
    const info = parseRoutine(detail)!;
    expect(info.triggers).toHaveLength(2);
    expect(scheduleOn(info)).toBe(false);
    expect(routineRunning(info)).toBe(false);
    expect(routineRunning({ ...info, status: "active", triggers: [{ id: "t1", kind: "schedule", enabled: true, archived: false }] })).toBe(true);
    expect(parseRoutine(null)).toBeNull();
    expect(routineReportParams(info)).toEqual({ routineId: "r1", status: "paused", triggers: info.triggers });
  });

  it("switch on: routine active, live schedule triggers on (archived ones left alone)", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let current = structuredClone(detail);
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (method === "PATCH" && url === "/api/routines/r1") current = { ...current, status: body.status };
      if (method === "PATCH" && url.startsWith("/api/routine-triggers/")) current = { ...current, triggers: current.triggers.map((t) => (url.endsWith(t.id) ? { ...t, enabled: body.enabled } : t)) };
      return new Response(JSON.stringify(current), { status: 200 });
    });
    const after = await switchOnRoutine(parseRoutine(detail)!);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([
      ["/api/routines/r1", { status: "active" }],
      ["/api/routine-triggers/t1", { enabled: true }],
    ]);
    expect(routineRunning(after)).toBe(true);
  });

  it("a refused switch surfaces the host's error", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Missing permission: tasks:assign" }), { status: 403 }));
    await expect(switchOnRoutine(parseRoutine(detail)!)).rejects.toThrow("Missing permission: tasks:assign");
  });
});

describe("approval and proposed times", () => {
  it("keeps a time only when it is still ahead", () => {
    const now = new Date("2026-09-27T10:00:00Z");
    expect(keepProposedTime("2026-09-27T10:05:00Z", now)).toBe(true);
    expect(keepProposedTime("2026-09-27T10:01:00Z", now)).toBe(false);
    expect(keepProposedTime(null, now)).toBe(false);
    expect(reasonText("invalid", { proposed: null, problems: ["X (PiB): text is too long"] })).toContain("text is too long");
    expect(whenText("2026-10-05T05:30:00.000Z", "Africa/Johannesburg")).toMatch(/07:30/);
  });

  it("the post list says proposed for a draft's time and scheduled once it is scheduled", () => {
    const base = { publishedAt: null, updatedAt: "2026-09-27T08:00:00Z", scheduledAt: "2026-10-05T05:30:00.000Z" };
    expect(timeLabel({ ...base, status: "review" }, "UTC")).toMatch(/^Proposed /);
    expect(timeLabel({ ...base, status: "scheduled" }, "UTC")).toMatch(/^Scheduled /);
    expect(timeLabel({ ...base, status: "approved", scheduledAt: null }, "UTC")).toBe("Approved, no time yet");
  });
});

describe("cockpit team report", () => {
  it("reports the linked Social agent and its status", async () => {
    const ctx = fakeCtx({
      state: { get: vi.fn(async (k: { namespace?: string }) => (k.namespace === "pib-hire" ? { agentId: "a1" } : null)), set: vi.fn() },
      agents: { get: vi.fn(async (id: string) => ({ id, status: "paused", name: "Sam" })), managed: { get: vi.fn(async () => ({ agentId: null })) } },
      events: { emit: vi.fn(), on: vi.fn() },
    });
    const snap = await cockpitSnapshot(ctx, "co");
    expect(snap.team).toEqual([{ role: "social", agentId: "a1", status: "paused" }]);
  });
});
