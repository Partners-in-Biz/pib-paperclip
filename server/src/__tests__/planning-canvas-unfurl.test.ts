import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type AddressInfo, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { guardedRemoteHttpFetch, type RemoteHttpSocketFactory } from "../services/remote-http-fetch.js";
import {
  createPlanningCanvasUnfurlGate,
  fetchPlanningCanvasWebLinkPreview,
  parsePlanningCanvasWebLinkHtml,
  planningCanvasUnfurlAddressAllowed,
  UNFURL_USER_AGENT,
  type PlanningCanvasUnfurlFetch,
} from "../services/planning-canvas-unfurl.js";

/**
 * PAR-14426 (plan PAR-14389 C.5 steps 1 to 9, E "D3"). The real
 * `guardedRemoteHttpFetch` runs under the wrapper: the custom lookup, the pin,
 * the peer check and its gunzip. Only TLS is skipped: the seam turns `https:`
 * into `http:` after the wrapper's step 1, and `socketFactory` routes every
 * dialled public address to one loopback listener that answers by `Host`.
 */

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let port = 0;
const sites = new Map<string, Handler>();
const requests: Array<{ host: string; url: string; method: string; headers: IncomingHttpHeaders }> = [];
const dns = new Map<string, string[]>();
const openSockets: Socket[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? "").toLowerCase();
    requests.push({ host, url: req.url ?? "", method: req.method ?? "", headers: req.headers });
    const handler = sites.get(host);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  sites.clear();
  dns.clear();
  requests.length = 0;
  for (const socket of openSockets.splice(0)) socket.destroy();
});

const socketFactory: RemoteHttpSocketFactory = (target) => {
  const socket = netConnect({ host: "127.0.0.1", port });
  openSockets.push(socket);
  Object.defineProperty(socket, "remoteAddress", { get: () => target.address, configurable: true });
  return socket;
};
const fetchSeam: PlanningCanvasUnfurlFetch = (url, init, options) => {
  const plain = new URL(url);
  plain.protocol = "http:";
  return guardedRemoteHttpFetch(plain, init, { ...options, socketFactory });
};
const lookup = async (hostname: string) => (dns.get(hostname) ?? []).map((address) => ({ address, family: isIP(address) }));

function site(host: string, handler: Handler, addresses = [PUBLIC_V4]) {
  dns.set(host, addresses);
  sites.set(host, handler);
}
const html = (body: string, type = "text/html; charset=utf-8"): Handler => (_req, res) => {
  res.writeHead(200, { "content-type": type });
  res.end(body);
};
const redirect = (location: string, status = 302): Handler => (_req, res) => {
  res.writeHead(status, { location });
  res.end();
};
const PAGE = `<html><head><title>Fallback</title>
<meta property="og:title" content="Example &amp; Co">
<meta name="og:description" content='A page about &quot;things&quot;'>
<meta property="og:site_name" content="Example"></head><body>x</body></html>`;

async function unfurl(url: string, deadlineMs?: number) {
  const logs: Array<[string, string]> = [];
  const preview = await fetchPlanningCanvasWebLinkPreview(url, {
    lookup,
    fetch: fetchSeam,
    deadlineMs,
    now: () => new Date("2026-11-26T00:00:00.000Z"),
    log: (host, reason) => logs.push([host, reason]),
  });
  return { preview, logs, reason: logs[0]?.[1] };
}

describe("web link preview fetch (C.5)", () => {
  it("returns the og text, with exactly the three request headers and no cookies", async () => {
    site("example.test", html(PAGE));
    const { preview, logs } = await unfurl("https://example.test/page?q=1");
    expect(preview).toEqual({ title: "Example & Co", description: 'A page about "things"', siteName: "Example", fetchedAt: "2026-11-26T00:00:00.000Z" });
    expect(logs).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("/page?q=1");
    const { host, connection, ...headers } = requests[0]!.headers;
    expect(host).toBe("example.test");
    expect(connection).toBeDefined();
    expect(headers).toEqual({ accept: "text/html", "accept-encoding": "identity", "user-agent": UNFURL_USER_AGENT });
  });

  it("accepts a public IPv6 answer inside 2000::/3", async () => {
    site("v6.test", html("<title>Six</title>"), [PUBLIC_V6]);
    expect((await unfurl("https://v6.test/")).preview?.title).toBe("Six");
  });

  describe("step 1: before any network call, on the first URL and every hop", () => {
    it.each([
      ["an IPv4 literal", `https://${PUBLIC_V4}/`, "ip_literal"],
      ["an IPv6 literal", `https://[${PUBLIC_V6}]/`, "ip_literal"],
      ["port 8443", "https://example.test:8443/", "port"],
      ["userinfo on the stored URL", "https://user:pw@example.test/", "stored_url"],
      ["an http: stored URL", "http://example.test/", "stored_url"],
    ])("refuses %s", async (_name, url, reason) => {
      site("example.test", html(PAGE));
      const result = await unfurl(url);
      expect(result.preview).toBeNull();
      expect(result.reason).toBe(reason);
      expect(requests).toHaveLength(0);
    });

    it.each([
      ["an http: hop", "http://next.test/", "not_https"],
      ["userinfo on a hop", "https://user:pw@next.test/", "userinfo"],
      ["port 8443 on a hop", "https://next.test:8443/", "port"],
      ["an IP-literal hop", `https://${PUBLIC_V4}/`, "ip_literal"],
    ])("refuses %s", async (_name, location, reason) => {
      site("start.test", redirect(location));
      site("next.test", html(PAGE));
      const result = await unfurl("https://start.test/");
      expect(result.preview).toBeNull();
      expect(result.reason).toBe(reason);
      expect(requests.map((r) => r.host)).toEqual(["start.test"]);
    });
  });

  describe("step 2: the strict address rule on every answer", () => {
    it.each(["127.0.0.1", "100.64.0.1", "::ffff:7f00:1", "::7f00:1", "::ffff:0:7f00:1", "fec0::1", "3ffe::1"])(
      "refuses a redirect to a name resolving to %s",
      async (address) => {
        site("start.test", redirect("https://inside.test/admin"));
        site("inside.test", html(PAGE), [address]);
        const result = await unfurl("https://start.test/");
        expect(result.preview).toBeNull();
        expect(result.reason).toBe("address_refused");
        expect(result.logs).toEqual([["inside.test", "address_refused"]]);
        expect(requests.map((r) => r.host)).toEqual(["start.test"]);
      },
    );

    it("refuses the whole answer when one address of it is private", async () => {
      site("mixed.test", html(PAGE), [PUBLIC_V4, "10.0.0.5"]);
      expect((await unfurl("https://mixed.test/")).reason).toBe("address_refused");
      expect(requests).toHaveLength(0);
    });

    it("allows only public IPv4 and public IPv6 inside 2000::/3", () => {
      for (const ok of [PUBLIC_V4, PUBLIC_V6, "2a00:1450:4001:80b::200e"]) expect(planningCanvasUnfurlAddressAllowed(ok)).toBe(true);
      for (const bad of [
        "127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1",
        "::ffff:93.184.216.34", "::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1", "fec0::1", "3ffe::1", "fe80::1", "fe80::1%eth0",
        "fd00::1", "ff02::1", "64:ff9b::7f00:1", "2001:db8::1", "2001:0db8::1", "2002:7f00:1::1", "not-an-ip",
      ]) {
        expect(planningCanvasUnfurlAddressAllowed(bad), bad).toBe(false);
      }
    });
  });

  it("step 4: follows three redirects, refuses a fourth", async () => {
    // r0/ -> r0/hop (relative Location) -> r1 -> r2 -> r3: four redirects; r0/hop starts three from the end.
    site("r0.test", (req, res) => (req.url === "/hop" ? redirect("https://r1.test/")(req, res) : redirect("/hop", 301)(req, res)));
    site("r1.test", redirect("https://r2.test/", 303));
    site("r2.test", redirect("https://r3.test/", 307));
    site("r3.test", html("<title>Three hops</title>"));
    const four = await unfurl("https://r0.test/");
    expect(four.preview).toBeNull();
    expect(four.reason).toBe("too_many_redirects");
    expect(requests.map((r) => `${r.host}${r.url}`)).toEqual(["r0.test/", "r0.test/hop", "r1.test/", "r2.test/"]);

    requests.length = 0;
    expect((await unfurl("https://r0.test/hop")).preview?.title).toBe("Three hops");
    expect(requests.map((r) => r.host)).toEqual(["r0.test", "r1.test", "r2.test", "r3.test"]);
  });

  it("step 5: a slow body past 5 s is cut by the one deadline", async () => {
    site("slow.test", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head><title>never");
    });
    const started = Date.now();
    const result = await unfurl("https://slow.test/");
    const elapsed = Date.now() - started;
    expect(result.preview).toBeNull();
    expect(result.reason).toBe("deadline");
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(6_500);
  }, 10_000);

  it("step 5: the deadline also covers a DNS lookup that never answers", async () => {
    const result = await fetchPlanningCanvasWebLinkPreview("https://hang.test/", {
      lookup: () => new Promise(() => {}),
      fetch: fetchSeam,
      deadlineMs: 200,
      log: () => {},
    });
    expect(result).toBeNull();
  });

  describe("step 6: status and type", () => {
    it.each([
      ["a PDF", (_req: IncomingMessage, res: ServerResponse) => html("%PDF-1.7", "application/pdf")(_req, res), "content_type"],
      ["a non-UTF-8 charset", html("<title>Caf\xe9</title>", "text/html; charset=iso-8859-1"), "charset"],
      ["a 404", (_req: IncomingMessage, res: ServerResponse) => res.writeHead(404, { "content-type": "text/html" }).end("<title>x</title>"), "status"],
    ] as Array<[string, Handler, string]>)("refuses %s", async (_name, handler, reason) => {
      site("t.test", handler);
      expect((await unfurl("https://t.test/")).reason).toBe(reason);
    });

    it("refuses bytes that are not UTF-8 when no charset is named", async () => {
      site("t.test", (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xe9, 0xff]));
      });
      expect((await unfurl("https://t.test/")).reason).toBe("charset");
    });
  });

  describe("step 7: the cap on decoded bytes", () => {
    it("refuses a 600 KB body", async () => {
      site("big.test", html(`<title>Big</title>${"a".repeat(600 * 1024)}`));
      expect((await unfurl("https://big.test/")).reason).toBe("too_large");
    });

    it("refuses a gzip bomb sent despite identity", async () => {
      const bomb = gzipSync(Buffer.from(`<title>Bomb</title>${" ".repeat(20 * 1024 * 1024)}`));
      expect(bomb.byteLength).toBeLessThan(64 * 1024);
      site("bomb.test", (_req, res) => {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(bomb);
      });
      expect((await unfurl("https://bomb.test/")).reason).toBe("too_large");
    });
  });

  it("step 8: HTML in a title arrives as text", async () => {
    site("x.test", html("<title>&lt;img src=x onerror=alert(1)&gt; <b>bold</b>\u202e\u0007</title>"));
    expect((await unfurl("https://x.test/")).preview?.title).toBe("<img src=x onerror=alert(1)> <b>bold</b>");
  });

  it("step 9: every failure is the same null, logged with the host only", async () => {
    site("leak.test", html("%PDF", "application/pdf"));
    const result = await unfurl("https://leak.test/private/path?token=SECRET-TOKEN#frag");
    expect(result.preview).toBeNull();
    expect(result.logs).toEqual([["leak.test", "content_type"]]);
    expect(JSON.stringify(result.logs)).not.toMatch(/SECRET|private|frag/);
  });
});

describe("parsePlanningCanvasWebLinkHtml", () => {
  it("falls back to <title>, decodes a fixed set of entities once, strips controls and caps", () => {
    const parsed = parsePlanningCanvasWebLinkHtml(
      `<TITLE lang=en>  A&nbsp;&amp;lt;B&#62;&#x43;\n\tD&bogus; </TITLE><meta content="${"d".repeat(900)}" property="OG:Description">`,
    );
    expect(parsed).toEqual({ title: "A &lt;B>C D&bogus;", description: "d".repeat(500), siteName: "" });
    expect(parsePlanningCanvasWebLinkHtml(`<title>${"\u{1F600}".repeat(150)}</title>`)?.title.length).toBe(200);
    expect(parsePlanningCanvasWebLinkHtml(`<title>${"a".repeat(199)}\u{1F600}</title>`)?.title).toBe("a".repeat(199));
  });

  it("keeps the first og value and answers null when there is no text", () => {
    expect(parsePlanningCanvasWebLinkHtml('<meta property="og:title" content="One"><meta property="og:title" content="Two">')?.title).toBe("One");
    expect(parsePlanningCanvasWebLinkHtml("<html><body>no head</body></html>")).toBeNull();
    expect(parsePlanningCanvasWebLinkHtml("<title> \u0000 </title>")).toBeNull();
  });
});

describe("unfurl gate (rate limit and in-flight caps)", () => {
  it("allows 30 per person per company per hour, then refuses until the window moves", () => {
    let now = 0;
    const gate = createPlanningCanvasUnfurlGate({ now: () => now });
    for (let i = 0; i < 30; i += 1) {
      const ticket = gate.tryStart("co-1", "u-1");
      expect(ticket.ok).toBe(true);
      if (ticket.ok) ticket.release();
    }
    expect(gate.tryStart("co-1", "u-1")).toMatchObject({ ok: false, refusal: "rate" });
    expect(gate.tryStart("co-2", "u-1").ok).toBe(true);
    expect(gate.tryStart("co-1", "u-2").ok).toBe(true);
    now = 60 * 60_000 + 1;
    expect(gate.tryStart("co-1", "u-1").ok).toBe(true);
  });

  it("holds 2 in flight per person and 6 per process; a busy refusal costs no allowance", () => {
    const gate = createPlanningCanvasUnfurlGate({ perHour: 3 });
    const a1 = gate.tryStart("co", "a"), a2 = gate.tryStart("co", "a");
    expect([a1.ok, a2.ok]).toEqual([true, true]);
    expect(gate.tryStart("co", "a")).toEqual({ ok: false, refusal: "busy" });
    expect(gate.tryStart("other-co", "a")).toEqual({ ok: false, refusal: "busy" });
    if (a1.ok) {
      a1.release();
      a1.release();
    }
    expect(gate.tryStart("co", "a").ok).toBe(true);
    expect(gate.tryStart("co", "a")).toEqual({ ok: false, refusal: "busy" });

    const wide = createPlanningCanvasUnfurlGate();
    const held = ["p1", "p1", "p2", "p2", "p3", "p3"].map((user) => wide.tryStart("co", user));
    expect(held.every((t) => t.ok)).toBe(true);
    expect(wide.tryStart("co", "p4")).toEqual({ ok: false, refusal: "busy" });
    const first = held[0]!;
    if (first.ok) first.release();
    expect(wide.tryStart("co", "p4").ok).toBe(true);
  });
});
