import { describe, expect, it } from "vitest";
import { spaceOf } from "../src/space.js";

describe("spaceOf", () => {
  it("defaults to the company and accepts me", () => {
    expect(spaceOf({})).toBe("company");
    expect(spaceOf({ space: "company" })).toBe("company");
    expect(spaceOf({ space: "me" })).toBe("me");
  });
  it("refuses anything else instead of falling back to the company", () => {
    expect(() => spaceOf({ space: "team" })).toThrow(/space must be/);
  });
});

describe("social.load in My Social", () => {
  it("returns the personal space and reads only personal rows", async () => {
    const { fakeCtx } = await import("./helpers.js");
    const { loadSnapshot } = await import("../src/service.js");
    const seen: string[] = [];
    const ctx = fakeCtx({}, { queryResult: (sql: string) => { seen.push(sql); return []; } });
    const viewer = { companyId: "co", userId: "u1", agentId: null, runId: null, isAgent: false };
    const snap = await loadSnapshot(ctx, viewer, { space: "me" });
    expect(snap.space).toBe("me");
    for (const table of ["accounts", "posts", "media_assets", "rss_feeds", "inbox_items", "templates"]) {
      const reads = seen.filter((s) => s.includes(`.${table} `) && s.trim().toUpperCase().startsWith("SELECT"));
      expect(reads.length, table).toBeGreaterThan(0);
      for (const sql of reads) expect(sql, `${table}: ${sql.slice(0, 80)}`).toContain("scope = 'personal'");
    }
  });

  it("the worker hands the space to the snapshot", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")).toContain("space: p.space");
  });
});
