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
});
