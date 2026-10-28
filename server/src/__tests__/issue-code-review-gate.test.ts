import { describe, expect, it } from "vitest";
import {
  CODE_REVIEW_REQUIRED_MESSAGE,
  evaluateCodeReviewGate,
  type CodeReviewGateComment,
  type CodeReviewGateInput,
} from "../services/issue-code-review-gate.js";

const REVIEWER_ID = "reviewer-1";
const PR = "https://github.com/Partners-in-Biz/pib-paperclip/pull/42";

function at(minute: number) {
  return new Date(Date.UTC(2026, 9, 28, 10, minute));
}

function comment(authorAgentId: string | null, body: string, minute: number): CodeReviewGateComment {
  return { authorAgentId, body, createdAt: at(minute) };
}

function input(overrides: Partial<CodeReviewGateInput> = {}): CodeReviewGateInput {
  return {
    assignee: { id: "dev-1", role: "Senior Developer", name: "Senior Developer" },
    projectName: "PiB Platform",
    labels: [],
    description: null,
    comments: [comment("dev-1", `PR ${PR}`, 1)],
    codeReviewerAgentIds: new Set([REVIEWER_ID]),
    completedCodeReviewerStage: false,
    ...overrides,
  };
}

describe("evaluateCodeReviewGate", () => {
  it("allows when a Code Reviewer PASS comment is newer than the PR link", () => {
    const result = evaluateCodeReviewGate(
      input({ comments: [comment("dev-1", PR, 1), comment(REVIEWER_ID, "PASS: looks good", 5)] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("accepts the Approved: marker", () => {
    const result = evaluateCodeReviewGate(
      input({ comments: [comment("dev-1", PR, 1), comment(REVIEWER_ID, "Approved: ship it", 5)] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("allows when a completed Code Reviewer review stage exists", () => {
    expect(evaluateCodeReviewGate(input({ completedCodeReviewerStage: true })).allowed).toBe(true);
  });

  it("denies code work with no PASS and names the fix", () => {
    const result = evaluateCodeReviewGate(input());
    expect(result).toEqual({ allowed: false, reason: CODE_REVIEW_REQUIRED_MESSAGE });
    expect(result.reason).toContain("Request Code Reviewer review");
  });

  it("denies when the PASS is older than the latest PR link", () => {
    const result = evaluateCodeReviewGate(
      input({ comments: [comment(REVIEWER_ID, "PASS", 1), comment("dev-1", `new PR ${PR}`, 5)] }),
    );
    expect(result.allowed).toBe(false);
  });

  it("ignores PASS comments from non-reviewers", () => {
    const result = evaluateCodeReviewGate(
      input({ comments: [comment("dev-1", PR, 1), comment("dev-2", "PASS", 5)] }),
    );
    expect(result.allowed).toBe(false);
  });

  it("treats a code-labelled issue without a PR link as code work", () => {
    expect(evaluateCodeReviewGate(input({ labels: ["code"], comments: [] })).allowed).toBe(false);
  });

  it("exempts non-code work (no PR link, no code label)", () => {
    expect(evaluateCodeReviewGate(input({ comments: [comment("dev-1", "done", 1)] })).allowed).toBe(true);
  });

  it("exempts non-engineer assignees", () => {
    const assignee = { id: "pm-1", role: "Planner", name: "Planner" };
    expect(evaluateCodeReviewGate(input({ assignee })).allowed).toBe(true);
  });

  it("lets the Code Reviewer itself close (not an engineer assignee)", () => {
    const assignee = { id: REVIEWER_ID, role: "Code Reviewer", name: "Code Reviewer" };
    expect(evaluateCodeReviewGate(input({ assignee })).allowed).toBe(true);
  });

  it("recognises Arjun and Kai as engineers", () => {
    const assignee = { id: "a-1", role: "general", name: "Arjun" };
    expect(evaluateCodeReviewGate(input({ assignee })).allowed).toBe(false);
  });

  it("exempts the Loyalty Plus project", () => {
    expect(evaluateCodeReviewGate(input({ projectName: "Loyalty Plus" })).allowed).toBe(true);
  });

  it("exempts no-code-review only with a justification comment", () => {
    const labels = ["no-code-review"];
    expect(evaluateCodeReviewGate(input({ labels })).allowed).toBe(false);
    const justified = input({
      labels,
      comments: [comment("dev-1", PR, 1), comment("dev-1", "no-code-review: docs-only change", 2)],
    });
    expect(evaluateCodeReviewGate(justified).allowed).toBe(true);
  });
});
