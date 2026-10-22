/**
 * PAR-4701: the autonomy ladder approves only a low-risk post with a clean owner streak of 5.
 * Video, carousel, rss, inbox reply, client-approval and no-streak posts are left to a person.
 */
import { describe, expect, it } from "vitest";
import { autoApprovalDecision, AUTO_APPROVE_STREAK } from "../src/autonomy.js";
import { reviewStats, summariseOutcomes } from "../src/review-outcomes.js";
import { recordReviewVerdictRecord, transitionPost } from "../src/service.js";
import { approvalWorld, REVIEWER_AGENT, SOCIAL_AGENT } from "./world.js";

type World = ReturnType<typeof approvalWorld>;

/** `n` earlier owner approvals of `type` (oldest first), on other posts. */
function seedStreak(w: World, n: number, type = "original:text", via = "ui", outcome = "approved") {
  for (let i = 0; i < n; i += 1) {
    w.outcomes.push({ id: `s${type}${via}${w.outcomes.length}`, post_id: `old-${w.outcomes.length}`, stage: "owner", outcome, round: 1, post_type: type, via, created_at: new Date(Date.UTC(2026, 9, 1, 0, w.outcomes.length)).toISOString() });
  }
}

async function sendForReview(w: World) {
  w.post.status = "draft";
  await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
}

describe("autoApprovalDecision", () => {
  const ok = { kind: "original", format: "text", requireClient: false, missing: ["owner"], validateOk: true, streak: 5 };
  it("approves low risk with a streak of 5", () => {
    expect(AUTO_APPROVE_STREAK).toBe(5);
    expect(autoApprovalDecision(ok).eligible).toBe(true);
    expect(autoApprovalDecision({ ...ok, kind: "repurpose", format: "image" }).eligible).toBe(true);
  });
  it.each([
    ["video", { format: "video" }],
    ["carousel", { format: "carousel" }],
    ["rss", { kind: "rss" }],
    ["inbox reply", { kind: "reply" }],
    ["client approval", { requireClient: true }],
    ["no streak", { streak: 0 }],
    ["streak of 4", { streak: 4 }],
    ["failed validation", { validateOk: false }],
    ["reviewer pass missing", { missing: ["reviewer", "owner"] }],
  ])("does not approve %s", (_name, patch) => {
    expect(autoApprovalDecision({ ...ok, ...patch }).eligible).toBe(false);
  });
});

describe("the ladder in the approval flow", () => {
  it("auto-approves a low-risk post with an owner streak of 5 and records it as auto", async () => {
    const w = approvalWorld({ client: null, policy: null });
    seedStreak(w, 5);
    await sendForReview(w);
    expect(w.post.status).toBe("approved");
    expect(w.outcomes.at(-1)).toMatchObject({ stage: "owner", outcome: "approved", via: "auto", post_id: "p1" });
  });

  it("does not auto-approve with no streak or a streak of 4", async () => {
    for (const n of [0, 4]) {
      const w = approvalWorld({ client: null, policy: null });
      seedStreak(w, n);
      await sendForReview(w);
      expect(w.post.status).toBe("review");
    }
  });

  it("a request for changes breaks the streak", async () => {
    const w = approvalWorld({ client: null, policy: null });
    seedStreak(w, 5);
    seedStreak(w, 1, "original:text", "ui", "changes");
    await sendForReview(w);
    expect(w.post.status).toBe("review");
  });

  it("a streak of another post type does not count, and auto rows do not extend a streak", async () => {
    const other = approvalWorld({ client: null, policy: null });
    seedStreak(other, 5, "original:image");
    await sendForReview(other);
    expect(other.post.status).toBe("review");
    const autos = approvalWorld({ client: null, policy: null });
    seedStreak(autos, 5, "original:text", "auto");
    await sendForReview(autos);
    expect(autos.post.status).toBe("review");
  });

  it.each([
    ["rss", { source: "rss" }],
    ["inbox reply", { source: "inbox_reply" }],
    ["video", { media: [{ kind: "video", url: "https://x.test/v.mp4" }] }],
  ])("does not auto-approve %s even with a streak of 5", async (_name, patch) => {
    const w = approvalWorld({ client: null, policy: null });
    Object.assign(w.post, patch);
    for (const type of ["original:text", "rss:text", "reply:text", "original:video"]) seedStreak(w, 5, type);
    await sendForReview(w);
    expect(w.post.status).toBe("review");
  });

  it("does not auto-approve a post in a scope where the client approves", async () => {
    const w = approvalWorld({ policy: { require_owner: true, require_client: true } });
    seedStreak(w, 5);
    await sendForReview(w);
    expect(w.post.status).toBe("review");
  });

  it("still needs the Reviewer's pass when the policy asks for it, then replaces only the owner click", async () => {
    const w = approvalWorld({ client: null, reviewer: "rev-1", policy: { require_reviewer: true }, reviewIssue: "iss-9" });
    seedStreak(w, 5);
    await sendForReview(w);
    expect(w.post.status).toBe("review");
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(w.post.status).toBe("approved");
    expect(w.outcomes.map((o) => `${o.stage}:${o.via}`)).toEqual(expect.arrayContaining(["reviewer:tool", "owner:auto"]));
  });

  it("review-outcomes reports the ladder per type: only a qualifying type is enabled", async () => {
    const w = approvalWorld({ client: null, policy: null });
    seedStreak(w, 5, "original:text");
    seedStreak(w, 5, "rss:text");
    seedStreak(w, 5, "original:video");
    const stats = await reviewStats(w.ctx, "co", null);
    expect(stats.autonomy.enabled).toBe(true);
    expect(stats.autonomy.types.filter((t) => t.enabled).map((t) => t.postType)).toEqual(["original:text"]);
    expect(summariseOutcomes([]).length).toBe(0);
  });
  it("review-outcomes keeps the ladder off in a scope where the client approves", async () => {
    const w = approvalWorld({ policy: { require_owner: true, require_client: true } });
    seedStreak(w, 5);
    const stats = await reviewStats(w.ctx, "co", { kind: "company", id: "c1" });
    expect(stats.autonomy.enabled).toBe(false);
    expect(stats.autonomy.types.every((t) => !t.enabled)).toBe(true);
  });

  it("leaves no auto sign-off row when completing the approval fails", async () => {
    const w = approvalWorld({ client: null, policy: null });
    seedStreak(w, 5);
    const seeded = w.outcomes.length;
    w.post.status = "draft";
    const execute = w.ctx.db.execute.bind(w.ctx.db);
    w.ctx.db.execute = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("status = ANY(") && params?.includes("approved")) throw new Error("boom");
      return execute(sql, params);
    }) as typeof w.ctx.db.execute;
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
    expect(w.post.status).toBe("review");
    expect(w.outcomes.slice(seeded).filter((o) => o.via === "auto")).toEqual([]);
  });
});
