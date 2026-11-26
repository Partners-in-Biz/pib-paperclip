import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_GEMINI_VOICE, GEMINI_VOICES, loadVoiceConfig, validGeminiVoice, validVoice, XAI_VOICES, type VoiceProvider, type VoiceSettings } from "./config.js";
import { SPEAK_DAILY_CHAR_CAP, SPEAK_DEADLINE_MS, SPEAK_MAX_CHARS, SPEAK_MIN_CHARS, PROVIDER_TIMEOUT_MS, TTS_SAMPLE_RATE } from "./limits.js";
import { cleanStyle, geminiSpeak, xaiSpeak, type TtsOutcome } from "./tts.js";
import { XAI_REALTIME_URL, XAI_VOICE_MODEL } from "./namespace.js";
import { baseMime, MAX_AUDIO_BYTES, mintLiveToken, transcribe, VoiceError } from "./xai.js";
type FetchLike = typeof fetch;

/** Voice is for people at the board, never for agent runs. */
export function requireBoardUser(context: PluginPerformActionContext): { companyId: string; userId: string } {
  if (context.actor.type !== "user" || !context.actor.userId) {
    throw new VoiceError("Voice is only available to signed-in people.");
  }
  if (!context.companyId) throw new VoiceError("Pick a company first.");
  return { companyId: context.companyId, userId: context.actor.userId };
}

async function requireKey(ctx: PluginContext, companyId: string) {
  const loaded = await loadVoiceConfig(ctx, companyId);
  const apiKey = await loaded.secrets.get("xaiApiKey");
  if (!apiKey) throw new VoiceError("Voice is not set up yet. Save the xAI key in Voice settings.");
  return { apiKey, settings: loaded.settings };
}

/** Agent names help the transcriber spell them; failures here never block a note. */
export async function keytermsFor(ctx: PluginContext, companyId: string, settings: VoiceSettings): Promise<string[]> {
  const terms = [...settings.keyterms];
  try {
    const agents = await ctx.agents.list({ companyId, limit: 100 });
    for (const agent of agents) {
      const name = typeof agent.name === "string" ? agent.name.trim() : "";
      if (name && !terms.some((t) => t.toLowerCase() === name.toLowerCase())) terms.push(name.slice(0, 50));
    }
  } catch {
    // agents.read can fail for a company without agents; the configured terms still apply.
  }
  return terms.slice(0, 100);
}

export async function statusAction(ctx: PluginContext, companyId: string | null) {
  if (!companyId) return { configured: false, geminiConfigured: false, liveEnabled: false, voiceNoteAutoSend: false };
  const loaded = await loadVoiceConfig(ctx, companyId);
  const raw = loaded.config.xaiApiKey;
  const configured = raw != null && raw !== "";
  const geminiRaw = loaded.config.geminiApiKey;
  return {
    configured,
    // A secret ref is present; never the value.
    geminiConfigured: geminiRaw != null && geminiRaw !== "",
    liveEnabled: configured && loaded.settings.liveEnabled,
    voiceNoteAutoSend: loaded.settings.voiceNoteAutoSend,
  };
}

export function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value) throw new VoiceError("No audio received.");
  const comma = value.indexOf(",");
  const base64 = value.startsWith("data:") && comma > 0 ? value.slice(comma + 1) : value;
  // Reject before decoding so an oversized body costs nothing.
  if ((base64.length * 3) / 4 > MAX_AUDIO_BYTES) throw new VoiceError("The recording is too long. Keep voice notes under about 20 minutes.");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export async function transcribeAction(
  ctx: PluginContext,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
  fetchImpl?: FetchLike,
) {
  const { companyId } = requireBoardUser(context);
  const { apiKey, settings } = await requireKey(ctx, companyId);
  const audio = decodeAudio(params.audio);
  const mimeType = baseMime(params.mimeType);
  const keyterms = await keytermsFor(ctx, companyId, settings);
  const result = await transcribe(
    { apiKey, audio, mimeType, language: settings.language || undefined, keyterms },
    fetchImpl,
  );
  ctx.logger.info("voice note transcribed", { companyId, bytes: audio.byteLength, seconds: result.duration });
  return { text: result.text, duration: result.duration, autoSend: settings.voiceNoteAutoSend };
}

/** A pass is good for five minutes to open the socket; the session itself can run longer. */
export const LIVE_TOKEN_SECONDS = 300;

const AGENT_VOICE_KEY = "voice";
const AGENT_PROFILE_KEY = "voice-profile";
const agentScope = (agentId: string) => ({ scopeKind: "agent" as const, scopeId: agentId, stateKey: AGENT_VOICE_KEY });
const profileScope = (agentId: string) => ({ scopeKind: "agent" as const, scopeId: agentId, stateKey: AGENT_PROFILE_KEY });

/** One agent's own voices. Every field is optional: a missing one falls back to the company voice. */
export interface AgentVoiceProfile {
  grokVoice?: string;
  geminiVoice?: string;
  geminiStyle?: string;
}

/** The agent must belong to the caller's company; a state key per foreign agent id is never read or written. */
async function requireCompanyAgent(ctx: PluginContext, companyId: string, agentId: unknown): Promise<string> {
  if (typeof agentId !== "string" || !agentId) throw new VoiceError("Pick an agent first.");
  const agents = await ctx.agents.list({ companyId, limit: 200 });
  if (!agents.some((a) => a.id === agentId)) throw new VoiceError("That agent is not in this company.");
  return agentId;
}

/** The saved profile, each field checked again; the legacy `voice` key fills `grokVoice` when the profile has none. */
async function readProfile(ctx: PluginContext, agentId: string): Promise<AgentVoiceProfile> {
  const profile: AgentVoiceProfile = {};
  const saved = await ctx.state.get(profileScope(agentId));
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const raw = saved as Record<string, unknown>;
    const grok = validVoice(raw.grokVoice);
    const gemini = validGeminiVoice(raw.geminiVoice);
    const style = cleanStyle(raw.geminiStyle);
    if (grok) profile.grokVoice = grok;
    if (gemini) profile.geminiVoice = gemini;
    if (style) profile.geminiStyle = style;
  }
  if (!profile.grokVoice) {
    const legacy = validVoice(await ctx.state.get(agentScope(agentId)));
    if (legacy) profile.grokVoice = legacy;
  }
  return profile;
}

/** Writes the profile (an empty one is deleted) and keeps the legacy `voice` key in step, so a rollback keeps the Grok voice. */
async function writeProfile(ctx: PluginContext, agentId: string, profile: AgentVoiceProfile): Promise<void> {
  if (Object.keys(profile).length) await ctx.state.set(profileScope(agentId), profile);
  else await ctx.state.delete(profileScope(agentId));
  if (profile.grokVoice) await ctx.state.set(agentScope(agentId), profile.grokVoice);
  else await ctx.state.delete(agentScope(agentId));
}

/** The agent's profile, or an empty one for an agent outside the company or an unreadable state. */
async function profileFor(ctx: PluginContext, companyId: string, agentId: unknown): Promise<AgentVoiceProfile> {
  if (typeof agentId !== "string" || !agentId) return {};
  try {
    const known = await ctx.agents.list({ companyId, limit: 200 });
    if (!known.some((a) => a.id === agentId)) return {};
    return await readProfile(ctx, agentId);
  } catch {
    return {};
  }
}

/** The voice a call to this agent uses: the agent's own saved Grok voice if it is still valid, else the company voice. */
export async function resolveVoice(ctx: PluginContext, companyId: string, agentId: unknown, companyVoice: string): Promise<string> {
  return (await profileFor(ctx, companyId, agentId)).grokVoice ?? companyVoice;
}

export async function agentVoiceData(ctx: PluginContext, companyId: string | null, agentId: unknown) {
  const loaded = companyId ? await loadVoiceConfig(ctx, companyId) : null;
  const profile = companyId ? await profileFor(ctx, companyId, agentId) : {};
  const raw = loaded?.config.geminiApiKey;
  return {
    profile,
    company: { grokVoice: loaded?.settings.voice ?? "eve", geminiVoice: loaded?.settings.geminiVoice ?? DEFAULT_GEMINI_VOICE },
    geminiConfigured: raw != null && raw !== "",
    voices: { grok: [...XAI_VOICES], gemini: [...GEMINI_VOICES] },
  };
}

/** Saves (or, with an empty voice, clears) one agent's Grok voice. Unknown ids are refused. */
export async function setAgentVoiceAction(ctx: PluginContext, params: Record<string, unknown>, context: PluginPerformActionContext) {
  const { companyId } = requireBoardUser(context);
  const agentId = await requireCompanyAgent(ctx, companyId, params.agentId);
  const profile = await readProfile(ctx, agentId);
  if (params.voice === null || params.voice === "") {
    delete profile.grokVoice;
    await writeProfile(ctx, agentId, profile);
    return { agentVoice: null };
  }
  const voice = validVoice(params.voice);
  if (!voice) throw new VoiceError(`Unknown voice. Pick one of: ${XAI_VOICES.join(", ")}.`);
  await writeProfile(ctx, agentId, { ...profile, grokVoice: voice });
  return { agentVoice: voice };
}

/**
 * Saves one agent's voice profile. A field left out is unchanged; an empty or null one is cleared.
 * Unknown voices are refused before anything is written; the style is cleaned (never rejected).
 */
export async function setAgentVoiceProfileAction(ctx: PluginContext, params: Record<string, unknown>, context: PluginPerformActionContext) {
  const { companyId } = requireBoardUser(context);
  const agentId = await requireCompanyAgent(ctx, companyId, params.agentId);
  const profile = await readProfile(ctx, agentId);
  const cleared = (value: unknown) => value === null || value === "";
  if ("grokVoice" in params && params.grokVoice !== undefined) {
    if (cleared(params.grokVoice)) delete profile.grokVoice;
    else {
      const voice = validVoice(params.grokVoice);
      if (!voice) throw new VoiceError(`Unknown Grok voice. Pick one of: ${XAI_VOICES.join(", ")}.`);
      profile.grokVoice = voice;
    }
  }
  if ("geminiVoice" in params && params.geminiVoice !== undefined) {
    if (cleared(params.geminiVoice)) delete profile.geminiVoice;
    else {
      const voice = validGeminiVoice(params.geminiVoice);
      if (!voice) throw new VoiceError(`Unknown Gemini voice. Pick one of: ${GEMINI_VOICES.join(", ")}.`);
      profile.geminiVoice = voice;
    }
  }
  if ("geminiStyle" in params && params.geminiStyle !== undefined) {
    if (params.geminiStyle !== null && typeof params.geminiStyle !== "string") throw new VoiceError("The style must be text.");
    const style = cleanStyle(params.geminiStyle);
    if (style) profile.geminiStyle = style;
    else delete profile.geminiStyle;
  }
  await writeProfile(ctx, agentId, profile);
  return { profile };
}

/** A person's saved way of talking: straight to the agent in `direct` mode (with a voice engine), or the `classic` live call. */
export type VoiceMode = { mode: "direct"; provider: VoiceProvider } | { mode: "classic" };

const modeScope = (companyId: string, userId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "voice-mode",
  stateKey: userId,
});

async function geminiConfigured(ctx: PluginContext, companyId: string) {
  const loaded = await loadVoiceConfig(ctx, companyId);
  const raw = loaded.config.geminiApiKey;
  return { configured: raw != null && raw !== "", defaultProvider: loaded.settings.defaultProvider };
}

/** The caller's own mode. Nothing saved, or a state that cannot be read, answers the default and writes nothing. */
export async function getMyVoiceModeAction(ctx: PluginContext, context: PluginPerformActionContext): Promise<VoiceMode & { geminiConfigured: boolean }> {
  const { companyId, userId } = requireBoardUser(context);
  const { configured, defaultProvider } = await geminiConfigured(ctx, companyId);
  const fallback: VoiceMode = { mode: "direct", provider: configured && defaultProvider === "gemini" ? "gemini" : "grok" };
  let saved: unknown = null;
  try {
    saved = await ctx.state.get(modeScope(companyId, userId));
  } catch {
    ctx.logger.warn("voice mode unreadable", { companyId });
  }
  const value = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : null;
  let mode: VoiceMode = fallback;
  if (value?.mode === "classic") mode = { mode: "classic" };
  else if (value?.mode === "direct" && value.provider === "grok") mode = { mode: "direct", provider: "grok" };
  else if (value?.mode === "direct" && value.provider === "gemini" && configured) mode = { mode: "direct", provider: "gemini" };
  return { ...mode, geminiConfigured: configured };
}

/** Saves the caller's own mode; the person comes from the actor, never from a param. */
export async function setMyVoiceModeAction(ctx: PluginContext, params: Record<string, unknown>, context: PluginPerformActionContext) {
  const { companyId, userId } = requireBoardUser(context);
  let next: VoiceMode;
  if (params.mode === "classic") next = { mode: "classic" };
  else if (params.mode === "direct") {
    if (params.provider !== "grok" && params.provider !== "gemini") throw new VoiceError("Pick a voice engine: grok or gemini.");
    if (params.provider === "gemini" && !(await geminiConfigured(ctx, companyId)).configured) {
      throw new VoiceError("Gemini voices are not set up yet. Save a Gemini key in Voice settings.");
    }
    next = { mode: "direct", provider: params.provider };
  } else throw new VoiceError("Unknown mode. Pick direct or classic.");
  await ctx.state.set(modeScope(companyId, userId), next);
  return next;
}

export async function liveSessionAction(
  ctx: PluginContext,
  context: PluginPerformActionContext,
  fetchImpl?: FetchLike,
  params: Record<string, unknown> = {},
) {
  const { companyId, userId } = requireBoardUser(context);
  const { apiKey, settings } = await requireKey(ctx, companyId);
  if (!settings.liveEnabled) throw new VoiceError("Live voice is switched off in Voice settings.");
  const minted = await mintLiveToken(apiKey, LIVE_TOKEN_SECONDS, fetchImpl);
  const keyterms = await keytermsFor(ctx, companyId, settings);
  ctx.logger.info("live voice session started", { companyId, userId });
  return {
    token: minted.token,
    expiresAt: minted.expiresAt,
    url: `${XAI_REALTIME_URL}?model=${encodeURIComponent(XAI_VOICE_MODEL)}`,
    // Sent to xAI as `voice` in the session.update the call opens with.
    voice: await resolveVoice(ctx, companyId, params.agentId, settings.voice),
    // Tried once by the panel if the realtime socket refuses the agent's own voice id.
    companyVoice: settings.voice,
    language: settings.language,
    keyterms,
  };
}

/** One `speak` call and the outcome it came to. The audio is base64 PCM16 mono at `sampleRate`. */
export type SpeakResult =
  | { audio: string; sampleRate: number; provider: VoiceProvider; voice: string }
  | { error: Exclude<TtsOutcome, "ok"> };

const usageScope = (companyId: string, userId: string, now: Date) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "speak-usage",
  stateKey: `${userId}:${now.toISOString().slice(0, 10)}`,
});

/** Runs `work`, answering `timeout` itself if it has not finished when the deadline passes. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | { error: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ error: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ error: "timeout" }), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns one chunk of an agent's reply into audio. Provider trouble is an answer (`{error}`), not a throw,
 * so the panel can fall back to the other engine. Wrong caller, wrong agent and bad text throw a VoiceError.
 * One provider call, no retries.
 */
export async function speakAction(
  ctx: PluginContext,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
  fetchImpl: FetchLike = fetch,
): Promise<SpeakResult> {
  const startedAt = Date.now();
  const { companyId, userId } = requireBoardUser(context);
  const text = params.text;
  if (typeof text !== "string" || text.trim().length < SPEAK_MIN_CHARS) throw new VoiceError("There is nothing to say.");
  if (text.length > SPEAK_MAX_CHARS) throw new VoiceError(`Keep each spoken piece under ${SPEAK_MAX_CHARS} characters.`);
  const agentId = await requireCompanyAgent(ctx, companyId, params.agentId);

  const run = async (): Promise<SpeakResult> => {
    const loaded = await loadVoiceConfig(ctx, companyId);
    const provider: VoiceProvider =
      params.provider === "gemini" || params.provider === "grok" ? params.provider : loaded.settings.defaultProvider;
    const apiKey = await loaded.secrets.get(provider === "gemini" ? "geminiApiKey" : "xaiApiKey");
    if (!apiKey) return { error: "not_configured" };

    // Read before the call, added after an `ok`. Two calls at the same moment can overshoot the cap by one call
    // (at most 600 characters); accepted, a lock would cost more than it saves.
    const scope = usageScope(companyId, userId, new Date());
    let used = 0;
    try {
      const saved = await ctx.state.get(scope);
      used = typeof saved === "number" && Number.isFinite(saved) && saved > 0 ? saved : 0;
    } catch {
      ctx.logger.warn("voice speak usage unreadable", { companyId });
      return { error: "provider_error" };
    }
    if (used + text.length > SPEAK_DAILY_CHAR_CAP) return { error: "daily_limit" };

    const remaining = SPEAK_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) return { error: "timeout" };
    const timeoutMs = Math.min(PROVIDER_TIMEOUT_MS, remaining);
    const profile = await profileFor(ctx, companyId, agentId);
    const voice = provider === "gemini" ? (profile.geminiVoice ?? loaded.settings.geminiVoice) : (profile.grokVoice ?? loaded.settings.voice);
    const result =
      provider === "gemini"
        ? await geminiSpeak({ apiKey, text, voice, style: cleanStyle(profile.geminiStyle), timeoutMs }, fetchImpl)
        : await xaiSpeak({ apiKey, text, voice, language: loaded.settings.language, timeoutMs }, fetchImpl);
    // Counts and outcomes only: never the key, the text or a provider error body.
    ctx.logger.info("voice speak", { companyId, provider, outcome: result.outcome, chars: text.length });
    if (result.outcome !== "ok") return { error: result.outcome };
    try {
      await ctx.state.set(scope, used + text.length);
    } catch {
      ctx.logger.warn("voice speak usage not saved", { companyId });
    }
    return { audio: result.audio, sampleRate: TTS_SAMPLE_RATE, provider, voice };
  };

  return withDeadline(run(), SPEAK_DEADLINE_MS);
}
