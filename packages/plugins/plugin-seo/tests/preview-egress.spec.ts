/**
 * PAR-8798 (plan PAR-8787 r3, T1): the preview service's /render runs Chromium with scripts on, so both the URL it is
 * asked for and every connection the page makes must be refused when they reach a non-public address (SSRF).
 * The proxy tests use real local sockets and an injected resolver.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy } from "../ops/preview-server/egress.mjs";
import { checkRenderUrl, isPublicAddress } from "../ops/preview-server/sweep.mjs";

const PRIVATE = ["127.0.0.1", "127.255.0.9", "::1", "0.0.0.0", "::", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.254", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "[::1]", "::127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "", "localhost", "not-an-ip", "1.2.3", "256.1.1.1"];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "65.108.146.144", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a01:4f9:c010::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "[2606:4700::1]"];

describe("isPublicAddress", () => {
  it.each(PRIVATE)("refuses %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(PUBLIC)("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
});

const table: Record<string, string[]> = {
  "public.test": ["93.184.215.14"],
  "mixed.test": ["93.184.215.14", "10.0.0.1"],
  "inside.test": ["10.0.0.1"],
  "meta.test": ["169.254.169.254"],
  "empty.test": [],
};
const resolver = async (host: string) => {
  if (!(host in table)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return table[host]!;
};

describe("checkRenderUrl", () => {
  it.each([
    ["file:///etc/passwd", /scheme file:/],
    ["ftp://public.test/x", /scheme ftp:/],
    ["data:text/html,<p>x</p>", /scheme data:/],
    ["javascript:alert(1)", /scheme javascript:/],
    ["http://user:pw@public.test/", /user name or password/],
    ["https://user@public.test/", /user name or password/],
    ["http://public.test:22/", /port 22/],
    ["https://public.test:3031/", /port 3031/],
    ["http://127.0.0.1/", /non-public/],
    ["http://127.0.0.1:3031/health", /port 3031/],
    ["http://[::1]/", /non-public/],
    ["http://10.0.0.1/", /non-public/],
    ["http://172.16.0.1/", /non-public/],
    ["http://192.168.1.1/", /non-public/],
    ["http://169.254.169.254/latest/meta-data/", /non-public/],
    ["http://100.64.0.1/", /non-public/],
    ["http://[fc00::1]/", /non-public/],
    ["http://[::ffff:127.0.0.1]/", /non-public/],
    ["http://2130706433/", /non-public/], // WHATWG URL turns this into 127.0.0.1
    ["https://mixed.test/", /non-public address \(10\.0\.0\.1\)/],
    ["https://meta.test/", /non-public/],
    ["https://empty.test/", /no address/],
    ["https://missing.test/", /does not resolve \(ENOTFOUND\)/],
    ["not a url", /not a URL/],
  ])("refuses %s", async (url, reason) => {
    await expect(checkRenderUrl(url, resolver)).rejects.toThrow(reason);
  });

  it("allows a public IP or a name whose every address is public, and returns what it checked", async () => {
    await expect(checkRenderUrl("https://8.8.8.8/", resolver)).resolves.toMatchObject({ host: "8.8.8.8", port: 443, addresses: ["8.8.8.8"] });
    await expect(checkRenderUrl("http://public.test:80/about-us/", resolver)).resolves.toEqual({ url: "http://public.test/about-us/", host: "public.test", port: 80, addresses: ["93.184.215.14"] });
    await expect(checkRenderUrl("https://public.test:443/", resolver)).resolves.toMatchObject({ port: 443 });
  });
});

// ---- the proxy ----

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  return (server.address() as net.AddressInfo).port;
}

/** Send a CONNECT; resolve with the status line and the open socket. */
function connect(proxyPort: number, authority: string): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((done, fail) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    closers.push(() => void socket.destroy());
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      done({ status: buf.slice(0, buf.indexOf("\r\n")), socket });
    };
    socket.on("data", onData);
    socket.on("error", fail);
  });
}

/** A plain-HTTP absolute-URI request through the proxy. */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: new URL(url).host }, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

const closed = (socket: net.Socket) => new Promise<void>((done) => (socket.destroyed ? done() : socket.once("close", () => done())));

describe("egress proxy", () => {
  async function proxy(options = {}) {
    const p = await startEgressProxy({ resolve: resolver, ...options });
    closers.push(p.close);
    return p.port;
  }

  it("refuses CONNECT to the preview service itself, by port and by address", async () => {
    const port = await proxy();
    for (const target of ["127.0.0.1:3031", "127.0.0.1:443", "localhost:443", "[::1]:443", "169.254.169.254:80"]) {
      const { status, socket } = await connect(port, target);
      expect(status, target).toMatch(/^HTTP\/1\.1 403/);
      await closed(socket);
    }
  });

  it("refuses CONNECT to a name resolving to a private address, or to public and private together", async () => {
    const port = await proxy();
    for (const target of ["inside.test:443", "mixed.test:443", "missing.test:443"]) expect((await connect(port, target)).status, target).toMatch(/^HTTP\/1\.1 403/);
    expect((await connect(port, "public.test:22")).status).toMatch(/^HTTP\/1\.1 403/);
    expect((await connect(port, "no-port")).status).toMatch(/^HTTP\/1\.1 400/);
  });

  it("tunnels to an upstream it was told is public, connecting to the checked address without a second lookup", async () => {
    const echo = net.createServer((s) => s.pipe(s));
    const upstreamPort = await listen(echo);
    const lookups: string[] = [];
    // A rebinding resolver: first answer "public" (the test upstream), every later answer private.
    const rebinding = async (host: string) => {
      lookups.push(host);
      return lookups.length === 1 ? ["127.0.0.1"] : ["10.0.0.1"];
    };
    const port = await proxy({ resolve: rebinding, isPublic: (ip: string) => ip === "127.0.0.1", ports: [443, upstreamPort] });
    const { status, socket } = await connect(port, `upstream.test:${upstreamPort}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const reply = new Promise<string>((done) => socket.once("data", (c) => done(c.toString())));
    socket.write("ping");
    expect(await reply).toBe("ping");
    expect(lookups).toEqual(["upstream.test"]);
  });

  it("forwards plain-HTTP requests to a checked upstream and refuses private ones", async () => {
    const web = http.createServer((req, res) => res.end(`hello ${req.headers.host} ${req.url}`));
    const upstreamPort = await listen(web);
    const port = await proxy({ resolve: async () => ["127.0.0.1"], isPublic: (ip: string) => ip === "127.0.0.1", ports: [80, upstreamPort] });
    expect(await viaProxy(port, `http://site.test:${upstreamPort}/a?b=1`)).toEqual({ status: 200, body: `hello site.test:${upstreamPort} /a?b=1` });

    const strict = await proxy();
    for (const url of ["http://127.0.0.1:3031/health", "http://169.254.169.254/latest/meta-data/", "http://inside.test/", "http://mixed.test/"]) {
      expect((await viaProxy(strict, url)).status, url).toBe(403);
    }
  });

  it("closes an idle tunnel", async () => {
    const silent = net.createServer(() => undefined);
    const upstreamPort = await listen(silent);
    const port = await proxy({ resolve: async () => ["127.0.0.1"], isPublic: () => true, ports: [upstreamPort], idleMs: 150 });
    const { status, socket } = await connect(port, `quiet.test:${upstreamPort}`);
    expect(status).toMatch(/200/);
    const started = Date.now();
    await closed(socket);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("listens on 127.0.0.1 only", async () => {
    const p = await startEgressProxy();
    closers.push(p.close);
    await expect(new Promise((done, fail) => net.connect(p.port, "127.0.0.1").once("connect", function (this: net.Socket) { this.destroy(); done(true); }).once("error", fail))).resolves.toBe(true);
    const source = (await import("node:fs")).readFileSync(new URL("../ops/preview-server/egress.mjs", import.meta.url), "utf8");
    expect(source).toContain('server.listen(0, "127.0.0.1"');
  });
});
