/**
 * Generation from a Planning Canvas board (PAR-14281; plan PAR-14257 C "Data model" and "Interfaces", D 3c, H, Q&A 7).
 *
 * - Who pays: the board decides, never a client picked by hand. A project board charges that project's client; a
 *   project without one, a company board and a personal board charge own work (the same rule as `boardTarget`).
 * - Inputs are explicit: the card's `inputKeys` (at most 8) are copied into the generation row at the click, with the
 *   reference asset ids, so rewiring the board afterwards cannot change a pending generation. Arrows are never inputs.
 * - A per-person daily limit (`boards.boardGenerationDailyLimit`, 20 by default) counts card clicks and `studio-generate`
 *   calls from a run bound to a board chat thread, against that run's person. Studio's own page is not counted. It is
 *   an abuse guard; the monthly credit cap stays the spend control. Queued, running and finished rows count; failed
 *   (and so refunded) rows don't. The count runs again inside the company lock, next to the cap check and the reserve.
 * - Everything sits behind `boards.generate` (default off; a settings read that throws is off).
 */
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ActingRestriction, ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { boardTarget, onBoard, WRONG_BOARD, type BoardScope } from "./board-scope.js";
import { StudioConfig } from "./config.js";
import { num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { assertOpenToPerson } from "./scope.js";

export const BOARD_ORIGIN = "board";
/** Core's issue origin for a board chat thread (server/src/services/planning-canvas-comments.ts). */
export const PLANNING_CANVAS_ORIGIN = "planning_canvas";
export const MAX_INPUT_KEYS = 8;
const MAX_KEY_LENGTH = 100;

export const BOARD_GENERATION_OFF = "board_generation_off";
export const BOARD_DAILY_LIMIT = "board_daily_limit";
export const ESTIMATE_CHANGED = "estimate_changed";

/** What a board generation carries into Studio's row and its daily count. */
export interface BoardMark {
  /** The person it counts against: the clicker, or the run's acting person on the agent path. */
  userId: string;
  dailyLimit: number;
  inputKeys: string[];
}

/** The card's input keys: unique node keys, at most 8. Anything else is refused, never trimmed quietly. */
export function inputKeysOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new StudioError("inputKeys must be a list of board node keys.", "bad_request");
  const keys = value.map((key) => (typeof key === "string" ? key.trim() : ""));
  if (keys.some((key) => !key || key.length > MAX_KEY_LENGTH)) throw new StudioError("Each input must be a board node key.", "bad_request");
  const unique = [...new Set(keys)];
  if (unique.length > MAX_INPUT_KEYS) throw new StudioError(`A card takes at most ${MAX_INPUT_KEYS} inputs.`, "bad_request");
  return unique;
}

/** Midnight UTC of the day `now` falls in. */
export function utcDayStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Board generations one person started today (UTC) that didn't fail. */
export async function boardUsedToday(ctx: PluginContext, companyId: string, userId: string, now: number): Promise<number> {
  const rows = await ctx.db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM ${table(ctx, "generations")} WHERE company_id = $1 AND origin = 'board' AND acting_user_id = $2 AND created_at >= $3 AND status <> 'failed'`,
    [companyId, userId, utcDayStart(now)],
  );
  return num(rows[0]?.n);
}

/** Refuses with `board_daily_limit` when `batch` more would pass the limit. Returns today's count. */
export async function assertBoardDailyFits(ctx: PluginContext, companyId: string, mark: BoardMark, batch: number, now: number): Promise<number> {
  const used = await boardUsedToday(ctx, companyId, mark.userId, now);
  if (used + batch > mark.dailyLimit) {
    throw new StudioError(
      `That's ${used} of ${mark.dailyLimit} board generations today (UTC) for this person, so nothing was started. The count starts again at midnight UTC; a company owner can change the limit in Studio's settings.`,
      BOARD_DAILY_LIMIT,
    );
  }
  return used;
}

export async function assertBoardGenerationOn(config: StudioConfig): Promise<void> {
  if (!(await config.boardGenerationOn())) throw new StudioError("Generating from boards is switched off in Studio's settings.", BOARD_GENERATION_OFF);
}

/**
 * The person path (a card click, or its estimate): checks the switches and the person, and returns the project that
 * decides who pays plus the mark for the row. Viewers are refused by the caller (`canGenerate`).
 */
export async function boardGenerationFor(ctx: PluginContext, companyId: string, board: BoardScope, params: Record<string, unknown>, userId: string, restriction: ActingRestriction) {
  if (params.client !== undefined && params.client !== null && params.client !== "") {
    throw new StudioError("A board pays for its own work (its project's client, or own work), so a client can't be picked here.", "bad_board_scope");
  }
  const config = new StudioConfig(ctx, companyId);
  await assertBoardGenerationOn(config);
  const target = await boardTarget(ctx, companyId, board, config);
  assertOpenToPerson(target.client, restriction);
  const mark: BoardMark = { userId, dailyLimit: await config.boardGenerationDailyLimit(), inputKeys: inputKeysOf(params.inputKeys) };
  return { projectId: board.projectId, mark, client: target.client, clientName: target.clientName };
}

/**
 * The agent path (stage 3d): a `studio-generate` call from a run bound to a board chat thread counts against the
 * run's acting person. Null when neither the run's own issue nor the named one is a board thread. A thread run with no
 * person is refused: the count would have no one to count against.
 */
export async function boardMarkForRun(ctx: PluginContext, run: ToolRunContext, namedIssueId: string | null): Promise<BoardMark | null> {
  let runIssueId: string | null = null;
  let actingUserId: string | null = null;
  try {
    const rows = await ctx.db.query<{ issue_id: string | null; responsible_user_id: string | null }>(
      "SELECT context_snapshot->>'issueId' AS issue_id, responsible_user_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
      [run.runId, run.companyId, run.agentId],
    );
    runIssueId = rows[0]?.issue_id || null;
    actingUserId = rows[0]?.responsible_user_id || null;
  } catch {
    // No run row: decided below from the named issue alone.
  }
  let thread = false;
  for (const id of new Set([runIssueId, namedIssueId].filter((v): v is string => Boolean(v)))) {
    const issue = await ctx.issues.get(id, run.companyId).catch(() => null);
    // Core's shared origin list doesn't name this kind yet; the host sends it as stored.
    if ((issue?.originKind as string | undefined) === PLANNING_CANVAS_ORIGIN) thread = true;
  }
  if (!thread) return null;
  const config = new StudioConfig(ctx, run.companyId);
  await assertBoardGenerationOn(config);
  if (!actingUserId) throw new StudioError("This run works from a board's chat but carries no person, so its board generation can't be counted. Nothing was started.", "board_no_person");
  return { userId: actingUserId, dailyLimit: await config.boardGenerationDailyLimit(), inputKeys: [] };
}

/** One generation's state for its output card, checked against the board like a file. */
export async function boardGenerationState(ctx: PluginContext, companyId: string, board: BoardScope, generationId: string, restriction: ActingRestriction) {
  const target = await boardTarget(ctx, companyId, board);
  const rows = await ctx.db.query<{ id: string; status: string; asset_id: string | null; client_kind: string | null; client_ref: string | null; error_message: string | null; model: string }>(
    `SELECT id, status, asset_id, client_kind, client_ref, error_message, model FROM ${table(ctx, "generations")} WHERE company_id = $1 AND id = $2`,
    [companyId, generationId],
  );
  const row = rows[0];
  if (!row) throw new StudioError("That generation is not in this company.", "unknown_generation");
  const scope = (row.client_ref ? { kind: row.client_kind, id: row.client_ref } : null) as ClientScope;
  if (!onBoard(scope, target)) throw new StudioError("That generation is not this board's work.", WRONG_BOARD);
  assertOpenToPerson(scope, restriction);
  return { id: row.id, status: row.status, assetId: row.asset_id, model: row.model, error: row.status === "failed" ? row.error_message : null };
}
