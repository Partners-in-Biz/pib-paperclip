/**
 * The CRM note for a call that has no transcript: the pipeline's `call.noted`
 * with an empty transcript, a one-line factual summary and the duration, so
 * the CRM timeline shows the call and the sales desk counts it the moment the
 * call ends. A later transcript note for the same call deduplicates on the CRM
 * side by call SID.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NOTE_EVENT } from "./note.js";

export interface CallRowForNote {
  company_id: string;
  contact_id: string | null;
  direction: string;
  status: string;
  from_e164: string;
  to_e164: string;
  duration_s: number | null;
  answered_at: string | Date | null;
  ended_at: string | Date | null;
  recorded: boolean;
  consent_notice_played: boolean;
}

function toDate(value: string | Date | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seconds the contact was on the line: ended minus answered, else Twilio's duration when the call was answered. */
export function talkSeconds(row: Pick<CallRowForNote, "answered_at" | "ended_at" | "duration_s" | "status">): number | null {
  const answered = toDate(row.answered_at);
  const ended = toDate(row.ended_at);
  if (answered && ended) return Math.max(0, Math.round((ended.getTime() - answered.getTime()) / 1000));
  if (row.status === "completed" && typeof row.duration_s === "number") return Math.max(0, row.duration_s);
  return null;
}

export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return mins ? `${h} h ${mins} min` : `${h} h`;
}

/** One factual line for the CRM activity body. Never includes transcript text. */
export function describeCallOutcome(row: CallRowForNote): string {
  const who = row.direction === "inbound" ? `Inbound call from ${row.from_e164}` : `Outbound call to ${row.to_e164}`;
  const answered = Boolean(toDate(row.answered_at));
  let outcome: string;
  switch (row.status) {
    case "completed": {
      const talk = talkSeconds(row);
      outcome = answered || (talk ?? 0) > 0 ? `answered, ${formatSeconds(talk ?? 0)}` : "ended before anyone answered";
      break;
    }
    case "busy": outcome = "busy"; break;
    case "no-answer": outcome = "no answer"; break;
    case "failed": outcome = "failed to connect"; break;
    case "canceled": outcome = "cancelled before it connected"; break;
    default: outcome = row.status;
  }
  const tail = row.recorded ? "Recorded." : "No recording.";
  return `${who}, ${outcome}. ${tail}`;
}

export async function emitBareCallNoted(
  ctx: PluginContext,
  namespace: string,
  callSid: string,
): Promise<"emitted" | "no_contact" | "erased" | "missing"> {
  const rows = await ctx.db.query<CallRowForNote>(
    `SELECT company_id, contact_id, direction, status, from_e164, to_e164, duration_s, answered_at, ended_at, recorded, consent_notice_played
     FROM ${namespace}.tel_calls WHERE call_sid = $1`,
    [callSid],
  );
  if (rows.length === 0) return "missing";
  const call = rows[0];
  if (!call.contact_id) return "no_contact";

  const prefRows = await ctx.db.query<{ erased_at: string | null; language: string | null }>(
    `SELECT erased_at, language FROM ${namespace}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
    [call.company_id, call.contact_id],
  );
  const prefs = prefRows[0] ?? null;
  if (prefs?.erased_at) return "erased";

  const talk = talkSeconds(call);
  await ctx.events.emit(NOTE_EVENT, call.company_id, {
    companyId: call.company_id,
    contactId: call.contact_id,
    callSid,
    summary: describeCallOutcome(call),
    nextActions: [],
    transcript: "",
    durationSec: talk ?? call.duration_s ?? 0,
    recordingUrl: null,
    language: prefs?.language || "en",
    consent: { noticePlayed: call.consent_notice_played },
  });
  return "emitted";
}
