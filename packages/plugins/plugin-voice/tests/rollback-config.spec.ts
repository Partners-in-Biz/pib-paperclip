/**
 * Rollback (plan PAR-14808, T5): a 0.2.0 company config must still load under 0.1.11 with the same Grok settings.
 * `settingsFromV0111` is a copy of 0.1.11's `settingsFrom` (git 4ce68aa7f9, src/config.ts), kept here as a fixture:
 * it ignores keys it does not know, so the new Gemini fields cannot change what a rolled-back worker reads.
 */
import { describe, expect, it } from "vitest";
import { settingsFrom } from "../src/config.js";

function splitKeytermsV0111(raw: unknown): string[] {
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

function settingsFromV0111(config: Record<string, unknown>) {
  const str = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  return {
    voice: str(config.voice, "eve"),
    language: typeof config.language === "string" ? config.language.trim() : "en",
    keyterms: splitKeytermsV0111(config.keyterms ?? "PiB, Paperclip, SEO, Partners in Biz"),
    voiceNoteAutoSend: config.voiceNoteAutoSend === true,
    liveEnabled: config.liveEnabled !== false,
  };
}

const CONFIG_0_2_0 = {
  xaiApiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
  geminiApiKey: { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222" },
  geminiVoice: "Puck",
  defaultProvider: "gemini",
  voice: "rex",
  language: "af",
  keyterms: "PiB, Ren, Paperclip",
  voiceNoteAutoSend: true,
  liveEnabled: false,
};

describe("rollback to 0.1.11", () => {
  it("reads the same Grok settings from a 0.2.0 config", () => {
    const old = settingsFromV0111(CONFIG_0_2_0);
    expect(old).toEqual({ voice: "rex", language: "af", keyterms: ["PiB", "Ren", "Paperclip"], voiceNoteAutoSend: true, liveEnabled: false });
    const current = settingsFrom(CONFIG_0_2_0);
    for (const key of Object.keys(old) as Array<keyof typeof old>) expect(current[key]).toEqual(old[key]);
  });

  it("reads the same defaults from a config with only the old fields", () => {
    expect(settingsFromV0111({})).toEqual({ voice: "eve", language: "en", keyterms: ["PiB", "Paperclip", "SEO", "Partners in Biz"], voiceNoteAutoSend: false, liveEnabled: true });
    expect(settingsFromV0111(CONFIG_0_2_0)).toEqual(settingsFromV0111({ ...CONFIG_0_2_0, geminiApiKey: undefined, geminiVoice: undefined, defaultProvider: undefined }));
  });
});
