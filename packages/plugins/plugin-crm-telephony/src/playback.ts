import { presignUrl } from "@partnersinbiz/pib-plugin-kit";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { writeAudit } from "./audit.js";

export class PlaybackError extends Error {
  constructor(
    public code: "not_found" | "r2_not_configured" | "recording_erased" | "no_r2_key" | "invalid_state",
    message: string,
  ) {
    super(message);
  }
}

export interface PlaybackResult {
  url: string;
  expiresAt: string; // ISO timestamp
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Generate a presigned URL for a call recording.
 * Validates company access, recording state, R2 config.
 * Writes audit before returning URL (so URL is never returned if audit fails).
 */
export async function playRecording(
  dbClient: PluginDatabaseClient,
  namespace: string,
  {
    companyId,
    userId,
    callSid,
    contactId,
    r2Config,
    now = new Date(),
  }: {
    companyId: string;
    userId: string;
    callSid: string;
    contactId?: string | null;
    r2Config: R2Config | null;
    now?: Date;
  },
): Promise<PlaybackResult> {
  // Find the call and its latest recording, with company isolation
  const rows = await dbClient.query(
    `SELECT r.id as recording_id, r.r2_key, r.state, r.erased_at, c.contact_id
     FROM ${namespace}.tel_recordings r
     JOIN ${namespace}.tel_calls c ON c.call_sid = r.call_sid
     WHERE c.company_id = $1 AND r.call_sid = $2
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [companyId, callSid],
  );

  if (rows.length === 0) {
    throw new PlaybackError("not_found", "Recording not found");
  }

  const row = rows[0] as Record<string, unknown>;
  const recordingId = row.recording_id as string;
  const r2Key = row.r2_key as string | null;
  const state = row.state as string;
  const erasedAt = row.erased_at as string | null;

  // Check erasure
  if (erasedAt) {
    throw new PlaybackError("recording_erased", "Recording has been erased");
  }

  // Check state (no playback for failed, dead, skipped, erased states)
  if (["failed", "dead", "skipped", "erased"].includes(state)) {
    throw new PlaybackError("invalid_state", `Recording is in ${state} state and cannot be played`);
  }

  // Check R2 key exists
  if (!r2Key) {
    throw new PlaybackError("no_r2_key", "Recording is not available for playback");
  }

  // Check R2 config
  if (!r2Config) {
    throw new PlaybackError("r2_not_configured", "R2 storage is not configured");
  }

  // Write audit BEFORE generating URL (so URL is not returned if audit fails)
  await writeAudit(dbClient, namespace, {
    companyId,
    userId,
    action: "recording.play",
    contactId: (row.contact_id as string) || null,
    detail: { callSid, recordingId },
  });

  // Generate presigned URL (valid 300 seconds)
  const expiresAt = new Date(now.getTime() + 300_000);
  const url = presignUrl({
    method: "GET",
    host: `${r2Config.accountId}.r2.cloudflarestorage.com`,
    path: `/${r2Config.bucket}/${r2Key}`,
    region: "auto",
    accessKeyId: r2Config.accessKeyId,
    secretAccessKey: r2Config.secretAccessKey,
    expiresSec: 300,
    now,
  });

  return { url, expiresAt: expiresAt.toISOString() };
}
