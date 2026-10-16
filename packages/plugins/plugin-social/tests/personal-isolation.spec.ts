import { describe, expect, it, vi } from "vitest";
import { canActOnPost, filterBySpace } from "../src/ownership.js";
import type { PostRow } from "../src/db.js";
import { approvePostByPerson } from "../src/approval-flow.js";
import { SocialError } from "../src/domain.js";
import { spaceMatches } from "../src/space.js";
import type { Viewer } from "../src/space.js";
import type { ScopedRow } from "../src/space.js";
import { fakeCtx } from "./helpers.js";

const COMPANY_ID = "co";
const USER_1 = "user-1";
const USER_2 = "user-2";
const AGENT_ID = "agent-reviewer";

const viewer1: Viewer = { companyId: COMPANY_ID, userId: USER_1, agentId: null, runId: null, isAgent: false };
const viewer2: Viewer = { companyId: COMPANY_ID, userId: USER_2, agentId: null, runId: null, isAgent: false };
const agentViewer: Viewer = { companyId: COMPANY_ID, userId: null, agentId: null, runId: null, isAgent: true };

function mockRow(scope: "org" | "personal", owner: string | null = null): ScopedRow {
  return { scope, owner_user_id: owner };
}

function mockPost(scope: "org" | "personal", owner: string | null = null): PostRow {
  return {
    id: "p1",
    company_id: COMPANY_ID,
    body: "test",
    overrides: {},
    media: [],
    status: "draft",
    scheduled_at: null,
    published_at: null,
    scope,
    owner_user_id: owner,
    created_at: new Date(),
    updated_at: new Date(),
    first_comment: null,
    client_kind: null,
    client_ref: null,
    client_name: null,
    source: null,
    source_ref: null,
    failure_issue_id: null,
    error: null,
    created_by_agent_id: null,
    schedule_issue_id: null,
    experiment_id: null,
    experiment_arm: null,
  } as PostRow;
}

describe("Space filtering (company vs me)", () => {
  it("spaceMatches returns true for org rows in company space", () => {
    const row = mockRow("org");
    expect(spaceMatches("company", viewer1, row)).toBe(true);
  });

  it("spaceMatches returns false for personal rows in company space", () => {
    const row = mockRow("personal", USER_1);
    expect(spaceMatches("company", viewer1, row)).toBe(false);
  });

  it("spaceMatches returns false for org rows in me space", () => {
    const row = mockRow("org");
    expect(spaceMatches("me", viewer1, row)).toBe(false);
  });

  it("spaceMatches returns true for personal rows owned by viewer in me space", () => {
    const row = mockRow("personal", USER_1);
    expect(spaceMatches("me", viewer1, row)).toBe(true);
  });

  it("spaceMatches returns false for personal rows not owned by viewer in me space", () => {
    const row = mockRow("personal", USER_1);
    expect(spaceMatches("me", viewer2, row)).toBe(false);
  });

  it("filterBySpace returns only org rows for company space", () => {
    const rows = [
      mockRow("org"),
      mockRow("personal", USER_1),
      mockRow("org"),
      mockRow("personal", USER_2),
    ];
    const filtered = filterBySpace(rows, "company", viewer1);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.scope === "org")).toBe(true);
  });

  it("filterBySpace returns only personal rows owned by viewer for me space", () => {
    const rows = [
      mockRow("personal", USER_1),
      mockRow("personal", USER_2),
      mockRow("org"),
      mockRow("personal", USER_1),
    ];
    const filtered = filterBySpace(rows, "me", viewer1);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.scope === "personal" && r.owner_user_id === USER_1)).toBe(true);
  });

  it("filterBySpace returns empty for me space when viewer has no userId", () => {
    const rows = [mockRow("personal", USER_1)];
    const filtered = filterBySpace(rows, "me", agentViewer);
    expect(filtered).toHaveLength(0);
  });
});

describe("Approval restrictions", () => {
  it("canActOnPost returns true for org posts (normal approval)", () => {
    const post = mockPost("org");
    expect(canActOnPost(viewer1, post)).toBe(true);
  });

  it("canActOnPost returns true for personal posts when viewer is owner", () => {
    const post = mockPost("personal", USER_1);
    expect(canActOnPost(viewer1, post)).toBe(true);
  });

  it("canActOnPost returns false for personal posts when viewer is not owner", () => {
    const post = mockPost("personal", USER_1);
    expect(canActOnPost(viewer2, post)).toBe(false);
  });

  it("canActOnPost returns false for agents on personal posts", () => {
    const post = mockPost("personal", USER_1);
    expect(canActOnPost(agentViewer, post)).toBe(false);
  });

  it("approvePostByPerson throws for agent on personal post", async () => {
    const post = mockPost("personal", USER_1);
    const ctx = fakeCtx(
      { config: { get: vi.fn(async () => ({})) }, agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } }, companies: { get: vi.fn(async () => ({ id: COMPANY_ID, issuePrefix: "PIB" })) } },
      { queryResult: (sql) => (sql.includes("review_outcomes") ? [] : []) },
    );
    const actor: Viewer = { companyId: COMPANY_ID, userId: null, agentId: null, runId: null, isAgent: true };
    await expect(approvePostByPerson(ctx, actor, post)).rejects.toThrow(/Agents cannot approve personal posts/);
  });

  it("approvePostByPerson throws for user-2 on user-1's personal post", async () => {
    const post = mockPost("personal", USER_1);
    const ctx = fakeCtx(
      { config: { get: vi.fn(async () => ({})) }, agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } }, companies: { get: vi.fn(async () => ({ id: COMPANY_ID, issuePrefix: "PIB" })) } },
      { queryResult: (sql) => (sql.includes("review_outcomes") ? [] : []) },
    );
    const actor: Viewer = { companyId: COMPANY_ID, userId: USER_2, agentId: null, runId: null, isAgent: false };
    await expect(approvePostByPerson(ctx, actor, post)).rejects.toThrow(/Only the post owner can approve/);
  });
});

describe("Org behavior unchanged", () => {
  it("canActOnPost allows any team member to act on org posts", () => {
    const post = mockPost("org");
    expect(canActOnPost(viewer1, post)).toBe(true);
    expect(canActOnPost(viewer2, post)).toBe(true);
    expect(canActOnPost(agentViewer, post)).toBe(true);
  });
});
