import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_RULE, noMediaExempt, parseMediaRule, postNeedsMedia, type MediaExperiment } from "../src/index.js";

const exp: MediaExperiment = { id: "e1", status: "running", hypothesisType: "media", minPerArm: 3, noMediaPosts: 1 };

describe("parseMediaRule", () => {
  it("defaults to advise with no block", () => {
    expect(parseMediaRule("# playbook")).toEqual(DEFAULT_MEDIA_RULE);
    expect(parseMediaRule(null).enforce).toBe("advise");
    expect(DEFAULT_MEDIA_RULE.maxVideoSeconds).toBe(30);
  });
  it("reads enforce: block from the fenced block", () => {
    expect(parseMediaRule("## Media\n```media-rule\nenforce: block\n```\n").enforce).toBe("block");
  });
  it("ignores an unreadable value", () => {
    expect(parseMediaRule("```media-rule\nenforce: sometimes\n```").enforce).toBe("advise");
  });
  it("does not share arrays with the default", () => {
    parseMediaRule("").mediaPlatforms.push("x");
    expect(DEFAULT_MEDIA_RULE.mediaPlatforms).not.toContain("x");
  });
});

describe("postNeedsMedia", () => {
  it("needs media on LinkedIn, Instagram and Facebook unless text-native", () => {
    for (const p of ["linkedin", "instagram", "facebook"] as const) {
      expect(postNeedsMedia(DEFAULT_MEDIA_RULE, p, false)).toBe(true);
      expect(postNeedsMedia(DEFAULT_MEDIA_RULE, p, true)).toBe(false);
    }
  });
  it("treats X as text-first", () => {
    expect(postNeedsMedia(DEFAULT_MEDIA_RULE, "x", false)).toBe(false);
  });
});

describe("noMediaExempt", () => {
  const post = { experimentId: "e1", arm: "no_media" };
  it("exempts a no_media post in a running media experiment", () => {
    expect(noMediaExempt(post, exp)).toBe(true);
  });
  it("does not exempt a no_media tag on a non-media experiment", () => {
    expect(noMediaExempt(post, { ...exp, hypothesisType: "hook" })).toBe(false);
  });
  it("does not exempt a tag with no experiment", () => {
    expect(noMediaExempt({ arm: "no_media" }, null)).toBe(false);
    expect(noMediaExempt(post, null)).toBe(false);
    expect(noMediaExempt({ experimentId: "other", arm: "no_media" }, exp)).toBe(false);
  });
  it("does not exempt a measured experiment or another arm", () => {
    expect(noMediaExempt(post, { ...exp, status: "measured" })).toBe(false);
    expect(noMediaExempt({ experimentId: "e1", arm: "with_media" }, exp)).toBe(false);
  });
  it("caps exempt posts at minPerArm", () => {
    expect(noMediaExempt(post, { ...exp, noMediaPosts: 3 })).toBe(true);
    expect(noMediaExempt(post, { ...exp, noMediaPosts: 4 })).toBe(false);
  });
});
