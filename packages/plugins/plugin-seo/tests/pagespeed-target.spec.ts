import { describe, expect, it } from "vitest";
import { sameSiteHost, stripCacheBusters } from "../src/service/url-guards.js";

describe("PageSpeed target URL", () => {
  it("drops cache-busters and tracking params but keeps real ones", () => {
    expect(stripCacheBusters("https://example.com/?cb=6")).toBe("https://example.com/");
    expect(stripCacheBusters("https://example.com/a?page=2&cb=4&utm_source=x#top")).toBe("https://example.com/a?page=2");
  });

  it("treats www and bare host as the same site, a preview host as another", () => {
    expect(sameSiteHost("https://www.partnersinbiz.online/x", "https://partnersinbiz.online")).toBe(true);
    expect(sameSiteHost("https://partnersinbiz-27w1a0aio-peet-standers-projects-caab22b2.vercel.app/", "https://partnersinbiz.online")).toBe(false);
    expect(sameSiteHost("not a url", "https://partnersinbiz.online")).toBe(false);
  });
});
