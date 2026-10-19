/**
 * Reconciliation watch tests: pure decision logic with fixture runs,
 * woken row tracking via repairs, once-only wake with escalate on second,
 * and success clearing state. Mocks wakeIssue and escalate.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReconciliationRun, ReconciliationIssue } from "../src/watch-model.js";
import { executionReconciliationDecisions, executionReconciliationChecks } from "../src/watch-model.js";

// Mock kit before importing watch
vi.mock("@partnersinbiz/pib-plugin-kit", async () => {
  const actual = await vi.importActual<typeof import("@partnersinbiz/pib-plugin-kit")>("@partnersinbiz/pib-plugin-kit");
  return {
    ...actual,
    wakeIssue: vi.fn(),
    escalate: vi.fn(),
  };
});

import { readReconciliationRuns, readWokenRunIds, readMarkerIssues, applyReconciliation } from "../src/watch.js";
import { createEnv } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const COMPANY = "test-company";
const NOW = "2026-10-19T10:00:00.000Z";

function setup() {
  const fake = fakeCtx({ savedConfigs: { [COMPANY]: {} } });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

type S = ReturnType<typeof setup>;

const run = (issueId: string, identifier: string, title: string, runId: string, minutesAgo: number, error: string | null = null, assigneeAgentId: string = "agent-1"): ReconciliationRun => ({
  issueId,
  identifier,
  title,
  runId,
  runTime: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
  error,
  assigneeAgentId,
});

describe("execution reconciliation detection (pure)", () => {
  it("detects no issues when no reconciliation runs exist", () => {
    const decisions = executionReconciliationDecisions([], new Set(), new Set());
    expect(decisions).toEqual([]);
  });

  it("marks a single reconciliation run as 'wake' when not yet woken", () => {
    const runs = [run("issue-1", "PAR-100", "Test issue", "run-1", 10, "Conversation reset required")];
    const decisions = executionReconciliationDecisions(runs, new Set(), new Set());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      issueId: "issue-1",
      action: "wake",
      runId: "run-1",
      error: "Conversation reset required",
    });
  });

  it("marks a second run as 'escalate' when the first is already woken", () => {
    const runs = [
      run("issue-1", "PAR-100", "Test issue", "run-1", 30, "Conversation reset"),
      run("issue-1", "PAR-100", "Test issue", "run-2", 10, "Still not working"),
    ];
    const wakenRunIds = new Set(["run-1"]);
    const decisions = executionReconciliationDecisions(runs, wakenRunIds, new Set());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      issueId: "issue-1",
      action: "escalate",
      runId: "run-2", // should be the newest
      error: "Still not working",
    });
  });

  it("shows nothing when an active escalation marker exists for the issue", () => {
    const runs = [run("issue-1", "PAR-100", "Test issue", "run-1", 10, "Reconciliation needed")];
    const markerIssueIds = new Set(["issue-1"]);
    const decisions = executionReconciliationDecisions(runs, new Set(), markerIssueIds);
    expect(decisions).toEqual([]);
  });

  it("sorts by newest run first and caps at 5 issues", () => {
    const runs: ReconciliationRun[] = [];
    for (let i = 0; i < 7; i += 1) {
      runs.push(run(`issue-${i}`, `PAR-${100 + i}`, `Issue ${i}`, `run-${i}`, 100 - i * 10, `Error ${i}`));
    }
    const decisions = executionReconciliationDecisions(runs, new Set(), new Set());
    expect(decisions).toHaveLength(5);
    // Most recent runs first
    expect(decisions[0]!.runId).toBe("run-6");
    expect(decisions[1]!.runId).toBe("run-5");
  });

  it("converts decisions to health checks with correct fix text", () => {
    const decisions: ReconciliationIssue[] = [
      {
        issueId: "issue-1",
        identifier: "PAR-100",
        title: "Test issue",
        assigneeAgentId: "agent-1",
        action: "wake",
        runId: "run-1",
        error: "Conversation reset",
      },
      {
        issueId: "issue-2",
        identifier: "PAR-101",
        title: "Another issue",
        assigneeAgentId: "agent-2",
        action: "escalate",
        runId: "run-2",
        error: "Still failing",
      },
    ];
    const runs = [
      run("issue-1", "PAR-100", "Test issue", "run-1", 10, "Conversation reset", "agent-1"),
      run("issue-2", "PAR-101", "Another issue", "run-2", 5, "Still failing", "agent-2"),
    ];
    const agents = new Map([
      ["agent-1", { id: "agent-1", name: "Agent One", status: "idle", urlKey: "agent-1" }],
      ["agent-2", { id: "agent-2", name: "Agent Two", status: "active" }],
    ]);
    const checks = executionReconciliationChecks(decisions, runs, agents);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      key: "execution-reconciliation:issue-1",
      status: "warn",
      title: expect.stringContaining("PAR-100"),
      fix: expect.stringContaining("Wake the agent"),
    });
    expect(checks[1]).toMatchObject({
      key: "execution-reconciliation:issue-2",
      status: "warn",
      title: expect.stringContaining("PAR-101"),
      fix: expect.stringContaining("failed again"),
    });
  });
});

describe("execution reconciliation detection (with repairs)", () => {
  it("applies wake action for first reconciliation run", async () => {
    const s = setup();
    const issueId = "issue-abc";
    const runId1 = "run-1";

    // Mock wakeIssue to succeed
    const { wakeIssue } = await import("@partnersinbiz/pib-plugin-kit");
    vi.mocked(wakeIssue).mockResolvedValue(true);

    // First run triggers wake
    await applyReconciliation(s.env, COMPANY, [
      {
        issueId,
        assigneeAgentId: "agent-1",
        action: "wake",
        runId: runId1,
        error: "Reconciliation needed",
      },
    ]);

    // Check that wakeIssue was called
    expect(vi.mocked(wakeIssue)).toHaveBeenCalledWith(
      expect.anything(),
      issueId,
      COMPANY,
      expect.stringContaining("Reconciliation"),
    );
  });

  it("applies escalate action for second reconciliation run", async () => {
    const s = setup();
    const issueId = "issue-abc";
    const runId2 = "run-2";

    // Mock escalate to succeed
    const { escalate } = await import("@partnersinbiz/pib-plugin-kit");
    vi.mocked(escalate).mockResolvedValue({ id: "unblock-2", level: 2, created: true });

    // Second run triggers escalate
    await applyReconciliation(s.env, COMPANY, [
      {
        issueId,
        assigneeAgentId: "agent-1",
        action: "escalate",
        runId: runId2,
        error: "Still failing",
      },
    ]);

    // Check that escalate was called
    expect(vi.mocked(escalate)).toHaveBeenCalledWith(
      expect.anything(),
      issueId,
      expect.stringMatching(/[Rr]econciliation/),
      expect.objectContaining({ companyId: COMPANY }),
    );
  });
});
