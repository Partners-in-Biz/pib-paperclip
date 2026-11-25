// Housekeeping for the preview service's private /tmp (systemd PrivateTmp=true, so the VPS janitor cannot see it).
// The service saved a PNG per review shot and ran Chromium with HOME=/tmp and never deleted anything: 634 MB and
// 157 screenshots after 14 hours, plus Chromium profile folders, until the next restart.
//
// - Screenshots stay for an hour (the review page links each image more than once, so a re-fetch does not shoot again),
//   then the next call to the service deletes them.
// - Every Chromium run gets its own profile folder (--user-data-dir, HOME and TMPDIR all point into it) that is removed
//   when the run ends; a folder a killed run left behind is swept after an hour.
// Only names this service creates are ever deleted, and only directly under the folder given.
import { lookup } from "node:dns/promises";
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join, resolve, sep } from "node:path";

export const SHOT_MAX_AGE_MS = 3_600_000;
export const PROFILE_MAX_AGE_MS = 3_600_000;

/** `<token>-live.png`, `<token>-proposed.png` and their `-m` (phone) variants. */
export const SHOT_NAME = /^[A-Za-z0-9_-]{20,64}-(?:live|proposed)(?:-m)?\.png$/;
/** What `makeProfile` creates: `p-` and the six characters `mkdtemp` adds. */
export const PROFILE_NAME = /^p-[A-Za-z0-9]{6}$/;

async function sweep(dir, pattern, maxAgeMs, now, remove) {
  let removed = 0;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0; // nothing there yet
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await remove(path);
      removed += 1;
    } catch {
      // gone already, or busy: the next call tries again
    }
  }
  return removed;
}

/** Delete screenshots in `dir` older than `maxAgeMs`. Returns how many went. */
export function sweepShots(dir, now = Date.now(), maxAgeMs = SHOT_MAX_AGE_MS) {
  return sweep(dir, SHOT_NAME, maxAgeMs, now, (path) => rm(path, { force: true }));
}

/** Remove one profile folder, but only a `p-xxxxxx` folder directly under `root` (never `root` itself or anything else). */
export async function removeProfile(root, dir) {
  const base = resolve(root);
  const target = resolve(dir);
  if (!PROFILE_NAME.test(basename(target)) || target !== join(base, basename(target)) || !target.startsWith(base + sep)) {
    throw new Error(`refusing to remove ${dir}: not a profile folder under ${root}`);
  }
  await rm(target, { recursive: true, force: true });
}

/** Delete profile folders a killed Chromium run left in `root`, older than `maxAgeMs`. */
export function sweepProfiles(root, now = Date.now(), maxAgeMs = PROFILE_MAX_AGE_MS) {
  return sweep(root, PROFILE_NAME, maxAgeMs, now, (path) => removeProfile(root, path));
}

/** A fresh, private profile folder for one Chromium run. Call `cleanup` when the run is over (it never throws). */
export async function makeProfile(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "p-"));
  return { dir, cleanup: () => removeProfile(root, dir).catch(() => undefined) };
}

/**
 * What Chromium needs so nothing lands outside its profile folder: its home, temp, config and cache folders all point
 * into it (a shared cache folder grew without bound: Chromium keeps its HTTP cache there, and a per-run one costs
 * nothing, the system font cache is used).
 */
export function chromiumEnv(dir, base = process.env) {
  return { ...base, HOME: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir };
}

/**
 * The Chromium to run: `explicit` (CHROME_PATH) when set, else the newest `chromium-<build>/chrome-linux64/chrome` under
 * Playwright's browser folder. Playwright removes the build folders it replaces, so a path fixed at deploy time went
 * missing and every /shot answered 502 while /health stayed ok (PAR-4798). Looked up on each run, so a later browser
 * update needs no restart. Throws a message naming the folder when no build is installed.
 */
export async function findChrome(root, explicit) {
  if (explicit) return explicit;
  const builds = (await readdir(root).catch(() => []))
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of builds) {
    const bin = join(root, name, "chrome-linux64", "chrome");
    if (await access(bin).then(() => true, () => false)) return bin;
  }
  throw new Error(`no Chromium build under ${root}`);
}

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// A profile folder of its own, used as a throwaway one. This Chromium (153, headless=new) never finishes a --screenshot or
// --dump-dom run with a persistent --user-data-dir (it waits for ever), so --incognito goes with it. Checked on the VPS.
const base = (dir) => ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--incognito", `--user-data-dir=${dir}`];

// Without --timeout, --virtual-time-budget alone never finishes on pages that keep the network busy (agriauctionssa.co.za
// /auctions/list-your-lot/: killed after 60 s, so no live dump and no live shot). --timeout makes Chromium stop waiting and write the page (PAR-7917).
const LOAD_TIMEOUT = "--timeout=9000";
// Desktop width for shots and DOM dumps alike, so the review page and /render measure the same layout.
const DESKTOP = "--window-size=1280,3200";

/** Chromium arguments to dump the DOM a visitor's browser ends up with (scripts run). */
export function domArgs(dir, url) {
  return [...base(dir), DESKTOP, "--virtual-time-budget=9000", LOAD_TIMEOUT, "--dump-dom", url];
}

/**
 * domArgs for /render: every connection Chromium makes goes through the egress proxy on 127.0.0.1:`proxyPort`
 * (egress.mjs), which refuses non-public addresses. `<-loopback>` removes Chromium's implicit localhost bypass, so
 * 127.0.0.1 and localhost go to the proxy too (and are refused there); QUIC and non-proxied WebRTC UDP are off so
 * nothing skips the proxy.
 */
export function renderArgs(dir, url, proxyPort) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error(`bad proxy port ${proxyPort}`);
  const args = domArgs(dir, url);
  const proxy = [`--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];
  return [...args.slice(0, -1), ...proxy, url];
}

/** Chromium arguments to save a full-page screenshot, desktop or phone width, to `file`. */
export function shotArgs(dir, url, file, mobile = false) {
  return [...base(dir), "--hide-scrollbars", mobile ? "--window-size=390,3000" : DESKTOP, ...(mobile ? [`--user-agent=${MOBILE_UA}`] : []), "--virtual-time-budget=9000", LOAD_TIMEOUT, `--screenshot=${file}`, url];
}

// ---- Egress checks (PAR-8798): which addresses Chromium and /render may reach ----

/** The four bytes of a dotted IPv4 address, or null. */
function v4Bytes(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

/** The eight 16-bit groups of an IPv6 address (with or without a dotted IPv4 tail), or null. */
function v6Groups(ip) {
  let text = ip.toLowerCase().split("%")[0];
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const b = v4Bytes(tail[1]);
    if (!b) return null;
    text = `${text.slice(0, -tail[1].length)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPublicV4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast 224/4, reserved 240/4, broadcast 255.255.255.255
  return true;
}

/**
 * True only for a globally routable unicast address. False for loopback, private, link-local, CGNAT, unique-local,
 * unspecified, multicast, broadcast and reserved ranges, for IPv4-mapped/compatible and NAT64 forms of those, and for
 * anything that is not an IP address. IPv6 must be in 2000::/3 (global unicast). Same ranges as plugin-host-services.ts
 * `isPrivateIP`, plus CGNAT, multicast and reserved.
 */
export function isPublicAddress(ip) {
  if (typeof ip !== "string") return false;
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const family = isIP(bare);
  if (family === 4) return isPublicV4(v4Bytes(bare));
  if (family !== 6) return false;
  const g = v6Groups(bare);
  if (!g) return false;
  const embedded = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  // ::ffff:a.b.c.d (mapped): judge by the IPv4 inside. ::/96 (::, ::1, deprecated IPv4-compatible): never public.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(embedded);
  if (g.slice(0, 6).every((x) => x === 0)) return false;
  // NAT64 64:ff9b::/96 reaches the IPv4 inside it
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(embedded);
  // 6to4 2002:a.b.c.d::/48 likewise
  if (g[0] === 0x2002) return isPublicV4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]);
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return (g[0] & 0xe000) === 0x2000; // global unicast only: refuses fe80::/10, fc00::/7, ff00::/8, fec0::/10, ...
}

/** All addresses `host` resolves to, in resolver order (no family preference, no caching). */
export async function lookupAll(host) {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/**
 * Resolve `host` (a name or an IP literal, IPv6 with or without brackets) with `resolve` and check every address.
 * Throws when it resolves to nothing or ANY address is not public; else returns the addresses, to connect to directly.
 */
export async function publicAddresses(host, resolve = lookupAll, isPublic = isPublicAddress) {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let addresses;
  if (isIP(bare)) addresses = [bare];
  else {
    try {
      addresses = await resolve(bare);
    } catch (err) {
      throw new Error(`refused: ${bare} does not resolve (${err?.code ?? err?.message ?? err})`);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error(`refused: ${bare} resolves to no address`);
  const bad = addresses.filter((a) => !isPublic(a));
  if (bad.length) throw new Error(`refused: ${bare} resolves to a non-public address (${bad.join(", ")})`);
  return addresses;
}

export const ALLOWED_PORTS = Object.freeze([80, 443]);

/**
 * Check a URL /render was asked to load: http or https only, no user name or password, port 80/443 (or none), and every
 * address the host resolves to is public. Throws `refused: ...` otherwise; returns `{ url, host, port, addresses }`.
 */
export async function checkRenderUrl(url, resolve = lookupAll) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("refused: not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`refused: scheme ${parsed.protocol} (http and https only)`);
  if (parsed.username || parsed.password) throw new Error("refused: user name or password in the URL");
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.includes(port)) throw new Error(`refused: port ${port} (80 and 443 only)`);
  const addresses = await publicAddresses(parsed.hostname, resolve);
  return { url: parsed.href, host: parsed.hostname, port, addresses };
}
