import dns from "node:dns";
import https from "node:https";
import { type ClientRequest, type IncomingMessage } from "node:http";
import net from "node:net";
import { isAllowedPushEndpoint } from "./hosts.js";

export interface PushLookupResult {
  address: string;
  family: number;
}

export interface PushTransportDeps {
  lookup?: (hostname: string) => Promise<PushLookupResult[]>;
  request?: typeof https.request;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface PushResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bodyTruncated: boolean;
}

export type PushTransportErrorCode =
  | "endpoint_not_allowed"
  | "dns_failed"
  | "private_address"
  | "redirect"
  | "timeout"
  | "network"
  | "body_too_large"
  | "bad_headers";

export class PushTransportError extends Error {
  readonly code: PushTransportErrorCode;
  constructor(code: PushTransportErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PushTransportError";
  }
}

export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return true;

  if (version === 4) {
    const octets = ip.split(".").map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return true;
    const [a, b, c, d] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ip.includes("%")) return true; // Zone ID: fail closed

  let normalized: string;
  try {
    normalized = new URL("http://[" + ip + "]/").hostname.slice(1, -1);
  } catch {
    return true;
  }

  const groups: number[] = [];
  if (normalized.includes("::")) {
    const parts = normalized.split("::");
    if (parts.length !== 2) return true;
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const padding = 8 - left.length - right.length;
    if (padding < 0) return true;
    for (const g of left) groups.push(parseInt(g, 16) || 0);
    for (let i = 0; i < padding; i++) groups.push(0);
    for (const g of right) groups.push(parseInt(g, 16) || 0);
  } else {
    const parts = normalized.split(":");
    if (parts.length !== 8) return true;
    for (const g of parts) groups.push(parseInt(g, 16) || 0);
  }

  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8

  // 0::/8 (with exceptions for IPv4-mapped/NAT64)
  if ((groups[0] & 0xff00) === 0) {
    // IPv4-mapped ::ffff:a.b.c.d (all of groups[0..4] must be 0)
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
      const ipv4 = embeddedIPv4(groups, 6);
      return ipv4 ? isPrivateAddress(ipv4) : true;
    }
    // NAT64 64:ff9b::/96 (groups[0]=0x64, [1]=0xff9b, [2..5]=0)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      const ipv4 = embeddedIPv4(groups, 6);
      return ipv4 ? isPrivateAddress(ipv4) : true;
    }
    return true; // Rest of 0::/8 is private
  }

  // 6to4 2002::/16 (embedded IPv4 in groups[1],[2])
  if ((groups[0] & 0xffff) === 0x2002) {
    const ipv4 = embeddedIPv4(groups, 1);
    return ipv4 ? isPrivateAddress(ipv4) : true;
  }

  return false;
}

function embeddedIPv4(groups: number[], startGroup: number): string | null {
  if (startGroup + 1 >= groups.length) return null;
  const a = (groups[startGroup] >> 8) & 0xff;
  const b = groups[startGroup] & 0xff;
  const c = (groups[startGroup + 1] >> 8) & 0xff;
  const d = groups[startGroup + 1] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

export async function postPush(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  deps: PushTransportDeps = {}
): Promise<PushResponse> {
  const lookup = deps.lookup || (async (hostname: string) => {
    const results = await dns.promises.lookup(hostname, { all: true });
    return results.map((r) => ({ address: r.address, family: r.family }));
  });
  const request = deps.request || https.request;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxResponseBytes = deps.maxResponseBytes ?? 4096;

  if (!isAllowedPushEndpoint(url)) {
    throw new PushTransportError("endpoint_not_allowed", "Endpoint not in allowed list");
  }

  if (body.length > 4096) {
    throw new PushTransportError("body_too_large", "Body exceeds 4096 bytes");
  }

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname!;

  let addresses: PushLookupResult[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new PushTransportError("dns_failed", `DNS lookup failed for ${hostname}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new PushTransportError("dns_failed", `No addresses resolved for ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr.address)) {
      throw new PushTransportError("private_address", "Resolved address is private");
    }
  }

  const pinnedAddress = addresses[0].address;

  // Map lowercase headers to originals for case-insensitive removal
  const lowerToOriginal = new Map<string, string>();
  for (const key of Object.keys(headers)) {
    lowerToOriginal.set(key.toLowerCase(), key);
  }

  const cleanHeaders: Record<string, string> = {};
  for (const [lower, orig] of lowerToOriginal) {
    if (!["host", "content-length", "transfer-encoding", "connection"].includes(lower)) {
      cleanHeaders[orig] = headers[orig];
    }
  }

  cleanHeaders["Host"] = hostname;
  cleanHeaders["Content-Length"] = String(body.length);

  if (!lowerToOriginal.has("content-encoding")) {
    cleanHeaders["Content-Encoding"] = "aes128gcm";
  } else {
    const orig = lowerToOriginal.get("content-encoding")!;
    cleanHeaders[orig] = headers[orig];
  }

  if (!lowerToOriginal.has("content-type")) {
    cleanHeaders["Content-Type"] = "application/octet-stream";
  } else {
    const orig = lowerToOriginal.get("content-type")!;
    cleanHeaders[orig] = headers[orig];
  }

  for (const [name, value] of Object.entries(cleanHeaders)) {
    if (name.includes("\r") || name.includes("\n") || value.includes("\r") || value.includes("\n")) {
      throw new PushTransportError("bad_headers", "Header contains CR/LF");
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const settle = (result: PushResponse | Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (req) req.destroy();
        reject(new PushTransportError("timeout", `Request timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    let req: ClientRequest | null = null;
    try {
      req = request(
        {
          method: "POST",
          host: pinnedAddress,
          port: 443,
          path: parsedUrl.pathname + parsedUrl.search,
          servername: hostname,
          agent: false,
          headers: cleanHeaders,
        },
        (res: IncomingMessage) => {
          if (!settled && res.statusCode! >= 300 && res.statusCode! < 400) {
            res.destroy();
            settle(new PushTransportError("redirect", `Redirect (${res.statusCode})`));
            return;
          }

          const chunks: Buffer[] = [];
          let collected = 0;

          const finish = (truncated: boolean) => {
            if (settled) return;
            const buffer = Buffer.concat(chunks);
            settle({
              status: res.statusCode!,
              headers: res.headers,
              body: buffer.slice(0, maxResponseBytes).toString("utf8"),
              bodyTruncated: truncated,
            });
          };

          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            const room = maxResponseBytes - collected;
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room));
              finish(true);
              res.destroy();
              return;
            }
            chunks.push(chunk);
            collected += chunk.length;
          });

          res.on("end", () => {
            if (!settled) finish(false);
          });

          res.on("error", (err: NodeJS.ErrnoException) => {
            if (!settled) {
              settle(new PushTransportError("network", `Response error: ${err.code ?? "unknown"}`));
            }
          });
        }
      );

      req.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settle(new PushTransportError("network", `Request error: ${err.code ?? "unknown"}`));
        }
      });

      req.end(body);
    } catch (err) {
      settle(new PushTransportError("network", "Request creation failed"));
    }
  });
}
