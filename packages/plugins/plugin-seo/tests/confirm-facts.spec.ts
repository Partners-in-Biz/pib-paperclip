import { describe, expect, it } from "vitest";
import { normalizeVisibleText, normalizeWording, wordingAppearsInText } from "../src/service/page-text.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("normalizeVisibleText", () => {
  it("removes script and style tags", () => {
    const html = "<p>visible</p><script>code</script><p>text</p>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("code");
    expect(result).toContain("visible");
    expect(result).toContain("text");
  });

  it("removes hidden div content", () => {
    const html = "<p>visible</p><div hidden>hidden content</div>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("hidden content");
    expect(result).toContain("visible");
  });

  it("removes aria-hidden elements", () => {
    const html = "<p>visible</p><p aria-hidden='true'>skip this</p>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("skip this");
  });

  it("removes inline display:none", () => {
    const html = "<p>visible</p><p style='display:none'>hidden</p>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("hidden");
  });

  it("removes noscript blocks", () => {
    const html = "<p>page</p><noscript>JS disabled</noscript>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("JS disabled");
  });

  it("decodes HTML entities", () => {
    const html = "<p>&nbsp;&#160;&amp;&lt;&quot;&rsquo;&ldquo;</p>";
    const result = normalizeVisibleText(html);
    expect(result).toContain("&");
    expect(result).toContain("<");
    expect(result).toContain('"');
  });

  it("folds curly quotes and dashes", () => {
    const html = "<p>It's called “fancy” and costs R500–15</p>";
    const result = normalizeVisibleText(html);
    expect(result).toContain("'");
    expect(result).toContain('"');
  });

  it("collapses whitespace", () => {
    const html = "<p>Multiple    spaces    and\n\nnewlines</p>";
    const result = normalizeVisibleText(html);
    expect(result).toBe("Multiple spaces and newlines");
  });

  it("removes entire head section including title and meta tags", () => {
    const html = "<head><title>Page Title</title><meta name='desc' content='description'></head><body><p>visible</p></body>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("Page Title");
    expect(result).not.toContain("description");
    expect(result).toContain("visible");
  });

  it("removes HTML comments including multiline and comments with >", () => {
    const html = "<p>start</p><!-- single line comment --><p>middle</p><!-- multi\nline\ncomment --><p>end</p><!-- comment with > inside -->";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("single line comment");
    expect(result).not.toContain("multi");
    expect(result).not.toContain("comment with >");
    expect(result).toContain("start");
    expect(result).toContain("middle");
    expect(result).toContain("end");
  });

  it("removes svg elements and their content", () => {
    const html = "<p>before</p><svg><circle cx='50' cy='50' r='40'></circle></svg><p>after</p>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("circle");
    expect(result).not.toContain("50");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("handles void/self-closing elements with hidden attribute correctly", () => {
    const html = "<div>before</div><input hidden><div>after</div>";
    const result = normalizeVisibleText(html);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("input");
  });

  it("handles nested hidden elements and respects nesting stack", () => {
    const html = "<div hidden><p>hidden paragraph</p><span>also hidden</span></div><p>visible</p>";
    const result = normalizeVisibleText(html);
    expect(result).not.toContain("hidden paragraph");
    expect(result).not.toContain("also hidden");
    expect(result).toContain("visible");
  });

  it("handles display:none on void elements without affecting subsequent text", () => {
    const html = "<div aria-hidden='true'><br></div>after";
    const result = normalizeVisibleText(html);
    expect(result).toContain("after");
    expect(result).not.toContain("br");
  });

  it("reads realistic FAQ fixture", () => {
    const fixturePath = resolve("tests/fixtures/faq.html");
    const html = readFileSync(fixturePath, "utf-8");
    const result = normalizeVisibleText(html);
    expect(result).toContain("Pricing & Fees");
    expect(result).toContain("free delivery");
    expect(result).toContain("best price");
    expect(result).toContain("R500");
    expect(result).not.toContain("hidden content");
    expect(result).not.toContain("JSON-LD");
  });
});

describe("normalizeWording", () => {
  it("decodes entities in text", () => {
    const result = normalizeWording("We &amp; they");
    expect(result).toContain("&");
  });

  it("folds quotes and dashes", () => {
    const result = normalizeWording("It’s “great”, cost R100–1000");
    expect(result).toContain("'");
  });

  it("collapses whitespace", () => {
    const result = normalizeWording("Multiple   spaces  \n  newlines");
    expect(result).toBe("Multiple spaces newlines");
  });
});

describe("wordingAppearsInText", () => {
  it("finds exact substring with word boundaries", () => {
    const text = "We offer free delivery on all orders within 3 days.";
    const normalized = normalizeWording("free delivery");
    expect(wordingAppearsInText(normalized, text)).toBe(true);
  });

  it("respects word boundaries: no match inside words", () => {
    const text = "This is wonderful and great.";
    const wording = normalizeWording("under");
    expect(wordingAppearsInText(wording, text)).toBe(false);
  });

  it("finds substring at start and end", () => {
    const wording1 = normalizeWording("We offer");
    const wording2 = normalizeWording("within 3 days");
    const text = "We offer free delivery within 3 days.";
    expect(wordingAppearsInText(wording1, text)).toBe(true);
    expect(wordingAppearsInText(wording2, text)).toBe(true);
  });

  it("returns false for empty wording", () => {
    expect(wordingAppearsInText("", "any text")).toBe(false);
  });

  it("returns false for wording longer than text", () => {
    expect(wordingAppearsInText("very long text", "short")).toBe(false);
  });
});

describe("confirm-client-facts tool", () => {
  it("is registered in dispatch", async () => {
    const { HANDLERS } = await import("../src/dispatch.js");
    expect(HANDLERS["confirm-client-facts"]).toBeDefined();
  });

  it("is declared in tools with correct schema", async () => {
    const { SEO_TOOL_DECLARATIONS } = await import("../src/tools.js");
    const confirmTool = SEO_TOOL_DECLARATIONS.find((t) => t.name === "confirm-client-facts");
    expect(confirmTool).toBeDefined();
    expect(confirmTool?.group).toBe("Site");
    expect(confirmTool?.parametersSchema.required).toEqual(["sprintId"]);
    expect(confirmTool?.parametersSchema.additionalProperties).toBe(false);
    const props = (confirmTool?.parametersSchema.properties as Record<string, Record<string, unknown>>) ?? {};
    expect(props.sprintId?.type).toBe("string");
  });
});
