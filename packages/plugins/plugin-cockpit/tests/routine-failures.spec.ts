/**
 * Routine failures tests: first failure wakes once, repeat tick same failure
 * does not re-wake, second distinct failure escalates, healthy firing resets counter.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit";

// Mock routineHealth from the kit before importing routine-failures.js
vi.mock("@partnersinbiz/pib-plugin-kit", async () => {
  const actual = await vi.importActual<typeof import("@partnersinbiz/pib-plugin-kit")>("@partnersinbiz/pib-plugin-kit");
  return {
    ...actual,
    routineHealth: vi.fn(),
    escalate: vi.fn(),
  };
});

import { routineFailureTick } from "../src/routine-failures.js";
import { createEnv } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";
import * as kitModule from "@partnersinbiz/pib-plugin-kit";

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";

function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: {} } });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

type S = ReturnType<typeof setup>;

const mockRoutineHealth = vi.mocked(kitModule.routineHealth);
const mockEscalate = vi.mocked(kitModule.escalate);

beforeEach(() => {
  vi.clearAllMocks();
  mockRoutineHealth.mockResolvedValue([]);
});

describe("routine failure detection and escalation", () => {
  it("First failure wakes the assignee once", async () => {
    const s = setup();
    const now = new Date(NOW);
    const since = now.toISOString();

    // Mock a failing routine
    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since,
      } as HealthCheck,
    ]);

    // Mock the routine details
    s.env.ctx.routines.managed.reconcile("cockpit-daily-operations", A, { assigneeAgentId: "agent-1" });

    const counts = await routineFailureTick(s.env, A);

    expect(counts.routine_wake).toBe(1);
    expect(counts.routine_escalated).toBe(0);
    expect(s.wakeReasons.length).toBe(1);
    expect(s.wakeReasons[0].reason).toContain("cockpit-daily-operations");
  });

  it("Same failure on next tick does not re-wake", async () => {
    const s = setup();
    const now = new Date(NOW);
    const since = now.toISOString();

    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since,
      } as HealthCheck,
    ]);

    s.env.ctx.routines.managed.reconcile("cockpit-daily-operations", A, { assigneeAgentId: "agent-1" });

    // First tick: wake
    const counts1 = await routineFailureTick(s.env, A);
    expect(counts1.routine_wake).toBe(1);
    const issueId1 = s.issues.get([...s.issues.keys()][0]!)?.id;

    // Second tick with same since: no re-wake
    const counts2 = await routineFailureTick(s.env, A);
    expect(counts2.routine_wake).toBe(0);
    expect(counts2.routine_escalated).toBe(0);
    expect(s.wakeReasons.length).toBe(1); // Still only one wake
    expect(s.issues.size).toBe(1); // Still only one issue
  });

  it("Second distinct failure (different since) escalates", async () => {
    const s = setup();
    const now = new Date(NOW);
    const since1 = now.toISOString();
    const since2 = new Date(now.getTime() + 3600000).toISOString(); // 1 hour later

    s.env.ctx.routines.managed.reconcile("cockpit-daily-operations", A, { assigneeAgentId: "agent-1" });

    // First tick: first failure wakes
    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since: since1,
      } as HealthCheck,
    ]);

    const counts1 = await routineFailureTick(s.env, A);
    expect(counts1.routine_wake).toBe(1);

    // Second tick: different since (second failure) escalates
    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since: since2,
      } as HealthCheck,
    ]);

    mockEscalate.mockResolvedValue({ id: "unblock-1", level: 1, created: true });

    const counts2 = await routineFailureTick(s.env, A);
    expect(counts2.routine_wake).toBe(0);
    expect(counts2.routine_escalated).toBe(1);
    expect(mockEscalate).toHaveBeenCalled();
    const escalateCall = mockEscalate.mock.calls[0];
    expect(escalateCall[2]).toBe("routine_failed");
  });

  it("Healthy routine resets counter for next failure", async () => {
    const s = setup();
    const now = new Date(NOW);
    const since1 = now.toISOString();
    const since2 = new Date(now.getTime() + 7200000).toISOString(); // 2 hours later

    s.env.ctx.routines.managed.reconcile("cockpit-daily-operations", A, { assigneeAgentId: "agent-1" });

    // First tick: routine fails, wakes
    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since: since1,
      } as HealthCheck,
    ]);

    const counts1 = await routineFailureTick(s.env, A);
    expect(counts1.routine_wake).toBe(1);

    // Second tick: routine is healthy (no failures reported)
    mockRoutineHealth.mockResolvedValue([]);

    const counts2 = await routineFailureTick(s.env, A);
    expect(counts2.routine_wake).toBe(0);
    expect(counts2.routine_escalated).toBe(0);

    // Third tick: routine fails again (different since) - should wake, not escalate
    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since: since2,
      } as HealthCheck,
    ]);

    const counts3 = await routineFailureTick(s.env, A);
    expect(counts3.routine_wake).toBe(1); // Wakes again, counter reset
    expect(counts3.routine_escalated).toBe(0); // No escalate
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it("Multiple routines tracked independently", async () => {
    const s = setup();
    const now = new Date(NOW);
    const since = now.toISOString();

    s.env.ctx.routines.managed.reconcile("cockpit-daily-operations", A, { assigneeAgentId: "agent-1" });
    s.env.ctx.routines.managed.reconcile("cockpit-weekly-retro", A, { assigneeAgentId: "agent-2" });

    mockRoutineHealth.mockResolvedValue([
      {
        key: "routine:cockpit-daily-operations",
        title: "Daily operations review failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since,
      } as HealthCheck,
      {
        key: "routine:cockpit-weekly-retro",
        title: "Weekly retro failed",
        status: "bad",
        detail: "The routine fired but created no issue.",
        since,
      } as HealthCheck,
    ]);

    const counts = await routineFailureTick(s.env, A);

    expect(counts.routine_wake).toBe(2);
    expect(counts.routine_escalated).toBe(0);
    expect(s.issues.size).toBe(2);
  });
});
