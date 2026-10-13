import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../idempotency.js";
import { normalizeE164, phoneRegion } from "../phone.js";
import { isWithinMarketingWindow, withOptOutLine } from "./policy.js";
import type {
  SmsSendRequest,
  SmsSendResult,
  SmsTransport,
  SuppressionChecker,
} from "./types.js";
import type { TelephonySettings } from "../settings.js";

export interface SendSmsDeps {
  db: SqlExecutor & { query?(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };
  namespace: string;
  settings: TelephonySettings;
  suppression: SuppressionChecker;
  transport: SmsTransport | null;
  newId: () => string;
}

async function auditRefusal(
  db: SendSmsDeps["db"],
  namespace: string,
  companyId: string,
  reason: string,
  contactId: string | null,
): Promise<void> {
  const auditId = randomUUID();
  const now = new Date().toISOString();
  const sql = `
    INSERT INTO ${namespace}.tel_audit (id, company_id, user_id, action, contact_id, at, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  const detail = JSON.stringify({ reason });
  try {
    await db.execute(sql, [auditId, companyId, "system", "sms.refused", contactId, now, detail]);
  } catch {
    // Audit failure should not block the response
  }
}

export async function sendSms(
  deps: SendSmsDeps,
  req: SmsSendRequest,
): Promise<SmsSendResult> {
  const { db, namespace, settings, suppression, transport, newId } = deps;
  const now = req.now ?? new Date();

  // Gate 1: SMS enabled
  if (!settings.smsEnabled) {
    await auditRefusal(db, namespace, req.companyId, "disabled", req.contactId);
    return { ok: false, reason: "disabled" };
  }

  // Gate 2: Valid E.164 and region check
  const e164 = normalizeE164(req.to);
  if (!e164) {
    await auditRefusal(db, namespace, req.companyId, "invalid_number", req.contactId);
    return { ok: false, reason: "invalid_number" };
  }

  const region = phoneRegion(e164);
  if (region === "ZA") {
    await auditRefusal(db, namespace, req.companyId, "za_provider_not_configured", req.contactId);
    return { ok: false, reason: "za_provider_not_configured" };
  }

  if (region === "OTHER") {
    await auditRefusal(db, namespace, req.companyId, "unsupported_region", req.contactId);
    return { ok: false, reason: "unsupported_region" };
  }

  // Gate 3: US campaign approval
  if (region === "US") {
    if (
      settings.usSmsCampaignStatus !== "approved" ||
      !settings.usMessagingServiceSid
    ) {
      await auditRefusal(
        db,
        namespace,
        req.companyId,
        "us_campaign_not_approved",
        req.contactId,
      );
      return { ok: false, reason: "us_campaign_not_approved" };
    }
  }

  // Gate 4: Contact opt-out
  if (req.contactId) {
    const query = `SELECT sms_opt_out_at, erased_at FROM ${namespace}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`;
    try {
      const result = await (db.query ? db.query(query, [req.companyId, req.contactId]) : db.execute(query, [req.companyId, req.contactId]));
      const rows = (result as any).rows ?? [];
      if (rows.length > 0) {
        const row = rows[0] as any;
        if (row.sms_opt_out_at || row.erased_at) {
          await auditRefusal(
            db,
            namespace,
            req.companyId,
            "opted_out",
            req.contactId,
          );
          return { ok: false, reason: "opted_out" };
        }
      }
    } catch {
      // If query fails, continue to suppression check
    }
  }

  // Gate 5: Suppression check
  let suppressed = false;
  let consented = true;
  try {
    const result = await suppression.check(req.companyId, e164);
    suppressed = result.suppressed;
    consented = result.consented;
  } catch {
    await auditRefusal(
      db,
      namespace,
      req.companyId,
      "suppression_check_failed",
      req.contactId,
    );
    return { ok: false, reason: "suppression_check_failed" };
  }

  if (suppressed) {
    await auditRefusal(db, namespace, req.companyId, "suppressed", req.contactId);
    return { ok: false, reason: "suppressed" };
  }

  if (!consented) {
    await auditRefusal(db, namespace, req.companyId, "no_consent", req.contactId);
    return { ok: false, reason: "no_consent" };
  }

  // Gate 6: Marketing window
  if (req.kind === "marketing") {
    if (!isWithinMarketingWindow(now, settings.smsHolidays)) {
      await auditRefusal(
        db,
        namespace,
        req.companyId,
        "outside_hours",
        req.contactId,
      );
      return { ok: false, reason: "outside_hours" };
    }
  }

  // Gate 7: Daily cap
  const capSql = `
    SELECT COUNT(*) as cnt FROM ${namespace}.tel_messages
    WHERE company_id = $1 AND channel = 'sms' AND direction = 'outbound'
    AND DATE(created_at AT TIME ZONE 'Africa/Johannesburg') = DATE(NOW() AT TIME ZONE 'Africa/Johannesburg')
  `;
  try {
    const result = await db.execute(capSql, [req.companyId]);
    const rows = (result as any).rows ?? [];
    const count = rows.length > 0 ? (rows[0] as any).cnt : 0;
    if (count >= settings.maxSmsPerDay) {
      await auditRefusal(db, namespace, req.companyId, "daily_cap", req.contactId);
      return { ok: false, reason: "daily_cap" };
    }
  } catch {
    await auditRefusal(db, namespace, req.companyId, "daily_cap", req.contactId);
    return { ok: false, reason: "daily_cap" };
  }

  // Gate 8: Transport available
  if (!transport) {
    await auditRefusal(db, namespace, req.companyId, "transport_error", req.contactId);
    return { ok: false, reason: "transport_error" };
  }

  // Prepare message
  const messageId = newId();
  const body = withOptOutLine(req.body, req.kind);
  const pendingProviderId = `pending:${messageId}`;

  // Insert tel_messages row
  const insertSql = `
    INSERT INTO ${namespace}.tel_messages
    (id, company_id, channel, direction, provider_msg_id, contact_id, from_e164, to_e164, body, kind, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `;
  try {
    await db.execute(insertSql, [
      messageId,
      req.companyId,
      "sms",
      "outbound",
      pendingProviderId,
      req.contactId,
      "system",
      e164,
      body,
      req.kind,
      "queued",
      now.toISOString(),
    ]);
  } catch {
    await auditRefusal(db, namespace, req.companyId, "transport_error", req.contactId);
    return { ok: false, reason: "transport_error" };
  }

  // Call transport
  const transportResult = await transport.send({ to: e164, body });

  if (transportResult.ok) {
    // Update tel_messages with provider info
    const updateSql = `
      UPDATE ${namespace}.tel_messages
      SET provider_msg_id = $1, status = $2
      WHERE id = $3
    `;
    try {
      await db.execute(updateSql, [transportResult.providerMsgId, transportResult.status, messageId]);
    } catch {
      // Log but don't fail
    }

    // Audit success
    const auditId = randomUUID();
    const auditSql = `
      INSERT INTO ${namespace}.tel_audit (id, company_id, user_id, action, contact_id, at, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    try {
      await db.execute(auditSql, [
        auditId,
        req.companyId,
        req.actorUserId ?? "system",
        "sms.send",
        req.contactId,
        now.toISOString(),
        JSON.stringify({}),
      ]);
    } catch {
      // Log but don't fail
    }

    return { ok: true, messageId, providerMsgId: transportResult.providerMsgId };
  } else {
    // Transport failure
    const updateSql = `
      UPDATE ${namespace}.tel_messages
      SET status = $1
      WHERE id = $2
    `;
    try {
      await db.execute(updateSql, ["failed", messageId]);
    } catch {
      // Log but don't fail
    }

    await auditRefusal(db, namespace, req.companyId, "transport_error", req.contactId);
    return { ok: false, reason: "transport_error", detail: transportResult.kind };
  }
}
