/**
 * The render queue: one `video_renders` row per render job (migration 006). The queue is host-wide: at most one job is
 * `rendering` or `uploading` at a time, and the database enforces it with the partial unique index
 * `video_renders_one_active`, not this code. `ctx.db.execute` returns only `{ rowCount }` and has no transactions, so:
 *  - claim is one UPDATE of the oldest queued row; rowCount 0 or a unique violation on that index = not claimed;
 *  - every later step (heartbeat, finish, requeue) is one UPDATE guarded by the claim token and an active status, so a
 *    runner that lost its claim (cancelled, recovered as stale) gets `false` back and must stop and kill its ffmpeg.
 * Times come from the database clock (`now()`), never the worker's.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { iso, num, table } from "../db.js";
import { errorText, StudioError } from "../errors.js";
import { normalizeEdit } from "./timeline.js";

export type RenderStatus = "queued" | "rendering" | "uploading" | "succeeded" | "failed" | "cancelled";
export type RenderErrorKind = "deterministic" | "infra";

export const MAX_RENDER_ERROR = 2_000;
export const MAX_STDERR_TAIL = 4_096;
const ACTIVE = "status IN ('rendering', 'uploading')";

export interface RenderRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  edit_id: string;
  edit_revision: number | string;
  doc: unknown;
  preset: string;
  status: RenderStatus;
  claim_token: string | null;
  pid: number | string | null;
  workdir: string | null;
  heartbeat_at: unknown;
  attempts: number | string;
  error_kind: RenderErrorKind | null;
  asset_id: string | null;
  preview_r2_key: string | null;
  error: string | null;
  stderr_tail: string | null;
  started_at: unknown;
  finished_at: unknown;
  created_at: unknown;
}

export interface RenderJob {
  id: string;
  companyId: string;
  client: { kind: string | null; id: string } | null;
  editId: string;
  editRevision: number;
  doc: unknown;
  preset: string;
  status: RenderStatus;
  pid: number | null;
  workdir: string | null;
  heartbeatAt: string | null;
  attempts: number;
  errorKind: RenderErrorKind | null;
  assetId: string | null;
  previewR2Key: string | null;
  error: string | null;
  stderrTail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

/** What the runner holds after a claim: the job plus the token every later write must present. */
export interface ClaimedRender extends RenderJob {
  claimToken: string;
}

export function renderView(r: RenderRow): RenderJob {
  return {
    id: r.id,
    companyId: r.company_id,
    client: r.client_ref ? { kind: r.client_kind, id: r.client_ref } : null,
    editId: r.edit_id,
    editRevision: num(r.edit_revision),
    doc: typeof r.doc === "string" ? JSON.parse(r.doc) : r.doc,
    preset: r.preset,
    status: r.status,
    pid: r.pid == null ? null : num(r.pid),
    workdir: r.workdir,
    heartbeatAt: iso(r.heartbeat_at),
    attempts: num(r.attempts),
    errorKind: r.error_kind,
    assetId: r.asset_id,
    previewR2Key: r.preview_r2_key,
    error: r.error,
    stderrTail: r.stderr_tail,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at),
  };
}

function bad(message: string): never {
  throw new StudioError(message, "bad_render");
}

function required(value: unknown, what: string, max = 200): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) bad(`A render needs ${what}.`);
  if (t.length > max) bad(`A render ${what} is at most ${max} characters.`);
  return t;
}

const clip = (value: unknown, max: number) => (value == null || value === "" ? null : String(value).slice(-max));

/** A write refused by `video_renders_one_active`: another job holds the render slot. The host may drop the SQLSTATE over RPC, so the index name counts too. */
export function isActiveSlotConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23505" || /video_renders_one_active|duplicate key value/.test(errorText(error));
}

export interface EnqueueRenderInput {
  companyId: string;
  client?: { kind: string; id: string } | null;
  editId: string;
  editRevision: number;
  /** The edit document as it was when the render was asked for; later saves do not change this render. */
  doc: unknown;
  preset: string;
}

export async function enqueueRender(ctx: PluginContext, input: EnqueueRenderInput): Promise<RenderJob> {
  const companyId = required(input.companyId, "a company");
  const editId = required(input.editId, "an edit");
  const preset = required(input.preset, "a preset", 40);
  if (!Number.isInteger(input.editRevision) || input.editRevision < 1) bad("A render needs the edit's revision.");
  if (input.doc == null || typeof input.doc !== "object") bad("A render needs the edit document.");
  // Stored normalized, so the render row holds the same schema version the edit was saved with (a v1 doc stays v1).
  const doc = normalizeEdit(input.doc);
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "video_renders")} (id, company_id, client_kind, client_ref, edit_id, edit_revision, doc, preset) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, companyId, input.client?.kind ?? null, input.client?.id ?? null, editId, input.editRevision, JSON.stringify(doc), preset],
  );
  return getRender(ctx, companyId, id);
}

/** One render of a company (for status and cancel); the claim token is never shown. */
export async function getRender(ctx: PluginContext, companyId: string, id: string): Promise<RenderJob> {
  const rows = await ctx.db.query<RenderRow>(`SELECT * FROM ${table(ctx, "video_renders")} WHERE id = $1 AND company_id = $2`, [String(id ?? ""), companyId]);
  if (!rows[0]) throw new StudioError("That render was not found in this company.", "unknown_render");
  return renderView(rows[0]);
}

/**
 * Takes the oldest queued job and moves it to `rendering` under a new claim token, or returns null when nothing was
 * claimed (queue empty, another job is active, or a parallel claim won). The outer `status = 'queued'` matters: when
 * two claims pick the same row, the loser re-checks it after the winner commits and matches nothing.
 */
export async function claimNextRender(ctx: PluginContext): Promise<ClaimedRender | null> {
  const t = table(ctx, "video_renders");
  const token = randomUUID();
  let claimed = 0;
  try {
    ({ rowCount: claimed } = await ctx.db.execute(
      `UPDATE ${t} SET status = 'rendering', claim_token = $1, attempts = attempts + 1, heartbeat_at = now(), started_at = now(), pid = NULL, workdir = NULL, error = NULL, error_kind = NULL, stderr_tail = NULL
       WHERE status = 'queued' AND id = (SELECT id FROM ${t} WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${ACTIVE})`,
      [token],
    ));
  } catch (error) {
    if (isActiveSlotConflict(error)) return null;
    throw error;
  }
  if (claimed !== 1) return null;
  const rows = await ctx.db.query<RenderRow>(`SELECT * FROM ${t} WHERE claim_token = $1`, [token]);
  return rows[0] ? { ...renderView(rows[0]), claimToken: token } : null;
}

export interface HeartbeatPatch {
  pid?: number;
  workdir?: string;
  /** Move rendering -> uploading once ffmpeg is done and the output is being stored. */
  stage?: "uploading";
}

/** Proves the runner is alive (and records its pid/workdir for recovery). False = the claim is gone: stop and kill. */
export async function heartbeatRender(ctx: PluginContext, id: string, token: string, patch: HeartbeatPatch = {}): Promise<boolean> {
  if (patch.pid !== undefined && (!Number.isInteger(patch.pid) || patch.pid <= 0)) bad("A render pid is a positive whole number.");
  const { rowCount } = await ctx.db.execute(
    `UPDATE ${table(ctx, "video_renders")} SET heartbeat_at = now(), pid = COALESCE($3, pid), workdir = COALESCE($4, workdir), status = COALESCE($5, status)
     WHERE id = $1 AND claim_token = $2 AND ${ACTIVE}`,
    [id, token, patch.pid ?? null, patch.workdir ?? null, patch.stage ?? null],
  );
  return rowCount === 1;
}

export type RenderOutcome =
  | { status: "succeeded"; assetId: string; previewR2Key?: string | null }
  | { status: "failed"; errorKind: RenderErrorKind; error: string; stderrTail?: string | null };

/** Ends a claimed job and frees the slot. False = the claim was already gone (cancelled or recovered); nothing changed. */
export async function finishRender(ctx: PluginContext, id: string, token: string, outcome: RenderOutcome): Promise<boolean> {
  const t = table(ctx, "video_renders");
  const guard = `WHERE id = $1 AND claim_token = $2 AND ${ACTIVE}`;
  if (outcome.status === "succeeded") {
    const assetId = required(outcome.assetId, "an output asset");
    const { rowCount } = await ctx.db.execute(
      `UPDATE ${t} SET status = 'succeeded', asset_id = $3, preview_r2_key = $4, error = NULL, error_kind = NULL, finished_at = now(), heartbeat_at = now() ${guard}`,
      [id, token, assetId, outcome.previewR2Key ?? null],
    );
    return rowCount === 1;
  }
  if (outcome.status !== "failed") bad("A render ends as succeeded or failed.");
  if (outcome.errorKind !== "deterministic" && outcome.errorKind !== "infra") bad("A failed render is deterministic or infra.");
  const { rowCount } = await ctx.db.execute(
    `UPDATE ${t} SET status = 'failed', error_kind = $3, error = $4, stderr_tail = $5, finished_at = now(), heartbeat_at = now() ${guard}`,
    [id, token, outcome.errorKind, clip(outcome.error, MAX_RENDER_ERROR) ?? "Render failed.", clip(outcome.stderrTail, MAX_STDERR_TAIL)],
  );
  return rowCount === 1;
}

/** Puts a claimed job back in the queue after an infra error (the runner decides whether attempts allow it). Keeps attempts and the error. */
export async function requeueRender(ctx: PluginContext, id: string, token: string, reason: { error: string; stderrTail?: string | null }): Promise<boolean> {
  const { rowCount } = await ctx.db.execute(
    `UPDATE ${table(ctx, "video_renders")} SET status = 'queued', claim_token = NULL, pid = NULL, workdir = NULL, heartbeat_at = NULL, started_at = NULL, error_kind = 'infra', error = $3, stderr_tail = $4
     WHERE id = $1 AND claim_token = $2 AND ${ACTIVE}`,
    [id, token, clip(reason.error, MAX_RENDER_ERROR) ?? "Render interrupted.", clip(reason.stderrTail, MAX_STDERR_TAIL)],
  );
  return rowCount === 1;
}

export interface CancelResult {
  render: RenderJob;
  /** False when the job had already ended; it is then left as it was. */
  cancelled: boolean;
  /** Set when the job was running: the runner must kill this process (pid + workdir check) — its next heartbeat returns false. */
  running: { pid: number | null; workdir: string | null } | null;
}

/** Cancels a queued or running job of this company. A running job's slot is freed at once; its ffmpeg is the runner's to stop. */
export async function cancelRender(ctx: PluginContext, companyId: string, id: string): Promise<CancelResult> {
  const t = table(ctx, "video_renders");
  const before = await getRender(ctx, companyId, id);
  const { rowCount } = await ctx.db.execute(
    `UPDATE ${t} SET status = 'cancelled', finished_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('queued', 'rendering', 'uploading')`,
    [before.id, companyId],
  );
  const render = await getRender(ctx, companyId, before.id);
  const wasRunning = before.status === "rendering" || before.status === "uploading";
  return { render, cancelled: rowCount === 1, running: rowCount === 1 && wasRunning ? { pid: render.pid, workdir: render.workdir } : null };
}

/** Active jobs whose last heartbeat is older than `olderThanSeconds` (worker died or hung), oldest first, with their tokens for recovery. */
export async function listStaleRenders(ctx: PluginContext, olderThanSeconds: number): Promise<ClaimedRender[]> {
  if (!Number.isFinite(olderThanSeconds) || olderThanSeconds < 1) bad("Stale age is at least one second.");
  const rows = await ctx.db.query<RenderRow>(
    `SELECT * FROM ${table(ctx, "video_renders")} WHERE ${ACTIVE} AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1)) ORDER BY heartbeat_at NULLS FIRST, id`,
    [Math.floor(olderThanSeconds)],
  );
  return rows.map((r: RenderRow) => ({ ...renderView(r), claimToken: r.claim_token ?? "" }));
}
