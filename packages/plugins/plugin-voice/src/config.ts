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

export interface VoiceSettings {
  voice: string;
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
