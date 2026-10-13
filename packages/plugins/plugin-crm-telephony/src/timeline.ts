import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { writeAudit } from "./audit.js";

export interface TimelineItem {
  id: string;
  type: "call" | "message" | "note";
  timestamp: string;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  channel?: "voice" | "sms" | "whatsapp";
  body?: string;
  duration_s?: number;
  status?: string;
  recordingId?: string;
  transcriptId?: string;
  recorded?: boolean;
}

export interface TimelineResult {
  items: TimelineItem[];
  contactPrefs?: {
    do_not_record: boolean;
    language: string;
  };
}

export interface ContactPrefs {
  do_not_record: boolean;
  language: string;
}

/**
 * Get merged timeline of calls, messages, and notes for a contact.
 * Sorted descending by time. Includes contact prefs. Returns only safe columns.
 */
export async function getTimeline(
  dbClient: PluginDatabaseClient,
  namespace: string,
  {
    companyId,
    contactId,
    limit = 100,
    before,
  }: {
    companyId: string;
    contactId: string;
    limit?: number;
    before?: string; // ISO timestamp for pagination
  },
): Promise<TimelineResult> {
  if (limit < 1 || limit > 100) throw new Error("limit must be 1-100");

  // Fetch calls, messages, and contact prefs in parallel
  const [calls, messages, prefs] = await Promise.all([
    dbClient.query(
      `SELECT
        id, 'call'::text as type, created_at as timestamp, direction, from_e164 as "from", to_e164 as "to",
        'voice'::text as channel, duration_s, status, recorded, call_sid
      FROM ${namespace}.tel_calls
      WHERE company_id = $1 AND contact_id = $2 ${before ? "AND created_at < $3" : ""}
      ORDER BY created_at DESC
      LIMIT $${before ? "4" : "3"}`,
      before ? [companyId, contactId, before, limit] : [companyId, contactId, limit],
    ),
    dbClient.query(
      `SELECT
        id, 'message'::text as type, created_at as timestamp, direction, from_e164 as "from", to_e164 as "to",
        channel, body, status
      FROM ${namespace}.tel_messages
      WHERE company_id = $1 AND contact_id = $2 ${before ? "AND created_at < $3" : ""}
      ORDER BY created_at DESC
      LIMIT $${before ? "4" : "3"}`,
      before ? [companyId, contactId, before, limit] : [companyId, contactId, limit],
    ),
    dbClient.query(
      `SELECT do_not_record, COALESCE(language, 'en') as language
      FROM ${namespace}.tel_contact_prefs
      WHERE company_id = $1 AND contact_id = $2`,
      [companyId, contactId],
    ),
  ]);

  // Merge and sort items
  const items: TimelineItem[] = [];
  for (const row of calls as Array<Record<string, unknown>>) {
    items.push({
      id: row.id as string,
      type: "call",
      timestamp: new Date(row.timestamp as string).toISOString(),
      direction: row.direction as "inbound" | "outbound",
      from: row.from as string,
      to: row.to as string,
      channel: "voice",
      duration_s: row.duration_s as number,
      status: row.status as string,
      recorded: row.recorded as boolean,
      // No call_sid exposed
    });
  }
  for (const row of messages as Array<Record<string, unknown>>) {
    items.push({
      id: row.id as string,
      type: "message",
      timestamp: new Date(row.timestamp as string).toISOString(),
      direction: row.direction as "inbound" | "outbound",
      from: row.from as string,
      to: row.to as string,
      channel: row.channel as "sms" | "whatsapp",
      body: row.body as string,
      status: row.status as string,
    });
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const contactPrefs = prefs.length > 0
    ? {
        do_not_record: (prefs[0] as Record<string, unknown>).do_not_record as boolean,
        language: (prefs[0] as Record<string, unknown>).language as string,
      }
    : { do_not_record: false, language: "en" };

  return { items: items.slice(0, limit), contactPrefs };
}

/**
 * Get transcript for a call (text and segments when requested).
 */
export async function getTranscript(
  dbClient: PluginDatabaseClient,
  namespace: string,
  {
    companyId,
    callSid,
  }: {
    companyId: string;
    callSid: string;
  },
): Promise<{
  id: string;
  text: string;
  language?: string;
  segments?: unknown;
  summary?: string;
  next_actions?: unknown;
} | null> {
  const rows = await dbClient.query(
    `SELECT t.id, t.text, t.language, t.segments, t.summary, t.next_actions
     FROM ${namespace}.tel_transcripts t
     JOIN ${namespace}.tel_calls c ON c.call_sid = t.call_sid
     WHERE c.company_id = $1 AND t.call_sid = $2`,
    [companyId, callSid],
  );

  if (rows.length === 0) return null;

  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    text: row.text as string,
    language: row.language as string | undefined,
    segments: row.segments,
    summary: row.summary as string | undefined,
    next_actions: row.next_actions,
  };
}

/**
 * List calls and messages with no contact_id match, grouped by external number.
 */
export async function listUnmatched(
  dbClient: PluginDatabaseClient,
  namespace: string,
  {
    companyId,
    limit = 50,
  }: {
    companyId: string;
    limit?: number;
  },
): Promise<
  Array<{
    number: string;
    type: "inbound_call" | "outbound_call" | "inbound_message" | "outbound_message";
    count: number;
    last_activity: string;
  }>
> {
  if (limit < 1 || limit > 100) throw new Error("limit must be 1-100");

  const rows = await dbClient.query(
    `
    SELECT
      COALESCE(calls.number, msgs.number) as number,
      COALESCE(calls.type, msgs.type) as type,
      COALESCE(calls.count, msgs.count) as count,
      COALESCE(calls.last_activity, msgs.last_activity) as last_activity
    FROM (
      SELECT
        CASE WHEN direction = 'inbound' THEN from_e164 ELSE to_e164 END as number,
        CASE WHEN direction = 'inbound' THEN 'inbound_call' ELSE 'outbound_call' END as type,
        COUNT(*) as count,
        MAX(created_at) as last_activity
      FROM ${namespace}.tel_calls
      WHERE company_id = $1 AND contact_id IS NULL
      GROUP BY number, direction
    ) calls
    FULL OUTER JOIN (
      SELECT
        CASE WHEN direction = 'inbound' THEN from_e164 ELSE to_e164 END as number,
        CASE WHEN direction = 'inbound' THEN 'inbound_message' ELSE 'outbound_message' END as type,
        COUNT(*) as count,
        MAX(created_at) as last_activity
      FROM ${namespace}.tel_messages
      WHERE company_id = $1 AND contact_id IS NULL
      GROUP BY number, direction
    ) msgs ON calls.number = msgs.number AND calls.type = msgs.type
    ORDER BY COALESCE(calls.last_activity, msgs.last_activity) DESC
    LIMIT $2
    `,
    [companyId, limit],
  );

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      number: r.number as string,
      type: r.type as "inbound_call" | "outbound_call" | "inbound_message" | "outbound_message",
      count: r.count as number,
      last_activity: new Date(r.last_activity as string).toISOString(),
    };
  });
}

/**
 * Set contact preferences (do not record, language).
 */
export async function setContactPrefs(
  dbClient: PluginDatabaseClient,
  namespace: string,
  {
    companyId,
    contactId,
    userId,
    doNotRecord,
    language,
  }: {
    companyId: string;
    contactId: string;
    userId: string;
    doNotRecord?: boolean;
    language?: "af" | "en";
  },
): Promise<void> {
  // Validate language
  if (language && !["af", "en"].includes(language)) {
    throw new Error("language must be 'af' or 'en'");
  }

  // Build the detail for audit (changed fields only)
  const detail: Record<string, unknown> = {};
  if (doNotRecord !== undefined) detail.do_not_record = doNotRecord;
  if (language !== undefined) detail.language = language;

  // For updates, we want to keep the old value if not provided
  // First, get current values if row exists
  const existing = await dbClient.query(
    `SELECT do_not_record, language FROM ${namespace}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
    [companyId, contactId],
  );

  const finalDoNotRecord =
    doNotRecord !== undefined
      ? doNotRecord
      : existing.length > 0
        ? ((existing[0] as Record<string, unknown>).do_not_record as boolean)
        : false;
  const finalLanguage =
    language || (existing.length > 0 ? ((existing[0] as Record<string, unknown>).language as string) : "en");

  await dbClient.execute(
    `INSERT INTO ${namespace}.tel_contact_prefs (company_id, contact_id, do_not_record, language, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (company_id, contact_id) DO UPDATE SET
       do_not_record = $3,
       language = $4,
       updated_by = $5,
       updated_at = now()`,
    [companyId, contactId, finalDoNotRecord, finalLanguage, userId],
  );

  // Write audit
  await writeAudit(dbClient, namespace, {
    companyId,
    userId,
    action: "contact.prefs.update",
    contactId,
    detail,
  });
}
