import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { R2Config } from "./r2-store.js";
import { r2Delete, recordingKey } from "./r2-store.js";
import { readR2Config } from "./settings.js";

export const QUIESCE_SECONDS = 3600;
export const TRANSCRIPT_RETENTION_MONTHS = 12;
export const RETENTION_MARKER = "retention";

export interface RetentionOpts {
  now?: Date;
  fetch?: typeof fetch;
  r2Config?: (ctx: PluginContext, companyId: string) => Promise<R2Config | null>;
  namespace?: string;
  batch?: number;
}

export interface RetentionResult {
  tombstoned: number;
  purged: number;
  transcriptsTrimmed: number;
  skipped: number;
  errors: number;
}

/**
 * Nightly retention job: tombstone expired/failed/dead recordings, purge quiesced rows and old transcript text.
 * Three phases:
 * 1. TOMBSTONE: Mark expired/failed/skipped/dead rows for deletion (erased_at set, lease cleared)
 * 2. PURGE: Delete from R2/Twilio, then delete from DB (must wait QUIESCE_SECONDS after tombstone)
 * 3. TRANSCRIPTS: Trim old transcript text to empty string (keeps summary/next_actions)
 */
export async function runRetention(ctx: PluginContext, opts?: RetentionOpts): Promise<RetentionResult> {
  const now = opts?.now ?? new Date();
  const batch = opts?.batch ?? 50;
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const readR2ConfigFn = opts?.r2Config ?? readR2Config;
  const namespace = opts?.namespace ?? (ctx.db as any).namespace ?? "";

  if (!namespace) throw new Error("namespace required: pass in opts.namespace or ensure ctx.db.namespace is set");
  if (!/^[a-z0-9_]+$/.test(namespace)) throw new Error(`Invalid namespace: ${namespace}`);

  let tombstoned = 0;
  let purged = 0;
  let transcriptsTrimmed = 0;
  let skipped = 0;
  let errors = 0;

  // Phase 1: TOMBSTONE
  // Mark expired/failed/skipped/dead rows for eventual purge
  const tombstoneRows = await ctx.db.query<{ id: string; recording_sid: string }>(
    `SELECT id, recording_sid FROM ${namespace}.tel_recordings
     WHERE erased_at IS NULL AND (
       state IN ('failed', 'skipped')
       OR (state = 'dead' AND (dead_issue_id IS NOT NULL OR company_id IS NULL))
       OR (expires_at IS NOT NULL AND expires_at <= $1::timestamptz)
     )
     LIMIT $2::int`,
    [now.toISOString(), batch],
  );

  for (const row of tombstoneRows) {
    const result = await ctx.db.execute(
      `UPDATE ${namespace}.tel_recordings SET erased_at = $1::timestamptz, state = 'erased', last_error = $2, lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = $3::uuid AND erased_at IS NULL`,
      [now.toISOString(), RETENTION_MARKER, row.id],
    );
    if (result.rowCount > 0) tombstoned++;
  }

  // Phase 2: PURGE
  // Delete from R2/Twilio, then delete from DB (only if quiesce time has passed)
  const quiesceTime = new Date(now.getTime() - QUIESCE_SECONDS * 1000);
  const purgeRows = await ctx.db.query<{
    id: string;
    recording_sid: string;
    call_sid: string;
    twilio_url: string;
    company_id: string | null;
    r2_key: string | null;
    last_error: string | null;
    erased_at: string;
  }>(
    `SELECT id, recording_sid, call_sid, twilio_url, company_id, r2_key, last_error, erased_at FROM ${namespace}.tel_recordings
     WHERE erased_at IS NOT NULL AND erased_at <= $1::timestamptz
     LIMIT $2::int`,
    [quiesceTime.toISOString(), batch],
  );

  for (const row of purgeRows) {
    try {
      // Skip if company_id is null
      if (!row.company_id) {
        skipped++;
        continue;
      }

      // Get R2 config
      const r2cfg = await readR2ConfigFn(ctx, row.company_id);
      if (!r2cfg) {
        skipped++;
        continue;
      }

      // Delete from R2: delete only this recording's wav file
      const expectedKey = recordingKey(r2cfg, row.call_sid, row.recording_sid);
      let r2Error = false;

      try {
        await r2Delete(r2cfg, expectedKey, fetchFn, now);
      } catch (err) {
        ctx.logger.warn(`Failed to delete R2 key for ${row.recording_sid}: ${err}`);
        errors++;
        r2Error = true;
      }

      if (r2Error) {
        continue; // Skip DB cleanup if R2 delete failed
      }

      // Delete from Twilio
      let twilioError = false;
      const accountMatch = row.twilio_url.match(/\/Accounts\/(AC[0-9a-f]+)\//i);
      if (!accountMatch) {
        // Unparseable Twilio URL: treat as error and keep row
        ctx.logger.warn(`Unparseable Twilio URL for ${row.recording_sid}: ${row.twilio_url}`);
        errors++;
        twilioError = true;
      } else {
        const accountSid = accountMatch[1];
        try {
          let apiKey: string;
          try {
            apiKey = await ctx.secrets.resolve("TWILIO_API_KEY_SID", { companyId: row.company_id });
          } catch {
            throw new Error("Missing secret: TWILIO_API_KEY_SID");
          }

          let apiSecret: string;
          try {
            apiSecret = await ctx.secrets.resolve("TWILIO_API_KEY_SECRET", { companyId: row.company_id });
          } catch {
            throw new Error("Missing secret: TWILIO_API_KEY_SECRET");
          }

          const authHeader = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
          const deleteUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${row.recording_sid}.json`;

          const deleteResponse = await fetchFn(deleteUrl, {
            method: "DELETE",
            headers: { Authorization: authHeader },
          });

          // 204 (success) or 404 (already deleted) are both OK
          if (deleteResponse.status !== 204 && deleteResponse.status !== 404) {
            throw new Error(`Twilio delete failed: HTTP ${deleteResponse.status}`);
          }
        } catch (err) {
          ctx.logger.warn(`Failed to delete from Twilio for ${row.recording_sid}: ${err}`);
          errors++;
          twilioError = true;
        }
      }

      if (twilioError) {
        continue; // Skip DB cleanup if Twilio delete failed
      }

      // If this is an erasure request (not a retention tombstone), delete transcripts
      if (row.last_error !== RETENTION_MARKER) {
        try {
          await ctx.db.execute(`DELETE FROM ${namespace}.tel_transcripts WHERE recording_id = $1::uuid`, [row.id]);
        } catch (err) {
          ctx.logger.warn(`Failed to delete transcripts for ${row.recording_sid}: ${err}`);
          errors++;
          continue;
        }
      }

      // Finally, delete the recording row
      try {
        const deleteResult = await ctx.db.execute(
          `DELETE FROM ${namespace}.tel_recordings WHERE id = $1::uuid AND erased_at IS NOT NULL`,
          [row.id],
        );
        if (deleteResult.rowCount > 0) purged++;
      } catch (err) {
        ctx.logger.warn(`Failed to delete recording row for ${row.recording_sid}: ${err}`);
        errors++;
      }
    } catch (err) {
      ctx.logger.warn(`Unexpected error processing ${row.recording_sid}: ${err}`);
      errors++;
    }
  }

  // Phase 3: TRANSCRIPTS
  // Trim old transcript text (keep summary and next_actions)
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - TRANSCRIPT_RETENTION_MONTHS);
  cutoff.setUTCHours(0, 0, 0, 0);

  const trimResult = await ctx.db.execute(
    `UPDATE ${namespace}.tel_transcripts SET text = '', segments = NULL, updated_at = now()
     WHERE created_at <= $1::timestamptz AND text <> ''`,
    [cutoff.toISOString()],
  );
  transcriptsTrimmed = trimResult.rowCount;

  ctx.logger.debug(
    `retention: tombstoned=${tombstoned} purged=${purged} transcriptsTrimmed=${transcriptsTrimmed} skipped=${skipped} errors=${errors}`,
  );

  return { tombstoned, purged, transcriptsTrimmed, skipped, errors };
}
