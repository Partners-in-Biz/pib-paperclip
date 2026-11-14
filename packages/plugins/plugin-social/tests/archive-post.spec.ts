/** archive-post / unarchive-post: soft delete with a flag, short ids, idempotent, refuses live posts. */
import { describe, expect, it } from "vitest";
import { archivePostRecord } from "../src/service.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import { approvalWorld, PERSON, SOCIAL_AGENT } from "./world.js";

function world(status = "draft", extra: Record<string, unknown> = {}) {
  const w = approvalWorld({ client: null });
  Object.assign(w.post, { status, ...extra });
  const query = w.ctx.db.query.bind(w.ctx.db);
  // Short-id lookup: the fake db has no LIKE support, so answer it here.
  const ctx = {
    ...w.ctx,
    db: {
      ...w.ctx.db,
      query: (sql: string, params: unknown[]) =>
        sql.includes("id LIKE $2") ? Promise.resolve(String(w.post.id).startsWith(String(params[1]).replace(/%$/, "")) ? [{ id: w.post.id }] : []) : query(sql, params),
    },
  };
  return { ...w, ctx } as typeof w;
}
const archived = (w: { post: unknown }) => (w.post as { archived_at?: unknown }).archived_at;

describe("archive-post", () => {
  it("is registered with postId required, plus unarchive-post", () => {
    for (const n of ["archive-post", "unarchive-post"]) {
      const t = SOCIAL_TOOLS.find((x) => x.name === n)!;
      expect((t.parametersSchema as { required: string[] }).required).toEqual(["postId"]);
    }
  });

  it("archives a draft by full id, keeps status and body", async () => {
    const w = world();
    const body = w.post.body;
    const out = await archivePostRecord(w.ctx, PERSON, { postId: "p1" });
    expect(out.changed).toBe(true);
    expect(archived(w)).not.toBeNull();
    expect(w.post.status).toBe("draft");
    expect(w.post.body).toBe(body);
  });

  it("accepts the short id prefix", async () => {
    const w = world("approved", { id: "b787c5f8-1111-2222-3333-444455556666" });
    await archivePostRecord(w.ctx, PERSON, { postId: "b787c5f8" });
    expect(archived(w)).not.toBeNull();
  });

  it("archiving twice is a no-op", async () => {
    const w = world();
    await archivePostRecord(w.ctx, PERSON, { postId: "p1" });
    const first = archived(w);
    const out = await archivePostRecord(w.ctx, PERSON, { postId: "p1" });
    expect(out.changed).toBe(false);
    expect(archived(w)).toBe(first);
  });

  it("unarchive clears the flag; unarchiving a live post is a no-op", async () => {
    const w = world();
    await archivePostRecord(w.ctx, PERSON, { postId: "p1" });
    expect((await archivePostRecord(w.ctx, PERSON, { postId: "p1" }, false)).changed).toBe(true);
    expect(archived(w)).toBeNull();
    expect((await archivePostRecord(w.ctx, PERSON, { postId: "p1" }, false)).changed).toBe(false);
  });

  for (const status of ["published", "partially_published", "publishing"]) {
    it(`refuses a ${status} post`, async () => {
      const w = world(status);
      await expect(archivePostRecord(w.ctx, PERSON, { postId: "p1" })).rejects.toThrow(/cannot be archived/);
      expect(archived(w) ?? null).toBeNull();
    });
  }

  it("refuses a scheduled post and says to unschedule", async () => {
    const w = world("scheduled", { scheduled_at: "2099-01-01T10:00:00Z" });
    await expect(archivePostRecord(w.ctx, PERSON, { postId: "p1" })).rejects.toThrow(/unschedule/);
  });

  it("says so when nothing matches", async () => {
    const w = world();
    const ctx = { ...w.ctx, db: { ...w.ctx.db, query: () => Promise.resolve([]) } } as typeof w.ctx;
    await expect(archivePostRecord(ctx, PERSON, { postId: "zzzzzzzz" })).rejects.toThrow(/No single post/);
  });

  it("an agent cannot archive another agent's personal post", async () => {
    const w = world("draft", { scope: "personal", created_by_agent_id: "someone-else" });
    await expect(archivePostRecord(w.ctx, SOCIAL_AGENT, { postId: "p1" })).rejects.toThrow(/personal posts|not visible/);
    expect(archived(w) ?? null).toBeNull();
  });
});
