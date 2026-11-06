/** Editing a failed, approved or scheduled post goes through draft, so changed content is always approved again. */
import { describe, expect, it } from "vitest";
import { editableViaDraft } from "../src/platforms.js";
import { transitionPost } from "../src/service.js";
import { approvalWorld, PERSON } from "./world.js";

function spying(status: string) {
  const w = approvalWorld({ client: null });
  (w.post as { status: string }).status = status;
  (w.post as { scheduled_at: unknown }).scheduled_at = new Date("2026-11-03T13:41:00Z");
  const sql: string[] = [];
  const execute = w.ctx.db.execute.bind(w.ctx.db);
  const ctx = { ...w.ctx, db: { ...w.ctx.db, execute: (text: string, params: unknown[]) => { sql.push(text); return execute(text, params); } } };
  return { w, ctx, sql };
}

describe("which posts can be edited through draft", () => {
  it("failed, approved and scheduled can; what went out cannot", () => {
    for (const status of ["failed", "approved", "scheduled"]) expect(editableViaDraft(status)).toBe(true);
    for (const status of ["published", "partially_published", "publishing", "draft", "review"]) expect(editableViaDraft(status)).toBe(false);
  });
});

describe("a failed post moved back to draft starts over", () => {
  it("resets its failed destinations, clears its error and drops the time that has passed", async () => {
    const { w, ctx, sql } = spying("failed");
    await transitionPost(ctx, PERSON, "p1", "draft");
    expect(w.post.status).toBe("draft");
    expect(w.post.scheduled_at).toBeNull();
    expect(sql.some((s) => s.includes("status = 'pending', attempts = 0") && s.includes("'failed', 'retrying'"))).toBe(true);
    expect(sql.some((s) => s.includes("SET status = $2, error = $3"))).toBe(true);
  });

  it("an approved post keeps its time and touches no destinations", async () => {
    const { w, ctx, sql } = spying("approved");
    await transitionPost(ctx, PERSON, "p1", "draft");
    expect(w.post.status).toBe("draft");
    expect(w.post.scheduled_at).not.toBeNull();
    expect(sql.some((s) => s.includes("status = 'pending', attempts = 0"))).toBe(false);
  });
});
