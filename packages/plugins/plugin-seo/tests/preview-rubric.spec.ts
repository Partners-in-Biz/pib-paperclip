import { describe, expect, it } from "vitest";
import { previewCopy, rubricLines, scorePreviewCopy } from "../src/engine/rubric.js";

describe("preview copy rubric", () => {
  it("returns null when the preview carries no copy", () => {
    expect(previewCopy({ css: "body{color:red}" })).toBeNull();
    expect(scorePreviewCopy({ css: "body{color:red}" })).toBeNull();
  });

  it("reads the headline first, then the description and the body text without markup", () => {
    const copy = previewCopy({ h1: "Why do bakeries lose orders?", metaDescription: "Fix it.", bodyHtml: "<p>Call us today.</p><script>x()</script>" });
    expect(copy?.split("\n")[0]).toBe("Why do bakeries lose orders?");
    expect(copy).toContain("Call us today.");
    expect(copy).not.toContain("<p>");
    expect(copy).not.toContain("x()");
  });

  it("scores a strong page above a flat one and says what is missing", () => {
    const strong = scorePreviewCopy({ h1: "Why do 3 in 4 bakeries lose orders?", bodyHtml: "<p>Book a free call and we fix your listing.</p>" })!;
    const flat = scorePreviewCopy({ title: "Welcome to our company website where we offer many different services to customers", bodyHtml: "<p>Information.</p>" })!;
    expect(strong.score).toBeGreaterThan(flat.score);
    expect(flat.notes.join(" ")).toMatch(/no ask|no hook|first line/i);
    expect(rubricLines(flat)[0]).toContain(`${flat.score}/100`);
  });

  it("advises only: a failing score has no blockers of its own", () => {
    const r = scorePreviewCopy({ h1: "Welcome" })!;
    expect(r.pass).toBe(false);
    expect(r.blockers).toEqual([]);
  });
});
