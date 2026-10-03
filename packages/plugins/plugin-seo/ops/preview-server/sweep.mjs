// Housekeeping for the preview service's private /tmp (systemd PrivateTmp=true, so the VPS janitor cannot see it).
// The service saved a PNG per review shot and ran Chromium with HOME=/tmp and never deleted anything: 634 MB and
// 157 screenshots after 14 hours, plus Chromium profile folders, until the next restart.
//
// - Screenshots stay for an hour (the review page links each image more than once, so a re-fetch does not shoot again),
//   then the next call to the service deletes them.
// - Every Chromium run gets its own profile folder (--user-data-dir, HOME and TMPDIR all point into it) that is removed
//   when the run ends; a folder a killed run left behind is swept after an hour.
// Only names this service creates are ever deleted, and only directly under the folder given.
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// A profile folder of its own, used as a throwaway one. This Chromium (153, headless=new) never finishes a --screenshot or
// --dump-dom run with a persistent --user-data-dir (it waits for ever), so --incognito goes with it. Checked on the VPS.
const base = (dir) => ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--incognito", `--user-data-dir=${dir}`];

/** Chromium arguments to dump the DOM a visitor's browser ends up with (scripts run). */
export function domArgs(dir, url) {
  return [...base(dir), "--virtual-time-budget=9000", "--dump-dom", url];
}

/** Chromium arguments to save a full-page screenshot, desktop or phone width, to `file`. */
export function shotArgs(dir, url, file, mobile = false) {
  return [...base(dir), "--hide-scrollbars", mobile ? "--window-size=390,3000" : "--window-size=1280,3200", ...(mobile ? [`--user-agent=${MOBILE_UA}`] : []), "--virtual-time-budget=9000", `--screenshot=${file}`, url];
}
