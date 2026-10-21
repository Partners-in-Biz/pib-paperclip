/**
 * Edge watch model: pure logic tests for edge announcement.
 */

import { describe, expect, it } from "vitest";
import { decideEdges, renderEdgeComment, shouldPostToIssue, type EdgeCandidate, type EdgeMarkerComment } from "../src/edge-watch-model.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const BEFORE = new Date(NOW.getTime() - 3600000).toISOString(); // 1 hour before
const AFTER = new Date(NOW.getTime() + 3600000).toISOString(); // 1 hour after

describe("edge-watch-model", () => {
  describe("decideEdges", () => {
    it("skips if disabled", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: false });
      expect(result).toEqual([]);
    });

    it("includes owner-assigned blocker", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: "user-1",
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([{ blockedId: "blocked-1", blockerId: "blocker-1" }]);
    });

    it("includes unassigned blocker", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([{ blockedId: "blocked-1", blockerId: "blocker-1" }]);
    });

    it("skips agent-assigned blocker", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: "agent-1",
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([]);
    });

    it("skips terminal blocked issue", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "done",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
        {
          blockedId: "blocked-2",
          blockedIdentifier: "PAR-102",
          blockedStatus: "cancelled",
          blockerId: "blocker-2",
          blockerIdentifier: "PAR-103",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([]);
    });

    it("skips terminal blocker", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "done",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([]);
    });

    it("skips edge older than cutoff", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: BEFORE,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([]);
    });

    it("handles multiple edges", () => {
      const candidates: EdgeCandidate[] = [
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-1",
          blockerIdentifier: "PAR-101",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
        {
          blockedId: "blocked-1",
          blockedIdentifier: "PAR-100",
          blockedStatus: "todo",
          blockerId: "blocker-2",
          blockerIdentifier: "PAR-102",
          blockerStatus: "todo",
          blockerAssigneeAgentId: "agent-1",
          blockerAssigneeUserId: null,
          createdAt: AFTER,
        },
        {
          blockedId: "blocked-2",
          blockedIdentifier: "PAR-103",
          blockedStatus: "todo",
          blockerId: "blocker-3",
          blockerIdentifier: "PAR-104",
          blockerStatus: "todo",
          blockerAssigneeAgentId: null,
          blockerAssigneeUserId: "user-1",
          createdAt: AFTER,
        },
      ];

      const result = decideEdges(candidates, { cutoff: NOW.toISOString(), enabled: true });
      expect(result).toEqual([
        { blockedId: "blocked-1", blockerId: "blocker-1" },
        { blockedId: "blocked-2", blockerId: "blocker-3" },
      ]);
    });
  });

  describe("shouldPostToIssue", () => {
    it("posts when marker is missing", () => {
      const comments: EdgeMarkerComment[] = [
        { id: "c1", body: "Some other comment" },
      ];

      const result = shouldPostToIssue(comments, "blocked-1", "blocker-1");
      expect(result).toBe(true);
    });

    it("skips when marker is present", () => {
      const comments: EdgeMarkerComment[] = [
        { id: "c1", body: "Some comment\n<!-- edge-watch:blocked-1-blocker-1 -->\nMore text" },
      ];

      const result = shouldPostToIssue(comments, "blocked-1", "blocker-1");
      expect(result).toBe(false);
    });

    it("handles empty comments", () => {
      const comments: EdgeMarkerComment[] = [];

      const result = shouldPostToIssue(comments, "blocked-1", "blocker-1");
      expect(result).toBe(true);
    });
  });

  describe("renderEdgeComment", () => {
    it("renders for owner-assigned blocker", () => {
      const body = renderEdgeComment(
        "blocked-1",
        "PAR-100",
        "blocker-1",
        "PAR-101",
        null,
        "user-1",
      );

      expect(body).toContain("This issue will now wait for PAR-101");
      expect(body).toContain("PAR-100 is blocked by it");
      expect(body).toContain("waiting on a person (owner-assigned)");
      expect(body).toContain("<!-- edge-watch:blocked-1-blocker-1 -->");
    });

    it("renders for unassigned blocker", () => {
      const body = renderEdgeComment(
        "blocked-1",
        "PAR-100",
        "blocker-1",
        "PAR-101",
        null,
        null,
      );

      expect(body).toContain("This issue will now wait for PAR-101");
      expect(body).toContain("unassigned");
      expect(body).toContain("<!-- edge-watch:blocked-1-blocker-1 -->");
    });

    it("falls back to issue IDs when identifiers are null", () => {
      const body = renderEdgeComment(
        "blocked-1",
        null,
        "blocker-1",
        null,
        null,
        null,
      );

      expect(body).toContain("blocker-1");
      expect(body).toContain("blocked-1");
      expect(body).toContain("<!-- edge-watch:blocked-1-blocker-1 -->");
    });
  });
});
