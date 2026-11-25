/** The post preview's model: the text each platform gets, where its feed cuts it, and what it would refuse. */
import { describe, expect, it } from "vitest";
import { atHandle, foldText, previewModel, textParts } from "../src/ui/preview-model.js";

const image = { url: "https://cdn.test/a.jpg", kind: "image" };
const video = { url: "https://cdn.test/a.mp4", kind: "video" };

describe("previewModel", () => {
  it("uses the platform's own text, title and link when the post has them", () => {
    const source = { body: "Main text", overrides: { x: { text: "Short for X", link: "https://a.test/p" }, youtube: { title: "How we build" } }, media: [video] };
    expect(previewModel(source, "x")).toMatchObject({ text: "Short for X", link: "https://a.test/p", layout: "micro" });
    expect(previewModel(source, "linkedin")).toMatchObject({ text: "Main text", link: null, layout: "feed" });
    expect(previewModel(source, "youtube")).toMatchObject({ title: "How we build", layout: "video", problems: [] });
  });

  it("names what the platform would refuse", () => {
    expect(previewModel({ body: "x".repeat(300), media: [] }, "x").problems).toEqual(["20 characters over X's limit of 280."]);
    expect(previewModel({ body: "Hi", media: [] }, "instagram").problems).toEqual(["Instagram needs an image or video."]);
    expect(previewModel({ body: "Hi", media: [image] }, "tiktok").problems).toEqual(["TikTok needs a video."]);
    expect(previewModel({ body: "Hi", media: [image, image, image, image, image] }, "x").problems).toEqual(["X takes 4 media items; this post has 5."]);
    expect(previewModel({ body: "Hi", media: [image, image, image, image, image] }, "x").media).toHaveLength(4);
  });

  it("counts characters as the platforms do and copes with an unknown platform", () => {
    expect(previewModel({ body: "👍👍", media: [] }, "x").length).toBe(2);
    expect(previewModel({ body: "Hi", media: [] }, null)).toMatchObject({ platform: null, layout: "feed", problems: [], maxText: null });
  });
});

describe("foldText", () => {
  it("shows a short post whole", () => {
    expect(foldText("Short post", "linkedin")).toEqual({ shown: "Short post", cut: false });
  });

  it("cuts a long LinkedIn post at a word, near 210 characters", () => {
    const fold = foldText("word ".repeat(100).trim(), "linkedin");
    expect(fold.cut).toBe(true);
    expect(fold.shown.length).toBeLessThanOrEqual(210);
    expect(fold.shown.endsWith("word")).toBe(true);
  });

  it("cuts after a few lines, and never cuts X", () => {
    expect(foldText("a\nb\nc\nd\ne\nf\ng", "facebook")).toEqual({ shown: "a\nb\nc\nd\ne", cut: true });
    expect(foldText("a\nb\nc", "instagram")).toEqual({ shown: "a\nb", cut: true });
    expect(foldText("x".repeat(280), "x").cut).toBe(false);
  });
});

describe("textParts and atHandle", () => {
  it("marks tags, mentions and links", () => {
    expect(textParts("Hi @sam see https://a.test/x #BuildInPublic now")).toEqual([
      { kind: "text", value: "Hi " },
      { kind: "tag", value: "@sam" },
      { kind: "text", value: " see " },
      { kind: "link", value: "https://a.test/x" },
      { kind: "text", value: " " },
      { kind: "tag", value: "#BuildInPublic" },
      { kind: "text", value: " now" },
    ]);
    expect(textParts("mail me@a.test")).toEqual([{ kind: "text", value: "mail me@a.test" }]);
  });

  it("reads a handle saved as a name, an @name or a profile link", () => {
    expect(atHandle("pib")).toBe("@pib");
    expect(atHandle("@pib")).toBe("@pib");
    expect(atHandle("https://www.tiktok.com/@pib/")).toBe("@pib");
    expect(atHandle(" ")).toBeNull();
  });
});
