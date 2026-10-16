import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { PipelineStep } from "./pipeline.js";
import { pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "./namespace.js";

export const NOTE_EVENT = "call.noted";
export const CRM_ACK_EVENT = pluginEvent("partnersinbiz.crm", "activity.logged");
export const MAX_NOTE_TRANSCRIPT_CHARS = 20000;
export const NOTE_REEMIT_AFTER_MS = 10 * 60 * 1000;
export const NOTE_MAX_EMITS = 6;

let lastGaveUp = 0;

interface CallNotedPayload {
  companyId: string;
  contactId: string;
  callSid: string;
  summary: string | null;
  nextActions: string[];
  transcript: string;
  durationSec: number | null;
  recordingUrl: null;
  language: string;
  consent: { noticePlayed: boolean };
}

export async function emitCallNoted(
  ctx: PluginContext,
  namespace: string,
  callSid: string,
  now?: Date,
): Promise<"emitted" | "no_contact" | "erased" | "missing"> {
  const timestamp = now ?? new Date();

  const transcriptRows = await ctx.db.query<{
    id: string;
    recording_id: string;
    text: string;
    summary: string | null;
    next_actions: { items: string[] } | null;
    language: string | null;
  }>(
    `SELECT id, recording_id, text, summary, next_actions, language FROM ${namespace}.tel_transcripts WHERE call_sid = $1`,
    [callSid],
  );
  if (transcriptRows.length === 0) return "missing";

  const transcript = transcriptRows[0];
  const callRows = await ctx.db.query<{
    company_id: string;
    contact_id: string | null;
    duration_s: number | null;
    consent_notice_played: boolean;
  }>(
    `SELECT company_id, contact_id, duration_s, consent_notice_played FROM ${namespace}.tel_calls WHERE call_sid = $1`,
    [callSid],
  );
  if (callRows.length === 0) return "missing";

  const call = callRows[0];
  if (!call.contact_id) return "no_contact";

  const prefRows = await ctx.db.query<{ erased_at: string | null; language: string | null }>(
    `SELECT erased_at, language FROM ${namespace}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
    [call.company_id, call.contact_id],
  );
  const prefs = prefRows[0] ?? null;
  if (prefs?.erased_at) return "erased";

  const language = prefs?.language || transcript.language || "en";
  const nextActionsJson = transcript.next_actions;
  let nextActions: string[] = [];
  if (nextActionsJson) {
    if (Array.isArray(nextActionsJson)) {
      // Plain array of strings
      nextActions = nextActionsJson.filter((item: unknown): item is string => typeof item === "string");
    } else if (typeof nextActionsJson === "object" && nextActionsJson !== null && "items" in nextActionsJson) {
      // Object with items property (e.g., from summarise.ts)
      const items = (nextActionsJson as Record<string, unknown>).items;
      if (Array.isArray(items)) {
        nextActions = items.filter((item: unknown): item is string => typeof item === "string");
      }
    }
  }

  const payload: CallNotedPayload = {
    companyId: call.company_id,
    contactId: call.contact_id,
    callSid,
    summary: transcript.summary,
    nextActions,
    transcript: transcript.text.length > MAX_NOTE_TRANSCRIPT_CHARS ? transcript.text.slice(0, MAX_NOTE_TRANSCRIPT_CHARS) : transcript.text,
    durationSec: call.duration_s,
    recordingUrl: null,
    language,
    consent: { noticePlayed: call.consent_notice_played },
  };

  await ctx.events.emit(NOTE_EVENT, call.company_id, payload);

  const updateResult = await ctx.db.execute(
    `UPDATE ${namespace}.tel_transcripts SET note_status = CASE WHEN note_status='acked' THEN 'acked' ELSE 'emitted' END, note_emitted_at = $1, note_emits = note_emits + 1 WHERE call_sid = $2`,
    [timestamp.toISOString(), callSid],
  );
  return updateResult.rowCount === 0 ? "missing" : "emitted";
}

export function makeNoteStep(): PipelineStep {
  return async (sc) => {
    const result = await emitCallNoted(sc.ctx, sc.namespace, sc.row.call_sid);
    if (result === "missing") sc.ctx.logger.warn(`Call transcript missing for recording ${sc.row.recording_sid}`);
    return { state: result === "erased" ? "erased" : "noted" };
  };
}

export function registerNoteAck(ctx: PluginContext): void {
  ctx.events.on(CRM_ACK_EVENT, async (event: PluginEvent) => {
    const p = event.payload;
    if (typeof p !== "object" || !p) return ctx.logger.debug("Malformed ack payload");

    const { companyId, sourceKey, activityId } = p as Record<string, unknown>;
    if (typeof companyId !== "string" || typeof sourceKey !== "string" || typeof activityId !== "string") {
      return ctx.logger.debug("Missing ack fields");
    }

    if (!sourceKey.startsWith("telephony:call:")) return ctx.logger.debug("Invalid sourceKey");
    const callSid = sourceKey.slice("telephony:call:".length);
    if (!callSid) return ctx.logger.debug("Empty callSid");

    const updateResult = await ctx.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts t SET crm_activity_id = $1, note_status='acked'
       FROM ${NAMESPACE}.tel_calls c
       WHERE t.call_sid = c.call_sid AND c.call_sid = $2 AND c.company_id = $3`,
      [activityId, callSid, companyId],
    );
    if (updateResult.rowCount > 0) ctx.logger.debug(`Acked call note: ${callSid}`);
  });
}

export async function sweepUnackedNotes(
  ctx: PluginContext,
  namespace: string,
  now?: Date,
): Promise<{ reemitted: number; gaveUp: number }> {
  const timestamp = now ?? new Date();
  const reemitThreshold = new Date(timestamp.getTime() - NOTE_REEMIT_AFTER_MS);

  const rows = await ctx.db.query<{ call_sid: string; note_emits: number }>(
    `SELECT call_sid, note_emits FROM ${namespace}.tel_transcripts
     WHERE note_status='emitted' AND note_emitted_at < $1 AND note_emits < $2 LIMIT 20`,
    [reemitThreshold.toISOString(), NOTE_MAX_EMITS],
  );

  let reemitted = 0;
  for (const row of rows) {
    try {
      if (await emitCallNoted(ctx, namespace, row.call_sid, timestamp) === "emitted") reemitted++;
    } catch (err) {
      ctx.logger.debug(`Failed to re-emit call note ${row.call_sid}: ${err}`);
    }
  }

  const gaveUpRows = await ctx.db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${namespace}.tel_transcripts WHERE note_status='emitted' AND note_emits >= $1`,
    [NOTE_MAX_EMITS],
  );
  const gaveUp = gaveUpRows[0]?.count ?? 0;
  if (gaveUp > 0 && gaveUp !== lastGaveUp) {
    ctx.logger.warn(`${gaveUp} unacked notes exceeded max re-emit attempts`);
    lastGaveUp = gaveUp;
  }

  return { reemitted, gaveUp };
}
