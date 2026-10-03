/**
 * 0.8.0 (Q10-10): every verdict on a post is one row, by post type and scope, tied to the exact version it was given on.
 * The numbers are inputs for a later autonomy ladder; nothing here approves anything.
 */
import { describe, expect, it } from "vitest";
import { contentHashOf } from "../src/content-hash.js";
import { currentSignoffs, postKind, postTypeOf, recordOutcome, reviewStats, summariseOutcomes, type StatRow } from "../src/review-outcomes.js";
import { approvalWorld, postRow, T } from "./world.js";

const img = { url: "https://m/a.png", kind: "image", altText: "x" };

describe("post types", () => {
  it("a type is where the post came from and its format", () => {
    expect(postTypeOf({ source: "agent", media: [] }).type).toBe("original:text");
    expect(postTypeOf({ source: "manual", media: [img] as never }).type).toBe("original:image");
    expect(postTypeOf({ source: "repurpose", media: [img, img] as never }).type).toBe("repurpose:carousel");
    expect(postTypeOf({ source: "rss", media: [{ ...img, kind: "video" }] as never }).type).toBe("rss:video");
    expect(postKind("inbox_reply")).toBe("reply");
    expect(postKind(null)).toBe("original");
  });
});

describe("content fingerprint", () => {
  const base = { body: "Hello", first_comment: null, overrides: {}, media: [], scheduled_at: null } as never;

  it("changes with anything the post will publish, and with nothing else", () => {
    const a = contentHashOf(base, ["a1", "a2"]);
    expect(contentHashOf(base, ["a2", "a1", "a1"])).toBe(a);
    expect(contentHashOf({ ...(base as object), body: "  Hello " } as never, ["a1", "a2"])).toBe(a);
    for (const change of [{ body: "Hello!" }, { first_comment: "More" }, { overrides: { x: { text: "short" } } }, { media: [img] }, { scheduled_at: "2026-10-05T07:30:00Z" }]) {
      expect(contentHashOf({ ...(base as object), ...change } as never, ["a1", "a2"]), JSON.stringify(change)).not.toBe(a);
    }
    expect(contentHashOf(base, ["a1"])).not.toBe(a);
  });

  it("does not depend on key order inside overrides", () => {
    expect(contentHashOf({ ...(base as object), overrides: { x: { text: "a", link: "https://l" }, linkedin: { text: "b" } } } as never, [])).toBe(
      contentHashOf({ ...(base as object), overrides: { linkedin: { text: "b" }, x: { link: "https://l", text: "a" } } } as never, []),
    );
  });
});

describe("sign-offs belong to one version", () => {
  const row = (stage: "reviewer" | "owner" | "client", outcome: "approved" | "changes", round: number, hash: string | null, at = "2026-10-03T08:00:00Z") => ({ stage, outcome, round, content_hash: hash, created_at: at });

  it("an approval counts only for the version it was given on", () => {
    const rows = [row("reviewer", "approved", 1, "h1"), row("owner", "approved", 1, "h2")];
    expect(currentSignoffs(rows, "h1")).toEqual({ reviewer: "approved", owner: "stale", client: "none" });
    expect(currentSignoffs(rows, "h2")).toEqual({ reviewer: "stale", owner: "approved", client: "none" });
  });

  it("the latest verdict at a stage wins, so changes after an approval withdraw it", () => {
    const rows = [row("client", "approved", 1, "h1", "2026-10-03T08:00:00Z"), row("client", "changes", 2, "h1", "2026-10-03T09:00:00Z")];
    expect(currentSignoffs(rows, "h1").client).toBe("changes");
    expect(currentSignoffs([...rows, row("client", "approved", 3, "h1", "2026-10-03T10:00:00Z")], "h1").client).toBe("approved");
  });
});

describe("recording a verdict", () => {
  it("the round counts the post's earlier verdicts at that stage", async () => {
    const w = approvalWorld();
    const input = { companyId: "co", post: postRow(w), platforms: ["linkedin", "x"], contentHash: "h", via: "tool" as const };
    expect(await recordOutcome(w.ctx, { ...input, stage: "reviewer", outcome: "changes" })).toEqual({ recorded: true, round: 1 });
    expect(await recordOutcome(w.ctx, { ...input, stage: "reviewer", outcome: "approved" })).toEqual({ recorded: true, round: 2 });
    expect(await recordOutcome(w.ctx, { ...input, stage: "client", outcome: "approved" })).toEqual({ recorded: true, round: 1 });
    expect(w.outcomes.map((o) => [o.stage, o.outcome, o.round])).toEqual([["reviewer", "changes", 1], ["reviewer", "approved", 2], ["client", "approved", 1]]);
    expect(w.outcomes[0]).toMatchObject({ post_type: "original:text", format: "text", platforms: JSON.stringify(["linkedin", "x"]) });
  });

  it("stores the type, the scope and the note (cut to 1000 characters), and never fails on a raced round", async () => {
    const w = approvalWorld();
    const insert = (note: string) => recordOutcome(w.ctx, { companyId: "co", post: postRow(w), platforms: [], stage: "owner", outcome: "changes", contentHash: "h", via: "ui", actor: { userId: "owner-1" }, note });
    await insert("x".repeat(1500));
    const sql = w.ctx.fakeDb.executes.find((e) => e.sql.startsWith(`INSERT INTO ${T("review_outcomes")}`))!;
    expect(sql.sql).toContain("ON CONFLICT (post_id, stage, round) DO NOTHING");
    expect(String(sql.params[17])).toHaveLength(1000);
    expect(sql.params.slice(11, 13)).toEqual(["company", "c1"]);
    // Another run took round 2 between the read and the write: one retry with the next round, then it gives up quietly.
    const raced = approvalWorld();
    let calls = 0;
    const patched = { ...raced.ctx, db: { ...raced.ctx.db, execute: async () => ({ rowCount: (calls += 1) === 1 ? 0 : 1 }) } } as typeof raced.ctx;
    expect(await recordOutcome(patched, { companyId: "co", post: postRow(raced), platforms: [], stage: "owner", outcome: "approved", contentHash: "h", via: "ui" })).toMatchObject({ recorded: true });
    const never = { ...raced.ctx, db: { ...raced.ctx.db, execute: async () => ({ rowCount: 0 }) } } as typeof raced.ctx;
    expect(await recordOutcome(never, { companyId: "co", post: postRow(raced), platforms: [], stage: "owner", outcome: "approved", contentHash: "h", via: "ui" })).toEqual({ recorded: false, round: 0 });
  });
});

describe("autonomy inputs", () => {
  const stat = (type: string, stage: "reviewer" | "owner" | "client", outcome: "approved" | "changes", round: number, day: number): StatRow => ({
    post_type: type, stage, outcome, round, post_id: `${type}-${day}`, created_at: new Date(Date.UTC(2026, 9, day)).toISOString(),
  });

  it("first-pass rate counts round 1 only; the streak is approvals in a row, newest first", () => {
    const rows = [
      stat("repurpose:text", "owner", "approved", 1, 1),
      stat("repurpose:text", "owner", "changes", 1, 2),
      stat("repurpose:text", "owner", "approved", 2, 3),
      stat("repurpose:text", "owner", "approved", 1, 4),
      stat("repurpose:text", "owner", "approved", 1, 5),
      stat("original:image", "client", "changes", 1, 6),
    ];
    const out = summariseOutcomes(rows);
    expect(out).toEqual([
      { postType: "original:image", stage: "client", total: 1, approved: 0, changes: 1, firstPassApproved: 0, firstPassTotal: 1, firstPassRate: 0, streak: 0, lastAt: "2026-10-06T00:00:00.000Z" },
      { postType: "repurpose:text", stage: "owner", total: 5, approved: 4, changes: 1, firstPassApproved: 3, firstPassTotal: 4, firstPassRate: 0.75, streak: 3, lastAt: "2026-10-05T00:00:00.000Z" },
    ]);
  });

  it("says plainly that auto-approval is off, and reads one scope only", async () => {
    const w = approvalWorld();
    const stats = await reviewStats(w.ctx, "co", { kind: "company", id: "c1" }, 30);
    expect(stats).toMatchObject({ days: 30, scope: "company:c1", types: [], autonomy: { enabled: false } });
    const q = w.ctx.fakeDb.queries.at(-1)!;
    expect(q.sql).toContain("client_ref = $4");
    expect(q.params).toEqual(["co", 30, "company", "c1"]);
    await reviewStats(w.ctx, "co", null, 90);
    expect(w.ctx.fakeDb.queries.at(-1)!.sql).toContain("client_ref IS NULL");
  });
});
