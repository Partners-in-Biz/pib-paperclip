import { describe, expect, it } from "vitest";
import { normalisePageUrl } from "../src/client-sites.js";

describe("normalisePageUrl (PAR-9131 Q14)", () => {
  it("lower-cases scheme and host, keeps the path, drops a trailing slash except on /", () => {
    expect(normalisePageUrl("HTTPS://Www.Example.COM/About-Us/")).toBe("https://www.example.com/About-Us");
    expect(normalisePageUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalisePageUrl("https://example.com")).toBe("https://example.com/");
    expect(normalisePageUrl("https://example.com/a/b//")).toBe("https://example.com/a/b");
    expect(normalisePageUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalisePageUrl("http://example.com:8080/a/")).toBe("http://example.com:8080/a");
  });

  it("resolves a relative URL against the site only", () => {
    expect(normalisePageUrl("/about/", "https://Example.com/blog/")).toBe("https://example.com/about");
    expect(normalisePageUrl("about", "https://example.com")).toBe("https://example.com/about");
    expect(normalisePageUrl("/about")).toBeNull();
    expect(normalisePageUrl("//evil.test/about", "https://example.com")).toBe("https://evil.test/about");
  });

  it("refuses a query, a fragment, other schemes, credentials and junk", () => {
    expect(normalisePageUrl("https://example.com/?p=45")).toBeNull();
    expect(normalisePageUrl("https://example.com/about?")).toBeNull();
    expect(normalisePageUrl("https://example.com/about#x")).toBeNull();
    expect(normalisePageUrl("/about#x", "https://example.com")).toBeNull();
    expect(normalisePageUrl("javascript:alert(1)")).toBeNull();
    expect(normalisePageUrl("ftp://example.com/a")).toBeNull();
    expect(normalisePageUrl("https://u:p@example.com/a")).toBeNull();
    expect(normalisePageUrl("")).toBeNull();
    expect(normalisePageUrl("http://")).toBeNull();
    expect(normalisePageUrl(5 as unknown as string)).toBeNull();
  });
});
