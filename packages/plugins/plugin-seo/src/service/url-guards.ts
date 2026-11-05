const CACHE_BUSTER_PARAMS = new Set(["cb", "cachebust", "cache_bust", "cachebuster", "nocache", "no-cache", "bust", "_", "ts", "rand"]);

/** Drop cache-buster and tracking query params so one page is always one URL (a ?cb=4 test run must not become its own page). */
export function stripCacheBusters(value: string): string {
  const parsed = new URL(value);
  for (const key of [...parsed.searchParams.keys()]) {
    if (CACHE_BUSTER_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  return parsed.toString();
}

/** True when both URLs are on the same host (a leading www. is ignored). */
export function sameSiteHost(url: string, siteUrl: string): boolean {
  const host = (v: string) => new URL(v).hostname.toLowerCase().replace(/^www\./, "");
  try {
    return host(url) === host(siteUrl);
  } catch {
    return false;
  }
}
