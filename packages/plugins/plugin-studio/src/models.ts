/**
 * The models Studio knows. Each model of partnersinbiz-web `lib/creative-canvas/model-registry.ts` was checked
 * against the Higgsfield REST docs (docs.higgsfield.ai, 2026-11-06). The registry uses Higgsfield CLI names
 * (`text2image_soul_v2`); REST endpoint ids differ (`higgsfield-ai/soul/v2/standard`).
 *
 * - `offered`: the model is on the REST API, so Studio can send it.
 * - `priced`: Studio knows the real cost of the request as sent: from `POST /estimate`, or for Seedance (billed by
 *   tokens; `/estimate` gives no credits) from the local table in `seedance-price.ts`.
 * People pick only offered and priced models; the others are still listed, with the reason, never hidden.
 * - `refField` / `minRefs` / `maxRefs`: where reference images go and how many the endpoint takes. The worker fills
 *   that field with short-lived signed links to library assets; agents and people only ever name asset ids.
 * - `audioRefField` / `minAudioRefs` / `maxAudioRefs`: the same for audio assets (lip-sync, PAR-8435). `nativeDialogue`:
 *   the model speaks a line written in the prompt (`generate_audio: true`), so it takes no audio. `lipsyncMode` derives
 *   the mode from these; it is never stored twice.
 */
import { StudioError } from "./errors.js";

export type RefField = "image_url" | "image_urls";
export type AudioRefField = "audio_url" | "audio_urls";

export interface StudioModel {
  /** The REST endpoint id when offered, else the registry id. */
  id: string;
  registryId: string;
  label: string;
  kind: "image" | "video";
  ratios: string[];
  /** Empty: the endpoint takes no `resolution` field, so the page sends none. */
  resolutions: string[];
  refField: RefField | null;
  minRefs: number;
  maxRefs: number;
  audioRefField: AudioRefField | null;
  minAudioRefs: number;
  maxAudioRefs: number;
  /** The model says a line from the prompt and makes its own sound; Studio always sends `generate_audio: true`. */
  nativeDialogue: boolean;
  /** Allowed clip lengths in seconds. Empty: not a video model, or the endpoint takes no duration. */
  durations: number[];
  /** The provider field that carries the duration (`params.params[durationField]`); null when there is none. */
  durationField: string | null;
  /** Filled in when the request gives no duration; the endpoint's own default. */
  defaultDuration: number | null;
  offered: boolean;
  priced: boolean;
  note: string | null;
  /** Most Higgsfield credits one job may cost; a dearer job is refused before anything is reserved. null: no ceiling. */
  maxCreditsPerJob: number | null;
}

/**
 * Per-job ceiling for Seedance, in Higgsfield credits (PAR-8309). 60 x $0.0625 = $3.75, under R250 at any rate up to
 * R66/$. Never raise it without PiB sign-off.
 */
export const SEEDANCE_MAX_CREDITS_PER_JOB = 60;

/**
 * Per-job ceiling for a lip-sync job, in Higgsfield credits (PAR-8407 Q18): 30 x $0.0625 = $1.875, about R35. Set on
 * every lip-sync entry, and on any model's job that carries an audio reference. Owner Planner; changed by PR only.
 */
export const LIPSYNC_MAX_CREDITS_PER_JOB = 30;

const NOT_ON_REST = "Not on the Higgsfield REST API";
const SOUL_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const KLING_RATIOS = ["16:9", "9:16", "1:1"];

/**
 * Video durations per endpoint, from docs.higgsfield.ai (2026-11-08): Kling 3.0 std/turbo text + image: integer 3-15, default 5;
 * Hailuo 2.3 standard: 6 or 10, default 6; Grok Imagine Video 1.5: integer 1-15, default 5; Seedance 2.0: integer 4-15, default 5.
 */
interface VideoDuration { durations: number[]; field: string; default: number }
const range = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const KLING_DURATION: VideoDuration = { durations: range(3, 15), field: "duration", default: 5 };
const HAILUO_DURATION: VideoDuration = { durations: [6, 10], field: "duration", default: 6 };
const GROK_DURATION: VideoDuration = { durations: range(1, 15), field: "duration", default: 5 };
const SEEDANCE_DURATION: VideoDuration = { durations: range(4, 15), field: "duration", default: 5 };
/** Seedance 2.5: integer 4-30 (docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video). */
const SEEDANCE_25_DURATION: VideoDuration = { durations: range(4, 30), field: "duration", default: 5 };
/** Wan 3.0 Prime reference: integer 2-30; Wan 2.7 image-to-video: integer 2-15 (docs.higgsfield.ai, 2026-11-08). */
const WAN3_DURATION: VideoDuration = { durations: range(2, 30), field: "duration", default: 5 };
const WAN27_DURATION: VideoDuration = { durations: range(2, 15), field: "duration", default: 5 };
/** Only 16:9 has cited pixel sizes, so only 16:9 has a price (src/seedance-price.ts). */
const SEEDANCE_RATIOS = ["16:9"];

function durationFields(d: VideoDuration | null): Pick<StudioModel, "durations" | "durationField" | "defaultDuration"> {
  return { durations: d?.durations ?? [], durationField: d?.field ?? null, defaultDuration: d?.default ?? null };
}

function live(
  id: string,
  registryId: string,
  label: string,
  kind: StudioModel["kind"],
  ratios: string[],
  resolutions: string[],
  refs: { field: RefField; min?: number; max: number } | null = null,
  duration: VideoDuration | null = null,
): StudioModel {
  return { id, registryId, label, kind, ratios, resolutions, refField: refs?.field ?? null, minRefs: refs?.min ?? 0, maxRefs: refs?.max ?? 0, ...NO_AUDIO, ...durationFields(duration), offered: true, priced: true, note: null, maxCreditsPerJob: null };
}

const NO_AUDIO = { audioRefField: null, minAudioRefs: 0, maxAudioRefs: 0, nativeDialogue: false } as const;

/** A lip-sync entry: one portrait plus our audio (`audio`), or a line in the prompt (`audio` null, native dialogue). */
function lipsync(
  id: string,
  registryId: string,
  label: string,
  ratios: string[],
  resolutions: string[],
  refs: { field: RefField; min: number; max: number },
  audio: { field: AudioRefField; min: number; max: number } | null,
  duration: VideoDuration,
): StudioModel {
  return {
    ...live(id, registryId, label, "video", ratios, resolutions, refs, duration),
    audioRefField: audio?.field ?? null,
    minAudioRefs: audio?.min ?? 0,
    maxAudioRefs: audio?.max ?? 0,
    nativeDialogue: audio === null,
    maxCreditsPerJob: LIPSYNC_MAX_CREDITS_PER_JOB,
  };
}

/** A Seedance text-to-video endpoint: priced from Studio's own table, with the per-job ceiling. */
function seedance(id: string, registryId: string, label: string, resolutions: string[], duration: VideoDuration): StudioModel {
  return { ...live(id, registryId, label, "video", SEEDANCE_RATIOS, resolutions, null, duration), maxCreditsPerJob: SEEDANCE_MAX_CREDITS_PER_JOB };
}

function unavailable(registryId: string, label: string, kind: StudioModel["kind"], note: string, rest?: string, duration: VideoDuration | null = null): StudioModel {
  return { id: rest ?? registryId, registryId, label, kind, ratios: [], resolutions: [], refField: null, minRefs: 0, maxRefs: 0, ...durationFields(duration), ...NO_AUDIO, offered: rest !== undefined, priced: false, note, maxCreditsPerJob: null };
}

export const MODEL_CATALOG: readonly StudioModel[] = [
  live("higgsfield-ai/soul/v2/standard", "text2image_soul_v2", "Soul v2 (image)", "image", SOUL_RATIOS, ["720p", "1080p"]),
  live("higgsfield-ai/soul/cinema", "soul_cinematic", "Soul Cinema (image)", "image", SOUL_RATIOS, ["720p", "1080p"]),
  live("z-image/turbo", "z_image", "Z-Image Turbo (image)", "image", ["1:1", "2:3", "3:2", "3:4", "4:3", "7:9", "9:7", "9:16", "16:9", "21:9"], ["1k", "2k"]),
  live("xai/grok-imagine-image-2.0", "grok_image", "Grok Image 2.0 (image, up to 10 references)", "image", ["auto", "1:1", "1:2", "2:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"], ["1k", "2k"], { field: "image_urls", max: 10 }),
  live("recraft/v4.1/text-to-image", "recraft_v4_1", "Recraft V4.1 (image)", "image", ["1:1", "2:1", "1:2", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16"], ["1k"]),
  live("kling-video/v3.0/std/text-to-video", "kling3_0", "Kling 3.0 (video)", "video", KLING_RATIOS, [], null, KLING_DURATION),
  live("kling-video/v3.0-turbo/text-to-video", "kling3_0_turbo", "Kling 3.0 Turbo (video)", "video", KLING_RATIOS, ["720p", "1080p"], null, KLING_DURATION),
  live("kling-video/v3.0-turbo/image-to-video", "kling3_0_turbo", "Kling 3.0 Turbo (image to video, 1 reference)", "video", [], ["720p", "1080p"], { field: "image_url", min: 1, max: 1 }, KLING_DURATION),
  live("minimax/hailuo-2.3/standard/text-to-video", "minimax_hailuo", "Hailuo 2.3 (video)", "video", [], [], null, HAILUO_DURATION),
  // Grok 1.5 also takes one optional `audio_url` (lip-sync); a job with audio gets the lip-sync ceiling.
  { ...live("xai/grok-imagine-video/v1.5/reference-to-video", "grok_video_v15", "Grok Video 1.5 (video, up to 7 references)", "video", ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], ["480p", "720p", "1080p"], { field: "image_urls", max: 7 }, GROK_DURATION), audioRefField: "audio_url", maxAudioRefs: 1 },
  seedance("bytedance/seedance-2.0/text-to-video", "seedance_2_0", "Seedance 2.0 (video)", ["480p", "720p", "1080p"], SEEDANCE_DURATION),
  seedance("bytedance/seedance-2.5/text-to-video", "seedance_2_5", "Seedance 2.5 (video)", ["480p", "720p"], SEEDANCE_25_DURATION),
  // Lip-sync (PAR-8435). Fields from docs.higgsfield.ai, 2026-11-08. Wan 3.0 Prime and Seedance 2.5 are priced from
  // src/seedance-price.ts (per second); Wan 2.7 from Higgsfield's /estimate (no credits back -> refused as no_price).
  lipsync("alibaba/wan-3.0-prime/reference-to-video", "wan_3_0_prime", "Wan 3.0 Prime (lip-sync to your audio)", ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], ["480p"], { field: "image_urls", min: 1, max: 10 }, { field: "audio_urls", min: 1, max: 5 }, WAN3_DURATION),
  lipsync("bytedance/seedance-2.5/reference-to-video", "seedance_2_5_reference", "Seedance 2.5 reference (lip-sync, may re-time your audio)", [], ["480p"], { field: "image_urls", min: 1, max: 30 }, { field: "audio_urls", min: 1, max: 10 }, SEEDANCE_25_DURATION),
  lipsync("wan/v2.7/image-to-video", "wan_2_7", "Wan 2.7 (image to video, lip-sync to your audio)", [], ["720p", "1080p"], { field: "image_url", min: 1, max: 1 }, { field: "audio_url", min: 1, max: 1 }, WAN27_DURATION),
  lipsync("bytedance/seedance-2.5/image-to-video", "seedance_2_5_dialogue", "Seedance 2.5 (image to video, says the line)", [], ["480p"], { field: "image_url", min: 1, max: 1 }, null, SEEDANCE_25_DURATION),
  unavailable("seedance1_5", "Seedance 1.5 (video)", "video", `${NOT_ON_REST} (REST has Seedance 2.0 and 2.5 only)`),
  unavailable("veo3_1", "Veo 3.1 (video)", "video", NOT_ON_REST),
  unavailable("veo3_1_lite", "Veo 3.1 Lite (video)", "video", NOT_ON_REST),
  unavailable("cinematic_studio_video_3_5", "Cinema Studio 3.5 (video)", "video", `${NOT_ON_REST} (REST has Cinema Studio 4.0 only)`),
  unavailable("marketing_studio_video", "Marketing Studio (video)", "video", NOT_ON_REST),
  unavailable("cinematic_studio_image", "Cinema Studio (image)", "image", NOT_ON_REST),
  unavailable("nano_banana_flash", "Nano Banana Flash (image)", "image", NOT_ON_REST),
  unavailable("nano_banana_2", "Nano Banana 2 (image)", "image", NOT_ON_REST),
  unavailable("seedream_v4_5", "Seedream 4.5 (image)", "image", NOT_ON_REST),
  unavailable("flux_2", "Flux 2 (image)", "image", NOT_ON_REST),
  unavailable("kling_omni_image", "Kling Omni (image)", "image", NOT_ON_REST),
  unavailable("gpt_image_2", "GPT Image 2 (image)", "image", NOT_ON_REST),
  unavailable("image_auto", "Auto (image)", "image", NOT_ON_REST),
];

export function isSelectable(model: StudioModel): boolean {
  return model.offered && model.priced;
}

export function findModel(id: string): StudioModel | undefined {
  return MODEL_CATALOG.find((m) => m.offered && m.id === id);
}

/** A lip-sync entry needs our audio or speaks a typed line; the generic page form offers neither (T8 adds the mode). */
export function isLipsyncOnly(model: StudioModel): boolean {
  return model.nativeDialogue || model.minAudioRefs > 0;
}

/** How a model takes lip-sync input, derived from its fields; null for every other model. */
export function lipsyncMode(model: string): "audio_ref" | "native_dialogue" | null {
  const known = findModel(model);
  return known?.nativeDialogue ? "native_dialogue" : known?.audioRefField ? "audio_ref" : null;
}

/**
 * Refuses one job priced over its model's ceiling. Called before any row or reserve, and again before a send.
 * `withAudio`: the job carries an audio reference, so the lip-sync ceiling applies too.
 */
export function assertJobCeiling(model: string, each: number, withAudio = false): void {
  const known = findModel(model);
  const own = known?.maxCreditsPerJob ?? null;
  const max = withAudio && known?.audioRefField ? Math.min(own ?? LIPSYNC_MAX_CREDITS_PER_JOB, LIPSYNC_MAX_CREDITS_PER_JOB) : own;
  if (max === null || each <= max) return;
  throw new StudioError(`${known!.label} costs ${each} credits for this job, over its limit of ${max} per job. Pick a shorter clip or a lower resolution.`, "over_job_ceiling");
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reference asset ids from a request: none, or a list of distinct Studio asset ids. */
export function referenceIds(value: unknown, name = "referenceAssetIds"): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !ASSET_ID.test(v))) {
    throw new StudioError(`${name} must be a list of Studio asset ids.`, "bad_request");
  }
  return [...new Set(value as string[])];
}

/** Refuses a reference count the model can't take. Unknown models take none through Studio. */
export function assertReferenceCount(model: string, count: number): void {
  const known = findModel(model);
  const min = known?.minRefs ?? 0;
  const max = known?.refField ? known.maxRefs : 0;
  if (count >= min && count <= max) return;
  const label = known?.label ?? model;
  if (max === 0) throw new StudioError(`${label} takes no reference images in Studio.`, "bad_request");
  throw new StudioError(min === max ? `${label} needs exactly ${min} reference image${min === 1 ? "" : "s"}.` : `${label} takes ${min} to ${max} reference images.`, "bad_request");
}

/** Refuses an audio reference count the model can't take, like `assertReferenceCount` for images. */
export function assertAudioCount(model: string, count: number): void {
  const known = findModel(model);
  const min = known?.minAudioRefs ?? 0;
  const max = known?.audioRefField ? known.maxAudioRefs : 0;
  if (count >= min && count <= max) return;
  const label = known?.label ?? model;
  if (max === 0) throw new StudioError(`${label} takes no audio in Studio.`, "bad_request");
  throw new StudioError(min === max ? `${label} needs exactly ${min} audio file${min === 1 ? "" : "s"}.` : `${label} takes ${min} to ${max} audio files.`, "bad_request");
}
