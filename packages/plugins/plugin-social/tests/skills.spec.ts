/** PAR-4162: the pib-creative-studio skill and the media paragraph in social-content. */
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { DESIRED_SKILLS, SKILLS } from "../src/skills.js";
import { SOCIAL_TOOLS } from "../src/tools.js";

const skill = (key: string) => SKILLS.find((s) => s.skillKey === key)!;
const studio = skill("creative-studio");

describe("pib-creative-studio", () => {
  it("is a managed skill, desired and declared by the manifest", () => {
    expect(studio.slug).toBe("pib-creative-studio");
    expect(DESIRED_SKILLS).toContain("plugin/partnersinbiz-social/creative-studio");
    expect(manifest.skills?.map((s) => s.skillKey)).toContain("creative-studio");
    expect(studio.markdown).toContain("name: pib-creative-studio");
  });

  it("stays within the skill budget", () => {
    expect(studio.markdown.length).toBeLessThanOrEqual(17_000);
  });

  it("walks brief, storyboard, render, R2, Drive and attach, in that order", () => {
    const md = studio.markdown;
    const at = ["**Brief.**", "**Storyboard.**", "**Render.**", "**Store on R2.**", "**Drive.**", "**Attach to the post.**"].map((h) => md.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("every tool it names is a registered Social tool (or a named tool of another plugin)", () => {
    const registered = new Set(SOCIAL_TOOLS.map((t) => t.name));
    const named = [...studio.markdown.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!);
    const other = new Set(["get-client-profile", "media-rule"]);
    expect(named.filter((n) => !registered.has(n) && !other.has(n))).toEqual([]);
    for (const tool of ["request-creative", "import-media-from-attachment", "update-post", "validate-post", "request-review"]) expect(named).toContain(tool);
  });

  it("never lets the agent approve, schedule or publish, and keeps the scope", () => {
    expect(studio.markdown).toContain("You do not approve, schedule or publish");
    expect(studio.markdown).toContain("Never use another scope's");
    expect(studio.markdown).toContain("30 seconds");
    expect(studio.markdown).toContain("alt text");
  });
});

describe("social-content media paragraph", () => {
  it("states the playbook media rule and points at the studio skill", () => {
    const md = skill("social-content").markdown;
    expect(md).toContain("**The media rule.**");
    expect(md).toContain("`media-rule`");
    expect(md).toContain("`request-creative`");
    expect(md).toContain("`pib-creative-studio`");
    const ref = skill("social-content").files!.find((f) => f.path === "references/media-studio.md")!.content;
    expect(ref).toContain("`request-creative`");
  });
});
