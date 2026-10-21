import { describe, expect, it } from "vitest";
import { COMPANY_MEMORY_INSTRUCTION } from "@partnersinbiz/pib-plugin-kit";
import { PACK_AGENT_FILES, PACK_MANIFEST_JSON, PACK_SHARED_BLOCKS } from "../src/pack/data.generated.js";
import { loadPack, templateByKey, templateVars, MAX_INSTRUCTION_CHARS } from "../src/templates.js";
import { renderInstructions } from "../src/templates-render.js";
import { assertSkeleton, SKELETON_H2S } from "./helpers/skeleton.js";

describe("skeleton template (delivery-lead)", () => {
  it("renders with all skeleton H2s and passes structure validation", () => {
    const template = templateByKey("delivery-lead");
    expect(template, "delivery-lead template exists").toBeTruthy();
    expect(template?.skeleton, "delivery-lead.skeleton is true").toBe(true);

    const vars = templateVars({ company: "Acme Ltd", prefix: "ACM", owner: "Jo Owner", ceo: { name: "Boss", urlKey: "boss" } });
    const rendered = renderInstructions(template!, vars);

    // Verify it passes skeleton structure validation
    expect(() => assertSkeleton(rendered)).not.toThrow();

    // Verify character count is within limits
    expect(rendered.length, `rendered text should be <= ${MAX_INSTRUCTION_CHARS} chars`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);

    // Verify memory instruction is included
    expect(rendered).toContain(COMPANY_MEMORY_INSTRUCTION);
  });

  it("validates manifest entry for delivery-lead", () => {
    const pack = loadPack();
    const template = pack.templates.find((t) => t.key === "delivery-lead");
    expect(template, "delivery-lead entry exists").toBeTruthy();
    expect(template?.skeleton, "skeleton is true").toBe(true);
    expect(template?.scope, "scope is 'pib'").toBe("pib");
    expect(template?.evalFile, "evalFile is a string").toBeTruthy();
    expect(template?.distilled, "distilled is true").toBe(true);
  });

  it("assertSkeleton rejects missing H2", () => {
    const missingHeading = `## Identity and mission\n\nText here.\n\n## Reports to and escalation\n\nMore text.\n## Owns / never does\n\nSkips "Triggers and inputs"`;

    expect(() => assertSkeleton(missingHeading)).toThrow(/missing heading/);
  });

  it("assertSkeleton rejects duplicated H2", () => {
    const headings = SKELETON_H2S.slice();
    const text = headings.map((h) => `## ${h}\n\nContent`).join("\n\n") + "\n\n## Identity and mission\n\nDuplicate";

    expect(() => assertSkeleton(text)).toThrow(/duplicate|extra heading/);
  });

  it("assertSkeleton rejects out-of-order H2", () => {
    const headings = Array.from(SKELETON_H2S);
    [headings[0], headings[1]] = [headings[1], headings[0]]; // Swap first two
    const text = headings.map((h) => `## ${h}\n\nContent`).join("\n\n");

    expect(() => assertSkeleton(text)).toThrow(/out of order/);
  });

  it("assertSkeleton ignores H2 inside code fences", () => {
    const text = `## Identity and mission\n\nContent\n\n\`\`\`\n## Fake heading in fence\n\`\`\`\n\n## Reports to and escalation\n\n${Array.from(SKELETON_H2S)
      .slice(2)
      .map((h) => `## ${h}\n\nContent`)
      .join("\n\n")}`;

    expect(() => assertSkeleton(text)).not.toThrow();
  });
});
