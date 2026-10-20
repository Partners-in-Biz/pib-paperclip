import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../src/unified-diff.js";

describe("applyUnifiedDiff", () => {
  it("rejects no-hunk diff", () => {
    const r = applyUnifiedDiff("x", "diff --git");
    expect(r.ok).toBe(false);
  });

  it("applies single-hunk replacement", () => {
    const r = applyUnifiedDiff("a\nb\nc\n", `@@ -1,3 +1,3 @@\n a\n-b\n+B\n c`);
    expect(r.ok && r.text).toBe("a\nB\nc\n");
  });

  it("applies insertion and deletion", () => {
    const r1 = applyUnifiedDiff("a\nc\n", `@@ -1,2 +1,3 @@\n a\n+b\n c`);
    expect(r1.ok && r1.text).toBe("a\nb\nc\n");
    const r2 = applyUnifiedDiff("a\nb\nc\n", `@@ -1,3 +1,2 @@\n a\n-b\n c`);
    expect(r2.ok && r2.text).toBe("a\nc\n");
  });

  it("applies multiple hunks", () => {
    const r = applyUnifiedDiff("a\nb\nc\nd\ne\n", `@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -4,2 +4,2 @@\n d\n-e\n+E`);
    expect(r.ok && r.text).toBe("a\nB\nc\nd\nE\n");
  });

  it("rejects context mismatch with hunk number", () => {
    const r = applyUnifiedDiff("a\nb\nc\n", `@@ -1,3 +1,3 @@\n a\n-x\n+b\n c`);
    expect(!r.ok && r.error).toContain("hunk 1");
  });

  it("rejects line count mismatch", () => {
    const r = applyUnifiedDiff("a\nb\n", `@@ -1,3 +1,2 @@\n a\n b`);
    expect(!r.ok && r.error).toContain("line counts");
  });

  it("rejects overlapping hunks", () => {
    const r = applyUnifiedDiff("a\nb\nc\nd\ne\n", `@@ -3,1 +3,1 @@\n-c\n+C\n@@ -1,2 +1,2 @@\n a\n-b\n+B`);
    expect(!r.ok && r.error).toContain("overlap");
  });

  it("preserves trailing newline", () => {
    const d = `@@ -1,2 +1,2 @@\n-a\n+x\n b`;
    const r1 = applyUnifiedDiff("a\nb\n", d);
    expect(r1.ok && r1.text.endsWith("\n")).toBe(true);
    const r2 = applyUnifiedDiff("a\nb", d);
    expect(r2.ok && !r2.text.endsWith("\n")).toBe(true);
  });

  it("handles CRLF", () => {
    const r = applyUnifiedDiff("a\nb\n", "---\r\n+++\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+B");
    expect(r.ok && r.text).toBe("a\nB\n");
  });

  it("handles empty lines", () => {
    const r = applyUnifiedDiff("a\n\nb\n", `@@ -1,3 +1,3 @@\n a\n\n b`);
    expect(r.ok && r.text).toBe("a\n\nb\n");
  });

  it("ignores backslash markers", () => {
    const r = applyUnifiedDiff("a\nb", `@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline`);
    expect(r.ok && r.text).toBe("a\nB");
  });

  it("inserts at start with oldCount=0", () => {
    const r = applyUnifiedDiff("a\n", `@@ -0,0 +1,2 @@\n+b\n+c`);
    expect(r.ok && r.text).toBe("b\nc\na\n");
  });

  it("inserts at end with oldCount=0", () => {
    const r = applyUnifiedDiff("a\nb\n", `@@ -2,0 +3,1 @@\n+c`);
    expect(r.ok && r.text).toBe("a\nb\nc\n");
  });

  it("truncates long error messages", () => {
    const l = "x".repeat(100);
    const r = applyUnifiedDiff(`${l}\nb\n`, `@@ -1,2 +1,2 @@\n-${l.slice(0, 80)}y\n+r\n b`);
    expect(!r.ok && r.error.length < 300).toBe(true);
  });

  it("accepts implicit count of 1", () => {
    const r = applyUnifiedDiff("a\nb\nc\n", `@@ -1 +1 @@\n-a\n+A`);
    expect(r.ok && r.text).toBe("A\nb\nc\n");
  });

  it("rejects hunk beyond file", () => {
    const r = applyUnifiedDiff("a\nb\n", `@@ -5,1 +5,1 @@\n-x\n+y`);
    expect(!r.ok && r.error).toContain("hunk");
  });

  it("handles multi-line replacement", () => {
    const r = applyUnifiedDiff("s\na\nb\nc\ne\n", `@@ -2,3 +2,1 @@\n-a\n-b\n-c\n+X`);
    expect(r.ok && r.text).toBe("s\nX\ne\n");
  });

  it("handles empty source", () => {
    const r = applyUnifiedDiff("", `@@ -0,0 +1,1 @@\n+a`);
    expect(r.ok && r.text).toBe("a\n");
  });
});
