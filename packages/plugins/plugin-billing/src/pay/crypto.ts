/** Small crypto helpers for webhook verification. Node only (the worker), never the page. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(key: string, message: string, algorithm: "sha256" | "sha512" = "sha256"): string {
  return createHmac(algorithm, key).update(message).digest("hex");
}

/** Constant-time equality for two strings (false on a different length, without comparing). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function md5Hex(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** PHP `urlencode` (what PayFast signs with): spaces become `+`, and only letters, digits and `-_.` stay as they are. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** The client address from the reverse proxy's `X-Forwarded-For` (the entry nearest to us), else null. */
export function remoteIpFrom(headers: Record<string, string>): string | null {
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last.replace(/^::ffff:/i, "");
  }
  const real = headers["x-real-ip"]?.trim();
  return real ? real.replace(/^::ffff:/i, "") : null;
}
