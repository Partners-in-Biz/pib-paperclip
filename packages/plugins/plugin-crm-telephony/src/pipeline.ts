import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { RecordingRow } from "./lease.js";
import { claimRecordings, releaseLease } from "./lease.js";

export const MAX_ATTEMPTS = 6;

/**
 * Thrown when a step detects the row has been tombstoned (erased_at set).
 * Signals to the pipeline that the row should be abandoned without incrementing attempts.
 */
export class ErasedError extends Error {
  constructor(message = "Recording has been erased") {
    super(message);
    this.name = "ErasedError";
  }
}

/**
 * Compute backoff seconds for a failed attempt.
 * attempts = failures so far (1-based): 60 * 2^(attempts-1), capped at 3600
 */
export function backoffSeconds(attempts: number): number {
  if (attempts < 1) return 0;
  const seconds = 60 * Math.pow(2, attempts - 1);
  return Math.min(seconds, 3600);
}

/**
 * Sanitize error message by redacting sensitive credentials.
 * Removes Authorization headers, Bearer tokens, SIDs, API keys.
 */
export function sanitizeErrorMessage(msg: string, maxLen = 500): string {
  return msg
    .slice(0, maxLen)
    .replace(/Authorization:\s*[^\s]+/gi, "Authorization: [redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[^\s]+/gi, "Basic [redacted]")
    .replace(/sk_test[_a-z0-9]+/gi, "[key redacted]")
    .replace(/AC[0-9a-f]{20,}/gi, "[SID redacted]")
    .replace(/[a-z]{2}[0-9]{32}/gi, "[SID redacted]");
}

export interface PipelineStepCtx {
  ctx: PluginContext;
  namespace: string;
  row: RecordingRow;
  extendLease(): Promise<boolean>;
  isErased(): Promise<boolean>;
}

export interface StepResult {
  state: string;
  error?: string;
  patch?: {
    r2Key?: string;
    bytes?: number;
    sha256?: string;
  };
}

export type PipelineStep = (sc: PipelineStepCtx) => Promise<StepResult>;
export type PipelineSteps = Partial<Record<string, PipelineStep>>;

export interface PipelineOpts {
  steps?: PipelineSteps;
  now?: Date;
  batch?: number;
  leaseSeconds?: number;
  namespace?: string;
}

/**
 * Run the media pipeline queue engine.
 * Claims rows for states with registered handlers, executes steps with lease extension,
 * handles backoff for failures, and marks rows as dead after MAX_ATTEMPTS.
 * Always calls raiseDeadIssues at the end.
 */
export async function runMediaPipeline(ctx: PluginContext, opts?: PipelineOpts) {
  const now = opts?.now ?? new Date();
  const batch = opts?.batch ?? 5;
  const leaseSeconds = opts?.leaseSeconds ?? 600;
  const steps = opts?.steps ?? {};
  const states = Object.keys(steps);

  let processed = 0;
  let failed = 0;
  let dead = 0;
  let abandoned = 0;

  const namespace = opts?.namespace ?? (ctx.db as any).namespace ?? "";
  if (!namespace) throw new Error("namespace required: pass in opts.namespace or ensure ctx.db.namespace is set");

  // If no steps registered, skip processing and go straight to issue sweep
  if (states.length === 0) {
    const issuesRaised = await raiseDeadIssues(ctx, namespace);
    return { processed, failed, dead, abandoned, issuesRaised };
  }

  // Claim rows for states with handlers
  const { token, rows } = await claimRecordings(ctx.db as any, {
    namespace,
    states,
    limit: batch,
    leaseSeconds,
  });

  for (const row of rows) {
    const step = steps[row.state];
    if (!step) continue;

    // Try to extend lease before running the step
    const extendLease = async (): Promise<boolean> => {
      const result = await ctx.db.execute(
        `UPDATE ${namespace}.tel_recordings SET lease_until = now() + make_interval(secs => $1::int), updated_at = now()
         WHERE id = $2::uuid AND lease_token = $3::uuid AND erased_at IS NULL AND state = $4`,
        [leaseSeconds, row.id, token, row.state],
      );
      return result.rowCount > 0;
    };

    // Check if row has been tombstoned (erased_at is set)
    const isErased = async (): Promise<boolean> => {
      const result = await ctx.db.query<{ cnt: string }>(
        `SELECT 1 FROM ${namespace}.tel_recordings WHERE id = $1::uuid AND erased_at IS NOT NULL`,
        [row.id],
      );
      return result.length > 0;
    };

    try {
      // Extend lease before running the step
      let extended: boolean;
      try {
        extended = await extendLease();
      } catch (err) {
        ctx.logger.debug(`Failed to extend lease for ${row.recording_sid}: ${err}`);
        abandoned++;
        continue;
      }

      if (!extended) {
        // Lost lease, erased, or state changed
        abandoned++;
        continue;
      }

      const stepCtx: PipelineStepCtx = {
        ctx,
        namespace,
        row,
        extendLease,
        isErased,
      };

      const result = await step(stepCtx);

      // Success: update state and reset attempts
      const updates = ["state = $1", "attempts = 0", "lease_token = NULL", "lease_until = NULL", "updated_at = now()"];
      const params: unknown[] = [result.state];
      let idx = 1;

      // Handle error field or reset last_error
      if (result.error) {
        const sanitized = sanitizeErrorMessage(result.error);
        updates.push(`last_error = $${++idx}`);
        params.push(sanitized);
      } else {
        updates.push("last_error = NULL");
      }

      if (result.patch?.r2Key) {
        updates.push(`r2_key = $${++idx}`);
        params.push(result.patch.r2Key);
      }
      if (result.patch?.bytes !== undefined) {
        updates.push(`bytes = $${++idx}`);
        params.push(result.patch.bytes);
      }
      if (result.patch?.sha256) {
        updates.push(`sha256 = $${++idx}`);
        params.push(result.patch.sha256);
      }

      // Add WHERE clause parameters
      const idIdx = ++idx;
      const tokenIdx = ++idx;
      params.push(row.id, token);

      const sql = `UPDATE ${namespace}.tel_recordings SET ${updates.join(", ")} WHERE id = $${idIdx}::uuid AND lease_token = $${tokenIdx}::uuid AND erased_at IS NULL`;
      const updateResult = await ctx.db.execute(sql, params);
      if (updateResult.rowCount === 0) {
        abandoned++;
        continue;
      }

      processed++;
      ctx.logger.debug(`recording ${row.recording_sid} ${row.state} -> ${result.state}`);
    } catch (err: any) {
      // Handle erasure: no attempts increment, just abandon
      if (err instanceof ErasedError) {
        abandoned++;
        continue;
      }

      // Failure: increment attempts and schedule backoff
      const errorMsg = sanitizeErrorMessage(String(err?.message || err || "Unknown error"));

      const newAttempts = row.attempts + 1;
      const isFinal = newAttempts >= MAX_ATTEMPTS;
      const nextState = isFinal ? "dead" : row.state;
      const nextAttemptAt = isFinal ? now : new Date(now.getTime() + backoffSeconds(newAttempts) * 1000);

      const params = [nextState, newAttempts, errorMsg, nextAttemptAt.toISOString(), row.id, token];
      const sql = `UPDATE ${namespace}.tel_recordings SET state = $1, attempts = $2, last_error = $3, lease_token = NULL, lease_until = NULL, updated_at = now(), next_attempt_at = $4
                   WHERE id = $5::uuid AND lease_token = $6::uuid AND erased_at IS NULL`;

      const updateResult = await ctx.db.execute(sql, params);
      if (updateResult.rowCount === 0) {
        abandoned++;
        continue;
      }

      failed++;
      if (isFinal) dead++;
      ctx.logger.debug(`recording ${row.recording_sid} ${row.state} failed (attempt ${newAttempts}/${MAX_ATTEMPTS})`);
    }
  }

  const issuesRaised = await raiseDeadIssues(ctx, namespace);

  return { processed, failed, dead, abandoned, issuesRaised };
}

/**
 * Raise Paperclip issues for dead recordings that don't have an issue yet.
 * Processes at most `limit` dead recordings (default 10).
 */
export async function raiseDeadIssues(ctx: PluginContext, namespace: string, limit = 10): Promise<number> {
  const rows = await ctx.db.query<{
    id: string;
    recording_sid: string;
    call_sid: string;
    attempts: number;
    last_error: string | null;
    company_id: string | null;
  }>(
    `SELECT id, recording_sid, call_sid, attempts, last_error, company_id FROM ${namespace}.tel_recordings
     WHERE state = 'dead' AND dead_issue_id IS NULL AND company_id IS NOT NULL
     ORDER BY updated_at LIMIT $1`,
    [limit],
  );

  let issuesRaised = 0;

  for (const row of rows) {
    if (!row.company_id) continue;

    try {
      const issue = await ctx.issues.create({
        companyId: row.company_id,
        title: `Call recording ${row.recording_sid} could not be saved after 6 attempts`,
        description: `Recording failed permanently and cannot be processed further.

Recording SID: ${row.recording_sid}
Call SID: ${row.call_sid}
Attempts: ${row.attempts}
Last Error: ${row.last_error || "(none)"}

The recording is still available on Twilio and has not been deleted. Please check the error and consider manual intervention or pipeline reconfiguration.`,
        priority: "high",
      });

      // Mark the recording with the issue ID
      const updateResult = await ctx.db.execute(
        `UPDATE ${namespace}.tel_recordings SET dead_issue_id = $1::uuid WHERE id = $2::uuid AND dead_issue_id IS NULL`,
        [issue.id, row.id],
      );

      if (updateResult.rowCount > 0) {
        issuesRaised++;
        ctx.logger.debug(`raised issue ${issue.id} for dead recording ${row.recording_sid}`);
      }
    } catch (err) {
      ctx.logger.warn(`Failed to raise issue for dead recording ${row.recording_sid}: ${err}`);
    }
  }

  return issuesRaised;
}
