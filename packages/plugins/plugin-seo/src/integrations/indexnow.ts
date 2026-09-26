/**
 * IndexNow (Bing, Yandex, Seznam, Naver … share submissions). The site hosts
 * a key file `/<key>.txt` containing the key; we then POST URL batches.
 * https://www.indexnow.org/documentation
 */
import { randomBytes } from "node:crypto";
import type { FetchLike } from "./google.js";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export function newIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

export function indexNowKeyLocation(siteUrl: string, key: string): string {
  return `${new URL(siteUrl).origin}/${key}.txt`;
}

export interface IndexNowRequest {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/** Request body: every URL must be on the key's host (max 10 000). */
export function indexNowRequest(siteUrl: string, key: string, urls: string[]): IndexNowRequest {
  const host = new URL(siteUrl).hostname;
  const urlList = [...new Set(urls)].filter((u) => {
    try {
      return new URL(u).hostname === host;
    } catch {
      return false;
    }
  });
  return { host, key, keyLocation: indexNowKeyLocation(siteUrl, key), urlList: urlList.slice(0, 10_000) };
}

const MEANING: Record<number, string> = {
  200: "accepted",
  202: "accepted (key validation pending)",
  400: "bad request",
  403: "key not valid (the key file is missing or does not match)",
  422: "URLs do not belong to the host or the key does not match",
  429: "too many requests",
};

export async function submitIndexNow(fetchImpl: FetchLike, body: IndexNowRequest): Promise<{ ok: boolean; status: number; meaning: string; submitted: number }> {
  if (body.urlList.length === 0) return { ok: false, status: 0, meaning: "no URLs on the site's host", submitted: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await res.text().catch(() => "");
    return { ok: res.status === 200 || res.status === 202, status: res.status, meaning: MEANING[res.status] ?? `HTTP ${res.status}`, submitted: body.urlList.length };
  } finally {
    clearTimeout(timer);
  }
}
