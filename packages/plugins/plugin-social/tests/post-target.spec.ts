import { describe, expect, it } from "vitest";
import { contentHashOf } from "../src/content-hash.js";
import { buildPublishRequest, validateDestination } from "../src/publish.js";
import { xProvider, xTargetFields } from "../src/oauth/providers/x.js";
import type { ProviderAccount, ProviderEnv, PublishRequest } from "../src/oauth/types.js";
import { parseTweetUrl, targetFromParams } from "../src/post-target.js";
import { targetOut } from "../src/service.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import { json, jsonOf, mockFetch } from "./helpers.js";

const env: ProviderEnv = { app: { platform: "x", clientId: "id", clientSecret: "secret" }, redirectUri: "https://paperclip.example.com/cb" };
const account: ProviderAccount = { id: "acc-1", platform: "x", externalId: "ext-1", handle: "pib", displayName: "PiB", meta: {}, token: { accessToken: "tok" } };
const post = { body: "Agreed.", media: [], overrides: {}, first_comment: null, scheduled_at: null, reply_to_url: null, quote_url: null };

describe("parseTweetUrl", () => {
  it("reads x.com and twitter.com status links", () => {
    expect(parseTweetUrl("https://x.com/peet/status/1850000000000000001")).toEqual({ id: "1850000000000000001", handle: "peet", url: "https://x.com/peet/status/1850000000000000001" });
    expect(parseTweetUrl("https://twitter.com/Peet_S/status/42?s=20&t=abc")).toMatchObject({ id: "42", handle: "Peet_S", url: "https://x.com/Peet_S/status/42" });
    expect(parseTweetUrl("https://www.x.com/i/web/status/99")).toMatchObject({ id: "99", handle: null });
    expect(parseTweetUrl("https://x.com/peet/status/42/photo/1")).toMatchObject({ id: "42" });
  });

  it("refuses anything that is not a post link", () => {
    for (const bad of ["", "not a url", "https://x.com/peet", "https://x.com/peet/status/abc", "https://evil.example.com/peet/status/42", "https://x.com.evil.example/peet/status/42", "javascript:alert(1)", "ftp://x.com/peet/status/42"]) {
      expect(parseTweetUrl(bad), bad).toBeNull();
    }
  });
});

describe("targetFromParams", () => {
  it("normalises the links and the note", () => {
    expect(targetFromParams({ replyToUrl: "https://twitter.com/peet/status/42?s=1", note: "  HOLD until PAR-1  " })).toEqual({
      replyToUrl: "https://x.com/peet/status/42",
      quoteUrl: undefined,
      note: "HOLD until PAR-1",
    });
  });

  it("keeps what is not passed and clears what is passed empty", () => {
    expect(targetFromParams({ body: "x" })).toEqual({ replyToUrl: undefined, quoteUrl: undefined, note: undefined });
    expect(targetFromParams({ replyToUrl: "", quoteUrl: null, note: "" })).toEqual({ replyToUrl: null, quoteUrl: null, note: null });
  });

  it("refuses a link that is not an X post, both targets together and a long note", () => {
    expect(() => targetFromParams({ replyToUrl: "https://example.com/a" })).toThrow(/x\.com post link/);
    expect(() => targetFromParams({ quoteUrl: "nonsense" })).toThrow(/x\.com post link/);
    expect(() => targetFromParams({ replyToUrl: "https://x.com/a/status/1", quoteUrl: "https://x.com/b/status/2" })).toThrow(/not both/);
    expect(() => targetFromParams({ note: "n".repeat(501) })).toThrow(/500/);
  });
});

describe("publishing a reply or quote", () => {
  it("sends reply.in_reply_to_tweet_id", async () => {
    const { calls } = mockFetch([["POST https://api.x.com/2/tweets", () => json({ data: { id: "t-9" } })]]);
    const req: PublishRequest = { text: "Agreed.", replyToUrl: "https://x.com/peet/status/1850000000000000001", media: [] };
    expect(await xProvider.publish(env, account, req)).toMatchObject({ ok: true, externalId: "t-9" });
    expect(jsonOf(calls.find((c) => c.url === "https://api.x.com/2/tweets")!)).toEqual({ text: "Agreed.", reply: { in_reply_to_tweet_id: "1850000000000000001" } });
  });

  it("sends quote_tweet_id, and the first comment still replies to the new post", async () => {
    const { calls } = mockFetch([["POST https://api.x.com/2/tweets", () => json({ data: { id: "t-9" } })]]);
    const req: PublishRequest = { text: "Worth a read.", quoteUrl: "https://x.com/peet/status/77", firstComment: "More below", media: [] };
    await xProvider.publish(env, account, req);
    const bodies = calls.filter((c) => c.url === "https://api.x.com/2/tweets").map((c) => jsonOf(c));
    expect(bodies[0]).toEqual({ text: "Worth a read.", quote_tweet_id: "77" });
    expect(bodies[1]).toEqual({ text: "More below", reply: { in_reply_to_tweet_id: "t-9" } });
  });

  it("posts a plain post when there is no target, and never posts plain when the target is bad", async () => {
    expect(xTargetFields({})).toEqual({});
    expect(() => xTargetFields({ replyToUrl: "https://example.com/a" })).toThrow(/not an X post link/);
    const { calls } = mockFetch([["POST https://api.x.com/2/tweets", () => json({ data: { id: "t-1" } })]]);
    const out = await xProvider.publish(env, account, { text: "Hi", quoteUrl: "https://example.com/a", media: [] });
    expect(out).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not an X post link/) });
    expect(calls.filter((c) => c.url === "https://api.x.com/2/tweets")).toHaveLength(0);
  });
});

describe("destinations", () => {
  const reply = { ...post, reply_to_url: "https://x.com/peet/status/42" };

  it("carries the target into the publish request", () => {
    expect(buildPublishRequest(reply, "x")).toMatchObject({ replyToUrl: "https://x.com/peet/status/42", quoteUrl: undefined });
    expect(buildPublishRequest({ ...post, quote_url: "https://x.com/peet/status/42" }, "x")).toMatchObject({ quoteUrl: "https://x.com/peet/status/42" });
  });

  it("lets X take it and refuses every other platform instead of posting it plain", () => {
    expect(validateDestination("x", buildPublishRequest(reply, "x"))).toEqual([]);
    for (const platform of ["bluesky", "threads", "mastodon", "linkedin"] as const) {
      expect(validateDestination(platform, buildPublishRequest(reply, platform)).join(" "), platform).toMatch(/cannot reply to or quote an X post/);
    }
    expect(validateDestination("bluesky", buildPublishRequest(post, "bluesky"))).toEqual([]);
  });

  it("changes the approval fingerprint when the target changes, and not when it is unset", () => {
    const plain = contentHashOf(post, ["a"]);
    expect(contentHashOf(reply, ["a"])).not.toBe(plain);
    expect(contentHashOf({ ...post, quote_url: "https://x.com/peet/status/42" }, ["a"])).not.toBe(contentHashOf(reply, ["a"]));
    expect(contentHashOf({ ...post, reply_to_url: undefined, quote_url: undefined }, ["a"])).toBe(plain);
  });
});

describe("tools and output", () => {
  it("exposes the fields on create-post, update-post and create-personal-draft", () => {
    for (const name of ["create-post", "update-post", "create-personal-draft"]) {
      const props = Object.keys(SOCIAL_TOOLS.find((t) => t.name === name)!.parametersSchema.properties as Record<string, unknown>);
      expect(props, name).toEqual(expect.arrayContaining(["replyToUrl", "quoteUrl", "note"]));
    }
  });

  it("shows the target for display", () => {
    expect(targetOut("https://x.com/peet/status/42")).toEqual({ url: "https://x.com/peet/status/42", id: "42", handle: "peet" });
    expect(targetOut(null)).toBeNull();
    expect(targetOut("junk")).toBeNull();
  });
});
