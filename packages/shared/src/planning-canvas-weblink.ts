import { PLANNING_CANVAS_LIMITS } from "./types/planning-canvas.js";

/**
 * Web link node rules (plan PAR-14389 C.5).
 *
 * The stored `url` rule is enforced by the shared validator for every writer
 * (people, agents, the ops route). `parseYouTubeUrl` is the only provider
 * check: a renderer rebuilds the frame URL from its id on every render, so no
 * frame URL is ever stored.
 */

// Whitespace and control characters: `new URL` would silently drop or trim them.
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

/** Why `url` may not be stored on a web link node, or null when it may. */
export function planningCanvasWebLinkUrlProblem(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return "url is required";
  if (url.length > PLANNING_CANVAS_LIMITS.webLinkUrlMaxLength) return "url is too long";
  if (UNSAFE_URL_CHARS.test(url)) return "url has spaces or control characters";
  // Checked on the raw text as well as the parsed URL: `https:host` and `https:/host` parse as https too.
  if (!/^https:\/\//i.test(url)) return "url must start with https://";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is not a valid URL";
  }
  if (parsed.protocol !== "https:") return "url must be https";
  // An empty userinfo (`https://@host`) parses to empty username and password, so look at the raw authority too.
  if (parsed.username || parsed.password || /^https:\/\/[^/?#]*@/i.test(url)) return "url must not carry a user name or password";
  if (!parsed.hostname) return "url has no host";
  return null;
}

export function isPlanningCanvasWebLinkUrl(url: unknown): url is string {
  return planningCanvasWebLinkUrlProblem(url) === null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"]);
const YOUTUBE_SHORT_HOST = "youtu.be";
const YOUTUBE_PATH_FORM = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/;
const YOUTU_BE_PATH_FORM = /^\/([A-Za-z0-9_-]{11})\/?$/;

/**
 * The 11-character YouTube video id of `url`, or null.
 *
 * Hosts: `youtube.com`, `www.youtube.com`, `m.youtube.com`,
 * `www.youtube-nocookie.com` and `youtu.be`. Forms: `/watch?v=<id>`,
 * `youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>`, `/live/<id>`. The host is
 * compared exactly (no suffix or path match), the URL must pass the web link
 * rule, and any other query (`?autoplay=1&...`) is dropped: callers get the
 * bare id and build `https://www.youtube-nocookie.com/embed/<id>` themselves.
 */
export function parseYouTubeUrl(url: string): string | null {
  if (!isPlanningCanvasWebLinkUrl(url)) return null;
  const parsed = new URL(url);
  if (parsed.port !== "") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === YOUTUBE_SHORT_HOST) return YOUTU_BE_PATH_FORM.exec(parsed.pathname)?.[1] ?? null;
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
    const ids = parsed.searchParams.getAll("v");
    return ids.length === 1 && YOUTUBE_ID.test(ids[0]!) ? ids[0]! : null;
  }
  return YOUTUBE_PATH_FORM.exec(parsed.pathname)?.[1] ?? null;
}
