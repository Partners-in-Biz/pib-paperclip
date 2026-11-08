/**
 * The 720p preview proxy (PAR-8276 A7c). After a render passes verification, one more contained ffmpeg run in the
 * same work folder scales it so the short side is 720 px (720x1280 for 9:16, 1280x720 for 16:9) as H.264/AAC with
 * faststart. It is stored next to the render, `studio/<company>/<scope>/<assetId>/preview-720p.mp4`, and its key goes
 * in `video_renders.preview_r2_key`. The proxy is best effort: the caller logs a failure and the render still
 * succeeds without a preview.
 */
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertOwnKey, MAX_ASSET_BYTES } from "../storage.js";
import { runContained, type RunOptions } from "./ffmpeg.js";
import { probeMedia } from "./probe.js";
import { failureFromRun } from "./runner.js";

export const PREVIEW_FILE = "preview-720p.mp4";
export const PREVIEW_MIME = "video/mp4";
export const PREVIEW_SHORT_SIDE = 720;
/** The proxy is a plain re-encode of a verified file: well under the render's 20 minutes. */
export const PREVIEW_TIMEOUT_SEC = 600;

export const PREVIEW_ENCODER_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"] as const;

/** ffmpeg args (no shell): short side to 720 px, even other side, first video stream plus sound if there is any. */
export function proxyArgs(input: string, output: string): string[] {
  const s = PREVIEW_SHORT_SIDE;
  return [
    "-i", `file:${input}`,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", `scale=w='if(gt(iw,ih),-2,${s})':h='if(gt(iw,ih),${s},-2)'`,
    ...PREVIEW_ENCODER_ARGS,
    `file:${output}`,
  ];
}

/** The preview's key: the render's own asset folder, so it passes `assertOwnKey` and goes wherever the asset goes. */
export function previewKeyFor(companyId: string, outputKey: string): string {
  assertOwnKey(companyId, outputKey);
  const key = `${outputKey.slice(0, outputKey.lastIndexOf("/") + 1)}${PREVIEW_FILE}`;
  assertOwnKey(companyId, key);
  return key;
}

export interface ProxyControl {
  signal: AbortSignal;
  /** Records the proxy run's pgid for recovery, like the render's own run. False = the claim is gone. */
  started(info: { pgid: number; workdir: string }): Promise<boolean>;
}

/** Makes and checks the proxy of `dir/<input>`. Throws on any failure; the caller decides it is not fatal. */
export async function makeProxy(dir: string, input: string, control: ProxyControl, run: Omit<RunOptions, "tool" | "captureStdout" | "cwd"> = {}): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number }> {
  const handle = runContained(proxyArgs(input, PREVIEW_FILE), { timeoutSec: PREVIEW_TIMEOUT_SEC, ...run, cwd: dir });
  const stop = () => handle.cancel();
  control.signal.addEventListener("abort", stop, { once: true });
  let result;
  try {
    if (handle.pgid > 0 && !(await control.started({ pgid: handle.pgid, workdir: dir }))) handle.cancel();
    result = await handle.done;
  } finally {
    control.signal.removeEventListener("abort", stop);
  }
  const failed = failureFromRun(result);
  if (failed) throw failed;
  const path = join(dir, PREVIEW_FILE);
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size <= 0 || size > MAX_ASSET_BYTES) throw new Error(`The preview is ${size} bytes.`);
  if (!(await probeMedia(path, run)).hasVideo) throw new Error("The preview has no video stream.");
  return { bytes: new Uint8Array(await readFile(path)) as Uint8Array<ArrayBuffer>, size };
}
