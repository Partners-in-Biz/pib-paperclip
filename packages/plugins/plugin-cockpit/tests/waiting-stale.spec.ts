import { describe, expect, it } from "vitest";
import type { CockpitSnapshot, WaitingItem } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { issueStatuses, pruneStaleWaiting } from "../src/brief.js";

const w = (key: string, issueId?: string): WaitingItem => ({ key, title: key, why: "why", kind: "review", issueId });
const snap = (waiting: WaitingItem[]): CockpitSnapshot => ({ plugin: "partnersinbiz.social", waiting } as unknown as CockpitSnapshot);
const keys = (s: CockpitSnapshot[]) => s.flatMap((x) => x.waiting.map((i) => i.key));

describe("pruneStaleWaiting", () => {
  const statuses = new Map([["open", "in_review"], ["done", "done"], ["gone", "cancelled"]]);

  it("drops rows linked to done, cancelled or missing issues", () => {
    const out = pruneStaleWaiting([snap([w("a", "open"), w("b", "done"), w("c", "gone"), w("d", "missing"), w("e")])], statuses);
    expect(keys(out)).toEqual(["a", "e"]);
  });

  it("drops a task row that duplicates its review row", () => {
    const out = pruneStaleWaiting([snap([w("seo:needs-you:s1:review:t1"), w("seo:needs-you:s1:task:t1"), w("seo:needs-you:s2:task:t1"), w("seo:needs-you:s1:task:t2")])], statuses);
    expect(keys(out)).toEqual(["seo:needs-you:s1:review:t1", "seo:needs-you:s2:task:t1", "seo:needs-you:s1:task:t2"]);
  });

  it("drops a row whose issue is hidden (the API answers 404 for it)", async () => {
    const ctx = { db: { query: async (sql: string) => { expect(sql).toContain("hidden_at"); return [{ id: "h", status: "hidden" }, { id: "open", status: "in_review" }]; } } } as never;
    const map = await issueStatuses(ctx, "c1", ["h", "open"]);
    expect(keys(pruneStaleWaiting([snap([w("q", "h"), w("r", "open")])], map))).toEqual(["r"]);
  });

  it("lists a sign-off once when two digests carry it (keeps the newest)", () => {
    const so = (key: string, since: string): WaitingItem => ({ key, title: "Sign off CWV fix: buy-a-gun/", why: "w", kind: "review", since, issueId: "open" });
    const out = pruneStaleWaiting([snap([so("seo:needs-you:s1:review:a", "2026-10-22T08:00:00Z"), so("seo:needs-you:s2:review:b", "2026-11-09T08:00:00Z"), w("other")])], statuses);
    expect(keys(out)).toEqual(["seo:needs-you:s2:review:b", "other"]);
  });

  it("keeps everything linked when the status lookup failed", () => {
    const out = pruneStaleWaiting([snap([w("a", "missing"), w("social:review:t1"), w("social:task:t1")])], null);
    expect(keys(out)).toEqual(["a", "social:review:t1"]);
  });
});

describe("issueStatuses", () => {
  const ctxWith = (query: () => Promise<unknown>) => ({ db: { query } }) as never;

  it("maps found issues so closed and missing ones can be pruned", async () => {
    const ctx = ctxWith(async () => [{ id: "open", status: "in_review" }, { id: "done", status: "done" }]);
    const map = await issueStatuses(ctx, "c1", ["open", "done", "missing"]);
    expect(Object.fromEntries(map)).toEqual({ open: "in_review", done: "done" });
    expect(keys(pruneStaleWaiting([snap([w("a", "open"), w("b", "done"), w("c", "missing")])], map))).toEqual(["a"]);
  });

  it("rejects when the lookup throws (caller passes null and keeps rows)", async () => {
    await expect(issueStatuses(ctxWith(async () => { throw new Error("db down"); }), "c1", ["x"])).rejects.toThrow("db down");
  });
});
