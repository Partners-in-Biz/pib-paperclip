/**
 * Where the public signing pages live (audit Q1b-11, Q10-14).
 *
 * A plugin has no public GET route. The host does serve the plugin's own static folder to anyone, at
 * `/_plugins/<installation uuid>/ui/<path>` (the same way the lead form is served), reading the file from disk on
 * every request. So a signing page is a file in `dist/ui/s/<page id>.html`, written here when a document is sent and
 * rewritten when its state changes; the page posts its answer to the plugin's public webhook on the same origin.
 *
 * Two facts about that folder shape this module:
 * - the deploy script keeps this folder (`dist/ui/s/` is excluded from its `--delete` copy), but the pages are still not
 *   data: the record is in the database and `syncPages` (care job, and at start) writes them again from it;
 * - the host treats a file name ending in `-<8 or more hex characters>.<ext>` as a content-hashed asset and tells browsers
 *   to cache it for a year. A page id never contains `-` or `.`, so it can never look like one (a test holds this).
 *
 * The folder is found from where this worker runs (`dist/worker.js` next to `dist/ui/`). Anywhere else (a test, a dev
 * run from `src/`) there is no folder, and nothing is written, unless a test points it somewhere safe.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_SUBDIR = "s";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const PAGE_ID_LENGTH = 24;

/** The host's own test for "this file never changes": the page file must never match it. */
export const HOST_HASHED_NAME = /[.-][a-fA-F0-9]{8,}\.\w+$/;

/** 24 characters from 32 letters and digits: 120 bits, no `-` and no `.`. */
export function generatePageId(): string {
  const bytes = randomBytes(PAGE_ID_LENGTH);
  let out = "";
  for (let i = 0; i < PAGE_ID_LENGTH; i += 1) out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return out;
}

export function isPageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z2-7]{24}$/.test(value);
}

export function pageFileName(pageId: string): string {
  if (!isPageId(pageId)) throw new Error("not a page id");
  return `${pageId}.html`;
}

let override: string | null | undefined;

/** Tests: use this folder (or none). Pass `undefined` to go back to finding it from where the worker runs. */
export function configurePagesDir(dir: string | null | undefined): void {
  override = dir;
}

/** The folder pages are written to, or null when this worker is not running from an installed `dist/`. */
export function pagesDir(): string | null {
  if (override !== undefined) return override;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return basename(here) === "dist" ? join(here, "ui", PAGE_SUBDIR) : null;
  } catch {
    return null;
  }
}

export type WriteResult = { ok: true } | { ok: false; reason: string };

/** Writes a page atomically (temp file, then rename), so the host never serves half of one. */
export function writePage(pageId: string, html: string): WriteResult {
  const dir = pagesDir();
  if (!dir) return { ok: false, reason: "This worker is not running from an installed plugin folder, so there is nowhere to publish the signing page." };
  try {
    const name = pageFileName(pageId);
    if (HOST_HASHED_NAME.test(name)) return { ok: false, reason: "The page name looks like a cached asset." };
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const temp = join(dir, `.${pageId}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(temp, html, { encoding: "utf8", mode: 0o644 });
    renameSync(temp, join(dir, name));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `The signing page could not be written (${error instanceof Error ? error.message : String(error)}).` };
  }
}

/** Removes a page. Quietly: a page that is not there is already gone. */
export function removePage(pageId: string): void {
  const dir = pagesDir();
  if (!dir || !isPageId(pageId)) return;
  try {
    rmSync(join(dir, pageFileName(pageId)), { force: true });
  } catch {
    // nothing to do
  }
}

/** Page ids that have a file now (for the sweep). */
export function pagesPresent(): Set<string> {
  const dir = pagesDir();
  const out = new Set<string>();
  if (!dir || !existsSync(dir)) return out;
  try {
    for (const name of readdirSync(dir)) {
      const match = /^([a-z2-7]{24})\.html$/.exec(name);
      if (match) out.add(match[1]!);
    }
  } catch {
    // an unreadable folder shows as empty
  }
  return out;
}

/** The state a page file says it shows (`<meta name="pib-state">` near the top), or null when there is no file or no marker. */
export function pageStateOnDisk(pageId: string): string | null {
  const dir = pagesDir();
  if (!dir || !isPageId(pageId)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(join(dir, pageFileName(pageId)), "r");
    const buffer = Buffer.alloc(512);
    const read = readSync(fd, buffer, 0, 512, 0);
    return /<meta name="pib-state" content="([a-z]+)">/.exec(buffer.toString("utf8", 0, read))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Whether pages can be written at all (a probe file, removed at once): the Cockpit shows it, so a read-only folder is found before a client is. */
export function pagesWritable(): WriteResult {
  const dir = pagesDir();
  if (!dir) return { ok: false, reason: "This worker is not running from an installed plugin folder." };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const probe = join(dir, `.probe.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(probe, "ok", { mode: 0o644 });
    rmSync(probe, { force: true });
    // Leftovers of a crashed write (temp files older than an hour) are swept here, the one place that looks at the folder regularly.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      try {
        if (Date.now() - statSync(join(dir, name)).mtimeMs > 3_600_000) rmSync(join(dir, name), { force: true });
      } catch {
        // gone already
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
