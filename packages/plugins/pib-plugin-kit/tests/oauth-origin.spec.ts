import { describe, expect, it } from "vitest";
import { oauthOriginMismatch } from "../src/oauth-bridge/client.js";

const REDIRECT = "https://paperclip.partnersinbiz.online/_plugins/11108a9c-3bb8-4e60-ad2f-9d22c225a048/ui/oauth-callback.html";

describe("oauthOriginMismatch", () => {
  it("passes when the page is on the redirect URI's origin", () => {
    expect(oauthOriginMismatch(REDIRECT, "https://paperclip.partnersinbiz.online")).toBeNull();
    expect(oauthOriginMismatch(REDIRECT, "https://Paperclip.PartnersInBiz.online")).toBeNull();
  });

  it("explains the fix when the page is on another host", () => {
    const message = oauthOriginMismatch(REDIRECT, "https://paperclip.65.108.146.144.sslip.io", "X");
    expect(message).toContain("Open Paperclip at https://paperclip.partnersinbiz.online to connect X");
    expect(message).toContain("https://paperclip.65.108.146.144.sslip.io");
  });

  it("stays quiet when the redirect URI is unknown or unreadable", () => {
    expect(oauthOriginMismatch(null, "https://paperclip.partnersinbiz.online")).toBeNull();
    expect(oauthOriginMismatch("not a url", "https://paperclip.partnersinbiz.online")).toBeNull();
    expect(oauthOriginMismatch(REDIRECT, "")).toBeNull();
  });
});
