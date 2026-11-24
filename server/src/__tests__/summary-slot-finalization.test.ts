import { describe, expect, it, vi } from "vitest";
import {
  finalizeSummarySlotsForTerminalIssue,
  finalizeSummarySlotsForTerminalRun,
} from "../services/summary-slot-finalization.js";

function createUpdateMock(returningRows: Array<{ id: string }> = [{ id: "slot-1" }]) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { update, set, where, returning };
}

function createSelectMock(results: Array<Array<{ id: string }>>) {
  let callIndex = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = results[callIndex++] ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
  return { select };
}

describe("finalizeSummarySlotsForTerminalIssue", () => {
  it("marks generating slots failed when the generation issue is blocked", async () => {
    const { update, set } = createUpdateMock();
    const updated = await finalizeSummarySlotsForTerminalIssue({ update } as any, {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAR-14067",
      title: "Summarize project",
      status: "blocked",
    });

    expect(updated).toEqual([{ id: "slot-1" }]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failureReason: "Summary generation task PAR-14067: Summarize project was blocked before writing a summary.",
      }),
    );
  });

  it("ignores active in_progress issues", async () => {
    const { update } = createUpdateMock();
    const updated = await finalizeSummarySlotsForTerminalIssue({ update } as any, {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAR-14067",
      title: "Summarize project",
      status: "in_progress",
    });

    expect(updated).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("finalizeSummarySlotsForTerminalRun", () => {
  it("marks generating slots failed when a run fails and no other active run exists", async () => {
    const { select } = createSelectMock([[{ id: "slot-1" }], []]);
    const { update, set } = createUpdateMock();

    const updated = await finalizeSummarySlotsForTerminalRun({ select, update } as any, {
      id: "run-1",
      companyId: "company-1",
      status: "failed",
      issueId: "issue-1",
      error: "Provider rate limited",
    });

    expect(updated).toEqual([{ id: "slot-1" }]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failureReason: "Summary generation run failed before writing a summary (Provider rate limited).",
      }),
    );
  });

  it("does not fail the slot when another queued or running run exists for the same issue", async () => {
    const { select } = createSelectMock([[{ id: "slot-1" }], [{ id: "run-2" }]]);
    const { update } = createUpdateMock();

    const updated = await finalizeSummarySlotsForTerminalRun({ select, update } as any, {
      id: "run-1",
      companyId: "company-1",
      status: "failed",
      contextSnapshot: { issueId: "issue-1" },
    });

    expect(updated).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("no-ops when no generating slot is linked to the run issue", async () => {
    const { select } = createSelectMock([[]]);
    const { update } = createUpdateMock();

    const updated = await finalizeSummarySlotsForTerminalRun({ select, update } as any, {
      id: "run-1",
      companyId: "company-1",
      status: "timed_out",
      issueId: "issue-1",
    });

    expect(updated).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
