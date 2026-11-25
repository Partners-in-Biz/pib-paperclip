import { describe, expect, it } from "vitest";
import type { PlanningCanvasComment } from "@paperclipai/shared";
import { summarizeThreads } from "./useCanvasComments";

function comment(over: Partial<PlanningCanvasComment>): PlanningCanvasComment {
  return {
    id: "c", companyId: "co", boardId: "b", itemKey: "n1", parentId: null, body: "hi",
    authorUserId: "u2", authorAgentId: null, linkedIssueId: null, mentionState: {},
    resolvedAt: null, resolvedByUserId: null, createdAt: "2026-11-23T10:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z", deletedAt: null, ...over,
  };
}

describe("summarizeThreads", () => {
  it("counts per node, marks unread from others, and groups the board thread under an empty key", () => {
    const out = summarizeThreads(
      [
        comment({ id: "1" }),
        comment({ id: "2", parentId: "1", authorAgentId: "a1", authorUserId: null, createdAt: "2026-11-23T10:05:00.000Z" }),
        comment({ id: "3", itemKey: null }),
      ],
      {},
      "u1",
    );
    expect(out.get("n1")).toMatchObject({ count: 2, openCount: 1, unread: true, latestAt: "2026-11-23T10:05:00.000Z" });
    expect(out.get("")).toMatchObject({ count: 1 });
  });

  it("clears unread once seen, ignores own and deleted comments, and reports resolved threads", () => {
    const out = summarizeThreads(
      [
        comment({ id: "1", resolvedAt: "2026-11-23T10:01:00.000Z" }),
        comment({ id: "2", authorUserId: "u1", createdAt: "2026-11-23T11:00:00.000Z" }),
        comment({ id: "3", deletedAt: "2026-11-23T12:00:00.000Z", createdAt: "2026-11-23T12:00:00.000Z" }),
      ],
      { n1: "2026-11-23T10:00:00.000Z" },
      "u1",
    );
    // Comment 1 (10:00) is not newer than the seen mark; 2 is mine; 3 is deleted.
    expect(out.get("n1")).toMatchObject({ count: 2, openCount: 1, unread: false });
  });
});
