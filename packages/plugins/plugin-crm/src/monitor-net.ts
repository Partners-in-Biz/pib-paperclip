/**
 * The network side of site monitoring: a certificate's expiry, a domain's
 * expiry, and the safety rules around both. Pure helpers (address checks,
 * domain splitting, RDAP parsing) are tested directly; the two network calls are
 * injected into the monitor so tests never touch the network.
 *
 * What these may do, and no more:
 * - the page check is one GET of the site's own address through the host's
 *   SSRF-guarded `ctx.http.fetch` (capability `http.outbound`, which the CRM
 *   already has);
 * - the certificate check is one TLS handshake with the site's own host on port
 *   443, nothing sent after it. Raw sockets bypass the host's address guard, so it
 *   resolves the name itself and refuses any private, loopback, link-local or
 *   reserved address before connecting (a site address an agent saved can never
 *   point it at an internal service), and connects to the address it checked;
 * - the domain check is one RDAP lookup (public registry data) per domain per day.
 * Nothing here scans, crawls or probes other ports.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect } from "node:tls";

/**
 * True for an address on the public internet. Everything private, local or reserved is refused, and anything this cannot read is refused
 * too. An IPv6 address is public only when it is global unicast (2000::/3) outside the special ranges; an IPv4-mapped one (any spelling,
 * dotted or hex) is judged as the IPv4 address it carries.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address);
  if (version !== 6) return false;
  const hextets = ipv6Hextets(address);
  if (!hextets) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hextets;
  // ::ffff:0:0/96, written either ::ffff:10.0.0.1 or ::ffff:a00:1: the address it carries decides.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPublicV4(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  // Everything outside global unicast goes: unspecified, loopback, IPv4-compatible ::/96, NAT64, 100::/64, unique local, link and site local, multicast.
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && b < 0x200) return false; // 2001::/23: Teredo (embeds IPv4), benchmarking, ORCHID and other protocol assignments
  if (a === 0x2001 && b === 0xdb8) return false; // documentation
  if (a === 0x2002) return false; // 6to4: embeds an IPv4 address
  if (a === 0x3fff && b < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** The eight 16-bit groups of an IPv6 address (any valid spelling: `::` compression, a trailing dotted IPv4), or null. A zone id (`%eth0`) is not read: a public address never has one. */
function ipv6Hextets(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted.slice(1, 5).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const fill = halves.length === 2 ? new Array<string>(8 - head.length - tail.length).fill("0") : [];
  const groups = [...head, ...fill, ...tail].map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

function isPublicV4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast and reserved
  return true;
}

// ---------------------------------------------------------------------------
// Certificate expiry
// ---------------------------------------------------------------------------

export interface TlsResult {
  expiresAt: string | null;
  error: string | null;
}

export interface TlsOptions {
  port?: number;
  timeoutMs?: number;
  /** Replaces the DNS lookup (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Replaces the socket (tests). */
  connectFn?: typeof connect;
}

async function resolvePublic(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true });
  return found.map((entry) => entry.address);
}

/** One TLS handshake with the host: when its certificate expires. Never throws. */
export async function tlsExpiry(hostname: string, options: TlsOptions = {}): Promise<TlsResult> {
  const host = hostname.trim().toLowerCase();
  if (!host || host.includes("/") || host.includes(":") || /\s/.test(host)) return { expiresAt: null, error: "Not a host name." };
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (options.resolve ?? resolvePublic)(host);
  } catch (error) {
    return { expiresAt: null, error: `The name did not resolve (${error instanceof Error ? error.message : String(error)}).` };
  }
  if (addresses.length === 0) return { expiresAt: null, error: "The name did not resolve." };
  // Every address must be public: a name that also points inside our network is refused outright.
  if (addresses.some((address) => !isPublicAddress(address))) return { expiresAt: null, error: "The name points at a private or reserved address, so it was not contacted." };
  // An IPv4 address first: a host with no IPv6 route would hang on an IPv6 one, and the check is the same either way.
  const target = addresses.find((address) => isIP(address) === 4) ?? addresses[0]!;
  return new Promise<TlsResult>((resolve) => {
    let settled = false;
    const done = (result: TlsResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = (options.connectFn ?? connect)({ host: target, port: options.port ?? 443, servername: host, rejectUnauthorized: false, timeout: options.timeoutMs ?? 8_000 }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert && typeof cert.valid_to === "string" ? Date.parse(cert.valid_to) : Number.NaN;
      if (!Number.isFinite(validTo)) return done({ expiresAt: null, error: "The site sent no readable certificate." });
      done({ expiresAt: new Date(validTo).toISOString(), error: socket.authorized ? null : `The certificate is not trusted (${String(socket.authorizationError)}).` });
    });
    socket.on("timeout", () => done({ expiresAt: null, error: "The TLS handshake timed out." }));
    socket.on("error", (error) => done({ expiresAt: null, error: `TLS failed (${error.message}).` }));
  });
}

// ---------------------------------------------------------------------------
// Domain expiry (RDAP)
// ---------------------------------------------------------------------------

/** Second-level suffixes that count as one public suffix (not exhaustive: an unlisted one falls back to two labels). */
const TWO_LABEL_SUFFIXES = new Set([
  "co.za", "org.za", "net.za", "gov.za", "ac.za", "web.za", "edu.za", "ngo.za",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.ke", "co.zw", "co.bw", "com.na", "com.br", "co.in", "co.jp", "com.mx", "com.ng",
]);

/** The registrable domain of a host: `www.acme.co.za` is `acme.co.za`. Null for an address or a name with no dot. */
export function registrableDomain(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (!name || isIP(name) || !name.includes(".") || !/^[a-z0-9.-]+$/.test(name)) return null;
  const labels = name.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  return lastTwo;
}

export function rdapUrl(domain: string): string {
  return `https://rdap.org/domain/${encodeURIComponent(domain)}`;
}

export interface DomainResult {
  expiresAt: string | null;
  error: string | null;
}

/**
 * What a registry lookup that gave no date says. rdap.org answers 404 for an ending it has no registry for (`.co.za` is one, and every
 * client site we run is a `.co.za`), which no retry changes: say so, and say what to do.
 */
export function rdapProblem(domain: string, status: number): string {
  if (status === 404) {
    const ending = `.${domain.split(".").slice(1).join(".")}`;
    return `The public registry lookup (rdap.org) has no data for ${ending} domains, so the expiry is not known. Read the renewal date from the domain's registrar and set it with set-site-monitoring (domainExpiresAt).`;
  }
  return `The registry lookup answered ${status}.`;
}

/** The expiry date in an RDAP domain record, or an error saying why there is none. */
export function parseRdapExpiry(body: unknown): DomainResult {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const events = Array.isArray(record.events) ? record.events : [];
  for (const event of events) {
    const e = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    if (typeof e.eventAction === "string" && /expir/i.test(e.eventAction) && typeof e.eventDate === "string") {
      const at = Date.parse(e.eventDate);
      if (Number.isFinite(at)) return { expiresAt: new Date(at).toISOString(), error: null };
    }
  }
  return { expiresAt: null, error: "The registry record has no expiry date." };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const DOWN_AFTER_MINUTES = 5;
export const TLS_WARN_DAYS = 14;
export const DOMAIN_WARN_DAYS = 30;

export function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor((at - now) / 86_400_000) : null;
}
