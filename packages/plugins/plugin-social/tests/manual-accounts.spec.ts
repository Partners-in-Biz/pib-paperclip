import { describe, expect, it } from "vitest";
import { rollupPostStatus } from "../src/domain.js";
import { cleanHandle } from "../src/manual.js";
import { composeIntent, manualExternalId } from "../src/platforms.js";

describe("composeIntent: the platform's own composer for a hand-posted destination", () => {
  it("puts the text in the box where the platform documents a share link", () => {
    expect(composeIntent("x", { text: "Hello & welcome" })).toEqual({ url: "https://x.com/intent/post?text=Hello%20%26%20welcome", prefilled: true, mediaByHand: true });
    expect(composeIntent("linkedin", { text: "Hi" }).url).toBe("https://www.linkedin.com/feed/?shareActive=true&text=Hi");
    expect(composeIntent("threads", { text: "Hi", link: "https://a.example/x" }).url).toBe("https://www.threads.net/intent/post?text=Hi&url=https%3A%2F%2Fa.example%2Fx");
    expect(composeIntent("bluesky", { text: "Hi" }).url).toBe("https://bsky.app/intent/compose?text=Hi");
    expect(composeIntent("mastodon", { text: "Hi", instanceUrl: "https://fosstodon.org/" }).url).toBe("https://fosstodon.org/share?text=Hi");
  });

  it("adds the link to the text once", () => {
    expect(composeIntent("x", { text: "Read this", link: "https://a.example" }).url).toBe(`https://x.com/intent/post?text=${encodeURIComponent("Read this\n\nhttps://a.example")}`);
    expect(composeIntent("x", { text: "Read https://a.example", link: "https://a.example" }).url).toBe(`https://x.com/intent/post?text=${encodeURIComponent("Read https://a.example")}`);
  });

  it("opens the upload page, not prefilled, where the platform has no share link", () => {
    for (const platform of ["tiktok", "youtube", "instagram", "dribbble"] as const) {
      const intent = composeIntent(platform, { text: "A caption" });
      expect(intent.prefilled).toBe(false);
      expect(intent.mediaByHand).toBe(true);
      expect(intent.url).not.toContain("caption");
    }
    expect(composeIntent("tiktok", { text: "x" }).url).toBe("https://www.tiktok.com/upload");
  });

  it("Facebook shares a link only; Reddit and Pinterest take their own fields", () => {
    expect(composeIntent("facebook", { text: "Hi", link: "https://a.example" })).toEqual({ url: "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fa.example", prefilled: false, mediaByHand: true });
    expect(composeIntent("facebook", { text: "Hi" }).url).toBe("https://www.facebook.com/");
    expect(composeIntent("reddit", { text: "Body\nmore", title: "A title", subreddit: "r/smallbusiness" }).url).toBe(`https://www.reddit.com/r/smallbusiness/submit?title=A%20title&type=TEXT&text=${encodeURIComponent("Body\nmore")}`);
    expect(composeIntent("pinterest", { text: "Pin", imageUrl: "https://cdn.example/a.png", link: "https://a.example" })).toEqual({
      url: "https://www.pinterest.com/pin/create/button/?media=https%3A%2F%2Fcdn.example%2Fa.png&description=Pin&url=https%3A%2F%2Fa.example",
      prefilled: true,
      mediaByHand: false,
    });
  });
});

describe("manual account handles", () => {
  it("accepts a handle with or without @ and a profile link", () => {
    expect(cleanHandle("@PartnersInBiz")).toBe("PartnersInBiz");
    expect(cleanHandle(" partners.in_biz ")).toBe("partners.in_biz");
    expect(cleanHandle("https://www.tiktok.com/@veloxmath?lang=en")).toBe("veloxmath");
    expect(cleanHandle("https://www.linkedin.com/company/partners-in-biz/")).toBe("partners-in-biz");
  });
  it("refuses anything that is not a handle", () => {
    expect(() => cleanHandle("two words")).toThrow(/handle/);
    expect(() => cleanHandle("")).toThrow(/handle/);
  });
  it("one external id per handle, whatever its case", () => {
    expect(manualExternalId("@VeloxMath")).toBe("manual:veloxmath");
  });
});

describe("rollup with a destination that waits for a person", () => {
  it("keeps the post open until it is posted by hand", () => {
    expect(rollupPostStatus(["published", "awaiting_manual"])).toBe("publishing");
    expect(rollupPostStatus(["awaiting_manual"])).toBe("publishing");
    expect(rollupPostStatus(["published", "published"])).toBe("published");
  });
});
