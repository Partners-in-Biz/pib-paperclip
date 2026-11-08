/**
 * The poster frame of a video asset (PAR-8364). A Layout card draws pictures only, so when its input is a video (for
 * example an Edit card's render) it draws the video's first frame instead. The poster is one JPEG per asset version,
 * `<asset folder>/poster-v<version>.jpg`, so it passes `assertOwnKey`, travels with the asset, and is made once: later
 * calls find it in storage and skip ffmpeg. Rendering the layout as moving video is Phase D, not here.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertOwnKey } from "../storage.js";
import { runContained } from "./ffmpeg.js";
import { failureFromRun } from "./runner.js";

export const POSTER_MIME = "image/jpeg";
export const POSTER_FILE = "poster.jpg";
export const POSTER_TIMEOUT_SEC = 120;
export const MAX_POSTER_BYTES = 25 * 1024 * 1024;

/** The poster's key: next to the video, named for the version, so a new version gets a new poster. */
export function posterKeyFor(companyId: string, videoKey: string, version: number): string {
  assertOwnKey(companyId, videoKey);
  if (!Number.isInteger(version) || version < 1) throw new Error("Bad asset version for a poster.");
  const key = `${videoKey.slice(0, videoKey.lastIndexOf("/") + 1)}poster-v${version}.jpg`;
  assertOwnKey(companyId, key);
  return key;
}

/** ffmpeg args (no shell): the first video frame as one high-quality JPEG. */
export function posterArgs(input: string, output: string): string[] {
  return ["-i", `file:${input}`, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-an", `file:${output}`];
}

/** Cuts the first frame out of `dir/<input>`. Throws if ffmpeg fails or writes nothing. */
export async function cutPoster(dir: string, input: string): Promise<Uint8Array> {
  const result = await runContained(posterArgs(input, POSTER_FILE), { timeoutSec: POSTER_TIMEOUT_SEC, cwd: dir }).done;
  const failed = failureFromRun(result);
  if (failed) throw failed;
  const path = join(dir, POSTER_FILE);
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size <= 0 || size > MAX_POSTER_BYTES) throw new Error(`The poster is ${size} bytes.`);
  return new Uint8Array(await readFile(path));
}

export interface PosterDeps {
  /** The stored poster, or null when there is none yet. */
  read(key: string): Promise<Uint8Array | null>;
  /** Makes the poster from the video (download + ffmpeg). */
  make(): Promise<Uint8Array>;
  write(key: string, bytes: Uint8Array): Promise<void>;
}

/** The poster for one asset version: from storage if it is there, else made once and stored. */
export async function ensurePoster(companyId: string, videoKey: string, version: number, deps: PosterDeps): Promise<Uint8Array> {
  const key = posterKeyFor(companyId, videoKey, version);
  const have = await deps.read(key);
  if (have && have.length > 0) return have;
  const made = await deps.make();
  await deps.write(key, made);
  return made;
}
