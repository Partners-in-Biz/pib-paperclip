import { describe, expect, it } from "vitest";
import { approvalEmail } from "../src/engine/approval-email.js";
import { checkWhy, fallbackWhy, whyOf } from "../src/engine/why.js";

describe("why sentence", () => {
  it("accepts a plain sentence and trims it", () => {
    expect(checkWhy("  A clearer title should help people find this page.  ").why).toBe("A clearer title should help people find this page.");
    expect(checkWhy(undefined)).toEqual({});
  });
  it("refuses promises, percentages and essays", () => {
    expect(checkWhy("This will rank number one on Google.").error).toMatch(/promises/);
    expect(checkWhy("Traffic goes up 40% after this.").error).toMatch(/promises/);
    expect(checkWhy("We guarantee more sales.").error).toMatch(/promises/);
    expect(checkWhy("One. Two. Three.").error).toMatch(/one sentence/);
    expect(checkWhy("x".repeat(400)).error).toMatch(/characters/);
  });
  it("falls back to a sentence from what changed", () => {
    expect(fallbackWhy({ title: "t" })).toMatch(/title and description/);
    expect(fallbackWhy({ bodyHtml: "<p>x</p>" })).toMatch(/copy/);
    expect(whyOf({ title: "t", why: "Names the product so shoppers find it." })).toBe("Names the product so shoppers find it.");
    expect(whyOf({ title: "t" })).toBe(fallbackWhy({ title: "t" }));
  });
  it("prints it under each page in the email, escaped", () => {
    const m = approvalEmail({ siteName: "S", firstNames: ["E"], pages: [{ title: "Home", pageUrl: "https://s.co/", link: "https://p/x", why: "Helps <b>people</b> find it." }, { title: "About", pageUrl: "https://s.co/a", link: "https://p/y" }], openDays: 30, signature: "PiB" });
    expect(m.text).toContain("   https://p/x\n   Why: Helps <b>people</b> find it.");
    expect(m.html).toContain("Why: Helps &lt;b&gt;people&lt;/b&gt; find it.");
    expect(m.text.match(/Why:/g)).toHaveLength(1);
  });
});
