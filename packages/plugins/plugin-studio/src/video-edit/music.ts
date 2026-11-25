/**
 * Music (PAR-10256 T2, plan PAR-10138): a prompt becomes an MP3 (Stable Audio), a kind-audio Library asset, and, when it
 * is ready within MUSIC_WAIT_MS, an audio clip at `at`. One `synthesizing` row, one reserve of 1.28 credits (USD 0.08).
 * Money rules (USD 25/month hard cap, Peet-approved PAR-10127): the cap is checked and the reserve written under one
 * lock shared by every company; only `charged: "no"` outcomes are refunded, and only by the call that moves the row out
 * of `synthesizing` (so the stale-row sweeper cannot cause a double refund); `"maybe"` is never refunded.
 * A job that outlives the wait keeps running: a late success is stored in the Library but never placed on the edit.
 * Logs carry the provider `ms` and the outcome code, never the prompt or the key.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { storeAsset, type StoreInput } from "../assets.js";
import { StudioConfig } from "../config.js";
import { table } from "../db.js";
import { StudioError } from "../errors.js";
import { assertFits, assertRunFits, capCheck, currentPeriod, refund, reserve, withCompanyLock, type LedgerTarget } from "../ledger.js";
import type { MusicGenerator } from "../music/stable-audio.js";
import { assertMusicCapFits, MAX_PROMPT_CHARS, MUSIC_DEFAULT_SECONDS, MUSIC_MAX_SECONDS, MUSIC_WAIT_MS, musicCredits, musicUsage, STABLE_AUDIO_USD_PER_GENERATION } from "../music/stable-audio-price.js";
import { musicFor } from "../providers/registry.js";
import { objectUrl } from "../storage.js";
import { applyOpsAction } from "./actions.js";
import { addAudioOps } from "./audio-ops.js";
import { probeMedia, type ProbeResult } from "./probe.js";
import { getVideoEdit } from "./store.js";
import { LIMITS } from "./timeline.js";
import type { VoiceoverActor } from "./voiceover.js";

export interface MusicDeps {
  /** Tests replace it; default: musicFor(config), which needs the Stability key. */
  music?: MusicGenerator;
  store?: (input: StoreInput) => Promise<string>;
  probe?: (r2Key: string) => Promise<ProbeResult>;
  /** Fake clock and sleep for the wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const bad = (message: string): never => {
  throw new StudioError(message, "bad_request");
};

function validate(params: Record<string, unknown>) {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) bad("prompt is required: describe the music you want.");
  if (prompt.length > MAX_PROMPT_CHARS) bad(`prompt is ${prompt.length} characters; music takes at most ${MAX_PROMPT_CHARS}.`);
  const duration = params.duration === undefined || params.duration === null ? MUSIC_DEFAULT_SECONDS : Number(params.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > MUSIC_MAX_SECONDS) bad(`duration must be from 1 to ${MUSIC_MAX_SECONDS} seconds.`);
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  const at = params.at === undefined || params.at === null ? 0 : Number(params.at);
  if (!Number.isFinite(at) || at < 0 || at >= LIMITS.maxDuration) bad(`at must be a time in seconds from 0 to under ${LIMITS.maxDuration}.`);
  return { prompt, duration, base, at, editId: String(params.editId ?? "").trim() };
}

type JobResult = { ok: true; assetId: string } | { ok: false; error: StudioError };

const usd = STABLE_AUDIO_USD_PER_GENERATION.toFixed(2);

/** `video-edit-music`: makes music from `prompt` and puts it on the audio track at `at`, at the revision you read. */
export async function musicAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: VoiceoverActor, deps: MusicDeps = {}) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms).unref?.()));
  const t0 = now();
  const v = validate(params);
  const edit = await getVideoEdit(ctx, companyId, v.editId);
  if (edit.revision !== v.base) throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  const config = new StudioConfig(ctx, companyId);
  const music = deps.music ?? (await musicFor(config, params.provider)); // no key: not_configured here, nothing written
  const estimate = musicCredits();
  const scope: ClientScope = edit.client ? ({ kind: edit.client.kind, id: edit.client.id } as ClientScope) : null;
  const id = randomUUID();
  const period = currentPeriod();
  const ledger: LedgerTarget = { generationId: id, companyId, clientKind: edit.client?.kind ?? null, clientRef: edit.client?.id ?? null, period };
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 200) : `Music: ${edit.title}`.slice(0, 200);

  // The music lock is shared by every company: one Stability account, one cap.
  await withCompanyLock(companyId, () =>
    withCompanyLock("music:stability", async () => {
      assertMusicCapFits(await musicUsage(ctx, period), estimate);
      assertFits(await capCheck(ctx, companyId, scope, period), estimate);
      if (actor.runId) await assertRunFits(ctx, companyId, actor.runId, estimate, actor.agentId);
      await ctx.db.execute(
        `INSERT INTO ${table(ctx, "generations")} (id, group_id, company_id, client_kind, client_ref, client_name, project_id, issue_id, agent_id, run_id, user_id, provider, model, prompt, params, name, status, period, estimated_credits)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'stability', $11, $12, $13::jsonb, $14, 'synthesizing', $15, $16)`,
        [id, companyId, ledger.clientKind, ledger.clientRef, edit.client?.name ?? null, edit.projectId, actor.issueId ?? null, actor.agentId ?? null, actor.runId ?? null, actor.userId ?? null, music.model, v.prompt, JSON.stringify({ editId: edit.id, duration: v.duration, at: v.at, licence: "stability-community" }), name, period, estimate],
      );
      await reserve(ctx, ledger, estimate);
    }),
  );

  const settle = (status: "succeeded" | "failed", fields: string, values: unknown[]) =>
    ctx.db.execute(`UPDATE ${table(ctx, "generations")} SET status = '${status}', ${fields}, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'synthesizing'`, [id, ...values]);
  const log = (outcome: string, ms: number | null) => ctx.logger.info("studio.music", { generationId: id, outcome, ms });

  // Never rejects: a late failure must not become an unhandled rejection.
  const job: Promise<JobResult> = (async (): Promise<JobResult> => {
    try {
      const made = await music.generate({ prompt: v.prompt, duration: v.duration });
      if (!made.ok) {
        const moved = await settle("failed", "error_code = $2, error_message = $3", [made.code, made.message.slice(0, 500)]);
        const refunded = made.charged === "no" && Boolean(moved.rowCount);
        if (refunded) await refund(ctx, ledger, estimate);
        log(made.code, made.ms);
        return { ok: false, error: new StudioError(`${made.message} ${refunded ? "Nothing was charged." : "It may have been charged."}`, made.code) };
      }
      try {
        const store = deps.store ?? ((input: StoreInput) => storeAsset(ctx, config, input));
        await store({ id, companyId, scope, clientName: edit.client?.name ?? null, projectId: edit.projectId, issueId: actor.issueId ?? null, name, source: "generated", sourceRef: `generation:${id}`, generationId: id, agentId: actor.agentId ?? null, userId: actor.userId ?? null, bytes: new Uint8Array(made.audio), mime: made.mime });
      } catch {
        const message = `The music was made (USD ${usd} charged) but could not be saved: charged, not saved. Try again later.`;
        await settle("failed", "error_code = $2, error_message = $3", ["store_failed", message]); // no refund: the provider billed
        log("store_failed", made.ms);
        return { ok: false, error: new StudioError(message, "store_failed") };
      }
      await settle("succeeded", "asset_id = $1, actual_credits = $2", [estimate]);
      log("succeeded", made.ms);
      return { ok: true, assetId: id };
    } catch (error) {
      // The ledger or the database failed: the row stays `synthesizing` and the sweeper fails it without a refund.
      log("job_error", null);
      return { ok: false, error: new StudioError(`Music failed unexpectedly. It may have been charged. ${error instanceof StudioError ? error.message : ""}`.trim(), "music_failed") };
    }
  })();

  const wait = Math.max(0, t0 + MUSIC_WAIT_MS - now());
  const first = await Promise.race([job, sleep(wait).then(() => null)]);
  if (first === null) {
    return { status: "synthesizing" as const, generationId: id, message: "Still making the music. It will be in the Library in a minute or two; add it with Add audio. Don't start it again." };
  }
  if (!first.ok) throw first.error;

  try {
    const probe = deps.probe ?? (async (key: string) => probeMedia(objectUrl(await config.bucket(), companyId, "GET", key, 600)));
    const rows = await ctx.db.query<{ r2_key: string }>(`SELECT r2_key FROM ${table(ctx, "asset_versions")} WHERE asset_id = $1 AND version = 1`, [id]);
    const length = (await probe(rows[0]?.r2_key ?? "")).durationSec;
    const made = addAudioOps(edit.doc, { id, version: 1, seconds: length }, v.at);
    if ("error" in made) throw new StudioError(made.error, "no_room");
    const saved = await applyOpsAction(ctx, companyId, { editId: edit.id, baseRevision: v.base, ops: made.ops }, { userId: actor.userId, agentId: actor.agentId });
    return { ...saved, status: "succeeded" as const, assetId: id, clipId: made.clipId, start: made.start, creditsCharged: estimate, usdCharged: STABLE_AUDIO_USD_PER_GENERATION };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new StudioError(`The music was made and saved as asset ${id}, USD ${usd} charged, but it was not added to the edit: ${why} Add asset ${id} from the Library.`, "music_not_placed");
  }
}
