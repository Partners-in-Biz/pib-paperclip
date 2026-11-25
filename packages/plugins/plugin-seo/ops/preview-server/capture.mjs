// Guard for the review-page screenshots (PAR-9042): a shot is only taken of the page it is meant to show.
// A mismatch throws, so /shot/* answers 502 instead of serving a picture of an error page or another site.

import { inflateSync } from "node:zlib";
import { checkRenderUrl } from "./sweep.mjs";

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

/**
 * Which answer GET /p/<token> gives (PAR-9042). Order matters: cancelled and declined win over everything; a request holding the
 * review key still sees the proposal after the link has expired, so the review page's own shots (proposed, proposed-mobile) are
 * not pictures of the "expired" page; without the key an approved answer stays valid, then expired.
 */
export function proposalState(row, key) {
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "declined") return "declined";
  const staffView = Boolean(key) && key === row.review_key;
  if (row.expired && staffView) return "staff";
  if (row.expired && row.approved_live) return "approved";
  if (row.expired) return "expired";
  if (staffView) return "staff";
  if (row.review_status !== "passed") return "hold";
  return "serve";
}

/**
 * Fetch a stored live page the way Chromium is allowed to load it (egress.mjs, PAR-8798): every hop must pass checkRenderUrl
 * (http/https, port 80/443, public addresses only), redirects are followed by hand to the same site only, at most `maxHops`,
 * and the body is capped. Throws `refused: ...` without leaking the redirect target or status.
 */
export async function fetchLive(url, { fetchImpl = fetch, check = checkRenderUrl, maxHops = 3, maxBytes = 2_000_000, timeoutMs = 20_000 } = {}) {
  const origin = bare(new URL(url).hostname);
  let current = url;
  for (let hop = 0; ; hop++) {
    await check(current);
    const r = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "pib-preview-shot-check" } });
    const location = r.status >= 300 && r.status < 400 ? r.headers?.get?.("location") : null;
    if (!location) return { status: r.status, url: current, html: await readCapped(r, maxBytes) };
    if (hop >= maxHops) throw new Error("refused: too many redirects");
    const next = new URL(location, current);
    if (bare(next.hostname) !== origin) throw new Error("refused: the live page redirects to another site");
    current = next.href;
  }
}

async function readCapped(r, maxBytes) {
  if (!r.body?.getReader) return String(await r.text()).slice(0, maxBytes);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    out += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return out.slice(0, maxBytes);
}

/**
 * Throws when the page a shot is about to capture is not the one it should show.
 * Proposal: must answer 2xx on loopback with the stored proposal's title. Live: only the site is checked (it must stay on its
 * own host and be a public address); an HTTP error or another title from this server's IP (a WAF may answer it differently)
 * does not block a shot Chromium can take.
 */
export async function guardShot({ which, mobile = false, liveUrl, proposalUrl, proposalHtml }, deps = {}) {
  const label = `${which}${mobile ? "-mobile" : ""}`;
  if (which === "live") {
    const got = await fetchLive(liveUrl, deps);
    const why = captureMismatch({ ...got, status: 200 }, { host: new URL(liveUrl).hostname });
    if (why) throw new Error(`shot refused for ${label}: ${why}`);
    return;
  }
  const f = deps.fetchImpl ?? fetch;
  const r = await f(proposalUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  const why = captureMismatch({ status: r.status, url: proposalUrl, html: await r.text() }, { host: "127.0.0.1", title: proposalHtml });
  if (why) throw new Error(`shot refused for ${label}: ${why}`);
}

/**
 * True when a PNG is one flat colour: Chromium wrote it before the page painted (PAR-12454). Only the 8-bit, non-interlaced
 * RGB/RGBA PNGs Chromium writes are read; any other PNG answers false, so it is never refused. A pixel check, not a byte-size
 * floor: a blank 390 px mobile shot is about 9.5 KB but a short real page is 12-25 KB, so no size limit separates them.
 */
export function isBlankPng(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [depth, colour, , , interlace] = buf.subarray(24, 29);
  const bpp = colour === 2 ? 3 : colour === 6 ? 4 : 0;
  if (depth !== 8 || !bpp || interlace !== 0 || !width || !height) return false;
  const idat = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return false;
  }
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return false;
  let prev = new Uint8Array(stride);
  let first = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return false;
      row[i] = (line[i] + add) & 0xff;
    }
    first ??= row.slice(0, bpp);
    for (let i = 0; i < stride; i++) if (row[i] !== first[i % bpp]) return false;
    prev = row;
  }
  return true;
}

/**
 * Take a shot until it is not blank (isBlankPng), at most `tries` times. A blank one is removed so it is never cached; still
 * blank after the last try throws, so /shot answers 502 and the next request tries again (PAR-12454).
 */
export async function shotUntilPainted({ take, read, remove, label, tries = 3 }) {
  for (let attempt = 1; ; attempt++) {
    await take();
    const png = await read();
    if (!isBlankPng(png)) return png;
    await remove().catch(() => undefined);
    if (attempt >= tries) throw new Error(`shot for ${label} came out blank after ${tries} tries`);
  }
}
