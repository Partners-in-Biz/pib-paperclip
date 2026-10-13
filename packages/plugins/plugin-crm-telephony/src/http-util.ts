import { createHash, timingSafeEqual } from "node:crypto";

export type HeaderBag = Record<string, string | string[] | undefined>;

export function readHeader(headers: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) {
        return value[0]?.trim() || undefined;
      }
      return value?.trim() || undefined;
    }
  }
  return undefined;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  try {
    return timingSafeEqual(aHash, bHash);
  } catch {
    return false;
  }
}
