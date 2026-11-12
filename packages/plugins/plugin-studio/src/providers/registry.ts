/**
 * Voice providers (PAR-8414). One const map, one switch: no factory layer. Each capability (speech to text, text to
 * speech) has a company default in the plugin settings (`providers.stt` / `providers.tts`) and a per-job `provider`
 * override. Order: override, then company default, then the first entry. Only xAI today.
 */
import type { ProviderSetting, StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { findModel, lipsyncMode } from "../models.js";
import { fakeProviderOn } from "../provider.js";
import { isTablePriced, localCredits } from "../seedance-price.js";
import { fakeSpeechToText, xaiSpeechToText, XAI_STT_MODEL, type SpeechToText } from "../video-edit/stt.js";
import { fakeTextToSpeech, xaiTextToSpeech, XAI_VOICES, type TextToSpeech } from "../video-edit/tts.js";
import { ttsCredits } from "../video-edit/tts-price.js";
import { MUSIC_MAX_SECONDS, STABLE_AUDIO_USD_PER_GENERATION, musicCredits } from "../music/stable-audio-price.js";
import { fakeMusic, stabilityMusic, type MusicGenerator } from "../music/stable-audio.js";

export type Capability = "stt" | "tts" | "music";

export interface ProviderEntry {
  key: string;
  label: string;
  /** Secret reference in the plugin settings. */
  secret: string;
}

const XAI: ProviderEntry = { key: "xai", label: "xAI (Grok)", secret: "xai.apiKey" };

const STABILITY: ProviderEntry = { key: "stability", label: "Stability AI (Stable Audio)", secret: "stability.apiKey" };

export const PROVIDERS: Record<Capability, readonly ProviderEntry[]> = { stt: [XAI], tts: [XAI], music: [STABILITY] };

const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function resolveProvider(cap: Capability, override?: unknown, configDefault?: unknown): ProviderEntry {
  const list = PROVIDERS[cap];
  const key = clean(override) ?? clean(configDefault);
  if (key === undefined) return list[0];
  const found = list.find((p) => p.key === key);
  if (!found) throw new StudioError(`Unknown provider "${key.slice(0, 40)}". Choose one of: ${list.map((p) => p.key).join(", ")}.`, "bad_request");
  return found;
}

export interface ProviderStatus {
  capability: Capability;
  provider: string;
  label: string;
  configured: boolean;
}

/** The provider each capability uses by default, and whether its key is set. Never returns the key. */
export async function providerStatus(config: StudioConfig): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const capability of ["stt", "tts", "music"] as const) {
    // Music has one provider and no company default setting.
    const configured = capability === "music" ? undefined : await config.providerDefault(capability).catch(() => undefined);
    const entry = resolveProvider(capability, undefined, configured);
    out.push({ capability, provider: entry.key, label: entry.label, configured: await config.hasSecret(entry.secret) });
  }
  return out;
}

/**
 * Lip-sync options (PAR-8436, plan PAR-8407 Q12-Q23). Every entry is a Higgsfield model whose input is derived from
 * models.ts (`lipsyncMode`): our audio (`audio`) or a line the model speaks (`line`). The bake-off (PAR-8432) set the
 * two code defaults and the notes; it removed no option. Company defaults: `providers.lipsync` (audio) and
 * `providers.lipsyncLine` (line).
 */
export type LipsyncInput = "audio" | "line";

export interface LipsyncEntry {
  key: string;
  label: string;
  model: string;
  qualityNote: string;
  isDefaultFor?: LipsyncInput;
}

export const LIPSYNC: readonly LipsyncEntry[] = [
  { key: "wan-3.0-prime", label: "Wan 3.0 Prime", model: "alibaba/wan-3.0-prime/reference-to-video", qualityNote: "Keeps our audio exactly, closes on b/m/p, mouth stays open in long pauses.", isDefaultFor: "audio" },
  { key: "seedance-2.5-dialogue", label: "Seedance 2.5 (says the line)", model: "bytedance/seedance-2.5/image-to-video", qualityNote: "Cleanest lips, says the line correctly.", isDefaultFor: "line" },
  { key: "wan-2.7", label: "Wan 2.7", model: "wan/v2.7/image-to-video", qualityNote: "PARTIAL: mouth open in pauses, no b/m/p closure" },
  { key: "seedance-2.5-reference", label: "Seedance 2.5 reference", model: "bytedance/seedance-2.5/reference-to-video", qualityNote: "Warning: re-times or replaces your audio" },
  { key: "grok-video-1.5", label: "Grok Video 1.5 reference", model: "xai/grok-imagine-video/v1.5/reference-to-video", qualityNote: "Untested: failed once on Higgsfield (Generation failed)" },
];

/** The input an entry takes, from its model's fields. */
export function lipsyncInputOf(entry: LipsyncEntry): LipsyncInput {
  const mode = lipsyncMode(entry.model);
  if (!mode) throw new StudioError(`${entry.label} is not a lip-sync model.`, "bad_request");
  return mode === "native_dialogue" ? "line" : "audio";
}

function lipsyncByKey(key: string, input: LipsyncInput): LipsyncEntry {
  const found = LIPSYNC.find((e) => e.key === key);
  if (!found) throw new StudioError(`Unknown lip-sync provider "${key.slice(0, 40)}". Choose one of: ${LIPSYNC.map((e) => e.key).join(", ")}.`, "bad_request");
  if (lipsyncInputOf(found) !== input) {
    throw new StudioError(
      input === "audio" ? `${found.label} speaks a typed line; it can't take an audio file. Pass line instead, or pick another provider.` : `${found.label} lip-syncs to an audio file; it can't speak a typed line. Pass an audio asset, or pick another provider.`,
      "bad_request",
    );
  }
  return found;
}

/** Order: the job's override, then the company default for this input type, then the code default. */
export function resolveLipsync(input: LipsyncInput, override?: unknown, defaults: Partial<Record<LipsyncInput, unknown>> = {}): LipsyncEntry {
  const key = clean(override) ?? clean(defaults[input]);
  if (key !== undefined) return lipsyncByKey(key, input);
  return LIPSYNC.find((e) => e.isDefaultFor === input)!;
}

/** Shown price: the model's own local estimate for 5 s at its first resolution; else Higgsfield prices it at estimate. */
export function lipsyncPrice(model: string): { credits: number | null; price: string } {
  const resolution = findModel(model)?.resolutions[0] ?? "480p";
  const each = isTablePriced(model) ? localCredits(model, { duration: 5, resolution }) : null;
  return each === null ? { credits: null, price: "Priced by Higgsfield when you estimate" } : { credits: each, price: `About ${each} credits per 5 s at ${resolution}` };
}

const VOICE_NOTES: Record<Capability, Record<string, { price: string; qualityNote: string }>> = {
  stt: { xai: { price: "Not charged to Studio credits (xAI bills the key a few cents a minute)", qualityNote: `${XAI_STT_MODEL}: timed words for captions.` } },
  tts: { xai: { price: `${ttsCredits(1000)} credits per 1,000 characters`, qualityNote: `Grok voice, ${XAI_VOICES.length} voices.` } },
  music: { stability: { price: `USD ${STABLE_AUDIO_USD_PER_GENERATION.toFixed(2)} (${musicCredits()} credits) per track, up to ${MUSIC_MAX_SECONDS} s`, qualityNote: "Stable Audio 2.5, instrumental music and sound beds" } },
};

/** Every option per capability with its price, quality note and whether it is the company's default. Never a key. */
export async function providerOptions(config: Pick<StudioConfig, "providerDefault">) {
  const def = (cap: ProviderSetting) => config.providerDefault(cap).catch(() => undefined);
  const safe = (pick: () => string, fallback: () => string) => {
    try {
      return pick();
    } catch {
      return fallback();
    }
  };
  const voice = async (cap: Capability) => {
    const configured = cap === "music" ? undefined : await def(cap);
    const chosen = safe(() => resolveProvider(cap, undefined, configured).key, () => PROVIDERS[cap][0].key);
    return PROVIDERS[cap].map((p) => ({ key: p.key, label: p.label, ...VOICE_NOTES[cap][p.key], isDefault: p.key === chosen }));
  };
  const defaults = { audio: await def("lipsync"), line: await def("lipsyncLine") };
  const chosen = {
    audio: safe(() => resolveLipsync("audio", undefined, defaults).key, () => resolveLipsync("audio").key),
    line: safe(() => resolveLipsync("line", undefined, defaults).key, () => resolveLipsync("line").key),
  };
  const lipsync = LIPSYNC.map((e) => {
    const input = lipsyncInputOf(e);
    return { key: e.key, label: e.label, model: e.model, input, ...lipsyncPrice(e.model), qualityNote: e.qualityNote, isDefault: chosen[input] === e.key };
  });
  return { stt: await voice("stt"), tts: await voice("tts"), music: await voice("music"), lipsync };
}

/** Speech to text for `override` (or the company default). Fake when PIB_STUDIO_FAKE_PROVIDER=1. */
export async function sttFor(override: unknown, config: StudioConfig): Promise<SpeechToText> {
  const entry = resolveProvider("stt", override, await config.providerDefault("stt"));
  if (fakeProviderOn()) return fakeSpeechToText();
  switch (entry.key) {
    case "xai":
      return xaiSpeechToText(await config.xaiKey());
    default:
      throw new StudioError(`Unknown provider "${entry.key}".`, "bad_request");
  }
}

/** Text to speech for `override` (or the company default). Fake when PIB_STUDIO_FAKE_PROVIDER=1. */
export async function ttsFor(override: unknown, config: StudioConfig): Promise<TextToSpeech> {
  const entry = resolveProvider("tts", override, await config.providerDefault("tts"));
  if (fakeProviderOn()) return fakeTextToSpeech();
  switch (entry.key) {
    case "xai":
      return xaiTextToSpeech(await config.xaiKey());
    default:
      throw new StudioError(`Unknown provider "${entry.key}".`, "bad_request");
  }
}

/** Music generator (Stable Audio). Fake when PIB_STUDIO_FAKE_PROVIDER=1. */
export async function musicFor(config: StudioConfig, override?: unknown): Promise<MusicGenerator> {
  resolveProvider("music", override);
  if (fakeProviderOn()) return fakeMusic();
  return stabilityMusic(await config.stabilityKey());
}
