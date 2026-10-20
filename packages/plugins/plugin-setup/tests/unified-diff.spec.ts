import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../src/unified-diff.js";

describe("applyUnifiedDiff", () => {
  describe("basic patches", () => {
    it("single-hunk replace", () => {
      const raw = "line 1\nline 2\nline 3\n";
      const diff = `--- a/file
+++ b/file
@@ -2 +2 @@
-line 2
+modified line 2
`;
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("line 1\nmodified line 2\nline 3\n");
      }
    });

    it("multi-hunk add and remove", () => {
      const raw = "a\nb\nc\nd\ne\nf\n";
      const diff = `@@ -2 +2,2 @@
 b
+inserted
@@ -5 +6,2 @@
 e
+another
`;
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\nb\ninserted\nc\nd\ne\nanother\nf\n");
      }
    });

    it("pure insertion (old count 0)", () => {
      const raw = "line 1\nline 2\n";
      const diff = `@@ -1,0 +1,2 @@
+inserted before
+more
`;
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("inserted before\nmore\nline 1\nline 2\n");
      }
    });

    it("hunk-only input starting at @@", () => {
      const raw = "a\nb\nc\n";
      const diff = "@@ -2 +2 @@\n-b\n+B\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\nB\nc\n");
      }
    });
  });

  describe("error cases", () => {
    it("empty diff rejected", () => {
      const raw = "line 1\n";
      const diff = "";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("no @@ hunk");
      }
    });

    it("diff with no hunk header rejected", () => {
      const raw = "line 1\n";
      const diff = "--- a/file\n+++ b/file\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("no @@ hunk");
      }
    });

    it("context mismatch rejected with hunk number", () => {
      const raw = "line 1\nline 2\nline 3\n";
      const diff = "@@ -2 +2 @@\n-WRONG\n+replaced\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("hunk 1");
      }
    });

    it("wrong line number rejected", () => {
      const raw = "line 1\nline 2\n";
      const diff = "@@ -5 +5 @@\n-line\n+replaced\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("out of bounds");
      }
    });

    it("old line count mismatch rejected", () => {
      const raw = "line 1\nline 2\n";
      const diff = "@@ -1,3 +1 @@\n-line 1\n+replaced\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("expected 3 old lines");
      }
    });

    it("new line count mismatch rejected", () => {
      const raw = "line 1\nline 2\n";
      const diff = "@@ -1 +1,3 @@\n-line 1\n+replaced\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("expected 3 new lines");
      }
    });

    it("overlapping hunks rejected", () => {
      const raw = "a\nb\nc\nd\ne\n";
      const diff = `@@ -2,2 +2,2 @@
 b
-c
+C
@@ -2,2 +2,2 @@
 b
-c
+C
`;
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("overlap");
      }
    });

    it("out-of-order hunks rejected", () => {
      const raw = "a\nb\nc\nd\ne\n";
      const diff = `@@ -4 +4 @@
-d
+D
@@ -2 +2 @@
-b
+B
`;
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("overlap");
      }
    });

    it("invalid line prefix rejected", () => {
      const raw = "line 1\n";
      const diff = "@@ -1 +1 @@\n?invalid\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("invalid line prefix");
      }
    });

    it("diff over 200_000 chars rejected", () => {
      const raw = "x";
      const diff = "@@ -1 +1 @@\n-x\n+" + "y".repeat(200_001) + "\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("exceeds 200_000");
      }
    });
  });

  describe("line ending preservation", () => {
    it("trailing newline preserved", () => {
      const raw = "line 1\nline 2\n";
      const diff = "@@ -1 +1 @@\n-line 1\n+modified\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text.endsWith("\n")).toBe(true);
      }
    });

    it("no trailing newline preserved", () => {
      const raw = "line 1\nline 2";
      const diff = "@@ -2 +2 @@\n-line 2\n+modified\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text.endsWith("\n")).toBe(false);
      }
    });

    it("CRLF in raw, LF in diff normalized correctly", () => {
      const raw = "line 1\r\nline 2\r\n";
      const diff = "@@ -1 +1 @@\r\n-line 1\r\n+modified\r\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("modified\nline 2\n");
        expect(result.text).not.toContain("\r");
      }
    });
  });

  describe("edge cases", () => {
    it("empty line as context", () => {
      const raw = "a\n\nc\n";
      const diff = "@@ -2 +2 @@\n \n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\n\nc\n");
      }
    });

    it("removes empty line correctly", () => {
      const raw = "a\n\nc\n";
      const diff = "@@ -2 +0,0 @@\n-\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\nc\n");
      }
    });

    it("default count of 1 when omitted", () => {
      const raw = "a\nb\nc\n";
      const diff = "@@ -2 +2 @@\n-b\n+B\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\nB\nc\n");
      }
    });

    it("skips No newline marker", () => {
      const raw = "line 1\nline 2";
      const diff = "@@ -2 +2 @@\n-line 2\n+modified\n\\ No newline at end of file\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("line 1\nmodified");
      }
    });

    it("multiple additions in a row", () => {
      const raw = "a\nc\n";
      const diff = "@@ -1,0 +1,2 @@\n+a\n+b\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("a\nb\na\nc\n");
      }
    });

    it("multiple removals in a row", () => {
      const raw = "a\nb\nc\n";
      const diff = "@@ -1,2 +0,0 @@\n-a\n-b\n";
      const result = applyUnifiedDiff(raw, diff);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("c\n");
      }
    });
  });
});
