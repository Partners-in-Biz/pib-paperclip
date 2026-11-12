// Guard for the review-page screenshots (PAR-9042): a shot is only taken of the page it is meant to show.
// A mismatch throws, so /shot/* answers 502 instead of serving a picture of an error page or another site.

const bare = (host) => String(host ?? "").toLowerCase().replace(/^www\./, "");

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Why a fetched page is not the one a shot should show, or null when it is.
 * `got` is what the pre-capture fetch saw ({ status, url, html }); `want` is { host, title? }.
 */
export function captureMismatch(got, want) {
  if (!got || got.status < 200 || got.status >= 300) return `target answered HTTP ${got?.status ?? "none"}`;
  let host;
  try {
    host = new URL(got.url).hostname;
  } catch {
    return "target URL is not valid";
  }
  if (want.host && bare(host) !== bare(want.host)) return `captured host ${host} is not ${want.host}`;
  if (want.title !== undefined && titleOf(got.html) !== titleOf(want.title)) return `captured title "${titleOf(got.html)}" does not match "${titleOf(want.title)}"`;
  return null;
}
