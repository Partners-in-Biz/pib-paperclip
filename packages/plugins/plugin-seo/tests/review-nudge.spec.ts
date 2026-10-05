/**
 * A preview that nobody has reviewed for 30 minutes is nudged (found on Agri Studies 2026-10-05: the Reviewer's run lost its tools
 * while the SEO plugin reloaded, handed the issue to another agent that also lacked them, and nothing ever retried).
 */
import { describe, expect, it } from "vitest";
import { nudgeStalledReviews, REVIEW_MAX_NUDGES } from "../src/service/preview.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import { executed, type Route, type Row } from "./helpers/seo-host.js";

const row = (extra: Row = {}): Row => ({ id: "p1", company_id: "co-1", sprint_id: "sp-real", task_id: "t1", page_url: "https://agristudies.co.za/product/farm/", title: "Farm machinery", review_issue_id: "rev-1", stats: {}, ...extra });
const routes = (rows: Row[]): Route[] => [[/FROM plugin_seo_8099f8879a\.previews\s+WHERE review_status = 'pending' AND review_issue_id IS NOT NULL/, () => rows]];
const sprint = () => sprintFor("real", { root_issue_id: "root-1", status: "active" });

describe("stalled reviews", () => {
  it("reopens the review for the Reviewer, wakes it, comments once and counts the try", async () => {
    const w = world({ sprints: [sprint()], routes: routes([row()]) });
    expect(await nudgeStalledReviews(w.env)).toBe(1);
    expect(w.updates.some((u) => u.id === "rev-1" && u.patch.status === "todo")).toBe(true);
    expect(w.wakeups).toContain("rev-1");
    expect(w.comments.find((c) => c.id === "rev-1")!.body).toMatch(/attempt 1 of 3[\s\S]*review-preview/);
    expect(executed(w, /SET stats = stats \|\| \$2::jsonb/)[0]!.params[1]).toContain('"reviewNudges":1');
  });

  it("waits between tries and stops after the last one, asking the owner once", async () => {
    const recent = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: 1, reviewNudgedAt: "2026-10-03T07:50:00Z" } })]) });
    expect(await nudgeStalledReviews(recent.env)).toBe(0);
    const done = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: REVIEW_MAX_NUDGES, reviewNudgedAt: "2026-10-01T00:00:00Z" } })]) });
    expect(await nudgeStalledReviews(done.env)).toBe(0);
    const last = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: REVIEW_MAX_NUDGES - 1, reviewNudgedAt: "2026-10-01T00:00:00Z" } })]) });
    expect(await nudgeStalledReviews(last.env)).toBe(1);
    expect(JSON.stringify(last.needsYou.at(-1)!.items)).toContain("has waited for the Reviewer through 3 tries");
  });

  it("leaves a paused sprint alone", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "paused" })], routes: routes([row()]) });
    expect(await nudgeStalledReviews(w.env)).toBe(0);
    expect(w.wakeups).toEqual([]);
  });
});
