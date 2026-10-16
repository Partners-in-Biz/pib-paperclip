import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { classifyInboundKeyword } from "./sms/policy.js";

export interface OptOutApplyRequest {
  companyId: string;
  e164: string;
  candidateIds: string[];
  providerMsgId: string;
  body: string;
}

export interface OptOutResult {
  optedOut: boolean;
  numberOptOutCreated: boolean;
}

/**
 * Apply WhatsApp opt-out based on inbound message keyword.
 *
 * If the message classifies as STOP:
 * - Insert into tel_number_optouts (company, 'whatsapp', e164) with ON CONFLICT DO NOTHING
 *   Returns whether the INSERT actually created a new row (true) or was a no-op (false)
 * - For EVERY candidateId, upsert tel_contact_prefs setting wa_opt_out_at = COALESCE(existing, now())
 *   with updated_by = 'whatsapp-keyword', never touching erased_at on conflict
 * - Returns { optedOut: true, numberOptOutCreated: boolean }
 *
 * If not STOP:
 * - Returns { optedOut: false, numberOptOutCreated: false }
 *
 * All statements are idempotent. Errors propagate (webhook fails, Twilio retries).
 * For an unmatched or ambiguous number, the number-keyed row is the safe stop.
 */
export async function applyWaOptOut(
  dbClient: PluginDatabaseClient,
  namespace: string,
  req: OptOutApplyRequest,
): Promise<OptOutResult> {
  const keyword = classifyInboundKeyword(req.body);

  if (keyword !== "stop") {
    return { optedOut: false, numberOptOutCreated: false };
  }

  // Insert into tel_number_optouts (company, 'whatsapp', e164) on conflict do nothing
  // (keeps the earliest opt_out_at timestamp)
  const numberResult = await dbClient.execute(
    `INSERT INTO ${namespace}.tel_number_optouts (company_id, channel, e164, opt_out_at, source_msg_id)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (company_id, channel, e164) DO NOTHING`,
    [req.companyId, "whatsapp", req.e164, req.providerMsgId],
  );

  const numberOptOutCreated = numberResult.rowCount > 0;

  // For each candidate contact, upsert tel_contact_prefs
  for (const contactId of req.candidateIds) {
    await dbClient.execute(
      `INSERT INTO ${namespace}.tel_contact_prefs (company_id, contact_id, wa_opt_out_at, updated_by, updated_at)
       VALUES ($1, $2, now(), $3, now())
       ON CONFLICT (company_id, contact_id) DO UPDATE
       SET wa_opt_out_at = COALESCE(tel_contact_prefs.wa_opt_out_at, EXCLUDED.wa_opt_out_at),
           updated_by = $3,
           updated_at = now()`,
      [req.companyId, contactId, "whatsapp-keyword"],
    );
  }

  return { optedOut: true, numberOptOutCreated };
}

/**
 * Check if a phone number (and optionally a specific contact) is opted out from WhatsApp.
 *
 * Returns true if:
 * - tel_number_optouts has the (company, 'whatsapp', e164) row, OR
 * - contactId is given and tel_contact_prefs.wa_opt_out_at IS NOT NULL
 *
 * Returns false otherwise.
 *
 * This covers:
 * - Number-level opt-outs (unmatched or ambiguous numbers)
 * - Contact-level opt-outs (matched contact)
 */
export async function isWaOptedOut(
  dbClient: PluginDatabaseClient,
  namespace: string,
  companyId: string,
  e164: string,
  contactId: string | null,
): Promise<boolean> {
  // Check number-level opt-out
  const numberRows = (await dbClient.query(
    `SELECT 1 FROM ${namespace}.tel_number_optouts
     WHERE company_id = $1 AND channel = $2 AND e164 = $3`,
    [companyId, "whatsapp", e164],
  )) as Array<{ "?column?": number }>;

  if (numberRows.length > 0) {
    return true;
  }

  // If contactId given, check contact-level opt-out
  if (contactId) {
    const contactRows = (await dbClient.query(
      `SELECT wa_opt_out_at FROM ${namespace}.tel_contact_prefs
       WHERE company_id = $1 AND contact_id = $2 AND wa_opt_out_at IS NOT NULL`,
      [companyId, contactId],
    )) as Array<{ wa_opt_out_at: string | null }>;

    if (contactRows.length > 0) {
      return true;
    }
  }

  return false;
}
