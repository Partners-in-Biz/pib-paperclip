/** PAR-7032: a person's sign-offs share one weekly issue instead of one issue per post. */
import { describe, expect, it } from "vitest";
import { closePostReview, handReviewIssue } from "../src/review.js";
import { addWeeklyReviewItem, closeWeeklyReviewItem, weekStart } from "../src/weekly-review.js";
import { approvalWorld, postRow, REVIEWER_AGENT, type World } from "./world.js";

/** Gives the world a plugin state that remembers, as the host's does. */
function remember(w: World) {
  const store = new Map<string, unknown>();
  const state = w.ctx.state as unknown as { get: (k: { namespace?: string; stateKey: string }) => Promise<unknown>; set: (k: { namespace?: string; stateKey: string }, v: unknown) => Promise<void>; delete: (k: { namespace?: string; stateKey: string }) => Promise<void> };
  const baseGet = state.get;
  const id = (k: { namespace?: string; stateKey: string }) => `${k.namespace}|${k.stateKey}`;
  state.get = async (k) => (k.namespace === "social-weekly-review" ? store.get(id(k)) ?? null : baseGet(k));
  state.set = async (k, v) => void store.set(id(k), JSON.parse(JSON.stringify(v)));
  state.delete = async (k) => void store.delete(id(k));
}

describe("weekly review issue", () => {
  it("weekStart is the Monday", () => {
    expect(weekStart(new Date("2026-11-04T10:00:00Z"))).toBe("2026-11-02");
    expect(weekStart(new Date("2026-11-08T23:00:00Z"))).toBe("2026-11-02");
  });

  it("a second post is appended to the same issue, and the issue closes when all are signed off", async () => {
    const w = approvalWorld({ policy: null, reviewIssue: "iss-9" });
    remember(w);
    const p1 = postRow(w);
    await handReviewIssue(w.ctx, "co", p1, { userId: "owner-1" }, "n", "wake");
    // The world holds one post, so the second joins through the same call handReviewIssue makes.
    await addWeeklyReviewItem(w.ctx, "co", { ...p1, id: "p2", body: "Second post" }, "owner-1", "n");
    expect(w.created).toHaveLength(1);
    const desc = (w.updates.filter((u) => u.id === "iss-1").at(-1)!.patch.description) as string;
    expect(desc).toContain("Spring sale");
    expect(desc).toContain("Second post");
    await closeWeeklyReviewItem(w.ctx, "co", "p1", "Approved.");
    expect(w.updates.filter((u) => u.id === "iss-1" && u.patch.status === "done")).toEqual([]);
    await closeWeeklyReviewItem(w.ctx, "co", "p2", "Approved.");
    expect(w.updates.at(-1)).toEqual({ id: "iss-1", patch: { status: "done" } });
  });

  it("the Social page sign-off (closePostReview) ticks the item", async () => {
    const w = approvalWorld({ policy: null, reviewIssue: "iss-9" });
    remember(w);
    await handReviewIssue(w.ctx, "co", postRow(w), { userId: "owner-1" }, "n", "wake");
    await closePostReview(w.ctx, { companyId: "co", userId: "owner-1", isAgent: false } as never, postRow(w), "approved", "ok");
    expect(w.updates.at(-1)).toEqual({ id: "iss-1", patch: { status: "done" } });
  });

  it("the agent path is unchanged: the issue is reassigned, not replaced", async () => {
    const w = approvalWorld({ policy: null, reviewIssue: "iss-9" });
    remember(w);
    await handReviewIssue(w.ctx, "co", postRow(w), { agentId: REVIEWER_AGENT.agentId ?? "rev-1" }, "n", "wake");
    expect(w.created).toEqual([]);
    expect(w.updates[0]).toMatchObject({ id: "iss-9", patch: { status: "todo", assigneeUserId: null } });
  });
});
