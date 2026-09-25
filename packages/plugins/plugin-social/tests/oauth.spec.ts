import { describe, expect, it } from "vitest";
import { decryptToken, deriveTokenKey, encryptToken } from "../src/oauth/crypto.js";
import { oauth1Header, percentEncode } from "../src/oauth/http.js";
import { facebookProvider, instagramProvider, threadsProvider } from "../src/oauth/providers/meta.js";
import { linkedinProvider } from "../src/oauth/providers/linkedin-x.js";
import { pinterestProvider, tiktokProvider } from "../src/oauth/providers/others.js";
import type { ProviderContext } from "../src/oauth/types.js";

const cfgCtx: ProviderContext = {
  cfg: { clientId: "test-client", clientSecret: "test-secret" },
  publicBaseUrl: "https://paperclip.example.com",
  redirectPath: "/social/oauth/callback",
};

describe("oauth crypto", () => {
  it("encrypts and decrypts tokens round-trip", () => {
    const key = deriveTokenKey("company-1", "super-secret");
    const enc = encryptToken("at:abc:refresh:x", key);
    expect(enc).toContain(".");
    expect(decryptToken(enc, key)).toBe("at:abc:refresh:x");
  });

  it("fails to decrypt with the wrong key", () => {
    const enc = encryptToken("secret-value", deriveTokenKey("company-1", "key-a"));
    expect(() => decryptToken(enc, deriveTokenKey("company-1", "key-b"))).toThrow();
  });

  it("derives different keys per company", () => {
    expect(deriveTokenKey("a", "s").equals(deriveTokenKey("b", "s"))).toBe(false);
  });
});

describe("oauth1 signing", () => {
  it("builds the OAuth header with the right params", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/oauth/request_token",
      { oauth_callback: "https://paperclip.example.com/social/oauth/callback?pstate=xyz" },
      "consumer",
      "consumer-secret",
      { token: "", tokenSecret: "" },
    );
    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).toContain('oauth_consumer_key="consumer"');
    expect(header).toContain("oauth_signature=");
    expect(header).toContain("oauth_signature_method=\"HMAC-SHA1\"");
    expect(header).toContain("oauth_version=\"1.0\"");
  });

  it("percent-encodes reserved characters per RFC 3986", () => {
    expect(percentEncode("a b&c=!")).toBe("a%20b%26c%3D%21");
  });
});

describe("provider authorize URLs", () => {
  it("facebook builds a dialog URL with redirect + state", () => {
    const url = facebookProvider.getAuthorizeUrl(cfgCtx, "state-1");
    expect(url.startsWith("https://www.facebook.com/v21.0/dialog/oauth?")).toBe(true);
    expect(url).toContain("client_id=test-client");
    expect(url).toContain(`redirect_uri=${encodeURIComponent("https://paperclip.example.com/social/oauth/callback")}`);
    expect(url).toContain("state=state-1");
    expect(url).toContain("pages_manage_posts");
  });

  it("instagram requests business + publish scopes", () => {
    const url = instagramProvider.getAuthorizeUrl(cfgCtx, "s2");
    expect(url).toContain("instagram_basic");
    expect(url).toContain("instagram_content_publish");
  });

  it("threads requests threads scopes", () => {
    const url = threadsProvider.getAuthorizeUrl(cfgCtx, "s3");
    expect(url).toContain("threads_basic");
    expect(url).toContain("threads_content_publish");
  });

  it("linkedin uses openid + w_member_social", () => {
    const url = linkedinProvider.getAuthorizeUrl(cfgCtx, "s4");
    expect(url.startsWith("https://www.linkedin.com/oauth/v2/authorization?")).toBe(true);
    expect(url).toContain("openid");
    expect(url).toContain("w_member_social");
  });

  it("pinterest requests boards + pins scopes", () => {
    const url = pinterestProvider.getAuthorizeUrl(cfgCtx, "s5");
    expect(url.startsWith("https://www.pinterest.com/oauth/?")).toBe(true);
    expect(url).toContain("boards%3Aread");
    expect(url).toContain("pins%3Awrite");
  });

  it("tiktok requests video.publish", () => {
    const url = tiktokProvider.getAuthorizeUrl(cfgCtx, "s6");
    expect(url.startsWith("https://www.tiktok.com/v2/auth/authorize/?")).toBe(true);
    expect(url).toContain("video.publish");
  });
});
