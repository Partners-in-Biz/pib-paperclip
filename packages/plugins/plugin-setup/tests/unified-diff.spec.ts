import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../src/unified-diff.js";

describe("applyUnifiedDiff", () => {
  it.each<[string, string, string, string]>([
    ["no-hunk", "x", "diff --git", ""],
    ["context mismatch", "a\nb\nc\n", `@@ -1,3 +1,3 @@\n a\n-x\n+b\n c`, "hunk 1"],
    ["line count mismatch", "a\nb\n", `@@ -1,3 +1,2 @@\n a\n b`, "line counts"],
    ["overlapping hunks", "a\nb\nc\nd\ne\n", `@@ -3,1 +3,1 @@\n-c\n+C\n@@ -1,2 +1,2 @@\n a\n-b\n+B`, "overlap"],
    ["hunk beyond file", "a\nb\n", `@@ -5,1 +5,1 @@\n-x\n+y`, "hunk"],
  ])("rejects %s", (_, src, diff, expected) => {
    const r = applyUnifiedDiff(src, diff);
    const msg = !r.ok ? r.error : "";
    expect(msg).toContain(expected);
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

  it("handles multi-line replacement", () => {
    const r = applyUnifiedDiff("s\na\nb\nc\ne\n", `@@ -2,3 +2,1 @@\n-a\n-b\n-c\n+X`);
    expect(r.ok && r.text).toBe("s\nX\ne\n");
  });

  it("handles empty source", () => {
    const r = applyUnifiedDiff("", `@@ -0,0 +1,1 @@\n+a`);
    expect(r.ok && r.text).toBe("a\n");
  });

  it("single-hunk diff ending in newline", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const diff = "--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-b\n+B\n";
    const r = applyUnifiedDiff(base, diff);
    expect(r.ok && r.text).toBe("a\nB\nc\nd\ne\nf\ng\nh\n");
  });

  it("multi-hunk diff ending in newline", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const diff = "--- a/f\n+++ b/f\n@@ -2,1 +2,1 @@\n-b\n+B\n@@ -5,1 +5,1 @@\n-e\n+E\n";
    const r = applyUnifiedDiff(base, diff);
    expect(r.ok && r.text).toBe("a\nB\nc\nd\nE\nf\ng\nh\n");
  });

  it("hunk 1 adds lines, hunk 2 applies after offset", () => {
    const base = "a\nb\nc\nd\ne\nf\n";
    const diff = `@@ -1,2 +1,4 @@\n a\n+X\n+Y\n b\n@@ -5,2 +7,2 @@\n e\n-f\n+F`;
    const r = applyUnifiedDiff(base, diff);
    expect(r.ok && r.text).toBe("a\nX\nY\nb\nc\nd\ne\nF\n");
  });

  it("hunk 1 removes lines, hunk 2 applies after offset", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const diff = `@@ -1,4 +1,2 @@\n a\n-b\n-c\n d\n@@ -6,2 +4,2 @@\n f\n-g\n+G`;
    const r = applyUnifiedDiff(base, diff);
    expect(r.ok && r.text).toBe("a\nd\ne\nf\nG\nh\n");
  });

  it("applies real git diff output", () => {
    const base = "line1\nline2\nline3\nline4\nline5\n";
    // Real git diff has --- and +++ lines that precede the @@
    const realDiff = "--- a/test.txt\n+++ b/test.txt\n@@ -1,5 +1,5 @@\n line1\n-line2\n+line2-modified\n line3\n line4\n line5";
    const r = applyUnifiedDiff(base, realDiff);
    expect(r.ok && r.text).toBe("line1\nline2-modified\nline3\nline4\nline5\n");
  });

  it("rejects hunk with context mismatch when preceded by offset-changing hunk", () => {
    const base = "a\nb\nc\nd\ne\n";
    // Hunk 1 adds a line at position 1, changing offsets; hunk 2 has wrong context.
    const diff = `@@ -1,1 +1,2 @@\n a\n+X\n@@ -3,1 +4,1 @@\n-WRONG\n+c`;
    const r = applyUnifiedDiff(base, diff);
    expect(!r.ok && r.error.includes("does not apply")).toBe(true);
  });
});
