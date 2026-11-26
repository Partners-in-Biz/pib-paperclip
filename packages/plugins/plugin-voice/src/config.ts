import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, secretField, SecretResolver } from "@partnersinbiz/pib-plugin-kit";

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Voice settings",
  description:
    "Voice notes (the mic in every chat box) and live two-way voice (the waveform), both on Grok voice. Save these once per company. Nothing shows in the chat box until the xAI key is saved.",
  properties: {
    xaiApiKey: secretField(
      "xAI API key",
      "Store it as a Paperclip secret. It stays on the server: phones only ever get a five-minute pass for a live session.",
    ),
    geminiApiKey: secretField(
      "Gemini API key",
      "Optional. Gives agents Gemini voices in direct voice mode. Needs a key on a billed Google Cloud project. Store it as a Paperclip secret; it stays on the server.",
    ),
    geminiVoice: {
      type: "string",
      title: "Gemini voice",
      default: "Kore",
      description: "The Gemini voice an agent uses when it has none of its own, e.g. Kore, Puck, Zephyr.",
    },
    defaultProvider: {
      type: "string",
      title: "Default direct voice",
      enum: ["grok", "gemini"],
      default: "grok",
      description: "The voice engine direct mode starts with for a person who has not picked one. Gemini applies only once its key is saved.",
    },
    voice: {
      type: "string",
      title: "Live voice",
      default: "eve",
      description: "A Grok voice id, e.g. eve, ara, rex, sal, leo, or a custom voice id.",
    },
    language: {
      type: "string",
      title: "Language",
      default: "en",
      description: "Language code for transcription, e.g. en or af. Leave empty to detect.",
    },
    keyterms: {
      type: "string",
      title: "Words to listen for",
      default: "PiB, Paperclip, SEO, Partners in Biz",
      description: "Names and terms the transcriber should get right, separated by commas. Agent names are added automatically.",
    },
    voiceNoteAutoSend: {
      type: "boolean",
      title: "Send voice notes straight away",
      default: false,
      description: "Off: the transcript lands in the chat box so you can check it, then you tap Send. On: it sends at once.",
    },
    liveEnabled: {
      type: "boolean",
      title: "Live voice",
      default: true,
      description: "Show the waveform button for live two-way talk.",
    },
  },
};

/** Built-in xAI voices. Source: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech (and the realtime guide for the first five). */
export const XAI_VOICES = [
  "carina", "zagan", "helix", "orion", "luna", "iris", "altair", "zenith", "perseus", "helios",
  "lux", "kepler", "rigel", "cosmo", "celeste", "ursa", "sirius", "lumen", "castor", "naksh",
  "atlas", "aurora", "liora", "ara", "eve", "leo", "rex", "sal",
] as const;

/** Prebuilt Gemini voices. Source: https://ai.google.dev/gemini-api/docs/speech-generation (voice table). */
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;

export const DEFAULT_GEMINI_VOICE = "Kore";

export type VoiceProvider = "grok" | "gemini";

/** A known built-in voice id (case-insensitive), lower-cased; otherwise null. */
export function validVoice(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (XAI_VOICES as readonly string[]).includes(id) ? id : null;
}

/** A known prebuilt Gemini voice (case-insensitive), in its canonical spelling; otherwise null. */
export function validGeminiVoice(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return GEMINI_VOICES.find((v) => v.toLowerCase() === id) ?? null;
}

export interface VoiceSettings {
  voice: string;
  geminiVoice: string;
  defaultProvider: VoiceProvider;
  language: string;
  keyterms: string[];
  voiceNoteAutoSend: boolean;
  liveEnabled: boolean;
}

export function splitKeyterms(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const term = part.trim().slice(0, 50);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

export function settingsFrom(config: Record<string, unknown>): VoiceSettings {
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return {
    voice: str(config.voice, "eve"),
    geminiVoice: validGeminiVoice(config.geminiVoice) ?? DEFAULT_GEMINI_VOICE,
    defaultProvider: config.defaultProvider === "gemini" ? "gemini" : "grok",
    language: typeof config.language === "string" ? config.language.trim() : "en",
    keyterms: splitKeyterms(config.keyterms ?? "PiB, Paperclip, SEO, Partners in Biz"),
    voiceNoteAutoSend: config.voiceNoteAutoSend === true,
    liveEnabled: config.liveEnabled !== false,
  };
}

export async function loadVoiceConfig(ctx: PluginContext, companyId: string) {
  const config = await readConfig(ctx, companyId);
  const secrets = new SecretResolver(ctx, companyId, config);
  return { config, settings: settingsFrom(config), secrets };
}
