import { describe, expect, it } from "vitest";
import { missingDestinationEntry } from "../src/service.js";

describe("missingDestinationEntry (PAR-11950)", () => {
  it("names the replied-to post when there is one", () => {
    expect(missingDestinationEntry({ reply_to_url: "https://x.com/a/status/1", quote_url: null })).toMatchObject({
      destinationId: null, accountId: null, status: "published", measurable: false,
      unmeasuredReason: "no destination record (no link stored; marked posted by hand or its account was deleted before 0.11.3; it replied to https://x.com/a/status/1)",
      replyToUrl: "https://x.com/a/status/1", quoteUrl: null,
    });
  });

  it("names a quoted post", () => {
    expect(missingDestinationEntry({ reply_to_url: null, quote_url: "https://x.com/a/status/2" }).unmeasuredReason).toBe(
      "no destination record (no link stored; marked posted by hand or its account was deleted before 0.11.3; it quoted https://x.com/a/status/2)",
    );
  });

  it("plain reason when no link is stored", () => {
    expect(missingDestinationEntry({ reply_to_url: "  ", quote_url: undefined })).toMatchObject({
      measurable: false, unmeasuredReason: "no destination record (no link stored; marked posted by hand or its account was deleted before 0.11.3)", replyToUrl: null, quoteUrl: null,
    });
  });
});
