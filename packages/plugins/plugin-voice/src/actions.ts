import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { loadVoiceConfig, validVoice, XAI_VOICES, type VoiceSettings } from "./config.js";
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
  if (!companyId) return { configured: false, liveEnabled: false, voiceNoteAutoSend: false };
  const loaded = await loadVoiceConfig(ctx, companyId);
  const raw = loaded.config.xaiApiKey;
  const configured = raw != null && raw !== "";
  return {
    configured,
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
