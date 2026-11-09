/**
 * 0.10.23: the per-post inbox reads (YouTube, Facebook, Instagram, Threads) isolate each post. A private video
 * (comments not supported) used to throw and abort the whole account's poll, so no other video's comments
 * reached the inbox (PiB Demo, 2026-11-08). Now a post that only it can fail is skipped and reported once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstSkip } from "../src/inbox.js";
import { facebookProvider, instagramProvider, threadsProvider } from "../src/oauth/providers/meta.js";
import { youtubeProvider } from "../src/oauth/providers/youtube.js";
import { ProviderHttpError } from "../src/oauth/http.js";
import { perPostInbox, skippablePostError } from "../src/oauth/providers/common.js";
import type { ProviderAccount, ProviderEnv, SocialProvider } from "../src/oauth/types.js";
import type { SocialPlatform } from "../src/platforms.js";
import { fastNetwork, json, mockFetch } from "./helpers.js";

function env(platform: SocialPlatform): ProviderEnv {
  return { app: { platform, clientId: "app-id", clientSecret: "app-secret" }, redirectUri: "https://paperclip.example.com/cb" };
}

function account(platform: SocialPlatform, meta: Record<string, unknown> = {}): ProviderAccount {
  return { id: "acc-1", platform, externalId: "chan-1", handle: "pib", displayName: "PiB", meta, token: { accessToken: "tok" } };
}

function googleError(status: number, reason: string, message: string) {
  return json({ error: { code: status, message, errors: [{ reason, domain: "youtube.commentThread", message }] } }, status);
}

function metaError(status: number, code: number, message: string) {
  return json({ error: { message, type: "GraphMethodException", code, fbtrace_id: "x" } }, status);
}

const thread = (id: string, text: string, author = "Sam") => ({
  id,
  snippet: { topLevelComment: { id, snippet: { textOriginal: text, authorDisplayName: author, authorChannelId: { value: "viewer-1" }, publishedAt: "2026-11-08T14:40:00Z" } } },
});

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

describe("YouTube inbox: one video cannot block the others", () => {
  const route = (handlers: Record<string, () => Response>) =>
    mockFetch([
      ["GET https://www.googleapis.com/youtube/v3/commentThreads", (url) => handlers[url.searchParams.get("videoId")!]!()],
    ]);

  it("skips a private video and a deleted one, and still returns the unlisted video's comments", async () => {
    const { calls } = route({
      private1: () => googleError(403, "commentsDisabled", "The video identified by the videoId parameter has disabled comments."),
      unlisted1: () => json({ items: [thread("t1", "Great demo!")] }),
      gone1: () => googleError(404, "videoNotFound", "The video identified by the videoId parameter could not be found."),
    });
    const onSkip = vi.fn();
    const items = await youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "private1" }, { externalId: "unlisted1" }, { externalId: "gone1" }], onSkip);
    expect(calls).toHaveLength(3);
    expect(items).toEqual([
      expect.objectContaining({ externalId: "t1", parentExternalId: "unlisted1", destinationExternalId: "unlisted1", body: "Great demo!", author: "Sam" }),
    ]);
    expect(onSkip.mock.calls.map((c) => c[0])).toEqual(["private1", "gone1"]);
    expect(onSkip.mock.calls[0]![1]).toMatch(/YouTube comments: .*disabled comments/);
  });

  it("works without a skip callback", async () => {
    route({ a: () => googleError(403, "commentsDisabled", "disabled comments"), b: () => json({ items: [thread("t2", "Hi")] }) });
    const items = await youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "a" }, { externalId: "b" }]);
    expect(items.map((i) => i.externalId)).toEqual(["t2"]);
  });

  it("does not skip a quota error: it is account-wide, so the poll fails as before", async () => {
    route({ a: () => json({ items: [thread("t1", "Hi")] }), b: () => googleError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.") });
    const onSkip = vi.fn();
    await expect(youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "a" }, { externalId: "b" }], onSkip)).rejects.toThrow(/quota/);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("does not skip an invalid token", async () => {
    route({ a: () => googleError(401, "authError", "Invalid Credentials"), b: () => json({ items: [] }) });
    await expect(youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "a" }, { externalId: "b" }])).rejects.toThrow(/Invalid Credentials/);
  });

  it("throws when every video failed, so an account-wide refusal still shows as a poll error", async () => {
    route({ a: () => googleError(403, "forbidden", "Access forbidden."), b: () => googleError(403, "forbidden", "Access forbidden.") });
    const onSkip = vi.fn();
    await expect(youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "a" }, { externalId: "b" }], onSkip)).rejects.toThrow(/Access forbidden/);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("leaves the channel's own comments out, as before", async () => {
    route({ a: () => json({ items: [{ ...thread("t1", "mine"), snippet: { topLevelComment: { snippet: { textOriginal: "mine", authorChannelId: { value: "chan-1" } } } } }] }) });
    expect(await youtubeProvider.inbox!(env("youtube"), account("youtube"), [{ externalId: "a" }])).toEqual([]);
  });
});

describe("Meta inboxes: a deleted or hidden post is skipped", () => {
  const cases: Array<{ name: string; provider: SocialProvider; platform: SocialPlatform; route: string; ok: unknown; meta?: Record<string, unknown> }> = [
    {
      name: "Facebook",
      provider: facebookProvider,
      platform: "facebook",
      route: "GET https://graph.facebook.com/v21.0/",
      ok: { data: [{ id: "c1", message: "Nice post", from: { id: "u1", name: "Sam" }, created_time: "2026-11-08T14:00:00Z" }] },
      meta: { pageId: "page-1" },
    },
    {
      name: "Instagram",
      provider: instagramProvider,
      platform: "instagram",
      route: "GET https://graph.facebook.com/v21.0/",
      ok: { data: [{ id: "c1", text: "Nice post", username: "sam", timestamp: "2026-11-08T14:00:00Z" }] },
      meta: { via: "facebook_login", apiHost: "graph.facebook.com" },
    },
    {
      name: "Threads",
      provider: threadsProvider,
      platform: "threads",
      route: "GET https://graph.threads.net/",
      ok: { data: [{ id: "c1", text: "Nice post", username: "sam", timestamp: "2026-11-08T14:00:00Z" }] },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: skips the post that answers 400 (object does not exist) and keeps the other post's comments`, async () => {
      const { calls } = mockFetch([
        [c.route, (url) => (url.pathname.includes("/gone-1/")
          ? metaError(400, 100, "Unsupported get request. Object with ID 'gone-1' does not exist, cannot be loaded due to missing permissions, or does not support this operation.")
          : json(c.ok))],
      ]);
      const onSkip = vi.fn();
      const items = await c.provider.inbox!(env(c.platform), account(c.platform, c.meta), [{ externalId: "gone-1" }, { externalId: "live-1" }], onSkip);
      expect(calls).toHaveLength(2);
      expect(items).toEqual([expect.objectContaining({ externalId: "c1", parentExternalId: "live-1", destinationExternalId: "live-1", body: "Nice post" })]);
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onSkip.mock.calls[0]![0]).toBe("gone-1");
      expect(onSkip.mock.calls[0]![1]).toMatch(/does not exist/);
    });

    it(`${c.name}: a Meta rate limit is not skipped`, async () => {
      mockFetch([
        [c.route, (url) => (url.pathname.includes("/busy-1/") ? metaError(400, 4, "Application request limit reached") : json(c.ok))],
      ]);
      await expect(c.provider.inbox!(env(c.platform), account(c.platform, c.meta), [{ externalId: "live-1" }, { externalId: "busy-1" }])).rejects.toThrow(/request limit/);
    });
  }
});

describe("perPostInbox and skippablePostError", () => {
  it("only skips 400/403/404 provider errors that are not a token, retry or quota problem", () => {
    expect(skippablePostError(new ProviderHttpError(403, '{"error":{"errors":[{"reason":"commentsDisabled"}]}}'))).toBe(true);
    expect(skippablePostError(new ProviderHttpError(404, "not found"))).toBe(true);
    expect(skippablePostError(new ProviderHttpError(400, '{"error":{"code":100,"message":"Unsupported get request"}}'))).toBe(true);
    expect(skippablePostError(new ProviderHttpError(401, "nope"))).toBe(false);
    expect(skippablePostError(new ProviderHttpError(403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}'))).toBe(false);
    expect(skippablePostError(new ProviderHttpError(429, "slow down"))).toBe(false);
    expect(skippablePostError(new ProviderHttpError(500, "boom"))).toBe(false);
    expect(skippablePostError(new ProviderHttpError(400, '{"error":{"code":190,"message":"Error validating access token"}}'))).toBe(false);
    expect(skippablePostError(new TypeError("fetch failed"))).toBe(false);
  });

  it("stops at a network error, as before", async () => {
    const read = vi.fn(async (id: string) => {
      if (id === "b") throw new TypeError("fetch failed");
      return [];
    });
    await expect(perPostInbox([{ externalId: "a" }, { externalId: "b" }, { externalId: "c" }], read)).rejects.toThrow("fetch failed");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns nothing and skips nothing for no posts", async () => {
    const onSkip = vi.fn();
    expect(await perPostInbox([], async () => [], onSkip)).toEqual([]);
    expect(onSkip).not.toHaveBeenCalled();
  });
});

describe("firstSkip: a skipped post is logged once", () => {
  it("answers true the first time per account and post only", () => {
    expect(firstSkip("acc-x", "vid-1")).toBe(true);
    expect(firstSkip("acc-x", "vid-1")).toBe(false);
    expect(firstSkip("acc-x", "vid-2")).toBe(true);
    expect(firstSkip("acc-y", "vid-1")).toBe(true);
  });
});
