import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { loadVoiceConfig, validVoice, XAI_VOICES, type VoiceProvider, type VoiceSettings } from "./config.js";
import { SPEAK_DAILY_CHAR_CAP, SPEAK_DEADLINE_MS, SPEAK_MAX_CHARS, SPEAK_MIN_CHARS, PROVIDER_TIMEOUT_MS, TTS_SAMPLE_RATE } from "./limits.js";
import { geminiSpeak, xaiSpeak, type TtsOutcome } from "./tts.js";
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
const agentScope = (agentId: string) => ({ scopeKind: "agent" as const, scopeId: agentId, stateKey: AGENT_VOICE_KEY });

/** The agent must belong to the caller's company; a state key per foreign agent id is never read or written. */
async function requireCompanyAgent(ctx: PluginContext, companyId: string, agentId: unknown): Promise<string> {
  if (typeof agentId !== "string" || !agentId) throw new VoiceError("Pick an agent first.");
  const agents = await ctx.agents.list({ companyId, limit: 200 });
  if (!agents.some((a) => a.id === agentId)) throw new VoiceError("That agent is not in this company.");
  return agentId;
}

/** The voice a call to this agent uses: the agent's own saved voice if it is still valid, else the company voice. */
export async function resolveVoice(ctx: PluginContext, companyId: string, agentId: unknown, companyVoice: string): Promise<string> {
  if (typeof agentId !== "string" || !agentId) return companyVoice;
  try {
    const known = await ctx.agents.list({ companyId, limit: 200 });
    if (!known.some((a) => a.id === agentId)) return companyVoice;
    return validVoice(await ctx.state.get(agentScope(agentId))) ?? companyVoice;
  } catch {
    return companyVoice;
  }
}

export async function agentVoiceData(ctx: PluginContext, companyId: string | null, agentId: unknown) {
  const loaded = companyId ? await loadVoiceConfig(ctx, companyId) : null;
  const companyVoice = loaded?.settings.voice ?? "eve";
  const voice = companyId ? await resolveVoice(ctx, companyId, agentId, companyVoice) : companyVoice;
  const own = companyId && typeof agentId === "string" && voice !== companyVoice ? voice : null;
  return { voices: [...XAI_VOICES], companyVoice, agentVoice: own, effective: voice };
}

/** Saves (or, with an empty voice, clears) one agent's voice. Unknown ids are refused. */
export async function setAgentVoiceAction(ctx: PluginContext, params: Record<string, unknown>, context: PluginPerformActionContext) {
  const { companyId } = requireBoardUser(context);
  const agentId = await requireCompanyAgent(ctx, companyId, params.agentId);
  if (params.voice === null || params.voice === "") {
    await ctx.state.delete(agentScope(agentId));
    return { agentVoice: null };
  }
  const voice = validVoice(params.voice);
  if (!voice) throw new VoiceError(`Unknown voice. Pick one of: ${XAI_VOICES.join(", ")}.`);
  await ctx.state.set(agentScope(agentId), voice);
  return { agentVoice: voice };
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
    const voice =
      provider === "gemini"
        ? loaded.settings.geminiVoice
        : await resolveVoice(ctx, companyId, agentId, loaded.settings.voice);
    const result =
      provider === "gemini"
        ? await geminiSpeak({ apiKey, text, voice, timeoutMs }, fetchImpl)
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
