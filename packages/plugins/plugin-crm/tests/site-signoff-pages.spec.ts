/** The page-scoped grant's allow list (PAR-9131 Q14), checked on the pure rule so every bypass is named. */
import { describe, expect, it } from "vitest";
import { PAGE_GRANT_ENDPOINTS, pageGrantRefusal } from "../src/site-signoff.js";

const SITE = { id: "s1", url: "https://example.com" };
const PAGES = new Set(["https://example.com/about", "https://example.com/"]);
const URL_OK = "https://example.com/about/";
const refuse = (endpoint: string, params: Record<string, unknown>, undo: { endpoint: string; target: string | null } | null = null) =>
  pageGrantRefusal(SITE, endpoint, params, PAGES, undo);

describe("page grant allow list", () => {
  it("allows each of the 4 endpoints on an approved url, absolute or relative", () => {
    for (const endpoint of PAGE_GRANT_ENDPOINTS) {
      expect(refuse(endpoint, { url: URL_OK, title: "x" })).toBeNull();
      expect(refuse(endpoint, { url: "/about" })).toBeNull();
      expect(refuse(endpoint, { url: "HTTPS://EXAMPLE.COM/about" })).toBeNull();
    }
    expect(refuse("seo/set", { url: "/" })).toBeNull();
  });

  it("refuses an approved url combined with any key the site resolves before url", () => {
    for (const [key, value] of [["postId", 12], ["site", true], ["termId", 5], ["taxonomy", "category"], ["postTypeArchive", "product"]] as const) {
      for (const endpoint of PAGE_GRANT_ENDPOINTS) {
        expect(refuse(endpoint, { url: URL_OK, [key]: value })).toMatch(new RegExp(`leave out ${key}`));
      }
    }
    // A null value is not sent on, so it is not a bypass.
    expect(refuse("seo/set", { url: URL_OK, postId: null })).toBeNull();
    expect(refuse("seo/set", { url: URL_OK, postId: 0 })).toMatch(/leave out postId/);
    expect(refuse("seo/set", { url: URL_OK, site: false })).toMatch(/leave out site/);
  });

  it("refuses a query, a fragment, another host, postId alone and a page that is not approved", () => {
    expect(refuse("posts/update", { url: "https://example.com/about?p=45" })).toMatch(/no query/);
    expect(refuse("posts/update", { url: "/?p=45" })).toMatch(/no query/);
    expect(refuse("seo/set", { url: "https://example.com/about#x" })).toMatch(/fragment/);
    expect(refuse("seo/set", { url: "https://evil.test/about" })).toMatch(/not on example\.com/);
    expect(refuse("seo/set", { url: "//evil.test/about" })).toMatch(/not on example\.com/);
    expect(refuse("seo/set", { url: "https://www.example.com/about" })).toMatch(/not on example\.com/);
    expect(refuse("posts/update", { postId: 45 })).toMatch(/name its page with url/);
    expect(refuse("posts/update", { url: "" })).toMatch(/name its page with url/);
    expect(refuse("posts/update", { url: "/contact" })).toMatch(/not one of the approved pages/);
    expect(refuse("posts/update", { url: "/about/team" })).toMatch(/not one of the approved pages/);
    // The site resolves the raw url, so a path the parser would clean up to an approved page is refused.
    expect(refuse("seo/set", { url: "/other/../about" })).toMatch(/not a page address/);
    expect(refuse("seo/set", { url: "https://example.com/other/%2e%2e/about" })).toMatch(/not a page address/);
    expect(refuse("seo/set", { url: "https://example.com/other\\..\\about" })).toMatch(/not a page address/);
  });

  it("refuses every other write, including posts/create and redirects/set", () => {
    for (const endpoint of ["posts/create", "redirects/set", "redirects/delete", "robots/set", "sitemap/set", "posts/publish", "media/sideload", "media/set-featured", "media/alt", "verify/set", "archive/set", "plugins/install", "self/update"]) {
      expect(refuse(endpoint, { url: URL_OK })).toMatch(/is not one of the page changes/);
    }
  });

  it("allows undo of an approved-page change and refuses any other undo", () => {
    expect(refuse("undo", { changeId: "c1" }, { endpoint: "seo/set", target: "https://example.com/about" })).toBeNull();
    expect(refuse("undo", { changeId: "c1" }, { endpoint: "posts/update", target: "/about/" })).toBeNull();
    expect(refuse("undo", { changeId: "c1" }, { endpoint: "seo/set", target: "https://example.com/contact" })).toMatch(/not on an approved page/);
    expect(refuse("undo", { changeId: "c1" }, { endpoint: "seo/set", target: "post:12" })).toMatch(/not on an approved page/);
    expect(refuse("undo", { changeId: "c1" }, { endpoint: "redirects/set", target: "https://example.com/about" })).toMatch(/redirects\/set change/);
    expect(refuse("undo", { changeId: "c1" }, null)).toMatch(/not an applied change on this site/);
  });
});
