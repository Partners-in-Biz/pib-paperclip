/**
 * Voice providers (PAR-8414). One const map, one switch: no factory layer. Each capability (speech to text, text to
 * speech) has a company default in the plugin settings (`providers.stt` / `providers.tts`) and a per-job `provider`
 * override. Order: override, then company default, then the first entry. xAI is first, so it stays the default.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Track } from "../ml/track.js";
import type { ProviderSetting, StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { findModel, lipsyncMode } from "../models.js";
import { fakeProviderOn } from "../provider.js";
import { isTablePriced, localCredits } from "../seedance-price.js";
import { PIB_BASIC_IDS } from "../video-edit/looks.js";
import { STICKER_PACKS, stickerIds } from "../video-edit/sticker-packs.js";
import { elevenLabsSpeechToText, ELEVENLABS_STT_MODEL, fakeSpeechToText, xaiSpeechToText, XAI_STT_MODEL, type SpeechToText } from "../video-edit/stt.js";
import { elevenLabsTextToSpeech, ELEVENLABS_VOICES, fakeTextToSpeech, xaiTextToSpeech, XAI_VOICES, type TextToSpeech } from "../video-edit/tts.js";
import { ttsCredits } from "../video-edit/tts-price.js";
import { MUSIC_MAX_SECONDS, STABLE_AUDIO_USD_PER_GENERATION, musicCredits } from "../music/stable-audio-price.js";
import { fakeMusic, stabilityMusic, type MusicGenerator } from "../music/stable-audio.js";

export type Capability = "stt" | "tts" | "music" | "reframe";

export interface ProviderEntry {
  key: string;
  label: string;
  /** Secret reference in the plugin settings (none for providers that run on our server). */
  secret?: string;
}

const XAI: ProviderEntry = { key: "xai", label: "xAI (Grok)", secret: "xai.apiKey" };
const ELEVENLABS: ProviderEntry = { key: "elevenlabs", label: "ElevenLabs", secret: "elevenlabs.apiKey" };

const STABILITY: ProviderEntry = { key: "stability", label: "Stability AI (Stable Audio)", secret: "stability.apiKey" };

const LOCAL_FACE: ProviderEntry = { key: "local-face", label: "Follow the face (on our server)" };
const CENTRE: ProviderEntry = { key: "centre", label: "Centre crop" };

export const PROVIDERS: Record<Capability, readonly ProviderEntry[]> = { stt: [XAI, ELEVENLABS], tts: [XAI, ELEVENLABS], music: [STABILITY], reframe: [LOCAL_FACE, CENTRE] };

/** SHA-256 of the shipped YuNet model (ml-models/SHA256SUMS); `local-face` is configured only when dist/ml/models holds exactly this file. */
export const YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

/** `dist/ml/models` next to the bundled worker. */
export function reframeModelDir(): string {
  return fileURLToPath(new URL("./ml/models/", import.meta.url));
}

export function yunetReady(dir: string = reframeModelDir()): boolean {
  const file = `${dir.replace(/\/+$/, "")}/yunet.onnx`;
  try {
    return existsSync(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === YUNET_SHA256;
  } catch {
    return false;
  }
}

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
  for (const capability of ["stt", "tts", "music", "reframe"] as const) {
    // Music has one provider and no company default setting.
    const configured = capability === "music" ? undefined : await config.providerDefault(capability).catch(() => undefined);
    const entry = resolveProvider(capability, undefined, configured);
    const ready = entry.secret ? await config.hasSecret(entry.secret) : entry.key === "local-face" ? yunetReady() : true;
    out.push({ capability, provider: entry.key, label: entry.label, configured: ready });
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

/**
 * Look packs (PAR-10156, plan PAR-8279 slice 2). A pack is a closed list of look ids defined in code (video-edit/looks.ts);
 * no secret and no network. Order: the clip's `look.pack`, then the company default `providers.looks`, then the first pack.
 */
export interface LookPackEntry {
  key: string;
  label: string;
  ids: readonly string[];
}

export const LOOK_PACKS: readonly LookPackEntry[] = [{ key: "pib-basic", label: "PiB basic", ids: PIB_BASIC_IDS }];

export function resolveLookPack(override?: unknown, configDefault?: unknown): LookPackEntry {
  const key = clean(override) ?? clean(configDefault);
  if (key === undefined) return LOOK_PACKS[0]!;
  const found = LOOK_PACKS.find((p) => p.key === key);
  if (!found) throw new StudioError(`Unknown look pack "${key.slice(0, 40)}". Choose one of: ${LOOK_PACKS.map((p) => p.key).join(", ")}.`, "bad_request");
  return found;
}

/**
 * Sticker packs (PAR-10172, plan PAR-8279 slice 4): closed lists defined in code (video-edit/sticker-packs.ts), shipped as
 * PNGs in the plugin. Nothing to configure: no secret, no default setting, no network.
 */
export interface StickerPackEntry {
  key: string;
  label: string;
  ids: readonly string[];
}
const STICKER_LABELS: Record<(typeof STICKER_PACKS)[number], string> = { "noto-emoji": "Noto Emoji", "pib-shapes": "PiB shapes" };
export const STICKER_PACK_ENTRIES: readonly StickerPackEntry[] = STICKER_PACKS.map((key) => ({ key, label: STICKER_LABELS[key], ids: stickerIds(key) }));

const VOICE_NOTES: Record<Capability, Record<string, { price: string; qualityNote: string }>> = {
  stt: { xai: { price: "Not charged to Studio credits (xAI bills the key a few cents a minute)", qualityNote: `${XAI_STT_MODEL}: timed words for captions.` },
    elevenlabs: { price: "Not charged to Studio credits (ElevenLabs bills the key $0.22 per hour of audio; elevenlabs.io/pricing/api, read 2026-11-09)", qualityNote: `${ELEVENLABS_STT_MODEL}: timed words for captions.` },
  },
  reframe: {
    "local-face": { price: "free, runs on our server", qualityNote: "Follows the main face and keeps it in frame; needs a clear, front-facing face." },
    centre: { price: "free, runs on our server", qualityNote: "Always crops the middle of the picture; steady, but ignores where people are." },
  },
  tts: { xai: { price: `${ttsCredits(1000)} credits per 1,000 characters`, qualityNote: `Grok voice, ${XAI_VOICES.length} voices.` },
    elevenlabs: { price: `${ttsCredits(1000, "elevenlabs")} credits per 1,000 characters`, qualityNote: `ElevenLabs Multilingual v2, ${ELEVENLABS_VOICES.length} premade voices.` },
  },
  music: { stability: { price: `USD ${STABLE_AUDIO_USD_PER_GENERATION.toFixed(2)} (${musicCredits()} credits) per track, up to ${MUSIC_MAX_SECONDS} s`, qualityNote: "Stable Audio 2.5, instrumental music and sound beds" } },
};

/** Every option per capability with its price, quality note and whether it is the company's default. Never a key. */
export async function providerOptions(config: Pick<StudioConfig, "providerDefault"> & Partial<Pick<StudioConfig, "hasSecret">>) {
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
    return Promise.all(PROVIDERS[cap].map(async (p) => ({ key: p.key, label: p.label, ...VOICE_NOTES[cap][p.key]!, isDefault: p.key === chosen, configured: p.key === "local-face" ? yunetReady() : config.hasSecret && p.secret ? await config.hasSecret(p.secret) : undefined })));
  };
  const lookDefault = await def("looks");
  const defaults = { audio: await def("lipsync"), line: await def("lipsyncLine") };
  const chosen = {
    audio: safe(() => resolveLipsync("audio", undefined, defaults).key, () => resolveLipsync("audio").key),
    line: safe(() => resolveLipsync("line", undefined, defaults).key, () => resolveLipsync("line").key),
  };
  const lipsync = LIPSYNC.map((e) => {
    const input = lipsyncInputOf(e);
    return { key: e.key, label: e.label, model: e.model, input, ...lipsyncPrice(e.model), qualityNote: e.qualityNote, isDefault: chosen[input] === e.key };
  });
  const lookChosen = safe(() => resolveLookPack(undefined, lookDefault).key, () => LOOK_PACKS[0]!.key);
  const looks = LOOK_PACKS.map((p) => ({ key: p.key, label: p.label, ids: p.ids, isDefault: p.key === lookChosen }));
  return { stt: await voice("stt"), tts: await voice("tts"), music: await voice("music"), reframe: await voice("reframe"), lipsync, looks, stickers: STICKER_PACK_ENTRIES };
}

/** Speech to text for `override` (or the company default). Fake when PIB_STUDIO_FAKE_PROVIDER=1. */
export async function sttFor(override: unknown, config: StudioConfig): Promise<SpeechToText> {
  const entry = resolveProvider("stt", override, await config.providerDefault("stt"));
  if (fakeProviderOn()) return fakeSpeechToText();
  switch (entry.key) {
    case "xai":
      return xaiSpeechToText(await config.xaiKey());
    case "elevenlabs":
      return elevenLabsSpeechToText(await config.elevenLabsKey());
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
    case "elevenlabs":
      return elevenLabsTextToSpeech(await config.elevenLabsKey());
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

/** What a reframe job gets: face boxes per sample (`centre` has none, so the crop stays in the middle). */
export interface ReframeEngine {
  key: string;
  track(input: { from: number; to: number; width: number; height: number }): Promise<Track>;
}

/** The fixed track the fake engine returns: one face, centred, at 5 samples a second. */
export function fakeReframeTrack(input: { from: number; to: number; width: number; height: number }): Track {
  const samples: Track["samples"] = [];
  const n = Math.max(0, Math.round((input.to - input.from) * 5));
  for (let i = 0; i < n; i++) {
    samples.push({ t: Math.round((input.from + i / 5) * 1000) / 1000, boxes: [{ x: Math.round(input.width * 0.4), y: Math.round(input.height * 0.3), w: Math.round(input.width * 0.2), h: Math.round(input.height * 0.2), score: 0.99 }] });
  }
  return { fps: 5, width: input.width, height: input.height, samples };
}

/** Reframe engine for `override` (or the company default). Fake when PIB_STUDIO_FAKE_PROVIDER=1. */
export async function reframeFor(override: unknown, config: Pick<StudioConfig, "providerDefault">): Promise<ReframeEngine> {
  const entry = resolveProvider("reframe", override, await config.providerDefault("reframe"));
  if (fakeProviderOn()) return { key: "fake", track: async (i) => fakeReframeTrack(i) };
  if (entry.key === "centre") return { key: "centre", track: async (i) => ({ fps: 5, width: i.width, height: i.height, samples: [] }) };
  if (!yunetReady()) throw new StudioError("Face reframe is not installed on this server: the face model is missing or does not match.", "not_configured");
  return { key: "local-face", track: async () => { throw new StudioError("Face tracking runs in the render worker.", "bad_request"); } };
}
