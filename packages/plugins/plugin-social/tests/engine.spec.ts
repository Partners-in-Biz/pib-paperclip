import { describe, expect, it } from "vitest";
import { mergeToolsGrant, TOOLS_GRANT } from "../src/agent.js";
import {
  dueMetricWindow,
  MAX_PUBLISH_ATTEMPTS,
  needsRefreshBeforePublish,
  nextDestinationState,
  refreshDecision,
  rollupPostStatus,
  type RefreshCandidate,
} from "../src/domain.js";
import { buildPublishRequest, validateDestination } from "../src/publish.js";
import { draftFromItem, parseFeed } from "../src/rss.js";
import { normalizeOverrides } from "../src/service.js";

const NOW = new Date("2026-09-26T10:00:00Z");
const minutes = (d: Date | null) => (d ? Math.round((d.getTime() - NOW.getTime()) / 60_000) : null);

describe("publish retry state machine", () => {
  it("backs off 1, 5, 15 and 60 minutes, then fails on the 5th attempt", () => {
    const waits = [1, 2, 3, 4].map((attempt) => {
      const next = nextDestinationState(attempt, { ok: false }, NOW);
      expect(next.status).toBe("retrying");
      expect(next.final).toBe(false);
      return minutes(next.nextAttemptAt);
    });
    expect(waits).toEqual([1, 5, 15, 60]);
    const last = nextDestinationState(MAX_PUBLISH_ATTEMPTS, { ok: false }, NOW);
    expect(last).toEqual({ status: "failed", nextAttemptAt: null, final: true });
  });

  it("fails at once when a retry cannot help", () => {
    expect(nextDestinationState(1, { ok: false, retryable: false }, NOW)).toMatchObject({ status: "failed", final: true });
  });

  it("publishes on success", () => {
    expect(nextDestinationState(3, { ok: true }, NOW)).toEqual({ status: "published", nextAttemptAt: null, final: true });
  });

  it("rolls destinations up into the post status", () => {
    expect(rollupPostStatus(["published", "published"])).toBe("published");
    expect(rollupPostStatus(["published", "failed"])).toBe("partially_published");
    expect(rollupPostStatus(["failed", "failed"])).toBe("failed");
    expect(rollupPostStatus(["published", "retrying"])).toBe("publishing");
    expect(rollupPostStatus(["pending"])).toBe("publishing");
    expect(rollupPostStatus([])).toBe("failed");
  });
});

describe("token refresh scheduling", () => {
  const base: RefreshCandidate = { id: "a", platform: "linkedin", status: "connected", expiresAt: null, refreshKind: "refresh_token", hasRefreshToken: true };
  const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

  it("refreshes refresh-token platforms within 48 hours", () => {
    expect(refreshDecision({ ...base, expiresAt: inHours(47) }, NOW).action).toBe("refresh");
    expect(refreshDecision({ ...base, expiresAt: inHours(49) }, NOW).action).toBe("skip");
    expect(refreshDecision({ ...base, platform: "x", expiresAt: inHours(1.5) }, NOW).action).toBe("refresh");
  });

  it("re-exchanges long-lived Meta tokens within 10 days", () => {
    const meta = { ...base, platform: "facebook" as const, refreshKind: "long_lived" as const, hasRefreshToken: false };
    expect(refreshDecision({ ...meta, expiresAt: inHours(9 * 24) }, NOW).action).toBe("refresh");
    expect(refreshDecision({ ...meta, expiresAt: inHours(11 * 24) }, NOW).action).toBe("skip");
    expect(refreshDecision({ ...meta, expiresAt: inHours(-1) }, NOW).action).toBe("expired");
  });

  it("warns a week ahead when a token cannot be refreshed, then flags reconnect", () => {
    const noRefresh = { ...base, hasRefreshToken: false };
    expect(refreshDecision({ ...noRefresh, expiresAt: inHours(6 * 24) }, NOW).action).toBe("warn");
    expect(refreshDecision({ ...noRefresh, expiresAt: inHours(8 * 24) }, NOW).action).toBe("skip");
    expect(refreshDecision({ ...noRefresh, expiresAt: inHours(-2) }, NOW).action).toBe("expired");
  });

  it("skips disabled accounts and tokens without expiry", () => {
    expect(refreshDecision({ ...base, status: "disabled", expiresAt: inHours(1) }, NOW).action).toBe("skip");
    expect(refreshDecision({ ...base, expiresAt: null }, NOW).action).toBe("skip");
  });

  it("refreshes right before publishing when the token lapses within 5 minutes", () => {
    expect(needsRefreshBeforePublish(new Date(NOW.getTime() + 4 * 60_000).toISOString(), NOW)).toBe(true);
    expect(needsRefreshBeforePublish(new Date(NOW.getTime() + 10 * 60_000).toISOString(), NOW)).toBe(false);
    expect(needsRefreshBeforePublish(null, NOW)).toBe(false);
  });
});

describe("metric windows", () => {
  const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  it("captures the latest passed window and skips missed earlier ones", () => {
    expect(dueMetricWindow(ago(0.5), [], NOW)).toEqual({ capture: null, skip: [] });
    expect(dueMetricWindow(ago(2), [], NOW)).toEqual({ capture: "1h", skip: [] });
    expect(dueMetricWindow(ago(30), ["1h"], NOW)).toEqual({ capture: "24h", skip: [] });
    expect(dueMetricWindow(ago(72), [], NOW)).toEqual({ capture: "24h", skip: ["1h"] });
    expect(dueMetricWindow(ago(31 * 24), ["1h", "24h", "7d", "30d"], NOW)).toEqual({ capture: null, skip: [] });
  });
});

describe("publish request and validation", () => {
  const post = {
    body: "Main copy for LinkedIn and Facebook with a long enough body",
    media: [{ assetId: "a1", url: "https://m.example.com/a.jpg", kind: "image" }],
    overrides: { x: { text: "Short X copy" }, reddit: { subreddit: "smallbusiness", title: "Guide" }, youtube: { privacy: "unlisted" } },
    first_comment: "  First!  ",
  };

  it("applies the platform override and falls back to the main body", () => {
    expect(buildPublishRequest(post, "x")).toMatchObject({ text: "Short X copy", firstComment: "First!" });
    expect(buildPublishRequest(post, "linkedin").text).toBe(post.body);
    expect(buildPublishRequest(post, "reddit")).toMatchObject({ subreddit: "smallbusiness", title: "Guide" });
    expect(buildPublishRequest(post, "facebook").media).toHaveLength(1);
  });

  it("flags destinations that would certainly fail", () => {
    const textOnly = buildPublishRequest({ ...post, media: [] }, "instagram");
    expect(validateDestination("instagram", textOnly)).toEqual(["Instagram needs an image or a video"]);
    expect(validateDestination("tiktok", buildPublishRequest(post, "tiktok"))).toContain("TikTok needs exactly one video");
    expect(validateDestination("x", { text: "a".repeat(300), media: [] })[0]).toMatch(/limit is 280/);
    expect(validateDestination("x", { text: "a".repeat(300), media: [] }, { longPosts: true })).toEqual([]);
    expect(validateDestination("reddit", { text: "Title\nbody", media: [] })).toContain("Reddit needs a subreddit (post override or account default)");
    expect(validateDestination("reddit", { text: "Title\nbody", media: [] }, { defaultSubreddit: "sa" })).toEqual([]);
    expect(validateDestination("pinterest", buildPublishRequest(post, "pinterest"), { boardId: "b1" })).toEqual([]);
    expect(validateDestination("bluesky", { text: "👍🏽".repeat(300), media: [] })).toEqual([]);
  });
});

describe("overrides", () => {
  it("normalises allowed fields and rejects unknown ones", () => {
    expect(normalizeOverrides({ reddit: { subreddit: "/r/SmallBusiness/", title: " T " }, x: { text: "" } })).toEqual({ reddit: { subreddit: "SmallBusiness", title: "T" } });
    expect(() => normalizeOverrides({ instagram: { link: "https://x" } })).toThrow(/does not take an override for "link"/);
    expect(() => normalizeOverrides({ myspace: {} })).toThrow(/Unknown platform/);
    expect(() => normalizeOverrides({ facebook: { link: "ftp://x" } })).toThrow(/http/);
  });
});

describe("agent tool grant", () => {
  it("adds the plugin tools grant once and keeps existing grants", () => {
    const existing = [{ permissionKey: "tasks:assign", scope: null }];
    const first = mergeToolsGrant(existing);
    expect(first.added).toBe(true);
    expect(first.grants).toEqual([{ permissionKey: "tasks:assign", scope: null }, TOOLS_GRANT]);
    const again = mergeToolsGrant(first.grants);
    expect(again.added).toBe(false);
    expect(again.grants).toHaveLength(2);
    expect(mergeToolsGrant([{ permissionKey: "tools:use", scope: null }]).added).toBe(false);
  });
});

describe("RSS parser", () => {
  it("reads RSS 2.0 with CDATA and entities", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>PiB Blog</title>
      <item><title><![CDATA[Grow &amp; win]]></title><link>https://pib.example/grow</link><guid isPermaLink="false">g-1</guid>
      <pubDate>Fri, 25 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>How to <b>grow</b> fast</p>]]></description></item>
      <item><title>Second</title><link>https://pib.example/second</link></item></channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe("PiB Blog");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({ title: "Grow & win", link: "https://pib.example/grow", guid: "g-1", publishedAt: "2026-09-25T08:00:00.000Z", summary: "How to grow fast" });
    expect(feed.items[0]!.key).not.toBe(feed.items[1]!.key);
    expect(draftFromItem(feed.items[0]!).body).toBe("Grow & win\n\nHow to grow fast\n\nhttps://pib.example/grow");
  });

  it("reads Atom entries with alternate links", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title>
      <entry><title>Hello</title><link rel="alternate" href="https://pib.example/hello"/><link rel="self" href="https://pib.example/self"/>
      <id>urn:uuid:1</id><updated>2026-09-24T10:00:00Z</updated><summary>Short</summary></entry></feed>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe("News");
    expect(feed.items[0]).toMatchObject({ title: "Hello", link: "https://pib.example/hello", guid: "urn:uuid:1" });
  });
});
