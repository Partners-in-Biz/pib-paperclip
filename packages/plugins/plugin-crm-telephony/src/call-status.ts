/**
 * Twilio call status callbacks into `tel_calls`.
 *
 * A call the Dialer places has two legs. The parent leg is Twilio ringing the
 * person's browser (`client:<identity>`); its SID is the `tel_calls.call_sid`
 * written at dial time. The child leg is the contact's phone, created by the
 * `<Dial>` in the inline TwiML; its callbacks carry `ParentCallSid`. The parent
 * leg's `completed` ends the row and emits the CRM note.
 */
import type { PluginContext, PluginWebhookInput, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { buildPublicWebhookUrl, parseFormParams } from "./twilio-signature.js";
import { getPublicBaseUrl, resolveVerifiedCompany } from "./company-resolve.js";
import { insertOnce } from "./idempotency.js";
import { matchContactsByPhone } from "./contact-match.js";
import { emitBareCallNoted } from "./voice-note.js";

export type CallStatusOutcome =
  | "ok"
  | "ignored"
  | "duplicate"
  | "unknown_call"
  | "bad_signature"
  | "missing_secret"
  | "missing_host"
  | "bad_payload";

export const TERMINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;

export interface CallStatusEvent {
  callSid: string;
  parentCallSid: string | null;
  status: string;
  durationSec: number | null;
  from: string | null;
  to: string | null;
  /** Twilio's Direction: inbound, outbound-api, outbound-dial. */
  direction: string | null;
}

export function parseCallStatusParams(params: Record<string, string[]>): CallStatusEvent | null {
  const callSid = params.CallSid?.[0];
  const status = params.CallStatus?.[0]?.toLowerCase();
  if (!callSid || !CALL_SID.test(callSid) || !status) return null;
  const parent = params.ParentCallSid?.[0];
  const durationRaw = params.CallDuration?.[0];
  const duration = durationRaw !== undefined && /^\d+$/.test(durationRaw) ? Number(durationRaw) : null;
  return {
    callSid,
    parentCallSid: parent && CALL_SID.test(parent) ? parent : null,
    status,
    durationSec: duration,
    from: params.From?.[0] ?? null,
    to: params.To?.[0] ?? null,
    direction: params.Direction?.[0]?.toLowerCase() ?? null,
  };
}

export interface CallRowState {
  status: string;
  answered_at: string | Date | null;
  ended_at: string | Date | null;
}

/** What a child-leg (the contact's phone) status does to the parent row. */
export function childPatch(row: CallRowState, status: string): { status?: string; markAnswered?: boolean } | null {
  if (row.ended_at) return null;
  switch (status) {
    case "initiated":
    case "queued":
      return null;
    case "ringing":
      return row.answered_at ? null : { status: "ringing" };
    case "in-progress":
    case "answered":
      return { status: "in-progress", markAnswered: true };
    case "completed":
      return row.answered_at ? { status: "completed" } : null;
    case "busy":
    case "no-answer":
    case "failed":
    case "canceled":
      return { status };
    default:
      return null;
  }
}

/** What a parent-leg (the browser) status does to the row. */
export function parentPatch(
  row: CallRowState,
  status: string,
  durationSec: number | null,
): { status: string; terminal: boolean; durationSec: number | null } | null {
  if (row.ended_at) return null;
  if (TERMINAL_STATUSES.has(status)) {
    // A child-leg verdict (busy, no answer) is more telling than the parent's "completed".
    const childVerdict = ["busy", "no-answer", "failed", "canceled"].includes(row.status);
    const finalStatus = status === "completed" && childVerdict ? row.status : status;
    return { status: finalStatus, terminal: true, durationSec };
  }
  if (status === "queued" || status === "initiated") return null;
  if (status === "ringing") {
    // The browser is ringing; the contact has not been dialled yet.
    return row.status === "initiated" ? { status: "ringing", terminal: false, durationSec: null } : null;
  }
  if (status === "in-progress") {
    // The browser answered; the contact's leg reports its own progress.
    return row.status === "initiated" || row.status === "ringing" ? { status: "connecting", terminal: false, durationSec: null } : null;
  }
  return null;
}

export interface CallStatusDeps {
  now?: () => Date;
  emitNote?: (ctx: PluginContext, namespace: string, callSid: string) => Promise<unknown>;
}

export async function handleCallStatus(
  ctx: PluginContext,
  dbClient: PluginDatabaseClient,
  namespace: string,
  input: PluginWebhookInput,
  pluginId: string,
  deps: CallStatusDeps = {},
): Promise<CallStatusOutcome> {
  const { headers, rawBody } = input;
  const now = deps.now ?? (() => new Date());
  const emitNote = deps.emitNote ?? emitBareCallNoted;

  const baseUrl = getPublicBaseUrl(headers);
  if (!baseUrl) {
    ctx.logger.warn("call-status webhook: could not derive host from headers");
    return "missing_host";
  }
  const webhookUrl = buildPublicWebhookUrl({ baseUrl, pluginId, endpointKey: "call-status" });

  const verified = await resolveVerifiedCompany(ctx, headers, rawBody, webhookUrl);
  if (!verified) {
    ctx.logger.warn("call-status webhook: no TWILIO_AUTH_TOKEN configured for any company");
    return "missing_secret";
  }
  if ("error" in verified) {
    ctx.logger.warn("call-status webhook: signature verification failed", { reason: verified.error });
    return verified.error as CallStatusOutcome;
  }
  const companyId = verified.companyId;

  const event = parseCallStatusParams(parseFormParams(rawBody));
  if (!event) {
    ctx.logger.warn("call-status webhook: malformed CallSid or CallStatus");
    return "bad_payload";
  }

  type Row = CallRowState & { call_sid: string; contact_id: string | null };
  const select = async (callSid: string): Promise<Row | null> => {
    const rows = await dbClient.query<Row>(
      `SELECT call_sid, status, answered_at, ended_at, contact_id FROM ${namespace}.tel_calls WHERE call_sid = $1 AND company_id = $2`,
      [callSid, companyId],
    );
    return rows[0] ?? null;
  };

  // Child leg: the contact's phone. Update the parent row.
  if (event.parentCallSid) {
    const parent = await select(event.parentCallSid);
    if (!parent) {
      ctx.logger.debug("call-status webhook: child leg for an unknown parent", { call_sid: event.callSid });
      return "unknown_call";
    }
    const patch = childPatch(parent, event.status);
    if (!patch) return "ignored";
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [event.parentCallSid, companyId];
    if (patch.status) {
      values.push(patch.status);
      sets.push(`status = $${values.length}`);
    }
    if (patch.markAnswered) {
      values.push(now().toISOString());
      sets.push(`answered_at = COALESCE(answered_at, $${values.length}::timestamptz)`);
    }
    const result = await dbClient.execute(
      `UPDATE ${namespace}.tel_calls SET ${sets.join(", ")} WHERE call_sid = $1 AND company_id = $2 AND ended_at IS NULL`,
      values,
    );
    return result.rowCount > 0 ? "ok" : "duplicate";
  }

  // Parent leg (or a call nobody placed from here, such as an inbound call to the number).
  let row = await select(event.callSid);
  if (!row) {
    const inbound = event.direction === "inbound";
    const from = event.from && E164.test(event.from) ? event.from : null;
    const to = event.to && E164.test(event.to) ? event.to : null;
    if (!inbound || !from || !to) {
      ctx.logger.debug("call-status webhook: status for a call this plugin did not place", { call_sid: event.callSid });
      return "unknown_call";
    }
    const match = await matchContactsByPhone(dbClient, namespace, companyId, from);
    await insertOnce(dbClient, namespace, "call", {
      company_id: companyId,
      contact_id: match.contactId,
      user_id: "unknown",
      direction: "inbound",
      from_e164: from,
      to_e164: to,
      call_sid: event.callSid,
      status: "initiated",
      started_at: now(),
    });
    row = await select(event.callSid);
    if (!row) return "unknown_call";
  }

  const patch = parentPatch(row, event.status, event.durationSec);
  if (!patch) return "ignored";

  if (!patch.terminal) {
    const result = await dbClient.execute(
      `UPDATE ${namespace}.tel_calls SET status = $3, updated_at = now() WHERE call_sid = $1 AND company_id = $2 AND ended_at IS NULL`,
      [event.callSid, companyId, patch.status],
    );
    return result.rowCount > 0 ? "ok" : "duplicate";
  }

  const endedAt = now().toISOString();
  const result = await dbClient.execute(
    `UPDATE ${namespace}.tel_calls
     SET status = $3, ended_at = $4::timestamptz, duration_s = COALESCE($5::int, duration_s), updated_at = now()
     WHERE call_sid = $1 AND company_id = $2 AND ended_at IS NULL`,
    [event.callSid, companyId, patch.status, endedAt, patch.durationSec],
  );
  if (result.rowCount === 0) return "duplicate";

  if (row.contact_id) {
    try {
      const noted = await emitNote(ctx, namespace, event.callSid);
      ctx.logger.debug("call-status webhook: call note", { call_sid: event.callSid, result: noted });
    } catch (err) {
      ctx.logger.warn("call-status webhook: call note failed", { call_sid: event.callSid, error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    ctx.logger.debug("call-status webhook: call ended without a CRM contact; no note", { call_sid: event.callSid });
  }
  return "ok";
}
