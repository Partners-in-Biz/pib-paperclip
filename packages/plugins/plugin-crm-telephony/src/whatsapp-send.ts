import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { TwilioClient } from "./twilio-client.js";
import { normalizeE164 } from "./phone.js";
import { writeAudit } from "./audit.js";
import { isWindowOpen } from "./wa-window.js";
import type { TelephonySettings } from "./settings.js";

export type SendOutcome =
  | { sent: true; messageId: string; providerMsgId: string }
  | { sent: false; reason:
      | "disabled"
      | "bad_number"
      | "opted_out"
      | "cap_reached"
      | "bad_body"
      | "window_closed_template_required"
      | "template_not_approved"
      | "send_failed"
      | "unknown_outcome"
    ; failureKind?: string
    };

export interface SendWhatsappInput {
  companyId: string;
  userId: string;
  contactId: string | null;
  toE164: string;
  kind: "service" | "marketing";
  body?: string;
  templateId?: string;
  variables?: Record<string, string>;
}

export interface SendWhatsappDeps {
  db: PluginDatabaseClient;
  namespace: string;
  client: TwilioClient;
  settings: TelephonySettings;
  fromWhatsapp: string;
  statusCallbackUrl?: string;
  now?: () => Date;
}

/**
 * Send a WhatsApp message via Twilio.
 * Enforces all validation rules in order.
 */
export async function sendWhatsapp(
  deps: SendWhatsappDeps,
  input: SendWhatsappInput
): Promise<SendOutcome> {
  const now = deps.now ?? (() => new Date());
  const currentTime = now();

  // Rule 1: Check if WhatsApp is enabled
  if (!deps.settings.whatsappEnabled) {
    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send.blocked",
      contactId: input.contactId,
      detail: { reason: "disabled" },
    });
    return { sent: false, reason: "disabled" };
  }

  // Rule 2: Validate phone number
  const normalizedTo = normalizeE164(input.toE164);
  if (!normalizedTo) {
    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send.blocked",
      contactId: input.contactId,
      detail: { reason: "bad_number" },
    });
    return { sent: false, reason: "bad_number" };
  }

  // Rule 3: Check opt-out preferences
  const prefResult = await deps.db.query<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM ${deps.namespace}.tel_contact_prefs
       WHERE company_id = $1
         AND contact_id = $2
         AND (wa_opt_out_at IS NOT NULL OR erased_at IS NOT NULL)
     ) as found`,
    [input.companyId, input.contactId]
  );

  if (prefResult[0]?.found) {
    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send.blocked",
      contactId: input.contactId,
      detail: { reason: "opted_out" },
    });
    return { sent: false, reason: "opted_out" };
  }

  // Rule 4: Check daily cap
  const dayStartSql = `date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3`;
  const dayEndSql = `${dayStartSql} + interval '1 day'`;
  const capResult = await deps.db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM ${deps.namespace}.tel_messages
     WHERE company_id = $1
       AND channel = 'whatsapp'
       AND direction = 'outbound'
       AND created_at >= ${dayStartSql}
       AND created_at < ${dayEndSql}`,
    [input.companyId, currentTime.toISOString(), deps.settings.allowedHours.timezone]
  );

  const messageCount = capResult[0]?.count ?? 0;
  if (messageCount >= deps.settings.maxWhatsappPerDay) {
    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send.blocked",
      contactId: input.contactId,
      detail: { reason: "cap_reached" },
    });
    return { sent: false, reason: "cap_reached" };
  }

  // Rule 5: Check messaging window and template requirements
  const windowOpen = await isWindowOpen(
    deps.db,
    deps.namespace,
    input.companyId,
    normalizedTo,
    currentTime
  );

  let templateId: string | null = null;
  let contentSid: string | null = null;

  if (!windowOpen) {
    // Window closed: template REQUIRED
    if (!input.templateId) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "window_closed_template_required" },
      });
      return { sent: false, reason: "window_closed_template_required" };
    }

    // Validate template UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(input.templateId)) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "template_not_approved" },
      });
      return { sent: false, reason: "template_not_approved" };
    }

    // Template lookup: must exist, be approved, and have content SID
    const templateResult = await deps.db.query<{ id: string; twilio_content_sid: string }>(
      `SELECT id, twilio_content_sid FROM ${deps.namespace}.tel_templates
       WHERE id = $1::uuid
         AND company_id = $2
         AND channel = 'whatsapp'
         AND approved = true
         AND twilio_content_sid IS NOT NULL`,
      [input.templateId, input.companyId]
    );

    if (templateResult.length === 0) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "template_not_approved" },
      });
      return { sent: false, reason: "template_not_approved" };
    }

    templateId = templateResult[0].id;
    contentSid = templateResult[0].twilio_content_sid;
  } else if (input.templateId) {
    // Window open with explicit template: also allowed
    // Validate template UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(input.templateId)) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "template_not_approved" },
      });
      return { sent: false, reason: "template_not_approved" };
    }

    // Template lookup
    const templateResult = await deps.db.query<{ id: string; twilio_content_sid: string }>(
      `SELECT id, twilio_content_sid FROM ${deps.namespace}.tel_templates
       WHERE id = $1::uuid
         AND company_id = $2
         AND channel = 'whatsapp'
         AND approved = true
         AND twilio_content_sid IS NOT NULL`,
      [input.templateId, input.companyId]
    );

    if (templateResult.length === 0) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "template_not_approved" },
      });
      return { sent: false, reason: "template_not_approved" };
    }

    templateId = templateResult[0].id;
    contentSid = templateResult[0].twilio_content_sid;
  } else {
    // Window open, no template: freeform body allowed
    const bodyTrimmed = (input.body ?? "").trim();
    const bodyLength = bodyTrimmed.length;

    if (bodyLength === 0 || bodyLength > 1600) {
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.blocked",
        contactId: input.contactId,
        detail: { reason: "bad_body" },
      });
      return { sent: false, reason: "bad_body" };
    }
  }

  // Claim: Create the tel_messages row with pending SID.
  // Note: A status webhook that lands before the SID UPDATE is a no-op (accepted: rank logic keeps later statuses).
  const messageId = randomUUID();
  const pendingSid = `pending:${messageId}`;

  await deps.db.execute(
    `INSERT INTO ${deps.namespace}.tel_messages
       (id, company_id, channel, direction, provider_msg_id, contact_id, from_e164, to_e164,
        body, template_id, kind, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      messageId,
      input.companyId,
      "whatsapp",
      "outbound",
      pendingSid,
      input.contactId || null,
      stripWhatsappPrefix(deps.fromWhatsapp),
      normalizedTo,
      contentSid ? null : (input.body ?? "").trim(),
      templateId ? templateId : null,
      input.kind,
      "queued",
      currentTime.toISOString(),
    ]
  );

  // Execute: Send the message via Twilio
  const sendInput = {
    from: addWhatsappPrefix(stripWhatsappPrefix(deps.fromWhatsapp)),
    to: addWhatsappPrefix(normalizedTo),
    statusCallback: deps.statusCallbackUrl,
    ...(contentSid
      ? { contentSid, contentVariables: input.variables }
      : { body: (input.body ?? "").trim() }),
  };

  let sendResult;
  try {
    sendResult = await deps.client.sendMessage(sendInput);
  } catch (err) {
    // Timeout or unexpected error: audit as unknown, don't mark failed
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send.unknown",
      contactId: input.contactId,
      detail: { messageId, templateId: templateId || undefined, reason: errorMsg },
    });
    return { sent: false, reason: "unknown_outcome" };
  }

  // Process result: Update row and audit
  if (sendResult.ok) {
    // Success: update with real SID and status from Twilio
    const mappedStatus = mapTwilioStatus(sendResult.value.status);

    await deps.db.execute(
      `UPDATE ${deps.namespace}.tel_messages
       SET provider_msg_id = $1, status = $2, updated_at = now()
       WHERE id = $3 AND company_id = $4`,
      [sendResult.value.sid, mappedStatus, messageId, input.companyId]
    );

    await writeAudit(deps.db, deps.namespace, {
      companyId: input.companyId,
      userId: input.userId,
      action: "wa.send",
      contactId: input.contactId,
      detail: {
        messageId,
        providerMsgId: sendResult.value.sid,
        templateId: templateId || undefined,
        kind: input.kind,
      },
    });

    return {
      sent: true,
      messageId,
      providerMsgId: sendResult.value.sid,
    };
  } else {
    // Failure: mark row as failed and audit
    const failure = sendResult.failure;

    if (failure.kind === "timeout" || failure.kind === "unknown") {
      // Don't mark as failed; message may have been sent
      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.unknown",
        contactId: input.contactId,
        detail: {
          messageId,
          templateId: templateId || undefined,
          kind: failure.kind,
          status: failure.status,
          code: failure.code,
        },
      });
    } else {
      // Mark as failed
      await deps.db.execute(
        `UPDATE ${deps.namespace}.tel_messages
         SET status = $1, updated_at = now()
         WHERE id = $2 AND company_id = $3`,
        ["failed", messageId, input.companyId]
      );

      await writeAudit(deps.db, deps.namespace, {
        companyId: input.companyId,
        userId: input.userId,
        action: "wa.send.failed",
        contactId: input.contactId,
        detail: {
          messageId,
          templateId: templateId || undefined,
          kind: failure.kind,
          status: failure.status,
          code: failure.code,
        },
      });

      // Only return bad_number for invalid-recipient codes
      if (failure.code === 21211 || failure.code === 21614) {
        return { sent: false, reason: "bad_number" };
      }

      return { sent: false, reason: "send_failed", failureKind: failure.kind };
    }

    return { sent: false, reason: "unknown_outcome" };
  }
}

/**
 * Map Twilio message status to app vocabulary.
 */
function mapTwilioStatus(twilioStatus: string): string {
  // Twilio status: accepted, scheduled, sending, sent, delivered, read, failed, undelivered
  // Map to: queued, sent, delivered, read, failed, undelivered
  switch (twilioStatus) {
    case "accepted":
    case "scheduled":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    case "undelivered":
      return "undelivered";
    default:
      // Unknown status -> assume queued
      return "queued";
  }
}

function stripWhatsappPrefix(value: string): string {
  return value.replace(/^whatsapp:/, "");
}

function addWhatsappPrefix(value: string): string {
  if (value.startsWith("whatsapp:")) return value;
  return `whatsapp:${value}`;
}
