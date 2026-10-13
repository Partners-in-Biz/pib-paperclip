/**
 * Subscribes to call.noted events from the CRM Telephony plugin.
 * Writes idempotent call activity notes and emits activity.logged ack events.
 */

import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { asRecord } from "./db.js";
import { getActivityIdBySourceKey, insertActivityOnce, getContact } from "./db.js";

const TELEPHONY_PLUGIN_ID = "partnersinbiz.crm-telephony";
const CALL_NOTED_EVENT = "call.noted";
const ACK_EVENT_NAME = "activity.logged";

export interface CallNotedPayload {
  companyId: string;
  contactId: string;
  callSid: string;
  summary: string | null;
  nextActions: string[];
  transcript: string;
  durationSec: number | null;
  recordingUrl: string | null;
  language: string;
}

/**
 * Parse and validate call.noted event payload defensively.
 * Returns null if payload is malformed.
 */
export function parseCallNoted(raw: unknown): CallNotedPayload | null {
  const payload = asRecord(raw);

  const companyId = typeof payload.companyId === "string" ? payload.companyId : null;
  const contactId = typeof payload.contactId === "string" ? payload.contactId : null;
  const callSid = typeof payload.callSid === "string" ? payload.callSid : null;
  const summary = payload.summary === null || typeof payload.summary === "string" ? payload.summary : null;
  const transcript = typeof payload.transcript === "string" ? payload.transcript : "";
  const durationSec = typeof payload.durationSec === "number" && payload.durationSec >= 0 ? payload.durationSec : null;
  const recordingUrl = payload.recordingUrl === null || typeof payload.recordingUrl === "string" ? payload.recordingUrl : null;
  const language = typeof payload.language === "string" ? payload.language : "unknown";

  const nextActions = Array.isArray(payload.nextActions)
    ? payload.nextActions.filter((item) => typeof item === "string")
    : [];

  if (!companyId || !contactId || !callSid) {
    return null;
  }

  return {
    companyId,
    contactId,
    callSid,
    summary,
    nextActions,
    transcript,
    durationSec,
    recordingUrl,
    language,
  };
}

/**
 * Build call note body from payload.
 * Uses summary if present, otherwise truncated transcript.
 */
export function buildCallNoteBody(payload: CallNotedPayload): string {
  let body = "";

  if (payload.summary) {
    body = payload.summary;
  } else if (payload.transcript) {
    // Truncate to 4000 chars with trailing marker
    const maxLen = 4000;
    body = payload.transcript.length > maxLen
      ? payload.transcript.slice(0, maxLen - 1) + "…"
      : payload.transcript;
  }

  if (payload.nextActions.length > 0) {
    const actionsList = payload.nextActions
      .filter((action) => action && action.trim())
      .map((action) => `• ${action.trim()}`)
      .join("\n");

    if (actionsList) {
      body = body ? `${body}\n\nNext actions:\n${actionsList}` : `Next actions:\n${actionsList}`;
    }
  }

  return body || "";
}

/**
 * Handle call.noted event: write idempotent call activity and emit ack.
 */
async function onCallNoted(ctx: PluginContext, event: PluginEvent, payload: CallNotedPayload): Promise<void> {
  const { companyId, contactId, callSid, summary, nextActions, transcript, durationSec, recordingUrl, language } = payload;

  // Verify event company matches payload company
  if (event.companyId !== companyId) {
    ctx.logger.warn("CRM call.noted event company mismatch", {
      eventCompanyId: event.companyId,
      payloadCompanyId: companyId,
    });
    return;
  }

  // Check if contact exists and is not erased
  const contact = await getContact(ctx, contactId);
  if (!contact) {
    ctx.logger.info("CRM call.noted contact not found or erased", { contactId, companyId });
    return;
  }

  // Build call note body
  const body = buildCallNoteBody(payload);
  if (!body) {
    ctx.logger.warn("CRM call.noted empty body", { callSid, contactId });
    return;
  }

  const sourceKey = `telephony:call:${callSid}`;

  // Insert activity idempotently
  await insertActivityOnce(ctx, {
    companyId,
    recordType: "contact",
    recordId: contactId,
    kind: "call",
    body,
    sourceKey,
    meta: {
      callSid,
      durationSec,
      recordingUrl,
      language,
      source: "telephony",
    },
  });

  // Look up activity ID (works whether insert was new or deduped)
  const activityId = await getActivityIdBySourceKey(ctx, companyId, sourceKey);
  if (!activityId) {
    ctx.logger.error("CRM call.noted activity not found after insert", { sourceKey, callSid });
    return;
  }

  // Emit ack event
  ctx.events.emit(ACK_EVENT_NAME, companyId, {
    companyId,
    sourceKey,
    activityId,
  });
}

/**
 * Register the call.noted subscriber (call once in worker setup).
 */
export function registerCallNotedSubscriber(ctx: PluginContext): void {
  const eventName = pluginEvent(TELEPHONY_PLUGIN_ID, CALL_NOTED_EVENT);

  ctx.events.on(eventName, async (event: PluginEvent) => {
    if (!event.companyId) return;

    const payload = parseCallNoted(event.payload);
    if (!payload) {
      ctx.logger.warn("CRM call.noted malformed payload", { payload: event.payload });
      return;
    }

    try {
      await onCallNoted(ctx, event, payload);
    } catch (error) {
      ctx.logger.warn("CRM call.noted failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
