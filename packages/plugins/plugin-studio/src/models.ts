/**
 * The models Studio knows. Each model of partnersinbiz-web `lib/creative-canvas/model-registry.ts` was checked
 * against the Higgsfield REST docs (docs.higgsfield.ai, 2026-11-06). The registry uses Higgsfield CLI names
 * (`text2image_soul_v2`); REST endpoint ids differ (`higgsfield-ai/soul/v2/standard`).
 *
 * - `offered`: the model is on the REST API, so Studio can send it.
 * - `priced`: `POST /estimate` gives the real cost of the request as sent. Seedance bills by tokens, so it is not.
 * People pick only offered and priced models; the others are still listed, with the reason, never hidden.
 * - `refField` / `minRefs` / `maxRefs`: where reference images go and how many the endpoint takes. The worker fills
 *   that field with short-lived signed links to library assets; agents and people only ever name asset ids.
 */
import { StudioError } from "./errors.js";

export type RefField = "image_url" | "image_urls";

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
  /** Allowed clip lengths in seconds. Empty: not a video model, or the endpoint takes no duration. */
  durations: number[];
  /** The provider field that carries the duration (`params.params[durationField]`); null when there is none. */
  durationField: string | null;
  /** Filled in when the request gives no duration; the endpoint's own default. */
  defaultDuration: number | null;
  offered: boolean;
  priced: boolean;
  note: string | null;
}

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
  return { id, registryId, label, kind, ratios, resolutions, refField: refs?.field ?? null, minRefs: refs?.min ?? 0, maxRefs: refs?.max ?? 0, ...durationFields(duration), offered: true, priced: true, note: null };
}

function unavailable(registryId: string, label: string, kind: StudioModel["kind"], note: string, rest?: string, duration: VideoDuration | null = null): StudioModel {
  return { id: rest ?? registryId, registryId, label, kind, ratios: [], resolutions: [], refField: null, minRefs: 0, maxRefs: 0, ...durationFields(duration), offered: rest !== undefined, priced: false, note };
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
  live("xai/grok-imagine-video/v1.5/reference-to-video", "grok_video_v15", "Grok Video 1.5 (video, up to 7 references)", "video", ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], ["480p", "720p", "1080p"], { field: "image_urls", max: 7 }, GROK_DURATION),
  unavailable("seedance_2_0", "Seedance 2.0 (video)", "video", "Not priced: billed by tokens, so Studio can't quote it", "bytedance/seedance-2.0/text-to-video", SEEDANCE_DURATION),
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

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reference asset ids from a request: none, or a list of distinct Studio asset ids. */
export function referenceIds(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !ASSET_ID.test(v))) {
    throw new StudioError("referenceAssetIds must be a list of Studio asset ids.", "bad_request");
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
