import { describe, expect, it } from "vitest";
import { buildGoogleAuthorizeUrl, GMAIL_SCOPES } from "../src/gmail/api.js";

describe("Gmail authorize URL", () => {
  it("asks only for the Gmail scopes and never merges earlier grants (the Google client is shared)", () => {
    const url = new URL(buildGoogleAuthorizeUrl({ clientId: "c", redirectUri: "https://x.test/cb", state: "s", loginHint: "a@b.test" }));
    // include_granted_scopes would pull YouTube/Drive grants of the same client into this request,
    // and Google refuses: "This request contains scopes that cannot be requested together".
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual([...GMAIL_SCOPES].sort());
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("login_hint")).toBe("a@b.test");
  });
});
