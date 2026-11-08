/**
 * Voice providers (PAR-8414). One const map, one switch: no factory layer. Each capability (speech to text, text to
 * speech) has a company default in the plugin settings (`providers.stt` / `providers.tts`) and a per-job `provider`
 * override. Order: override, then company default, then the first entry. Only xAI today.
 */
import type { StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { fakeProviderOn } from "../provider.js";
import { fakeSpeechToText, xaiSpeechToText, type SpeechToText } from "../video-edit/stt.js";

export type Capability = "stt" | "tts";

export interface ProviderEntry {
  key: string;
  label: string;
  /** Secret reference in the plugin settings. */
  secret: string;
}

const XAI: ProviderEntry = { key: "xai", label: "xAI (Grok)", secret: "xai.apiKey" };

export const PROVIDERS: Record<Capability, readonly ProviderEntry[]> = { stt: [XAI], tts: [XAI] };

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
  for (const capability of ["stt", "tts"] as const) {
    const entry = resolveProvider(capability, undefined, await config.providerDefault(capability).catch(() => undefined));
    out.push({ capability, provider: entry.key, label: entry.label, configured: await config.hasSecret(entry.secret) });
  }
  return out;
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

// TODO(PAR-8407 T3): export `ttsFor(override, config)` here, same shape as sttFor, with a `case "xai"`.
