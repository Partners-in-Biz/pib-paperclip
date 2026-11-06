/** X replies are drafted here and posted by a person in X's own reply box. */
import { describe, expect, it } from "vitest";
import { xReplyIntentUrl } from "../src/platforms.js";

describe("xReplyIntentUrl", () => {
  it("opens the reply box on the post with the text in it", () => {
    const url = new URL(xReplyIntentUrl("2117001370897469466", " Thanks & see you at 5? ")!);
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("in_reply_to")).toBe("2117001370897469466");
    expect(url.searchParams.get("text")).toBe("Thanks & see you at 5?");
  });
  it("still opens with no text yet", () => {
    expect(xReplyIntentUrl("123", "  ")).toBe("https://x.com/intent/post?in_reply_to=123");
  });
  it("gives no link without a real post id", () => {
    for (const id of [null, undefined, "", "abc", "12/../3"]) expect(xReplyIntentUrl(id, "hi")).toBeNull();
  });
});
