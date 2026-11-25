import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyRemoteConnectionError, markRemoteConnectionFailure, readRemoteConnectionFailure } from "./remote-connection-failure.js";

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

type LookupResult = { address: string; family: number };

export type RemoteHttpEndpointLookup = (hostname: string) => Promise<LookupResult[]>;

export type RemoteHttpEndpointGuardOptions = {
  allowPrivateNetwork?: boolean;
  dnsTimeoutMs?: number;
  lookup?: RemoteHttpEndpointLookup;
};

export type RemoteHttpEndpointErrorFactory = (message: string, code: string) => Error;

export function parseRemoteHttpEndpoint(
  value: unknown,
  error: RemoteHttpEndpointErrorFactory,
): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw error("Remote MCP connection requires config.url", "mcp_remote_url_missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw error("Remote MCP connection URL is invalid", "mcp_remote_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw error("Remote MCP connection URL must use http or https", "mcp_remote_url_invalid");
  }
  return parsed;
}

export async function assertPublicRemoteHttpEndpoint(
  endpoint: URL,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<void> {
  await resolveApprovedRemoteHttpAddresses(endpoint, options, error);
}

/**
 * Validate a remote endpoint and return the exact address set that was approved.
 *
 * Callers must dial one of the returned addresses instead of letting the socket
 * layer resolve the hostname a second time. A second resolution reopens a
 * DNS-rebinding TOCTOU window: an attacker-controlled name server can answer
 * with a public address while this guard is looking, then with a loopback,
 * private or link-local address a moment later when the connection is made
 * (PAP-17098). Returning the resolved set — rather than a bare `void` — is what
 * lets `guardedRemoteHttpFetch` close that window.
 *
 * Hostnames are always resolved and pinned, including in deployments that
 * allow private networking. Link-local addresses remain outside that allowance,
 * so handing an allowed hostname back to platform fetch would reopen a DNS
 * rebinding path to instance metadata.
 */
export async function resolveApprovedRemoteHttpAddresses(
  endpoint: URL,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<string[]> {
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!options.allowPrivateNetwork && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    if (isAlwaysDeniedLinkLocalIp(hostname) || (!options.allowPrivateNetwork && isPrivateOrReservedIp(hostname))) {
      throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
    }
    return [hostname];
  }

  let results: LookupResult[];
  try {
    results = await lookupWithTimeout(
      hostname,
      options.lookup ?? defaultLookup,
      options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    );
  } catch (cause) {
    const failure = error("Remote MCP connection hostname could not be resolved", "remote_http_dns_failed");
    const reason = readRemoteConnectionFailure(cause) ?? classifyRemoteConnectionError(cause);
    if (reason === "dns_failure" || reason === "connection_timeout") markRemoteConnectionFailure(failure, reason);
    throw failure;
  }
  if (results.length === 0) {
    throw markRemoteConnectionFailure(error("Remote MCP connection hostname did not resolve", "remote_http_dns_failed"), "dns_failure");
  }
  if (results.some((result) =>
    isAlwaysDeniedLinkLocalIp(result.address)
    || (!options.allowPrivateNetwork && isPrivateOrReservedIp(result.address)))) {
    throw error("Remote MCP connection URL cannot resolve to private or reserved network addresses", "remote_http_private_endpoint");
  }
  return results.map((result) => result.address);
}

/**
 * Reduce an address to the form used for comparing an approved address against
 * the peer a socket actually connected to. `socket.remoteAddress` may come back
 * as an IPv4-mapped IPv6 address or carry an IPv6 zone index, neither of which
 * appears in a DNS answer.
 */
export function normalizeIpAddress(address: string): string {
  const lower = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return mappedIpv4[1];
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return mappedIpv4Hex;
  return lower;
}

function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function lookupWithTimeout(hostname: string, lookup: RemoteHttpEndpointLookup, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(markRemoteConnectionFailure(new Error(`DNS lookup timed out for ${hostname}`), "connection_timeout"));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isPrivateOrReservedIp(address: string): boolean {
  const lower = address.toLowerCase();
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
  if (isIP(address) === 4) return isPrivateOrReservedIpv4(address);
  if (isIP(address) === 6) return isPrivateOrReservedIpv6(lower);
  return true;
}

/**
 * IPv6 forms `isPrivateOrReservedIp` does not refuse yet (PAR-14396): IPv4-compatible
 * `::/96` (e.g. `::7f00:1`), IPv4-translated `::ffff:0:0/96` (e.g. `::ffff:0:7f00:1`),
 * deprecated site-local `fec0::/10` and the returned 6bone block `3ffe::/16`.
 * Parsed by value, so `::127.0.0.1` (glibc's spelling of `::7f00:1`) matches too.
 * Report-only for now; the enforcing change folds this into `isPrivateOrReservedIpv6`.
 */
export function isLegacyIpv6EmbeddedOrReserved(address: string): boolean {
  const hextets = parseIpv6Hextets(address);
  if (!hextets) return false;
  const [h0, h1, h2, h3, h4, h5] = hextets as [number, number, number, number, number, number];
  const firstFourZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0;
  if (firstFourZero && h4 === 0 && h5 === 0) return true;
  if (firstFourZero && h4 === 0xffff && h5 === 0) return true;
  if ((h0 & 0xffc0) === 0xfec0) return true;
  return h0 === 0x3ffe;
}

function parseIpv6Hextets(address: string): number[] | null {
  let text = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (isIP(text) !== 6) return null;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    const octets = parseIpv4Address(dotted[1]);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, -dotted[1].length)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const front = groups(halves[0]);
  const back = groups(halves[1]);
  const missing = 8 - front.length - back.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...front, ...Array<number>(missing).fill(0), ...back];
}

/** Link-local egress is denied in every deployment mode. */
export function isAlwaysDeniedLinkLocalIp(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (isIP(normalized) === 4) {
    const octets = parseIpv4Address(normalized);
    return octets !== null && octets[0] === 169 && octets[1] === 254;
  }
  return isIP(normalized) === 6 && /^fe[89ab]/.test(normalized);
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed as [number, number, number, number];
}

function parseMappedIpv4Hex(address: string): string | null {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(address)) return true;
  if (address.startsWith("ff")) return true;
  if (address === "100::" || address.startsWith("100:")) return true;
  if (/^2001:(?:0{0,4}:|:)/.test(address)) return true;
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return true;
  if (address.startsWith("2001:2:") || address === "2001:2::") return true;
  if (/^2001:0?2[0-9a-f]:/.test(address)) return true;
  if (address.startsWith("2002:")) return true;
  if (address.startsWith("64:ff9b:")) return true;
  return false;
}
