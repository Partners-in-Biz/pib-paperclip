/**
 * Place a call from the Dialer.
 *
 * The browser holds a registered Twilio Device. This action asks Twilio (REST
 * `Calls.json`) to ring that Device with inline TwiML that dials the contact
 * from the company's caller ID. The returned parent call SID is the
 * `tel_calls` row; status callbacks update it (call-status.ts).
 */
import type { PluginContext, PluginPerformActionContext, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { readSettings, r2Configured, validatePublicBaseUrl, withSeededNumbers, type TelephonySettings } from "./settings.js";
import { checkVoiceAccess } from "./access.js";
import { normalizeE164 } from "./phone.js";
import { pickCallerNumber } from "./caller-id.js";
import { checkCallingHours } from "./tcpa.js";
import { matchContactsByPhone } from "./contact-match.js";
import { insertOnce } from "./idempotency.js";
import { writeAudit } from "./audit.js";
import { buildDialTwiml } from "./twiml.js";
import { voiceWebhookUrls } from "./voice-readiness.js";
import { createTwilioClient, type HttpFetch, type TwilioClient } from "./twilio-client.js";
import { sanitizeErrorMessage } from "./pipeline.js";
import { NAMESPACE } from "./namespace.js";
import { resolveTelephonySecret } from "./secrets.js";

const CONTACT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/i;

/** Seconds the contact's phone rings before Twilio gives up. */
export const DIAL_TIMEOUT_SECONDS = 30;

export interface VoiceDialParams {
  to: string;
  contactId?: string;
  /** The browser's origin, used only when the company has no public base URL saved. */
  origin?: string;
}

export interface VoiceDialResult {
  callSid: string;
  to: string;
  callerId: string;
  /** The lead's country calling code, digits only ("27", "1"). */
  region: string;
  /** Which number served it and why. */
  numberLabel: string;
  matchedBy: "region" | "default";
  contactId: string | null;
  recording: boolean;
  identity: string;
}

export interface VoiceDialDeps {
  now?: () => Date;
  fetch?: HttpFetch;
  /** Replaces the Twilio client (tests). */
  client?: TwilioClient;
}

function actorForAccess(context: PluginPerformActionContext): PluginApiRequestInput["actor"] {
  return {
    actorType: context.actor.type === "system" ? "agent" : context.actor.type,
    userId: context.actor.userId ?? undefined,
    actorId: context.actor.userId ?? context.actor.agentId ?? "unknown",
    agentId: context.actor.agentId ?? undefined,
  };
}

function localHHMM(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** True when `now` falls inside the company's calling window (start inclusive, end exclusive). */
export function withinAllowedHours(now: Date, hours: TelephonySettings["allowedHours"]): boolean {
  const t = localHHMM(now, hours.timezone);
  return t >= hours.start && t < hours.end;
}

const resolveOptional = (ctx: PluginContext, name: string, companyId: string): Promise<string | null> =>
  resolveTelephonySecret(ctx, companyId, name);


export async function voiceDialAction(
  ctx: PluginContext,
  rawParams: unknown,
  context: PluginPerformActionContext,
  deps: VoiceDialDeps = {},
): Promise<VoiceDialResult> {
  const now = deps.now ?? (() => new Date());
  const { companyId } = context;
  if (!companyId) throw new Error("A company is required");

  const saved = await readSettings(ctx, companyId);
  const access = checkVoiceAccess(actorForAccess(context), saved.voiceAllowedUserIds);
  if (!access.ok) throw new Error(access.error);
  const identity = access.userId;
  const settings = await withSeededNumbers(ctx, companyId, saved);

  const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Partial<VoiceDialParams>;
  const to = typeof params.to === "string" ? normalizeE164(params.to) : null;
  if (!to) throw new Error("Enter a number in international format, like +27 82 123 4567");

  const blocked = async (reason: string, message: string, contactId: string | null): Promise<never> => {
    await writeAudit(ctx.db, NAMESPACE, { companyId, userId: identity, action: "voice.dial.blocked", contactId, detail: { reason, to } });
    throw new Error(message);
  };

  // Contact: the one the page carried, else the CRM contact that owns the number.
  let contactId: string | null = typeof params.contactId === "string" && CONTACT_ID.test(params.contactId.trim()) ? params.contactId.trim() : null;
  if (!contactId) {
    const match = await matchContactsByPhone(ctx.db, NAMESPACE, companyId, to);
    contactId = match.contactId;
  }

  // Hours: the company's window, and US calling hours for +1 numbers.
  const current = now();
  if (!withinAllowedHours(current, settings.allowedHours)) {
    await blocked(
      "outside_allowed_hours",
      `Calls are allowed ${settings.allowedHours.start}-${settings.allowedHours.end} (${settings.allowedHours.timezone}). Change the hours in Telephony settings if this is wrong.`,
      contactId,
    );
  }
  const tcpa = checkCallingHours(to, current);
  if (!tcpa.ok) {
    await blocked("outside_us_calling_hours", "US numbers may only be called between 08:00 and 21:00 in the contact's local time.", contactId);
  }

  // Daily cap, counted on the company's calendar day.
  const dayStart = `date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3`;
  const capRows = await ctx.db.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM ${NAMESPACE}.tel_calls
     WHERE company_id = $1 AND direction = 'outbound'
       AND created_at >= ${dayStart} AND created_at < ${dayStart} + interval '1 day'`,
    [companyId, current.toISOString(), settings.allowedHours.timezone],
  );
  const todayCount = Number(capRows[0]?.count ?? 0);
  if (todayCount >= settings.maxCallsPerDay) {
    await blocked("cap_reached", `The daily cap of ${settings.maxCallsPerDay} calls is reached. Raise Max calls in Telephony settings if needed.`, contactId);
  }

  // Caller ID: the company number that serves the lead's country, else the default (Numbers in Telephony settings).
  const pick = pickCallerNumber(to, settings.numbers, "voice");
  if (!pick.ok) {
    await blocked(pick.reason === "no_numbers" ? "caller_id_not_configured" : "no_number_for_region", pick.message, contactId);
    throw new Error("unreachable");
  }

  // Where Twilio reports status: the saved public base URL, else the browser's origin.
  const baseUrl = settings.publicBaseUrl ?? (typeof params.origin === "string" ? validatePublicBaseUrl(params.origin) : null);
  if (!baseUrl) {
    throw new Error("Set the public base URL in Telephony settings so Twilio can report call status to this Paperclip.");
  }
  const urls = voiceWebhookUrls(baseUrl);

  // Credentials.
  const accountSid = await resolveOptional(ctx, "TWILIO_ACCOUNT_SID", companyId);
  const authToken = await resolveOptional(ctx, "TWILIO_AUTH_TOKEN", companyId);
  if (!accountSid || !authToken) throw new Error("Twilio voice credentials are not configured");

  // Recording: on when the company switched it on, storage exists, and the contact did not opt out.
  let record = false;
  if (settings.recordingEnabled) {
    let raw: Record<string, unknown> = {};
    try {
      const cfg = await ctx.config.get(companyId);
      raw = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
    } catch {
      raw = {};
    }
    record = r2Configured(raw);
    if (record && contactId) {
      const prefs = await ctx.db.query<{ do_not_record: boolean }>(
        `SELECT do_not_record FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
        [companyId, contactId],
      );
      if (prefs[0]?.do_not_record) record = false;
    }
  }

  const twiml = buildDialTwiml({
    to,
    callerId: pick.callerId,
    record,
    recordingStatusCallbackUrl: urls.recordingStatus,
    statusCallbackUrl: urls.callStatus,
    timeoutSeconds: DIAL_TIMEOUT_SECONDS,
  });

  const client = deps.client ?? createTwilioClient({ accountSid, authToken, fetch: deps.fetch ?? ctx.http.fetch });
  const created = await client.createCall({
    to: `client:${identity}`,
    from: pick.callerId,
    twiml,
    statusCallback: urls.callStatus,
    statusCallbackEvents: ["initiated", "ringing", "answered", "completed"],
    timeoutSeconds: 20,
  });
  if (!created.ok) {
    await writeAudit(ctx.db, NAMESPACE, {
      companyId, userId: identity, action: "voice.dial.failed", contactId,
      detail: { kind: created.failure.kind, status: created.failure.status, code: created.failure.code, to },
    });
    throw new Error(`Twilio refused the call: ${sanitizeErrorMessage(created.failure.error)}`);
  }

  await insertOnce(ctx.db, NAMESPACE, "call", {
    company_id: companyId,
    contact_id: contactId,
    user_id: identity,
    direction: "outbound",
    from_e164: pick.callerId,
    to_e164: to,
    call_sid: created.value.sid,
    status: "initiated",
    started_at: current,
    recorded: record,
  });

  await writeAudit(ctx.db, NAMESPACE, {
    companyId, userId: identity, action: "voice.dial", contactId,
    detail: { callSid: created.value.sid, callingCode: pick.callingCode, callerId: pick.callerId, matchedBy: pick.matchedBy, recorded: record },
  });

  return {
    callSid: created.value.sid, to, callerId: pick.callerId, region: pick.callingCode, numberLabel: pick.number.label, matchedBy: pick.matchedBy,
    contactId, recording: record, identity,
  };
}

export interface VoiceCallView {
  callSid: string;
  status: string;
  direction: string;
  to: string;
  from: string;
  contactId: string | null;
  recorded: boolean;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
}

/** The Dialer polls this while a call runs: one row, the caller's own company only. */
export async function voiceCallLookupAction(
  ctx: PluginContext,
  rawParams: unknown,
  context: PluginPerformActionContext,
): Promise<VoiceCallView | null> {
  const { companyId } = context;
  if (!companyId) throw new Error("A company is required");
  const settings = await readSettings(ctx, companyId);
  const access = checkVoiceAccess(actorForAccess(context), settings.voiceAllowedUserIds);
  if (!access.ok) throw new Error(access.error);

  const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as { callSid?: unknown };
  const callSid = typeof params.callSid === "string" ? params.callSid.trim() : "";
  if (!CALL_SID.test(callSid)) throw new Error("callSid is required");

  const rows = await ctx.db.query<{
    call_sid: string; status: string; direction: string; to_e164: string; from_e164: string; contact_id: string | null;
    recorded: boolean; started_at: string | Date | null; answered_at: string | Date | null; ended_at: string | Date | null; duration_s: number | null;
  }>(
    `SELECT call_sid, status, direction, to_e164, from_e164, contact_id, recorded, started_at, answered_at, ended_at, duration_s
     FROM ${NAMESPACE}.tel_calls WHERE call_sid = $1 AND company_id = $2`,
    [callSid, companyId],
  );
  const row = rows[0];
  if (!row) return null;
  const iso = (v: string | Date | null): string | null => (v ? new Date(v).toISOString() : null);
  return {
    callSid: row.call_sid,
    status: row.status,
    direction: row.direction,
    to: row.to_e164,
    from: row.from_e164,
    contactId: row.contact_id,
    recorded: row.recorded,
    startedAt: iso(row.started_at),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    durationSec: row.duration_s,
  };
}
