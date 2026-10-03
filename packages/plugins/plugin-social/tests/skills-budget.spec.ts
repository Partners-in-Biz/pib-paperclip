/**
 * 0.8.0: the two Social skills stay within the 18,000 character budget (the host copy carries the appended memory section too, so
 * the files here already include it), and the reference material that does not fit moves into each skill's references.
 */
import { describe, expect, it } from "vitest";
import { SKILLS } from "../src/skills.js";
import { SOCIAL_TOOLS } from "../src/tools.js";

const BUDGET = 18_000;
const skill = (key: string) => SKILLS.find((s) => s.skillKey === key)!;
const reference = (key: string, path: string) => skill(key).files!.find((f) => f.path === path)!.content;

describe("skill budget", () => {
  it("every skill is under 18,000 characters, with room left", () => {
    for (const s of SKILLS) {
      expect(s.markdown.length, `${s.skillKey} is ${s.markdown.length}`).toBeLessThanOrEqual(BUDGET);
      expect(s.markdown.length, `${s.skillKey} leaves no headroom`).toBeLessThanOrEqual(BUDGET - 1_000);
    }
  });

  it("references carry what does not fit, and each stays a readable size", () => {
    for (const s of SKILLS) for (const file of s.files ?? []) expect(file.content.length, `${s.skillKey}/${file.path}`).toBeLessThan(16_000);
    expect(skill("social-publish").files!.map((f) => f.path)).toEqual(["references/approvals.md"]);
    expect(skill("social-content").files!.map((f) => f.path)).toEqual(["references/platforms.md", "references/media-studio.md"]);
  });

  it("every skill points at the references it needs", () => {
    expect(skill("social-publish").markdown).toContain("references/approvals.md");
    expect(skill("social-publish").markdown).toContain("references/media-studio.md");
    expect(skill("social-content").markdown).toContain("references/media-studio.md");
    expect(skill("social-content").markdown).toContain("pib-media-studio");
  });
});

describe("what the skills tell agents", () => {
  it("names every tool, so a tool is never missing from the guidance", () => {
    const publish = skill("social-publish").markdown;
    for (const tool of SOCIAL_TOOLS) expect(publish, tool.name).toContain(tool.name);
  });

  it("agents never approve, never change a policy, and never send the client's email", () => {
    const publish = skill("social-publish").markdown;
    expect(publish).toContain("You never approve, and never change who approves");
    expect(publish).toContain("Mailbox DRAFT");
    expect(publish).toContain("never send it");
    const approvals = reference("social-publish", "references/approvals.md");
    expect(approvals).toContain("**Never send it**");
    expect(approvals).toContain("You may not approve, record a client approval or change a policy");
    expect(approvals).toContain("auto-approval is off");
    expect(approvals).toContain("A link made for an older version of the post does not count");
  });

  it("the client's link is the client's: an agent never answers it, and the draft goes to the Account Manager by default", () => {
    const approvals = reference("social-publish", "references/approvals.md");
    expect(approvals).toContain("Never open it to answer, and never submit its form");
    expect(approvals).toContain("Normally the call itself opens the drafting task for the Account Manager");
    expect(approvals).not.toContain("With no mailbox delegation, call");
    const tool = SOCIAL_TOOLS.find((t) => t.name === "request-client-approval")!;
    expect(JSON.stringify(tool.parametersSchema)).toContain("Leave it out: the plugin opens a drafting task for the Account Manager");
  });

  it("connecting an account tells the agent the plugin wakes it, and how to pass the effect", () => {
    const publish = skill("social-publish").markdown;
    expect(publish).toContain("connect-account");
    expect(publish).toContain("When the account is connected the plugin comments on your issue and wakes you: do not poll");
  });

  it("the media studio describes the production workflow without any provider dependency", () => {
    const media = reference("social-content", "references/media-studio.md");
    for (const must of ["get-client-profile", "brand.json", "1080x1350", "1080x1920", "ffmpeg", "list-issue-attachments", "import-media-from-attachment", "para4-asset-generator.zip", "Never hotlink", "never required", "Attach each file to the issue"]) {
      expect(media, must).toContain(must);
    }
    // The client's brand kit in the CRM profile comes first; the client's own site is only the fallback for what it lacks.
    for (const field of ["primaryColor", "secondaryColor", "accentColor", "fonts", "logoKey", "toneExamples", "missingBrand", "r2Key"]) expect(media, field).toContain(field);
    expect(media.indexOf("Use those first")).toBeGreaterThan(-1);
    expect(media.indexOf("Use those first")).toBeLessThan(media.indexOf("take it from the client's own site"));
    expect(media).not.toContain("until the CRM client profile has colour and logo fields");
    // Generation tools are optional: nothing says to sign up for or buy one.
    expect(media).not.toMatch(/sign up|api key|subscribe|purchase/i);
    expect(media).toContain("If it does not, write exact, paste-ready prompts");
    // The shell blocks survived the template literal (a stray backslash would break a copied command).
    expect(media).toContain('ffmpeg -y -framerate 1/3 -i out/slide-%02d.png -vf "scale=1080:1920,format=yuv420p" -r 30 \\\n  -c:v libx264');
    expect(media).toContain("```");
    expect(media).not.toContain("\\`");
  });
});
