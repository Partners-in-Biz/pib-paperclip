/**
 * Voiceover (PAR-8407 T3): a script becomes an MP3 (text to speech), a kind-audio Library asset, and an audio clip at
 * `at` on the edit's audio track. Charged through the generations ledger like a picture: one `synthesizing` row and one
 * reserve, no adjust (the estimate is the charge). Any failure before the asset is stored refunds and fails the row;
 * after it is stored the charge stays and the error names the asset. A `synthesizing` row is never picked by the
 * Higgsfield queue (generation.ts), and one left over 10 minutes is failed there without a refund.
 * Never logs the key or the script.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { storeAsset, type StoreInput } from "../assets.js";
import { StudioConfig } from "../config.js";
import { table } from "../db.js";
import { StudioError } from "../errors.js";
import { assertFits, assertRunFits, capCheck, currentPeriod, refund, reserve, withCompanyLock, type LedgerTarget } from "../ledger.js";
import { PROVIDERS, resolveProvider, ttsFor } from "../providers/registry.js";
import { objectUrl } from "../storage.js";
import { applyOpsAction } from "./actions.js";
import { addAudioOps } from "./audio-ops.js";
import { probeMedia, type ProbeResult } from "./probe.js";
import { getVideoEdit } from "./store.js";
import { LIMITS } from "./timeline.js";
import { type TextToSpeech } from "./tts.js";
import { MAX_SCRIPT_CHARS, ttsEstimate } from "./tts-price.js";

export interface VoiceoverActor {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  issueId?: string | null;
}

export interface VoiceoverDeps {
  tts?: TextToSpeech;
  /** Stores the MP3; tests replace it. Default: storeAsset in the company's private bucket. */
  store?: (input: StoreInput) => Promise<string>;
  /** Probes the stored file at `r2Key`; tests replace it. */
  probe?: (r2Key: string) => Promise<ProbeResult>;
  /** Tests only: a lower per-voiceover ceiling (a 4,000-character script stays under the real one). */
  ceiling?: number;
}

const bad = (message: string): never => {
  throw new StudioError(message, "bad_request");
};
const LANGUAGE = /^(auto|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/i;

function validate(params: Record<string, unknown>) {
  const script = typeof params.script === "string" ? params.script.trim() : "";
  if (!script) bad("script is required: the words to speak.");
  if (script.length > MAX_SCRIPT_CHARS) bad(`script is ${script.length} characters; a voiceover takes at most ${MAX_SCRIPT_CHARS}.`);
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  const voice = typeof params.voice === "string" ? params.voice.trim() : ""; // "" = the provider's first voice
  const language = (typeof params.language === "string" && params.language.trim()) || "en";
  if (!LANGUAGE.test(language)) bad("language must be a language code like en or pt-BR, or auto.");
  const at = params.at === undefined || params.at === null ? 0 : Number(params.at);
  if (!Number.isFinite(at) || at < 0 || at >= LIMITS.maxDuration) bad(`at must be a time in seconds from 0 to under ${LIMITS.maxDuration}.`);
  return { script, base, voice, language, at, editId: String(params.editId ?? "").trim() };
}

/** `video-edit-voiceover`: speaks `script` and puts it on the audio track at `at`, at the revision you read. */
export async function voiceoverAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: VoiceoverActor, deps: VoiceoverDeps = {}) {
  const v = validate(params);
  const edit = await getVideoEdit(ctx, companyId, v.editId);
  if (edit.revision !== v.base) throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  const config = new StudioConfig(ctx, companyId);
  const providerKey = deps.tts?.key ?? resolveProvider("tts", params.provider, await config.providerDefault("tts")).key;
  const estimate = ttsEstimate(v.script.length, deps.ceiling, providerKey); // over the ceiling: refused here, nothing reserved or sent
  const tts = deps.tts ?? (await ttsFor(params.provider, config)); // no key: refused here, nothing reserved
  const voice = v.voice ? tts.voices.find((x) => x.toLowerCase() === v.voice.toLowerCase()) : tts.voices[0];
  if (!voice) bad(`voice must be one of: ${tts.voices.join(", ")}.`);
  v.voice = voice!;
  const ledgerProvider = PROVIDERS.tts.some((p) => p.key === providerKey) ? providerKey : "xai";
  const scope: ClientScope = edit.client ? ({ kind: edit.client.kind, id: edit.client.id } as ClientScope) : null;
  const id = randomUUID();
  const period = currentPeriod();
  const ledger: LedgerTarget = { generationId: id, companyId, clientKind: edit.client?.kind ?? null, clientRef: edit.client?.id ?? null, period };
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 200) : `Voiceover: ${edit.title}`.slice(0, 200);

  await withCompanyLock(companyId, async () => {
    assertFits(await capCheck(ctx, companyId, scope, period), estimate);
    if (actor.runId) await assertRunFits(ctx, companyId, actor.runId, estimate, actor.agentId);
    // `synthesizing`, never queued/submitting/submitted/storing: the Higgsfield queue would pick those up.
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "generations")} (id, group_id, company_id, client_kind, client_ref, client_name, project_id, issue_id, agent_id, run_id, user_id, provider, model, prompt, params, name, status, period, estimated_credits)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 'synthesizing', $16, $17)`,
      [id, companyId, ledger.clientKind, ledger.clientRef, edit.client?.name ?? null, edit.projectId, actor.issueId ?? null, actor.agentId ?? null, actor.runId ?? null, actor.userId ?? null, ledgerProvider, tts.model, `Voiceover, ${v.script.length} characters`, JSON.stringify({ editId: edit.id, voice: v.voice, language: v.language, chars: v.script.length }), name, period, estimate],
    );
    await reserve(ctx, ledger, estimate);
  });

  const settle = (status: "succeeded" | "failed", fields: string, values: unknown[]) =>
    ctx.db.execute(`UPDATE ${table(ctx, "generations")} SET status = '${status}', ${fields}, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'synthesizing'`, [id, ...values]);
  try {
    const { audio, mime } = await tts.synthesize({ text: v.script, voice: v.voice, language: v.language });
    const store = deps.store ?? ((input: StoreInput) => storeAsset(ctx, config, input));
    await store({ id, companyId, scope, clientName: edit.client?.name ?? null, projectId: edit.projectId, issueId: actor.issueId ?? null, name, source: "generated", sourceRef: `generation:${id}`, generationId: id, agentId: actor.agentId ?? null, userId: actor.userId ?? null, bytes: audio, mime });
  } catch (error) {
    const e = error instanceof StudioError ? error : new StudioError("The voiceover could not be stored.", "store_failed");
    // Only the call that moves the row out of `synthesizing` refunds, so a race with the sweeper refunds at most once.
    const moved = await settle("failed", "error_code = $2, error_message = $3", [e.code, e.message.slice(0, 500)]);
    if (moved.rowCount) await refund(ctx, ledger, estimate);
    throw new StudioError(`${e.message} Nothing was charged.`, e.code);
  }
  await settle("succeeded", "asset_id = $1, actual_credits = $2", [estimate]);

  try {
    const probe = deps.probe ?? (async (key: string) => probeMedia(objectUrl(await config.bucket(), companyId, "GET", key, 600)));
    const rows = await ctx.db.query<{ r2_key: string }>(`SELECT r2_key FROM ${table(ctx, "asset_versions")} WHERE asset_id = $1 AND version = 1`, [id]);
    const length = (await probe(rows[0]?.r2_key ?? "")).durationSec;
    const made = addAudioOps(edit.doc, { id, version: 1, seconds: length }, v.at);
    if ("error" in made) throw new StudioError(made.error, "no_room");
    const saved = await applyOpsAction(ctx, companyId, { editId: edit.id, baseRevision: v.base, ops: made.ops }, { userId: actor.userId, agentId: actor.agentId });
    return { ...saved, assetId: id, clipId: made.clipId, start: made.start, creditsCharged: estimate };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new StudioError(`The voiceover was made and saved as asset ${id} (${estimate} credits charged), but it was not added to the edit: ${why} Add asset ${id} from the Library.`, "voiceover_not_placed");
  }
}
