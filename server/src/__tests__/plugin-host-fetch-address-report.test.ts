import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { logger } from "../middleware/logger.js";

// PAR-14396 report-only stage: the plugin host logs (never refuses) a fetch whose
// pinned address the stricter check would refuse. Everything goes through the
// `http.fetch` host handler a plugin's `ctx.http.fetch` calls.

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

// Addresses that cannot be reached from a test box (Tailscale, NAT64, site-local ...)
// are recorded as the pinned connect target, then routed to the local test server.
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

const PLUGIN_KEY = "acme.fetch-report";
let server: Server;
let serverPort = 0;
const warn = vi.spyOn(logger, "warn");

function pluginFetch(url: string) {
  const services = buildHostServices({} as never, "plugin-record-id", PLUGIN_KEY, {
    forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }),
  } as never);
  const handlers = createHostClientHandlers({
    pluginId: PLUGIN_KEY,
    capabilities: ["http.outbound"] as never,
    services,
  });
  return handlers["http.fetch"]({ url });
}

function reports() {
  return warn.mock.calls
    .map(([record]) => record as unknown as Record<string, unknown>)
    .filter((record) => record?.event === "plugin_fetch_strict_address_report");
}

beforeAll(async () => {
  server = createServer((req, res) => res.end(`ok ${req.headers.host}`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  warn.mockClear();
  dnsAnswers.clear();
  redirect.port = 0;
  redirect.connectedHosts = [];
});

const family = (address: string) => (address.includes(":") ? 6 : 4);
let hostSeq = 0;
const uniqueHost = (label: string) => `${label}-${++hostSeq}.report.test`;

describe("plugin ctx.http.fetch strict-address report (PAR-14396, report only)", () => {
  it("hex IPv4-mapped loopback reaches a real loopback server through the host, and is reported without the query", async () => {
    const result = await pluginFetch(`http://[::ffff:127.0.0.1]:${serverPort}/hook?token=secret-value`);

    expect(result.status).toBe(200);
    expect(result.body).toContain("ok");
    expect(redirect.connectedHosts).toEqual(["::ffff:7f00:1"]);
    expect(reports()).toEqual([expect.objectContaining({
      pluginKey: PLUGIN_KEY,
      host: `[::ffff:7f00:1]:${serverPort}`,
      resolvedAddress: "::ffff:7f00:1",
      wouldFail: true,
      fallbackAddress: null,
    })]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-value|token|\/hook/);
  });

  // One case per range the old check misses, plus the four IPv6 forms isPrivateOrReservedIp
  // misses and fe90::1 (fe80::/10 was matched as the string prefix "fe80" only).
  const missedAddresses = [
    ["100.64.0.0/10 (Tailscale, low)", "100.64.0.1"],
    ["100.64.0.0/10 (Tailscale, MagicDNS)", "100.100.100.100"],
    ["0.0.0.0/8", "0.1.2.3"],
    ["198.18.0.0/15", "198.19.255.1"],
    ["multicast 224.0.0.0/4", "224.0.0.251"],
    ["reserved 240.0.0.0/4", "240.0.0.1"],
    ["NAT64 64:ff9b::/96", "64:ff9b::7f00:1"],
    ["fe80::/10 past the fe80 prefix", "fe90::1"],
    ["IPv4-compatible ::/96", "::7f00:1"],
    ["IPv4-compatible ::/96, glibc spelling", "::127.0.0.1"],
    ["IPv4-translated ::ffff:0:0/96", "::ffff:0:7f00:1"],
    ["site-local fec0::/10", "fec0::1"],
    ["6bone 3ffe::/16", "3ffe::1"],
    ["IPv6 multicast ff00::/8", "ff02::1"],
  ] as const;

  it.each(missedAddresses)("DNS name resolving to %s (%s) is fetched and reported", async (_label, address) => {
    redirect.port = serverPort;
    const host = uniqueHost("dns");
    dnsAnswers.set(host, [{ address, family: family(address) }]);

    const result = await pluginFetch(`http://${host}/path?q=1`);

    expect(result.status).toBe(200);
    expect(redirect.connectedHosts).toEqual([address]);
    expect(reports()).toEqual([expect.objectContaining({
      pluginKey: PLUGIN_KEY, host, resolvedAddress: address, wouldFail: true,
    })]);
  });

  it.each([
    "100.64.0.1",
    "198.18.0.1",
    "[::ffff:0:7f00:1]",
    "[::7f00:1]",
    "[fec0::1]",
    "[3ffe::1]",
    "[fe90::1]",
    "[64:ff9b::7f00:1]",
  ])("IP literal %s is fetched and reported", async (literal) => {
    redirect.port = serverPort;
    const result = await pluginFetch(`http://${literal}/`);

    expect(result.status).toBe(200);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ pluginKey: PLUGIN_KEY, wouldFail: true });
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])("public address %s is fetched and not reported", async (address) => {
    redirect.port = serverPort;
    const host = uniqueHost("public");
    dnsAnswers.set(host, [{ address, family: family(address) }]);

    const result = await pluginFetch(`http://${host}/`);

    expect(result.status).toBe(200);
    expect(redirect.connectedHosts).toEqual([address]);
    expect(reports()).toEqual([]);
  });

  it.each(["127.0.0.1", "10.1.2.3", "::1", "fe80::1"])("address %s the current check refuses is still refused, not reported", async (address) => {
    const host = uniqueHost("private");
    dnsAnswers.set(host, [{ address, family: family(address) }]);

    await expect(pluginFetch(`http://${host}/`)).rejects.toThrow(/private\/reserved ranges/);
    expect(redirect.connectedHosts).toEqual([]);
    expect(reports()).toEqual([]);
  });

  it("multi-homed name: reports the pinned address and the public address enforcement would use", async () => {
    redirect.port = serverPort;
    const host = uniqueHost("multi");
    dnsAnswers.set(host, [{ address: "100.64.0.1", family: 4 }, { address: "93.184.216.34", family: 4 }]);

    await pluginFetch(`http://${host}/`);

    expect(reports()).toEqual([expect.objectContaining({
      resolvedAddress: "100.64.0.1", wouldFail: false, fallbackAddress: "93.184.216.34",
    })]);
  });

  it("logs one line per plugin, host and address per window and counts the repeats", async () => {
    redirect.port = serverPort;
    const host = uniqueHost("repeat");
    dnsAnswers.set(host, [{ address: "100.64.0.9", family: 4 }]);

    await pluginFetch(`http://${host}/`);
    await pluginFetch(`http://${host}/`);
    await pluginFetch(`http://${host}/`);

    expect(redirect.connectedHosts).toHaveLength(3);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ repeatsSinceLastReport: 0 });
  });
});
