/** unschedule-post: scheduled -> draft with a reason; nothing else qualifies; scope rules match update-post. */
import { describe, expect, it } from "vitest";
import { assertEditable } from "../src/domain.js";
import { unschedulePostRecord } from "../src/service.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import { approvalWorld, PERSON, SOCIAL_AGENT } from "./world.js";

function scheduled(status = "scheduled", extra: Record<string, unknown> = {}) {
  const w = approvalWorld({ client: null });
  Object.assign(w.post, { status, scheduled_at: new Date("2099-01-01T10:00:00Z"), ...extra });
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const execute = w.ctx.db.execute.bind(w.ctx.db);
  const ctx = { ...w.ctx, db: { ...w.ctx.db, execute: (sql: string, params: unknown[]) => { calls.push({ sql, params }); return execute(sql, params); } } };
  return { ...w, ctx, calls };
}

describe("unschedule-post", () => {
  it("is registered with postId and reason required", () => {
    const t = SOCIAL_TOOLS.find((x) => x.name === "unschedule-post")!;
    expect((t.parametersSchema as { required: string[] }).required).toEqual(["postId", "reason"]);
  });

  it("moves a scheduled post to draft, clears the time, keeps the body, records who and why", async () => {
    const w = scheduled();
    const body = w.post.body;
    await unschedulePostRecord(w.ctx, PERSON, { postId: "p1", reason: "client asked to hold" });
    expect(w.post.status).toBe("draft");
    expect(w.post.scheduled_at).toBeNull();
    expect(w.post.body).toBe(body);
    const noteWrite = w.calls.find((c) => c.sql.includes("note") && c.sql.includes("UPDATE") && c.params.some((p) => String(p).includes("Unscheduled by")));
    expect(String(noteWrite?.params.find((p) => String(p).includes("Unscheduled by")))).toBe("Unscheduled by user owner-1: client asked to hold");
  });

  it("update-post works on it afterwards", async () => {
    const w = scheduled();
    await unschedulePostRecord(w.ctx, PERSON, { postId: "p1", reason: "fix typo" });
    expect(() => assertEditable(w.post.status as never)).not.toThrow();
  });

  it("refuses a reason that is missing", async () => {
    const w = scheduled();
    await expect(unschedulePostRecord(w.ctx, PERSON, { postId: "p1" })).rejects.toThrow();
    await expect(unschedulePostRecord(w.ctx, PERSON, { postId: "p1", reason: "  " })).rejects.toThrow(/reason/);
    expect(w.post.status).toBe("scheduled");
  });

  for (const status of ["draft", "review", "approved", "published", "failed", "publishing"]) {
    it(`refuses a ${status} post`, async () => {
      const w = scheduled(status);
      await expect(unschedulePostRecord(w.ctx, PERSON, { postId: "p1", reason: "x" })).rejects.toThrow(/Only a scheduled post/);
      expect(w.post.status).toBe(status);
    });
  }

  it("enforces scope: an agent cannot unschedule another agent's personal post", async () => {
    const w = scheduled("scheduled", { scope: "personal", created_by_agent_id: "someone-else" });
    await expect(unschedulePostRecord(w.ctx, SOCIAL_AGENT, { postId: "p1", reason: "x" })).rejects.toThrow(/personal posts|not visible/);
    expect(w.post.status).toBe("scheduled");
  });
});
