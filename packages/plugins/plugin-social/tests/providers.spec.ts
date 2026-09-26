import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef } from "../src/db.js";
import { bridgeRedirectUri, type SocialPlatform } from "../src/platforms.js";
import { blueskyProvider, buildFacets, detectFacets, graphemeLength } from "../src/oauth/providers/bluesky.js";
import { facebookProvider, instagramProvider, threadsProvider } from "../src/oauth/providers/meta.js";
import { escapeLinkedInText, linkedinProvider, linkedinVersions } from "../src/oauth/providers/linkedin.js";
import { chooseTikTokPrivacy, tiktokProvider } from "../src/oauth/providers/tiktok.js";
import { xProvider, xWeightedLength } from "../src/oauth/providers/x.js";
import { redditProvider } from "../src/oauth/providers/reddit.js";
import type { ProviderAccount, ProviderEnv, PublishRequest } from "../src/oauth/types.js";
import { bytes, fastNetwork, formOf, json, jsonOf, mockFetch } from "./helpers.js";

const REDIRECT = bridgeRedirectUri("https://paperclip.example.com", "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/");

function env(platform: SocialPlatform, extra: Partial<ProviderEnv> = {}): ProviderEnv {
  return { app: { platform, clientId: "app-id", clientSecret: "app-secret" }, redirectUri: REDIRECT, ...extra };
}

function account(platform: SocialPlatform, meta: Record<string, unknown> = {}, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "acc-1", platform, externalId: "ext-1", handle: "pib", displayName: "PiB", meta, token: { accessToken: "tok" }, ...extra };
}

function image(url: string, altText: string | null = null): MediaRef {
  return { assetId: null, url, kind: "image", mime: "image/jpeg", width: 1080, height: 1350, durationS: null, altText, bytes: null };
}

function video(url: string): MediaRef {
  return { assetId: null, url, kind: "video", mime: "video/mp4", width: 1080, height: 1920, durationS: 20, altText: null, bytes: null };
}

function req(partial: Partial<PublishRequest>): PublishRequest {
  return { text: "Hello world", media: [], ...partial };
}

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

describe("Meta: Facebook connect", () => {
  it("exchanges the code, makes a long-lived token and offers every Page plus linked Instagram", async () => {
    const { calls } = mockFetch([
      ["GET https://graph.facebook.com/v21.0/oauth/access_token", (url) =>
        url.searchParams.get("grant_type") === "fb_exchange_token"
          ? json({ access_token: "long-user", expires_in: 5_184_000 })
          : json({ access_token: "short-user" })],
      ["GET https://graph.facebook.com/v21.0/me/accounts", () => json({
        data: [
          { id: "p1", name: "PiB", access_token: "page-1", instagram_business_account: { id: "ig1", username: "pib.sa" } },
          { id: "p2", name: "Client Page", access_token: "page-2" },
        ],
      })],
    ]);
    const result = await facebookProvider.exchange!(env("facebook"), { code: "the-code", state: "s" }, {});
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get("code")).toBe("the-code");
    expect(first.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(new URL(calls[1]!.url).searchParams.get("fb_exchange_token")).toBe("short-user");
    expect(new URL(calls[2]!.url).searchParams.get("access_token")).toBe("long-user");
    expect(result.candidates.map((c) => c.key)).toEqual(["page:p1", "ig:ig1", "page:p2"]);
    const ig = result.candidates[1]!;
    expect(ig.platform).toBe("instagram");
    expect(ig.token.accessToken).toBe("page-1");
    expect(ig.token.userAccessToken).toBe("long-user");
    expect(ig.meta).toMatchObject({ pageId: "p1", igUserId: "ig1", via: "facebook_login", apiHost: "graph.facebook.com" });
    expect(result.candidates[2]!.token.accessToken).toBe("page-2");
  });

  it("fails with a clear message when no Page was shared", async () => {
    mockFetch([
      ["GET https://graph.facebook.com/v21.0/oauth/access_token", () => json({ access_token: "t", expires_in: 100 })],
      ["GET https://graph.facebook.com/v21.0/me/accounts", () => json({ data: [] })],
    ]);
    await expect(facebookProvider.exchange!(env("facebook"), { code: "c" }, {})).rejects.toThrow(/No Facebook Pages/);
  });
});

describe("Meta: Facebook publish", () => {
  it("posts a single photo with a form-encoded body and adds the first comment", async () => {
    const { calls } = mockFetch([
      ["POST https://graph.facebook.com/v21.0/p1/photos", () => json({ id: "photo-1", post_id: "p1_99" })],
      ["POST https://graph.facebook.com/v21.0/p1_99/comments", () => json({ id: "c-1" })],
    ]);
    const out = await facebookProvider.publish(env("facebook"), account("facebook", { pageId: "p1" }, { token: { accessToken: "page-token" } }),
      req({ media: [image("https://media.example.com/a.jpg")], link: "https://pib.example/offer", firstComment: "More below" }));
    expect(out).toMatchObject({ ok: true, externalId: "p1_99", url: "https://www.facebook.com/p1_99" });
    expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = formOf(calls[0]!);
    expect(form.get("url")).toBe("https://media.example.com/a.jpg");
    expect(form.get("access_token")).toBe("page-token");
    expect(form.get("caption")).toContain("https://pib.example/offer");
    expect(formOf(calls[1]!).get("message")).toBe("More below");
    expect(out.detail?.firstCommentId).toBe("c-1");
  });

  it("uploads multiple photos unpublished and attaches them to one feed post", async () => {
    let n = 0;
    const { calls } = mockFetch([
      ["POST https://graph.facebook.com/v21.0/p1/photos", () => json({ id: `m${++n}` })],
      ["POST https://graph.facebook.com/v21.0/p1/feed", () => json({ id: "p1_7" })],
    ]);
    const out = await facebookProvider.publish(env("facebook"), account("facebook", { pageId: "p1" }),
      req({ media: [image("https://m.example.com/1.jpg"), image("https://m.example.com/2.jpg")] }));
    expect(out.ok).toBe(true);
    expect(formOf(calls[0]!).get("published")).toBe("false");
    const feed = formOf(calls[2]!);
    expect(feed.get("attached_media[0]")).toBe(JSON.stringify({ media_fbid: "m1" }));
    expect(feed.get("attached_media[1]")).toBe(JSON.stringify({ media_fbid: "m2" }));
  });

  it("classifies an expired token as needing reconnect", async () => {
    mockFetch([["POST https://graph.facebook.com/v21.0/p1/feed", () => json({ error: { message: "Error validating access token", code: 190 } }, 400)]]);
    const out = await facebookProvider.publish(env("facebook"), account("facebook", { pageId: "p1" }), req({}));
    expect(out).toMatchObject({ ok: false, tokenInvalid: true, retryable: false });
    expect(out.error).toContain("Error validating access token");
  });

  it("marks rate limits as retryable", async () => {
    mockFetch([["POST https://graph.facebook.com/v21.0/p1/feed", () => json({ error: { message: "Too many calls", code: 4 } }, 400)]]);
    const out = await facebookProvider.publish(env("facebook"), account("facebook", { pageId: "p1" }), req({}));
    expect(out).toMatchObject({ ok: false, retryable: true });
  });
});

describe("Meta: Instagram publish", () => {
  it("builds a carousel from child containers, waits for processing and publishes", async () => {
    let child = 0;
    let statusPolls = 0;
    const { calls } = mockFetch([
      ["POST https://graph.facebook.com/v21.0/ig1/media_publish", () => json({ id: "media-9" })],
      ["POST https://graph.facebook.com/v21.0/ig1/media", (_u, init) => {
        const form = new URLSearchParams(String(init.body));
        return json({ id: form.get("media_type") === "CAROUSEL" ? "carousel-1" : `child-${++child}` });
      }],
      ["GET https://graph.facebook.com/v21.0/media-9", () => json({ permalink: "https://www.instagram.com/p/abc/" })],
      [/^GET https:\/\/graph\.facebook\.com\/v21\.0\/(child-\d|carousel-1)\?/, () => json({ status_code: ++statusPolls < 2 ? "IN_PROGRESS" : "FINISHED" })],
    ]);
    const out = await instagramProvider.publish(env("facebook"), account("instagram", { igUserId: "ig1", apiHost: "graph.facebook.com", via: "facebook_login" }),
      req({ text: "Carousel", media: [image("https://m.example.com/1.jpg"), video("https://m.example.com/2.mp4")] }));
    expect(out).toMatchObject({ ok: true, externalId: "media-9", url: "https://www.instagram.com/p/abc/" });
    const posts = calls.filter((c) => c.method === "POST");
    expect(formOf(posts[0]!).get("is_carousel_item")).toBe("true");
    expect(formOf(posts[1]!).get("media_type")).toBe("VIDEO");
    const parent = formOf(posts[2]!);
    expect(parent.get("media_type")).toBe("CAROUSEL");
    expect(parent.get("children")).toBe("child-1,child-2");
    expect(parent.get("caption")).toBe("Carousel");
    expect(formOf(posts[3]!).get("creation_id")).toBe("carousel-1");
  });

  it("publishes a single video as a Reel after polling status", async () => {
    let polls = 0;
    mockFetch([
      ["POST https://graph.instagram.com/v21.0/ig2/media_publish", () => json({ id: "reel-1" })],
      ["POST https://graph.instagram.com/v21.0/ig2/media", (_u, init) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("media_type")).toBe("REELS");
        return json({ id: "c1" });
      }],
      ["GET https://graph.instagram.com/v21.0/c1", () => json({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" })],
      ["GET https://graph.instagram.com/v21.0/reel-1", () => json({ permalink: "https://www.instagram.com/reel/x/" })],
    ]);
    const out = await instagramProvider.publish(env("instagram"), account("instagram", { igUserId: "ig2", via: "instagram_login" }), req({ media: [video("https://m.example.com/v.mp4")] }));
    expect(out.ok).toBe(true);
    expect(polls).toBe(3);
  });

  it("refuses a post without media", async () => {
    const out = await instagramProvider.publish(env("instagram"), account("instagram"), req({}));
    expect(out).toMatchObject({ ok: false, retryable: false });
  });
});

describe("Meta: Threads", () => {
  it("exchanges on graph.threads.net and makes a long-lived token", async () => {
    const { calls } = mockFetch([
      ["POST https://graph.threads.net/oauth/access_token", () => json({ access_token: "short", user_id: "t1" })],
      ["GET https://graph.threads.net/access_token", () => json({ access_token: "long", expires_in: 5_184_000 })],
      ["GET https://graph.threads.net/v1.0/me", () => json({ id: "t1", username: "pib" })],
    ]);
    const result = await threadsProvider.exchange!(env("threads"), { code: "c" }, {});
    expect(formOf(calls[0]!).get("grant_type")).toBe("authorization_code");
    expect(new URL(calls[1]!.url).searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(result.candidates[0]!.token.accessToken).toBe("long");
  });

  it("publishes text through a container", async () => {
    mockFetch([
      ["POST https://graph.threads.net/v1.0/t1/threads_publish", () => json({ id: "post-1" })],
      ["POST https://graph.threads.net/v1.0/t1/threads", () => json({ id: "cont-1" })],
      ["GET https://graph.threads.net/v1.0/cont-1", () => json({ status: "FINISHED" })],
      ["GET https://graph.threads.net/v1.0/post-1", () => json({ permalink: "https://www.threads.net/@pib/post/x" })],
    ]);
    const out = await threadsProvider.publish(env("threads"), account("threads", {}, { externalId: "t1" }), req({ text: "Hi Threads" }));
    expect(out).toMatchObject({ ok: true, externalId: "post-1" });
  });
});

describe("LinkedIn", () => {
  it("exchanges the code and uses the member URN", async () => {
    const { calls } = mockFetch([
      ["POST https://www.linkedin.com/oauth/v2/accessToken", () => json({ access_token: "li-tok", expires_in: 5_184_000, scope: "openid profile email w_member_social" })],
      ["GET https://api.linkedin.com/v2/userinfo", () => json({ sub: "abc", name: "Peet" })],
    ]);
    const result = await linkedinProvider.exchange!(env("linkedin"), { code: "c" }, {});
    const form = formOf(calls[0]!);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.get("client_secret")).toBe("app-secret");
    expect(result.candidates[0]).toMatchObject({ externalId: "urn:li:person:abc", meta: { authorUrn: "urn:li:person:abc" } });
  });

  it("uploads an image and posts to /rest/posts with version headers", async () => {
    const { calls } = mockFetch([
      ["POST https://api.linkedin.com/rest/images?action=initializeUpload", () => json({ value: { uploadUrl: "https://upload.linkedin.example/u1", image: "urn:li:image:1" } })],
      ["GET https://media.example.com/a.jpg", () => bytes(2048, "image/jpeg")],
      ["PUT https://upload.linkedin.example/u1", () => new Response(null, { status: 201 })],
      ["POST https://api.linkedin.com/rest/posts", () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:77" } })],
    ]);
    const out = await linkedinProvider.publish(env("linkedin", { app: { platform: "linkedin", clientId: "x", apiVersion: "202606" } }),
      account("linkedin", { authorUrn: "urn:li:organization:5" }), req({ text: "Launch (today) @ 9", media: [image("https://media.example.com/a.jpg", "A chart")] }));
    expect(out).toMatchObject({ ok: true, externalId: "urn:li:share:77", url: "https://www.linkedin.com/feed/update/urn:li:share:77/" });
    const post = calls.find((c) => c.url === "https://api.linkedin.com/rest/posts")!;
    expect(post.headers.get("linkedin-version")).toBe("202606");
    expect(post.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    const body = jsonOf(post);
    expect(body.author).toBe("urn:li:organization:5");
    expect(body.commentary).toBe("Launch \\(today\\) \\@ 9");
    expect(body.content).toEqual({ media: { id: "urn:li:image:1", altText: "A chart" } });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers.get("authorization")).toBe("Bearer tok");
  });

  it("falls back to an active version when the configured one is sunset", async () => {
    const seen: string[] = [];
    mockFetch([
      ["POST https://api.linkedin.com/rest/posts", (_u, _i, call) => {
        const v = call.headers.get("linkedin-version")!;
        seen.push(v);
        return v === "201901"
          ? json({ message: "Requested version 201901 is not active" }, 426)
          : new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
      }],
    ]);
    const out = await linkedinProvider.publish(env("linkedin", { app: { platform: "linkedin", clientId: "x", apiVersion: "201901" } }), account("linkedin"), req({}));
    expect(out.ok).toBe(true);
    expect(seen[0]).toBe("201901");
    expect(seen.length).toBe(2);
  });

  it("escapes reserved characters but keeps hashtags", () => {
    expect(escapeLinkedInText("a_b *c* #tag (x)")).toBe("a\\_b \\*c\\* #tag \\(x\\)");
    expect(linkedinVersions(undefined, new Date("2026-09-15T00:00:00Z"))[0]).toBe("202607");
  });
});

describe("X", () => {
  it("exchanges the code with the PKCE verifier and Basic auth", async () => {
    const { calls } = mockFetch([
      ["POST https://api.x.com/2/oauth2/token", () => json({ access_token: "x-tok", refresh_token: "x-ref", expires_in: 7200, scope: "tweet.read tweet.write users.read offline.access media.write" })],
      ["GET https://api.x.com/2/users/me", () => json({ data: { id: "42", username: "pib", name: "PiB" } })],
    ]);
    const result = await xProvider.exchange!(env("x"), { code: "c" }, { codeVerifier: "verifier-123" });
    const form = formOf(calls[0]!);
    expect(form.get("code_verifier")).toBe("verifier-123");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(calls[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("app-id:app-secret").toString("base64")}`);
    expect(result.candidates[0]!.token).toMatchObject({ accessToken: "x-tok", refreshToken: "x-ref" });
  });

  it("uploads an image with v2 media upload and posts", async () => {
    const { calls } = mockFetch([
      ["GET https://media.example.com/a.png", () => bytes(1000, "image/png")],
      ["POST https://api.x.com/2/media/upload", () => json({ data: { id: "m-1" } })],
      ["POST https://api.x.com/2/tweets", () => json({ data: { id: "t-1" } })],
    ]);
    const out = await xProvider.publish(env("x"), account("x"), req({ text: "Short", media: [image("https://media.example.com/a.png")] }));
    expect(out).toMatchObject({ ok: true, externalId: "t-1", url: "https://x.com/pib/status/t-1" });
    const upload = calls.find((c) => c.url === "https://api.x.com/2/media/upload")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get("media_category")).toBe("tweet_image");
    expect(jsonOf(calls.find((c) => c.url === "https://api.x.com/2/tweets")!)).toEqual({ text: "Short", media: { media_ids: ["m-1"] } });
  });

  it("uploads video in chunks and waits for processing", async () => {
    let status = 0;
    const { calls } = mockFetch([
      ["GET https://media.example.com/v.mp4", () => bytes(5 * 1024 * 1024, "video/mp4")],
      ["POST https://api.x.com/2/media/upload/initialize", () => json({ data: { id: "v-1" } })],
      ["POST https://api.x.com/2/media/upload/v-1/append", () => new Response(null, { status: 204 })],
      ["POST https://api.x.com/2/media/upload/v-1/finalize", () => json({ data: { processing_info: { state: "pending" } } })],
      ["GET https://api.x.com/2/media/upload?command=STATUS", () => json({ data: { processing_info: { state: ++status < 2 ? "in_progress" : "succeeded" } } })],
      ["POST https://api.x.com/2/tweets", () => json({ data: { id: "t-2" } })],
    ]);
    const out = await xProvider.publish(env("x"), account("x"), req({ text: "Video", media: [video("https://media.example.com/v.mp4")] }));
    expect(out.ok).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/append")).length).toBe(2);
    expect(jsonOf(calls.find((c) => c.url.endsWith("/initialize"))!)).toMatchObject({ media_category: "tweet_video", total_bytes: 5 * 1024 * 1024 });
  });

  it("rejects text over the weighted limit before calling the API", async () => {
    const out = await xProvider.publish(env("x"), account("x"), req({ text: "a".repeat(281) }));
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(xWeightedLength(`${"a".repeat(250)} https://example.com/a/very/long/path/that/is/long`)).toBe(274);
  });
});

describe("TikTok", () => {
  it("queries creator info, pulls from the R2 URL and polls the status", async () => {
    let polls = 0;
    const { calls } = mockFetch([
      ["POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => json({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], creator_username: "pib" }, error: { code: "ok" } })],
      ["POST https://open.tiktokapis.com/v2/post/publish/video/init/", () => json({ data: { publish_id: "pub-1" }, error: { code: "ok" } })],
      ["POST https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => json({ data: ++polls < 2 ? { status: "PROCESSING_DOWNLOAD" } : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7123] }, error: { code: "ok" } })],
    ]);
    const out = await tiktokProvider.publish(env("tiktok"), account("tiktok"), req({ text: "Clip #fyp", privacy: "public", media: [video("https://media.example.com/c.mp4")] }));
    expect(out).toMatchObject({ ok: true, externalId: "7123", url: "https://www.tiktok.com/@pib/video/7123" });
    const init = jsonOf(calls[1]!) as { post_info: { privacy_level: string }; source_info: { source: string; video_url: string } };
    expect(init.post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(init.source_info).toEqual({ source: "PULL_FROM_URL", video_url: "https://media.example.com/c.mp4" });
  });

  it("exchanges the code with a form body", async () => {
    const { calls } = mockFetch([
      ["POST https://open.tiktokapis.com/v2/oauth/token/", () => json({ access_token: "tt", refresh_token: "rr", expires_in: 86400, open_id: "o1", scope: "user.info.basic,video.publish" })],
      ["GET https://open.tiktokapis.com/v2/user/info/", () => json({ data: { user: { open_id: "o1", display_name: "PiB", username: "pib" } }, error: { code: "ok" } })],
    ]);
    const result = await tiktokProvider.exchange!(env("tiktok"), { code: "c" }, {});
    expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = formOf(calls[0]!);
    expect(form.get("client_key")).toBe("app-id");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(result.candidates[0]).toMatchObject({ externalId: "o1", handle: "pib" });
  });

  it("keeps privacy within the creator's options", () => {
    expect(chooseTikTokPrivacy(undefined, ["SELF_ONLY", "PUBLIC_TO_EVERYONE"])).toBe("SELF_ONLY");
    expect(chooseTikTokPrivacy("friends", ["MUTUAL_FOLLOW_FRIENDS"])).toBe("MUTUAL_FOLLOW_FRIENDS");
    expect(() => chooseTikTokPrivacy("public", ["SELF_ONLY"])).toThrow(/does not allow/);
  });
});

describe("Reddit", () => {
  it("submits to the override subreddit with a real User-Agent", async () => {
    const { calls } = mockFetch([
      ["POST https://oauth.reddit.com/api/submit", () => json({ json: { errors: [], data: { url: "https://www.reddit.com/r/smallbusiness/comments/x", name: "t3_x" } } })],
    ]);
    const out = await redditProvider.publish(env("reddit"), account("reddit", { defaultSubreddit: "other" }), req({ text: "A useful guide\n\nbody", subreddit: "r/smallbusiness" }));
    expect(out).toMatchObject({ ok: true, externalId: "t3_x" });
    expect(calls[0]!.headers.get("user-agent")).toContain("partnersinbiz-paperclip");
    const form = formOf(calls[0]!);
    expect(form.get("sr")).toBe("smallbusiness");
    expect(form.get("kind")).toBe("self");
    expect(form.get("title")).toBe("A useful guide");
  });

  it("fails without a subreddit", async () => {
    const out = await redditProvider.publish(env("reddit"), account("reddit"), req({}));
    expect(out).toMatchObject({ ok: false, retryable: false });
  });
});

describe("Bluesky", () => {
  it("computes facet byte offsets for links, mentions and tags", () => {
    const text = "Hé 👋 see https://pib.example/a?b=1. Thanks @peet.bsky.social! #SmallBiz";
    const facets = detectFacets(text);
    const bytesOf = Buffer.from(text, "utf8");
    const slice = (f: { byteStart: number; byteEnd: number }) => bytesOf.subarray(f.byteStart, f.byteEnd).toString("utf8");
    expect(facets.map((f) => f.type)).toEqual(["link", "mention", "tag"]);
    expect(slice(facets[0]!)).toBe("https://pib.example/a?b=1");
    expect(slice(facets[1]!)).toBe("@peet.bsky.social");
    expect(slice(facets[2]!)).toBe("#SmallBiz");
    expect(facets[0]!.byteStart).toBe(Buffer.byteLength("Hé 👋 see ", "utf8"));
    expect(facets[1]!.value).toBe("peet.bsky.social");
    expect(facets[2]!.value).toBe("SmallBiz");
  });

  it("counts graphemes, not code units", () => {
    expect(graphemeLength("👍🏽👍🏽")).toBe(2);
    expect(graphemeLength("abc")).toBe(3);
  });

  it("resolves mentions to DIDs and publishes with image blobs", async () => {
    const { calls } = mockFetch([
      ["POST https://pds.example.com/xrpc/com.atproto.server.createSession", () => json({ accessJwt: "jwt", did: "did:plc:me", handle: "pib.bsky.social" })],
      ["GET https://pds.example.com/xrpc/com.atproto.identity.resolveHandle", () => json({ did: "did:plc:peet" })],
      ["GET https://media.example.com/a.jpg", () => bytes(500, "image/jpeg")],
      ["POST https://pds.example.com/xrpc/com.atproto.repo.uploadBlob", () => json({ blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/jpeg", size: 500 } })],
      ["POST https://pds.example.com/xrpc/com.atproto.repo.createRecord", () => json({ uri: "at://did:plc:me/app.bsky.feed.post/3k", cid: "cid1" })],
    ]);
    const out = await blueskyProvider.publish(env("bluesky"),
      account("bluesky", { pdsUrl: "https://pds.example.com" }, { token: { accessToken: "", identifier: "pib.bsky.social", appPassword: "app-pass" } }),
      req({ text: "Hi @peet.bsky.social", media: [image("https://media.example.com/a.jpg", "logo")] }));
    expect(out).toMatchObject({ ok: true, externalId: "at://did:plc:me/app.bsky.feed.post/3k", url: "https://bsky.app/profile/pib.bsky.social/post/3k" });
    const record = (jsonOf(calls.find((c) => c.url.endsWith("createRecord"))!).record ?? {}) as Record<string, unknown>;
    expect(record.facets).toEqual([{ index: { byteStart: 3, byteEnd: 20 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:peet" }] }]);
    expect((record.embed as { images: Array<{ alt: string }> }).images[0]!.alt).toBe("logo");
    const upload = calls.find((c) => c.url.endsWith("uploadBlob"))!;
    expect(upload.headers.get("content-type")).toBe("image/jpeg");
    expect(upload.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects posts over 300 graphemes", async () => {
    const out = await blueskyProvider.publish(env("bluesky"), account("bluesky", {}, { token: { accessToken: "", identifier: "a", appPassword: "b" } }), req({ text: "x".repeat(301) }));
    expect(out).toMatchObject({ ok: false, retryable: false });
  });

  it("buildFacets skips mentions it cannot resolve", async () => {
    mockFetch([[/resolveHandle/, () => json({ error: "InvalidRequest" }, 400)]]);
    const facets = await buildFacets("hello @nobody.example.com", "https://pds.example.com");
    expect(facets).toEqual([]);
  });
});

describe("media URL safety", () => {
  it("refuses to download from private hosts", async () => {
    const { setHostResolver } = await import("../src/oauth/http.js");
    setHostResolver(async () => ["10.0.0.5"]);
    const out = await xProvider.publish(env("x"), account("x"), req({ text: "a", media: [image("https://internal.example.com/a.png")] }));
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(out.error).toMatch(/public host/);
  });
});
