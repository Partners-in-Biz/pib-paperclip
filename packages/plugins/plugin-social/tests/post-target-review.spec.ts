import { describe, expect, it } from "vitest";
import { snapshotOf } from "../src/client-approval.js";
import { xTargetFields } from "../src/oauth/providers/x.js";
import { summarizeTarget } from "../src/post-target.js";
import { unsupportedTargetProblem, validateDestination } from "../src/publish.js";
import { postReviewDescription } from "../src/review.js";
import { changedTarget } from "../src/service.js";
import { createPersonalDraftRecord } from "../src/personal-draft.js";
import { account, world } from "./world.js";

const base = { body: "Agreed.", first_comment: null, overrides: {}, media: [], scheduled_at: null };
const REPLY = "https://x.com/peet/status/42";
const QUOTE = "https://x.com/anna/status/77";

describe("summarizeTarget", () => {
  it("names the handle for a reply and a quote, and has nothing for a plain post", () => {
    expect(summarizeTarget({ reply_to_url: REPLY })).toEqual({ kind: "reply", label: "Replying to @peet", url: REPLY });
    expect(summarizeTarget({ quote_url: QUOTE })).toEqual({ kind: "quote", label: "Quoting @anna", url: QUOTE });
    expect(summarizeTarget({ reply_to_url: "https://x.com/i/web/status/9" })?.label).toBe("Replying to an X post");
    expect(summarizeTarget({})).toBeNull();
  });
});

describe("the approval gate shows what the content hash covers", () => {
  const input = { accounts: [{ platform: "x", display_name: "@acme" }], poster: "PiB", clientName: "Acme", timezone: "Africa/Johannesburg" };

  it("puts the reply or quote target in the client's snapshot, and never the internal note", () => {
    const reply = snapshotOf({ ...input, post: { ...base, reply_to_url: REPLY, quote_url: null, note: "HOLD until PAR-1" } as never });
    expect(reply.target).toEqual({ kind: "reply", label: "Replying to @peet", url: REPLY });
    expect(JSON.stringify(reply)).not.toContain("HOLD until PAR-1");
    const quote = snapshotOf({ ...input, post: { ...base, reply_to_url: null, quote_url: QUOTE } as never });
    expect(quote.target).toMatchObject({ kind: "quote", label: "Quoting @anna" });
    expect(snapshotOf({ ...input, post: { ...base, reply_to_url: null, quote_url: null } as never }).target).toBeNull();
  });

  it("tells the Reviewer about the target, not the note", () => {
    const description = (extra: Record<string, unknown>) =>
      postReviewDescription({
        post: { id: "p1", body: "Agreed.", first_comment: null, client_kind: null, client_ref: null, client_name: null, media: [], ...extra } as never,
        destinations: ["X"],
        pagePath: null,
        handTo: { userId: null, label: "a board user" },
      });
    const text = description({ reply_to_url: REPLY, note: "HOLD until PAR-1" });
    expect(text).toContain(`**Replying to @peet:** ${REPLY}`);
    expect(text).not.toContain("HOLD until PAR-1");
    expect(description({ quote_url: QUOTE })).toContain(`**Quoting @anna:** ${QUOTE}`);
    expect(description({})).not.toMatch(/Replying to|Quoting/);
  });
});

describe("publish never turns a target into a plain post", () => {
  it("refuses a target on every platform but X, at publish as well as at validation", () => {
    expect(unsupportedTargetProblem("x", { replyToUrl: REPLY })).toBeNull();
    expect(unsupportedTargetProblem("bluesky", {})).toBeNull();
    expect(unsupportedTargetProblem("bluesky", { replyToUrl: REPLY })).toMatch(/replyToUrl/);
    expect(unsupportedTargetProblem("threads", { quoteUrl: QUOTE })).toMatch(/quoteUrl/);
  });

  it("refuses a row that holds both a reply and a quote instead of sending both", () => {
    expect(() => xTargetFields({ replyToUrl: REPLY, quoteUrl: QUOTE })).toThrow(/not both/);
  });
});

describe("update-post target changes", () => {
  it("clears one field and keeps the other", () => {
    expect(changedTarget({ replyToUrl: "" })).toMatchObject({ replyToUrl: null, quoteUrl: undefined });
    expect(changedTarget({ quoteUrl: "" })).toMatchObject({ quoteUrl: null, replyToUrl: undefined });
  });

  it("setting a reply clears the quote, and setting a quote clears the reply", () => {
    expect(changedTarget({ replyToUrl: REPLY })).toMatchObject({ replyToUrl: REPLY, quoteUrl: null });
    expect(changedTarget({ quoteUrl: QUOTE })).toMatchObject({ quoteUrl: QUOTE, replyToUrl: null });
  });

  it("changing only the note leaves both targets alone", () => {
    expect(changedTarget({ note: "HOLD" })).toEqual({ replyToUrl: undefined, quoteUrl: undefined, note: "HOLD" });
  });
});

describe("create-personal-draft", () => {
  it("keeps the note and the target on the draft", async () => {
    const { ctx, posts } = world([account("a1", { owner_user_id: "user-1", scope: "personal", platform: "x" })]);
    const result = await createPersonalDraftRecord(ctx, { companyId: "co", userId: "user-1", agentId: null, runId: null, isAgent: false }, {
      targetUserId: "user-1",
      body: "Agreed.",
      accountIds: ["a1"],
      replyToUrl: REPLY,
      note: "HOLD until PAR-1",
    });
    expect(posts.get(result.id)).toMatchObject({ reply_to_url: REPLY, quote_url: null, note: "HOLD until PAR-1" });
  });
});

describe("a body that only says it is a reply", () => {
  const fake = "Reply to: https://x.com/peet/status/42\nThe Mac Mini going offline is the real story.";
  it("is refused on X unless replyToUrl or quoteUrl carries the target", () => {
    expect(validateDestination("x", { text: fake, media: [] })[0]).toMatch(/replyToUrl/);
    expect(validateDestination("x", { text: "In reply to @peet: agreed.", media: [] })[0]).toMatch(/replyToUrl/);
    expect(validateDestination("x", { text: "Agreed.", replyToUrl: REPLY, media: [] })).toEqual([]);
    expect(validateDestination("x", { text: fake, replyToUrl: REPLY, media: [] })).toEqual([]);
    expect(validateDestination("x", { text: "Replying to customers faster is our focus.", media: [] })).toEqual([]);
    expect(validateDestination("x", { text: "We reply to every email within a day.", media: [] })).toEqual([]);
    expect(validateDestination("linkedin", { text: fake, media: [] })).toEqual([]);
  });
});
