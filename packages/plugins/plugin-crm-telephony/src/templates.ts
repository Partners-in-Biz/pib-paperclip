import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { writeAudit } from "./audit.js";

export interface TwilioClient {
  listContentTemplates(): Promise<
    | { ok: true; value: Array<{ sid: string; friendlyName: string; language: string; bodyPreview: string }> }
    | { ok: false; failure: { kind: string; status?: number; code?: string; error?: string } }
  >;
  getApprovalStatus(
    sid: string,
  ): Promise<
    | { ok: true; value: "approved" | "pending" | "rejected" | "unsubmitted" | "unknown" }
    | { ok: false; failure: { kind: string; status?: number; code?: string; error?: string } }
  >;
}

export interface SyncResult {
  created: number;
  updated: number;
  approved: number;
  unchanged: number;
  skipped: number;
  error?: string;
}

/**
 * Parse language tags (e.g., "en_US", "en-GB", "af", "en") to whitelisted values.
 * Returns "af" or "en", or null if not supported.
 */
function parseLanguage(tag: string): "af" | "en" | null {
  if (!tag) return null;
  // Lowercase and split on - or _
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === "af" || base === "en") return base;
  return null;
}

/**
 * Sync WhatsApp templates from Twilio for a company.
 * Phase 1: fetch templates and approval statuses (network only)
 * Phase 2: upsert to DB and un-approve vanished rows
 *
 * Returns error + zero counts if network operations fail; DB is never touched on failure.
 */
export async function syncTemplates(deps: {
  db: PluginDatabaseClient;
  namespace: string;
  client: TwilioClient;
  companyId: string;
  agentId: string;
}): Promise<SyncResult> {
  const { db, namespace, client, companyId, agentId } = deps;

  // Phase 1: network operations only
  const listResult = await client.listContentTemplates();
  if (!listResult.ok) {
    return {
      created: 0,
      updated: 0,
      approved: 0,
      unchanged: 0,
      skipped: 0,
      error: `${listResult.failure.kind}${listResult.failure.status ? ` (${listResult.failure.status})` : ""}`,
    };
  }

  const templates = listResult.value;

  // Map sid to { name, language, bodyPreview, approvalStatus }
  const networkState: Record<
    string,
    { name: string; language: "af" | "en"; bodyPreview: string | null; approvalStatus: string }
  > = {};

  for (const t of templates) {
    const lang = parseLanguage(t.language);
    if (!lang) {
      // Unsupported language; skip
      continue;
    }

    const statusResult = await client.getApprovalStatus(t.sid);
    if (!statusResult.ok) {
      return {
        created: 0,
        updated: 0,
        approved: 0,
        unchanged: 0,
        skipped: 0,
        error: `${statusResult.failure.kind}${statusResult.failure.status ? ` (${statusResult.failure.status})` : ""}`,
      };
    }

    networkState[t.sid] = {
      name: t.friendlyName,
      language: lang,
      bodyPreview: t.bodyPreview || null,
      approvalStatus: statusResult.value,
    };
  }

  // Phase 2: DB operations
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let approved = 0;

  // Fetch existing rows for this company/channel
  const existingRows = await db.query<{
    id: string;
    twilio_content_sid: string;
    name: string;
    language: string;
    body_preview: string | null;
    approved: boolean;
  }>(
    `SELECT id, twilio_content_sid, name, language, body_preview, approved
     FROM ${namespace}.tel_templates
     WHERE company_id = $1 AND channel = 'whatsapp'`,
    [companyId],
  );

  const existingBySid = new Map<string, (typeof existingRows)[0]>();
  for (const row of existingRows) {
    if (row.twilio_content_sid) {
      existingBySid.set(row.twilio_content_sid, row);
    }
  }

  // Upsert for each template in networkState
  for (const [sid, data] of Object.entries(networkState)) {
    const existing = existingBySid.get(sid);
    const isApproved = data.approvalStatus === "approved";

    if (existing) {
      // Check if anything changed (compare normalized values)
      const existingBodyPreview = existing.body_preview ?? null;
      const newBodyPreview = data.bodyPreview ?? null;

      if (
        existing.name === data.name &&
        existing.language === data.language &&
        existingBodyPreview === newBodyPreview &&
        existing.approved === isApproved
      ) {
        unchanged++;
      } else {
        // UPDATE
        await db.execute(
          `UPDATE ${namespace}.tel_templates
           SET name = $1, language = $2, body_preview = $3, approved = $4, updated_at = now()
           WHERE id = $5`,
          [data.name, data.language, newBodyPreview, isApproved, existing.id],
        );
        updated++;
      }
    } else {
      // INSERT
      await db.execute(
        `INSERT INTO ${namespace}.tel_templates (company_id, channel, name, language, twilio_content_sid, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, "whatsapp", data.name, data.language, sid, data.bodyPreview, isApproved],
      );
      created++;
    }

    if (isApproved) {
      approved++;
    }
  }

  // Un-approve vanished rows: rows where sid is no longer in networkState
  const vanishedSids = Array.from(existingBySid.keys()).filter((sid) => !networkState[sid]);
  if (vanishedSids.length > 0) {
    await db.execute(
      `UPDATE ${namespace}.tel_templates
       SET approved = false, updated_at = now()
       WHERE company_id = $1 AND channel = 'whatsapp' AND approved = true AND twilio_content_sid = ANY($2::text[])`,
      [companyId, vanishedSids],
    );
    updated += vanishedSids.length;
  }

  // Write audit
  await writeAudit(db, namespace, {
    companyId,
    userId: agentId,
    action: "template.sync",
    detail: { created, updated, approved, unchanged, skipped: templates.length - Object.keys(networkState).length },
  });

  return { created, updated, approved, unchanged, skipped: templates.length - Object.keys(networkState).length };
}

/**
 * List approved WhatsApp templates for a company, optionally filtered by language.
 */
export async function listPickerTemplates(
  db: PluginDatabaseClient,
  namespace: string,
  companyId: string,
  opts?: { language?: "af" | "en" },
): Promise<Array<{ id: string; name: string; language: string; bodyPreview: string }>> {
  const language = opts?.language;

  let sql = `SELECT id, name, language, body_preview
             FROM ${namespace}.tel_templates
             WHERE company_id = $1 AND channel = 'whatsapp' AND approved = true`;
  const params: unknown[] = [companyId];

  if (language) {
    sql += ` AND language = $2`;
    params.push(language);
  }

  sql += ` ORDER BY language, name`;

  const rows = await db.query<{ id: string; name: string; language: string; body_preview: string }>(sql, params);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language,
    bodyPreview: row.body_preview,
  }));
}
