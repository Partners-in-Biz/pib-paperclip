/**
 * Local credit price for Seedance text-to-video. Higgsfield's `/estimate` gives no credits for these models (it answers
 * `type: description` with a token formula), so Studio prices them here, from Higgsfield's own published rates.
 *
 * Sources, checked 2026-11-08 (PAR-8340):
 * - Token formula and rates: live `POST https://platform.higgsfield.ai/estimate/<model>` `pricing_description`.
 *   2.0: tokens = ceil(seconds x width x height x 24 / 1024); 480p/720p/1080p $0.014 per 1,000 tokens (4K $0.008).
 *   2.5: same formula; 480p/720p $0.0214, 1080p $0.0234 per 1,000 tokens; 16:9 = $0.2056 / $0.4622 / $1.1372 per second.
 * - Pixels: the docs (https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video and
 *   https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video) list ratios but no sizes. The 16:9 sizes below
 *   are the only ones Higgsfield pins: they give back its 16:9 $/s exactly (854 x 480 x 24 / 1024 x 0.0214 / 1000 =
 *   0.2056). Other ratios are not cited, so they have no price.
 * - USD_PER_CREDIT: live `/estimate` answers (Kling 3.0 Turbo 8.960 credits = $0.560; Soul 1.500 credits = $0.094).
 *
 * Rates are before any customer discount, so the table never prices below what Higgsfield charges.
 */
import { StudioError } from "./errors.js";

export const USD_PER_CREDIT = 0.0625;

/** model id -> resolution -> USD per 1,000 video tokens. 4K on 2.0 and 1080p on 2.5 are left out on purpose. */
export const SEEDANCE_RATES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "bytedance/seedance-2.0/text-to-video": { "480p": 0.014, "720p": 0.014, "1080p": 0.014 },
  "bytedance/seedance-2.5/text-to-video": { "480p": 0.0214, "720p": 0.0214 },
};

/** resolution -> aspect ratio -> [width, height]. Only ratios Higgsfield's pricing pins (see header). */
export const SEEDANCE_PIXELS: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  "480p": { "16:9": [854, 480] },
  "720p": { "16:9": [1280, 720] },
  "1080p": { "16:9": [1920, 1080] },
};

/** Body keys that do not change the price. Any other key (a reference image, video or audio) means no local price. */
const NEUTRAL_KEYS = new Set(["prompt", "duration", "resolution", "aspect_ratio", "bitrate_mode", "output_format", "generate_audio", "seed"]);

function own<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** True when Studio prices this model from the table above, not from the provider's `/estimate`. */
export function isTablePriced(modelId: string): boolean {
  return own(SEEDANCE_RATES, modelId) !== undefined;
}

/**
 * Credits for one job on a table-priced model, ceiled to 3 decimals. null: the model is not table-priced (ask the
 * provider). A table-priced model with any setting the table cannot price throws `no_price`; there are no defaults.
 */
export function localCredits(modelId: string, body: Record<string, unknown>): number | null {
  const rates = own(SEEDANCE_RATES, modelId);
  if (!rates) return null;
  const refuse = (why: string): never => {
    throw new StudioError(`Studio has no price for ${modelId} ${why}, so nothing was started.`, "no_price");
  };
  const extra = Object.keys(body).find((key) => !NEUTRAL_KEYS.has(key));
  if (extra !== undefined) refuse(`with "${extra}" (only text-to-video without references is priced)`);
  const { duration, resolution, aspect_ratio: ratio } = body;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0) refuse("without a whole-second duration");
  const rate = own(rates, resolution);
  if (rate === undefined) refuse(`at resolution ${String(resolution)}`);
  const pixels = own(SEEDANCE_PIXELS, resolution);
  const size = pixels ? own(pixels, ratio) : undefined;
  if (!size) refuse(`at aspect ratio ${String(ratio)}`);
  const [width, height] = size as readonly [number, number];
  const tokens = Math.ceil(((duration as number) * width * height * 24) / 1024);
  // Integer maths in thousandths of a credit so float noise never ceils a whole step up.
  const milli = Math.ceil(Number(((tokens * (rate as number)) / USD_PER_CREDIT).toFixed(6)));
  return milli / 1000;
}
