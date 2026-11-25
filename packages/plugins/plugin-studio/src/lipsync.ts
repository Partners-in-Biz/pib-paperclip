/**
 * Lip-sync (PAR-8436): one portrait plus our audio asset, or a typed line the model speaks. Resolves the option
 * (registry.ts), builds an ordinary generate request and hands it to `requestGeneration`: same row, reserve, caps,
 * run limit, sweeper and settle as any video. No spend path of its own.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { StudioConfig } from "./config.js";
import { StudioError } from "./errors.js";
import { requestGeneration, type Actor } from "./generation.js";
import { findModel } from "./models.js";
import { resolveLipsync, type LipsyncEntry, type LipsyncInput } from "./providers/registry.js";

export const MAX_LINE_CHARS = 500;
const AUDIO_PROMPT = "The person in the picture speaks the audio, lips in sync, natural expression.";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The generate request for a lip-sync job, and the option it resolved to. */
export function lipsyncRequest(params: Record<string, unknown>, defaults: Partial<Record<LipsyncInput, unknown>> = {}): { entry: LipsyncEntry; input: LipsyncInput; request: Record<string, unknown> } {
  const portrait = str(params.portraitAssetId);
  if (!portrait) throw new StudioError("portraitAssetId is required: the picture of the person who speaks.", "bad_request");
  const audio = str(params.audioAssetId);
  const line = str(params.line);
  if (Boolean(audio) === Boolean(line)) throw new StudioError("Give either audioAssetId (our audio) or line (words the model says), not both and not neither.", "bad_request");
  if (line.length > MAX_LINE_CHARS) throw new StudioError(`line is at most ${MAX_LINE_CHARS} characters.`, "bad_request");
  const input: LipsyncInput = audio ? "audio" : "line";
  const entry = resolveLipsync(input, params.provider, defaults);
  const model = findModel(entry.model)!;
  const resolution = str(params.resolution) || model.resolutions[0];
  if (model.resolutions.length && !model.resolutions.includes(resolution)) throw new StudioError(`${model.label} doesn't offer ${resolution}.`, "bad_request");
  const note = str(params.prompt);
  const prompt = input === "line" ? `${note ? `${note} ` : ""}The person says: "${line}"` : note || AUDIO_PROMPT;
  const duration = params.duration === undefined || params.duration === null || params.duration === "" ? undefined : Number(params.duration);
  const request: Record<string, unknown> = {
    model: entry.model,
    prompt,
    params: { ...(duration === undefined ? {} : { duration }), ...(resolution ? { resolution } : {}) },
    referenceAssetIds: [portrait],
    ...(audio ? { audioAssetIds: [audio] } : {}),
  };
  for (const key of ["client", "issueId", "name"] as const) if (params[key] !== undefined) request[key] = params[key];
  return { entry, input, request };
}

/** Resolves against the company defaults, then queues through the one generate path. */
export async function lipsyncAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: Actor, generate = requestGeneration) {
  const config = new StudioConfig(ctx, companyId);
  const defaults = { audio: await config.providerDefault("lipsync"), line: await config.providerDefault("lipsyncLine") };
  const { entry, input, request } = lipsyncRequest(params, defaults);
  const out = await generate(ctx, companyId, request, actor);
  return { ...out, provider: entry.key, input };
}
