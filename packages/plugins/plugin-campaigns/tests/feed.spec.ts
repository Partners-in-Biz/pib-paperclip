import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fetchFeed, parseRss, pickItems, sanitizeItem, type CleanFeedItem } from "../src/feed.js";
import { personalize } from "../src/domain.js";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>Old one</title><link>https://x.test/a</link><guid>g-a</guid><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><category>seo</category>
<description><![CDATA[<p>Hello <b>world</b></p><script>alert(1)</script><style>p{}</style>  done]]></description></item>
<item><title>Tom &amp; Jerry&#8217;s</title><link>https://x.test/b</link><pubDate>Wed, 01 Jan 2025 10:00:00 GMT</pubDate><category>seo</category><category>ads</category><description>Fish &amp; chips&#8217;</description></item>
<item><title>Undated</title><link>https://x.test/c</link><description>none</description></item>
</channel></rss>`;

const ctxWith = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => ({ http: { fetch } }) as unknown as PluginContext;
const xmlRes = (body: string, status = 200, type = "application/rss+xml") => new Response(body, { status, headers: { "content-type": type } });
const clean = (xml = FEED): CleanFeedItem[] => parseRss(xml).map(sanitizeItem).filter((i): i is CleanFeedItem => i !== null);

describe("parseRss", () => {
  it("parses 3 items to plain text", () => {
    const items = parseRss(FEED);
    expect(items).toHaveLength(3);
    expect(items[0]!.description).toBe("Hello world done");
    expect(items[1]!.title).toBe("Tom & Jerry\u2019s");
    expect(items[1]!.description).toBe("Fish & chips\u2019");
    expect(items[1]!.categories).toEqual(["seo", "ads"]);
  });
  it("caps lengths and item count", () => {
    const one = (n: number) => `<item><title>${"t".repeat(300)}</title><link>https://x.test/${n}</link><description>${"d".repeat(2000)}</description></item>`;
    const items = parseRss(Array.from({ length: 120 }, (_, n) => one(n)).join(""));
    expect(items).toHaveLength(100);
    expect(items[0]!.title).toHaveLength(200);
    expect(items[0]!.description).toHaveLength(1000);
  });
});

describe("fetchFeed", () => {
  it("refuses http without fetching", async () => {
    const fetch = vi.fn();
    await expect(fetchFeed(ctxWith(fetch), "http://x.test/feed")).rejects.toThrow(/only https/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns the body of a good feed", async () => {
    await expect(fetchFeed(ctxWith(async () => xmlRes(FEED)), "https://x.test/feed")).resolves.toBe(FEED);
  });
  it("gives a clear error for big, html, 404 and rejected", async () => {
    await expect(fetchFeed(ctxWith(async () => xmlRes("a".repeat(1_000_001))), "https://x.test/f")).rejects.toThrow(/too large/);
    await expect(fetchFeed(ctxWith(async () => xmlRes("<html>", 200, "text/html")), "https://x.test/f")).rejects.toThrow(/not a feed/);
    let read = false;
    const moved = xmlRes(FEED);
    Object.defineProperty(moved, "url", { value: "https://evil.test/feed" });
    moved.text = async () => { read = true; return FEED; };
    await expect(fetchFeed(ctxWith(async () => moved), "https://x.test/feed")).rejects.toThrow(/redirects/);
    expect(read).toBe(false);
    await expect(fetchFeed(ctxWith(async () => xmlRes("", 301)), "https://x.test/f")).rejects.toThrow(/status 301/);
    await expect(fetchFeed(ctxWith(async () => xmlRes("", 404)), "https://x.test/f")).rejects.toThrow(/status 404/);
    await expect(fetchFeed(ctxWith(async () => { throw new Error("timeout after 30s"); }), "https://x.test/f")).rejects.toThrow(/https:\/\/x\.test\/f.*timeout after 30s/);
  });
});

describe("sanitizeItem", () => {
  const base = { title: "t", description: "d", pubDate: null, guid: null, categories: [] };
  it("drops non-https links", () => {
    expect(sanitizeItem({ ...base, link: "http://x.test/a" })).toBeNull();
    expect(sanitizeItem({ ...base, link: "javascript:alert(1)" })).toBeNull();
  });
  it("keys by guid, else link", () => {
    expect(sanitizeItem({ ...base, link: "https://x.test/a", guid: "g1" })!.key).toBe("g1");
    expect(sanitizeItem({ ...base, link: "https://x.test/a" })!.key).toBe("https://x.test/a");
  });
  it("escapes merge tokens in every text field so the real renderer leaves them alone", () => {
    const item = sanitizeItem({
      ...base,
      link: "https://x.test/a",
      title: "Hi {{first_name}} {{{name}}}",
      description: "{{ unsubscribe_url }} {{first_name|there}}",
      pubDate: "{{first_name}}",
      guid: "{{ unsubscribe_url }}",
      categories: ["{{first_name}}"],
    })!;
    const all = [item.title, item.description, item.pubDate!, item.guid!, item.key, ...item.categories].join(" | ");
    const out = personalize(all, { name: "Ann Lee", unsubscribeUrl: "https://u.test/x" });
    expect(out).not.toContain("Ann");
    expect(out).not.toContain("https://u.test/x");
    expect(out).toBe(all);
    expect(item.title).toContain("{ {first_name}}");
    expect(item.pubDate).toBe("{ {first_name}}");
  });
});

describe("parseRss on pathological input", () => {
  const fast = (xml: string) => {
    const start = Date.now();
    parseRss(xml);
    expect(Date.now() - start).toBeLessThan(1000);
  };
  it("unclosed <item> repeated at the size cap", () => fast("<item>".repeat(160_000)));
  it("unclosed <title> inside an item", () => fast(`<item>${"<title>".repeat(140_000)}</item>`));
  it("unclosed CDATA, script and tags in a description", () => {
    fast(`<item><description>${"<![CDATA[".repeat(100_000)}</description></item>`);
    fast(`<item><description>${"&lt;script&gt;".repeat(70_000)}</description></item>`);
    fast(`<item><description>${"<<<".repeat(300_000)}</description></item>`);
  });
});

describe("pickItems", () => {
  it("filters by category, excludes keys, sorts newest first, caps", () => {
    const items = clean();
    expect(pickItems(items, { exclude: new Set(), max: 10 }).map((i) => i.key)).toEqual(["https://x.test/b", "g-a", "https://x.test/c"]);
    expect(pickItems(items, { category: "ads", exclude: new Set(), max: 10 }).map((i) => i.key)).toEqual(["https://x.test/b"]);
    expect(pickItems(items, { exclude: new Set(["g-a"]), max: 10 }).map((i) => i.key)).toEqual(["https://x.test/b", "https://x.test/c"]);
    expect(pickItems(items, { exclude: new Set(), max: 1 })).toHaveLength(1);
  });
});
