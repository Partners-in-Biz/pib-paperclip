import { describe, expect, it } from "vitest";
import { holdsUpCounts, readHoldsUp, type BlockEdge } from "../src/holds-up.js";
import { hostWaiting, mergeWaiting, type WaitingAskInfo } from "../src/merge.js";

const e = (from: string, to: string, toOpen = true): BlockEdge => ({ from, to, toOpen });

describe("holdsUpCounts", () => {
  it("counts a PAR-3928-shaped tree: 1 blocker, 17 blocked over two levels", () => {
    const edges: BlockEdge[] = [];
    for (let i = 0; i < 5; i++) edges.push(e("root", `a${i}`));
    for (let i = 0; i < 12; i++) edges.push(e(`a${i % 5}`, `b${i}`));
    expect(holdsUpCounts(["root", "a0"], edges).get("root")).toBe(17);
  });
  it("does not count closed issues and counts a diamond once", () => {
    const edges = [e("r", "x"), e("r", "y"), e("x", "z"), e("y", "z"), e("r", "done", false)];
    expect(holdsUpCounts(["r"], edges).get("r")).toBe(3);
  });
  it("does not walk past a closed issue", () => {
    expect(holdsUpCounts(["r"], [e("r", "x", false), e("x", "y"), e("r", "z")]).get("r")).toBe(1);
  });
  it("terminates on a relation cycle", () => {
    expect(holdsUpCounts(["a"], [e("a", "b"), e("b", "c"), e("c", "a")]).get("a")).toBe(2);
  });
  it("readHoldsUp reads through the db and falls back to empty on error", async () => {
    const ok = { db: { query: async () => [{ from_id: "r", to_id: "x", open: true }] } } as never;
    expect((await readHoldsUp(ok, "c", ["r"])).get("r")).toBe(1);
    const bad = { db: { query: async () => { throw new Error("x"); } } } as never;
    expect((await readHoldsUp(bad, "c", ["r"])).size).toBe(0);
  });
});

describe("waiting ranking", () => {
  const issue = (id: string, holdsUp: number, createdAt: string) => ({ id, identifier: `PAR-${id}`, title: id, status: "todo", updatedAt: createdAt, createdAt, holdsUp, ageHours: 5 });
  it("ranks the item holding up the most first, then oldest, with its fields", () => {
    const host = { source: "host", items: hostWaiting({ myIssues: [issue("old", 0, "2026-01-01T00:00:00Z"), issue("3928", 17, "2026-10-01T00:00:00Z"), issue("new", 0, "2026-10-02T00:00:00Z")] }) };
    const out = mergeWaiting([host]);
    expect(out.map((o) => o.issueId)).toEqual(["3928", "old", "new"]);
    expect(out[0]!.rank).toMatchObject({ holdsUp: 17, identifier: "PAR-3928", link: "/issues/PAR-3928", ageHours: 5 });
    expect(out[0]!.rank!.recommended).toBeTruthy();
  });
  it("ranks an escalated ask above a bigger holds-up", () => {
    const ask: WaitingAskInfo = { id: "a", kind: "decision", question: "q", options: [], why: null, askedBy: null, askedAt: "2026-10-01T00:00:00Z", dueBy: null, clientName: null, escalatedAt: "2026-10-02T00:00:00Z" };
    const host = { source: "host", items: hostWaiting({ myIssues: [issue("big", 17, "2026-10-01T00:00:00Z")] }) };
    const asks = { source: "asks", items: [{ key: "ask:a", title: "q", why: "w", kind: "judgement" as const, issueId: "ia", ask }] };
    expect(mergeWaiting([host, asks]).map((o) => o.key)).toEqual(["ask:a", "issue:big"]);
  });
});
