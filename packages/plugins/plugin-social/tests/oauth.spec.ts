import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { oauthCallbackUrl } from "@partnersinbiz/pib-plugin-kit";
import { bridgeRedirectUri, PLUGIN_ID, type SocialPlatform } from "../src/platforms.js";
import { PROVIDERS } from "../src/oauth/registry.js";
import type { ProviderEnv } from "../src/oauth/types.js";

const BASE = "https://paperclip.partnersinbiz.online";
const REDIRECT = bridgeRedirectUri(BASE, "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/");

function env(platform: SocialPlatform, extra: Partial<ProviderEnv> = {}): ProviderEnv {
  return { app: { platform, clientId: `${platform}-client`, clientSecret: "secret" }, redirectUri: REDIRECT, ...extra };
}

async function authorize(platform: SocialPlatform, extra: Partial<ProviderEnv> = {}, input: Record<string, string> = {}) {
  const provider = PROVIDERS[platform];
  const result = await provider.authorize!(env(platform, extra), "state-123", input);
  return { ...result, parsed: new URL(result.url) };
}

describe("bridge redirect URI", () => {
  it("matches the kit callback URL for the social plugin", () => {
    // The host serves plugin files only by installation uuid, not by plugin key.
    expect(REDIRECT).toBe("https://paperclip.partnersinbiz.online/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/oauth-callback.html");
    expect(REDIRECT).toBe(oauthCallbackUrl(BASE, "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/"));
    expect(() => bridgeRedirectUri(BASE, `/_plugins/${PLUGIN_ID}/ui/`)).toThrow();
  });
});

describe("authorize URLs", () => {
  const cases: Array<{ platform: SocialPlatform; host: string; clientKey?: string; scopes: string[]; sep: string }> = [
    { platform: "facebook", host: "https://www.facebook.com/v21.0/dialog/oauth", scopes: ["pages_manage_posts", "pages_show_list", "instagram_content_publish"], sep: "," },
    { platform: "instagram", host: "https://www.instagram.com/oauth/authorize", scopes: ["instagram_business_basic", "instagram_business_content_publish"], sep: "," },
    { platform: "threads", host: "https://threads.net/oauth/authorize", scopes: ["threads_basic", "threads_content_publish"], sep: "," },
    { platform: "linkedin", host: "https://www.linkedin.com/oauth/v2/authorization", scopes: ["openid", "profile", "email", "w_member_social"], sep: " " },
    { platform: "x", host: "https://x.com/i/oauth2/authorize", scopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"], sep: " " },
    { platform: "tiktok", host: "https://www.tiktok.com/v2/auth/authorize/", clientKey: "client_key", scopes: ["user.info.basic", "video.publish"], sep: "," },
    { platform: "youtube", host: "https://accounts.google.com/o/oauth2/v2/auth", scopes: ["https://www.googleapis.com/auth/youtube.upload"], sep: " " },
    { platform: "pinterest", host: "https://www.pinterest.com/oauth/", scopes: ["boards:read", "pins:write"], sep: "," },
    { platform: "reddit", host: "https://www.reddit.com/api/v1/authorize", scopes: ["identity", "submit"], sep: " " },
    { platform: "dribbble", host: "https://dribbble.com/oauth/authorize", scopes: ["public", "upload"], sep: " " },
  ];

  for (const c of cases) {
    it(`${c.platform}: bridge redirect, state, client id and scopes`, async () => {
      const { parsed } = await authorize(c.platform);
      expect(`${parsed.origin}${parsed.pathname}`).toBe(c.host);
      expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT);
      expect(parsed.searchParams.get("state")).toBe("state-123");
      expect(parsed.searchParams.get(c.clientKey ?? "client_id")).toBe(`${c.platform}-client`);
      const scope = parsed.searchParams.get("scope") ?? "";
      const list = scope.split(c.sep);
      for (const s of c.scopes) expect(list).toContain(s);
      if (c.sep === " ") expect(scope).not.toContain(",");
    });
  }

  it("linkedin adds organization scopes only when company pages are on", async () => {
    const off = (await authorize("linkedin")).parsed.searchParams.get("scope")!;
    const on = (await authorize("linkedin", { linkedinOrgPages: true })).parsed.searchParams.get("scope")!;
    expect(off).not.toContain("w_organization_social");
    expect(on.split(" ")).toEqual(expect.arrayContaining(["w_organization_social", "r_organization_social"]));
  });

  it("x uses PKCE S256 and keeps the verifier in the session", async () => {
    const { parsed, sessionExtra } = await authorize("x");
    const verifier = String(sessionExtra?.codeVerifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("youtube asks for offline access with consent", async () => {
    const { parsed } = await authorize("youtube");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("reddit asks for a permanent grant", async () => {
    expect((await authorize("reddit")).parsed.searchParams.get("duration")).toBe("permanent");
  });

  it("mastodon uses the registered instance app and remembers the instance", async () => {
    const { parsed, sessionExtra } = await authorize("mastodon", {}, { instanceUrl: "https://fosstodon.org" });
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://fosstodon.org/oauth/authorize");
    expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(parsed.searchParams.get("scope")).toBe("read write:statuses write:media");
    expect(sessionExtra?.instanceUrl).toBe("https://fosstodon.org");
  });

  it("scope overrides from settings replace the defaults", async () => {
    const result = await PROVIDERS.facebook.authorize!(
      { app: { platform: "facebook", clientId: "id", scopes: ["pages_show_list", "pages_manage_posts"] }, redirectUri: REDIRECT },
      "s",
      {},
    );
    expect(new URL(result.url).searchParams.get("scope")).toBe("pages_show_list,pages_manage_posts");
  });

  it("uses the configured Graph version", async () => {
    const result = await PROVIDERS.facebook.authorize!({ app: { platform: "facebook", clientId: "id", apiVersion: "v23.0" }, redirectUri: REDIRECT }, "s", {});
    expect(result.url.startsWith("https://www.facebook.com/v23.0/dialog/oauth?")).toBe(true);
  });
});
