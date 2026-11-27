import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";

// PAR-14396 enforcing stage: the plugin host refuses a fetch whose every resolved
// address `isPrivateOrReservedIp` refuses. Everything goes through the `http.fetch`
// host handler a plugin's `ctx.http.fetch` calls.

type LookupAnswer = { address: string; family: number };
const dnsAnswers = vi.hoisted(() => new Map<string, LookupAnswer[]>());
const redirect = vi.hoisted(() => ({ port: 0, connectedHosts: [] as string[] }));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: vi.fn(async (hostname: string, options?: unknown) => {
      const answer = dnsAnswers.get(hostname);
      return answer ?? actual.lookup(hostname, options as never);
    }),
  };
});

// Every connect attempt is recorded; public test addresses are routed to the local
// test server so "still works" cases need no network.
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    request: vi.fn((options: import("node:http").RequestOptions, callback: never) => {
      redirect.connectedHosts.push(String(options.host));
      if (redirect.port === 0) return actual.request(options, callback);
      return actual.request({ ...options, host: "127.0.0.1", port: redirect.port }, callback);
    }),
  };
});

const PLUGIN_KEY = "acme.fetch-guard";
const REFUSED = /private\/reserved ranges/;
let server: Server;
let serverPort = 0;
let serverHits = 0;

function pluginFetch(url: string, init?: Record<string, unknown>) {
  const services = buildHostServices({} as never, "plugin-record-id", PLUGIN_KEY, {
    forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }),
  } as never);
  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_KEY,
    capabilities: ["http.outbound"] as never,
    services,
  });
  return handlers["http.fetch"]({ url, init } as never);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    serverHits += 1;
    res.end(`ok ${req.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dnsAnswers.clear();
  redirect.port = 0;
  redirect.connectedHosts = [];
  serverHits = 0;
});

const family = (address: string) => (address.includes(":") ? 6 : 4);
let hostSeq = 0;
const uniqueHost = (label: string) => `${label}-${++hostSeq}.guard.test`;

describe("plugin ctx.http.fetch refuses private and reserved addresses (PAR-14396)", () => {
  it("hex IPv4-mapped loopback no longer reaches a real loopback server through the host", async () => {
    await expect(pluginFetch(`http://[::ffff:127.0.0.1]:${serverPort}/hook?token=secret-value`)).rejects.toThrow(REFUSED);
    expect(redirect.connectedHosts).toEqual([]);
    expect(serverHits).toBe(0);
  });

  // One case per range the old check missed, plus the four IPv6 forms isPrivateOrReservedIp
  // missed and fe90::1 (fe80::/10 was matched as the string prefix "fe80" only).
  const newlyRefused = [
    ["100.64.0.0/10 (Tailscale, low)", "100.64.0.1"],
    ["100.64.0.0/10 (Tailscale, MagicDNS)", "100.100.100.100"],
    ["0.0.0.0/8", "0.1.2.3"],
    ["198.18.0.0/15", "198.19.255.1"],
    ["multicast 224.0.0.0/4", "224.0.0.251"],
    ["reserved 240.0.0.0/4", "240.0.0.1"],
    ["NAT64 64:ff9b::/96", "64:ff9b::7f00:1"],
    ["hex IPv4-mapped loopback", "::ffff:7f00:1"],
    ["fe80::/10 past the fe80 prefix", "fe90::1"],
    ["IPv4-compatible ::/96", "::7f00:1"],
    ["IPv4-compatible ::/96, glibc spelling", "::127.0.0.1"],
    ["IPv4-translated ::ffff:0:0/96", "::ffff:0:7f00:1"],
    ["site-local fec0::/10", "fec0::1"],
    ["6bone 3ffe::/16", "3ffe::1"],
    ["IPv6 multicast ff00::/8", "ff02::1"],
  ] as const;

  it.each(newlyRefused)("DNS name resolving to %s (%s) is refused before connecting", async (_label, address) => {
    redirect.port = serverPort;
    const host = uniqueHost("dns");
    dnsAnswers.set(host, [{ address, family: family(address) }]);

    await expect(pluginFetch(`http://${host}/path?q=1`)).rejects.toThrow(REFUSED);
    expect(redirect.connectedHosts).toEqual([]);
  });

  it.each([
    "100.64.0.1",
    "198.18.0.1",
    "[::ffff:7f00:1]",
    "[::ffff:0:7f00:1]",
    "[::7f00:1]",
    "[fec0::1]",
    "[3ffe::1]",
    "[fe90::1]",
    "[64:ff9b::7f00:1]",
  ])("IP literal %s is refused before connecting", async (literal) => {
    redirect.port = serverPort;
    await expect(pluginFetch(`http://${literal}/`)).rejects.toThrow(REFUSED);
    expect(redirect.connectedHosts).toEqual([]);
  });

  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fd00::1"])(
    "address %s the old check refused is still refused",
    async (address) => {
      const host = uniqueHost("private");
      dnsAnswers.set(host, [{ address, family: family(address) }]);

      await expect(pluginFetch(`http://${host}/`)).rejects.toThrow(REFUSED);
      expect(redirect.connectedHosts).toEqual([]);
    },
  );

  it.each(["93.184.216.34", "2606:4700:4700::1111"])("public address %s still works", async (address) => {
    redirect.port = serverPort;
    const host = uniqueHost("public");
    dnsAnswers.set(host, [{ address, family: family(address) }]);

    const result = await pluginFetch(`http://${host}/`);

    expect(result.status).toBe(200);
    expect(redirect.connectedHosts).toEqual([address]);
  });

  it("multi-homed name: the refused address is skipped and the public one is pinned", async () => {
    redirect.port = serverPort;
    const host = uniqueHost("multi");
    dnsAnswers.set(host, [{ address: "100.64.0.1", family: 4 }, { address: "93.184.216.34", family: 4 }]);

    const result = await pluginFetch(`http://${host}/`);

    expect(result.status).toBe(200);
    expect(redirect.connectedHosts).toEqual(["93.184.216.34"]);
  });

  // Settings- and user-supplied URLs: the call shapes CRM connector.ts and Campaigns feed.ts use.
  // Both catch a thrown fetch error, so a refusal must reject, not hang or connect.
  it("a CRM connector-style POST to a site URL on the Tailscale range is refused", async () => {
    const host = uniqueHost("crm-site");
    dnsAnswers.set(host, [{ address: "100.101.102.103", family: 4 }]);

    await expect(pluginFetch(`https://${host}/wp-json/pib/v1/connect`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual",
    })).rejects.toThrow(REFUSED);
    expect(redirect.connectedHosts).toEqual([]);
  });

  it("a Campaigns feed-style GET to a feed on an IPv4-compatible loopback is refused", async () => {
    const host = uniqueHost("feed");
    dnsAnswers.set(host, [{ address: "::127.0.0.1", family: 6 }]);

    await expect(pluginFetch(`https://${host}/feed.xml?utm=1`, {
      method: "GET", headers: { accept: "application/rss+xml, application/xml, text/xml" },
    })).rejects.toThrow(REFUSED);
    expect(redirect.connectedHosts).toEqual([]);
  });
});
