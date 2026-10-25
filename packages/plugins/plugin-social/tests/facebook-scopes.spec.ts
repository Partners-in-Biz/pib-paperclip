import { describe, expect, it } from "vitest";
import { FACEBOOK_SCOPES } from "../src/oauth/providers/meta.js";

describe("Facebook login scopes", () => {
  it("requests pages_read_user_content, which Meta requires for pages_manage_engagement", () => {
    expect(FACEBOOK_SCOPES).toContain("pages_manage_engagement");
    expect(FACEBOOK_SCOPES).toContain("pages_read_user_content");
  });

  it("lists each scope once", () => {
    expect(new Set(FACEBOOK_SCOPES).size).toBe(FACEBOOK_SCOPES.length);
  });
});
