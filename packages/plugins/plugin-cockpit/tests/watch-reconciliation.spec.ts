import { describe, expect, it } from "vitest";
import type { ReconciliationRun } from "../src/watch-model.js";
import { executionReconciliationDecisions } from "../src/watch-model.js";

const run = (id: string, issueId: string, minutesAgo: number): ReconciliationRun => ({
  issueId,
  identifier: "PAR-1",
  title: "Issue",
  runId: id,
  runTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  error: "reconciliation needed",
  assigneeAgentId: "agent-1",
});

describe("execution reconciliation (pure)", () => {
  it("empty runs → no decisions", () => {
    const d = executionReconciliationDecisions([], new Set(), new Set(), new Set());
    expect(d).toEqual([]);
  });

  it("one run, not woken → wake", () => {
    const d = executionReconciliationDecisions([run("r1", "i1", 10)], new Set(), new Set(), new Set());
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ issueId: "i1", action: "wake", runId: "r1" });
  });

  it("two runs for issue, older woken, newer not → escalate", () => {
    const runs = [run("r1", "i1", 30), run("r2", "i1", 10)];
    const woken = new Set(["r1"]);
    const d = executionReconciliationDecisions(runs, woken, new Set(), new Set());
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ issueId: "i1", action: "escalate", runId: "r2" });
  });

  it("any run already escalated → no decision", () => {
    const runs = [run("r1", "i1", 30), run("r2", "i1", 10)];
    const woken = new Set(["r1"]);
    const escalated = new Set(["r2"]);
    const d = executionReconciliationDecisions(runs, woken, new Set(), escalated);
    expect(d).toEqual([]);
  });

  it("marker exists for issue → no decision", () => {
    const d = executionReconciliationDecisions([run("r1", "i1", 10)], new Set(), new Set(["i1"]), new Set());
    expect(d).toEqual([]);
  });

  it("multi-issue mix orders by run time desc and respects cap", () => {
    const runs = [
      run("r1", "i1", 30), // oldest, will be dropped due to cap
      run("r2", "i2", 25),
      run("r3", "i3", 20),
      run("r4", "i4", 15),
      run("r5", "i5", 10),
      run("r6", "i6", 5), // newest
    ];
    const d = executionReconciliationDecisions(runs, new Set(), new Set(), new Set());
    expect(d).toHaveLength(5);
    // Ordered by recency (newest first), capped at WATCH.perRule of 5
    expect(d.map((x) => x.issueId)).toEqual(["i6", "i5", "i4", "i3", "i2"]);
    expect(d.map((x) => x.action)).toEqual(["wake", "wake", "wake", "wake", "wake"]);
  });

  it("null identifier and title are preserved", () => {
    const nullRun: ReconciliationRun = {
      issueId: "i1",
      identifier: null,
      title: null,
      runId: "r1",
      runTime: new Date(Date.now() - 10 * 60_000).toISOString(),
      error: "Something broke",
      assigneeAgentId: "agent-1",
    };
    const d = executionReconciliationDecisions([nullRun], new Set(), new Set(), new Set());
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      issueId: "i1",
      assigneeAgentId: "agent-1",
      action: "wake",
      runId: "r1",
    });
  });
});
