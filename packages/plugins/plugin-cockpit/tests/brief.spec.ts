import { describe, expect, it } from "vitest";
describe("listUserIssues paging", () => {
  const mk = (n: number, total: number) => ({
    db: { query: async (_sql: string, p: unknown[]) => {
      const off = Number(p[3]); const lim = Number(p[2]);
      return Array.from({ length: Math.max(0, Math.min(lim, n - off)) }, (_, i) => ({ id: `i${off + i}`, title: "t", status: "todo", total: String(total) }));
    } },
    logger: { info() {} },
  }) as never;
  it("lists all 120 and reports the total", async () => {
    const { listUserIssues } = await import("../src/brief.js");
    const r = await listUserIssues(mk(120, 120), "c", "u");
    expect(r.items).toHaveLength(120);
    expect(r).toMatchObject({ total: 120, more: false });
  });
  it("stops at the ceiling and flags more not shown", async () => {
    const { listUserIssues } = await import("../src/brief.js");
    const r = await listUserIssues(mk(700, 700), "c", "u");
    expect(r.items).toHaveLength(500);
    expect(r).toMatchObject({ total: 700, more: true });
  });
  it("exactly 500 is complete, not more", async () => {
    const { listUserIssues } = await import("../src/brief.js");
    const r = await listUserIssues(mk(500, 500), "c", "u");
    expect(r).toMatchObject({ total: 500, more: false });
    expect(r.items).toHaveLength(500);
  });
  it("keeps pages already read when a later page fails", async () => {
    const { listUserIssues } = await import("../src/brief.js");
    let calls = 0;
    const ctx = { db: { query: async (_s: string, p: unknown[]) => {
      if (++calls > 1) throw new Error("x");
      return Array.from({ length: 100 }, (_, i) => ({ id: `i${Number(p[3]) + i}`, title: "t", status: "todo", total: "250" }));
    } }, logger: { info() {} } } as never;
    const r = await listUserIssues(ctx, "c", "u");
    expect(r.items).toHaveLength(100);
    expect(r).toMatchObject({ total: 250, more: true });
  });
  it("lists a row once when pages overlap", async () => {
    const { listUserIssues } = await import("../src/brief.js");
    let calls = 0;
    const ctx = { db: { query: async () => {
      calls++;
      return calls === 1 ? [{ id: "a", title: "t", status: "todo", total: "3" }, { id: "b", title: "t", status: "todo", total: "3" }] : [{ id: "b", title: "t", status: "todo", total: "3" }];
    } }, logger: { info() {} } } as never;
    expect((await listUserIssues(ctx, "c", "u")).items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
