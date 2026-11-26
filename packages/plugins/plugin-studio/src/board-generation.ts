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
import { formatClientParam, sameClient, type ActingRestriction, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { boardTarget, isBoardId, onBoard, WRONG_BOARD, type BoardScope } from "./board-scope.js";
import { StudioConfig } from "./config.js";
import { num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { assertOpenToPerson, scopeInput, type ResolvedScope } from "./scope.js";

export const BOARD_ORIGIN = "board";
export const BOARD_CLIENT_CHANGED = "board_client_changed";
export const BOARD_AMBIGUOUS = "board_ambiguous";
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
  return { projectId: board.projectId, mark, client: target.client, clientName: target.clientName, scope: { scope: target.client, client: target.crm } satisfies ResolvedScope };
}

/**
 * A board generate that names its board (PAR-14835 Approach 4) carries the client its estimate showed. A link changed
 * since then refuses with `board_client_changed` before anything is priced or reserved.
 */
export function assertExpectedClient(params: Record<string, unknown>, client: ClientScope): void {
  if (!("expectedClient" in params) || params.expectedClient === undefined) {
    throw new StudioError("expectedClient is required with boardScope.boardId: the client the estimate showed (null for own work).", "bad_request");
  }
  const expected = scopeInput({ client: params.expectedClient }) ?? null;
  if (!sameClient(expected, client)) {
    throw new StudioError("This board's client changed since the estimate, so nothing was started. Check the new estimate and confirm again.", BOARD_CLIENT_CHANGED);
  }
}

/** The board a chat thread issue belongs to: `originId` is `<boardId>` or `<boardId>:<itemKey>` (core's planning canvas comments). */
function threadBoardId(originId: unknown): string | null {
  if (typeof originId !== "string") return null;
  const id = originId.split(":")[0] ?? "";
  return isBoardId(id) ? id.toLowerCase() : null;
}

/** A run bound to a board chat thread: the mark for the daily count, and the board that decides who pays. */
export interface BoardRun {
  mark: BoardMark;
  board: Required<BoardScope>;
}

/**
 * The agent path (stage 3d): a `studio-generate` call from a run bound to a board chat thread counts against the
 * run's acting person. Null when neither the run's own issue nor the named one is a board thread. A thread run with no
 * person is refused: the count would have no one to count against.
 */
export async function boardMarkForRun(ctx: PluginContext, run: ToolRunContext, namedIssueId: string | null): Promise<BoardMark | null> {
  return (await boardRunFor(ctx, run, namedIssueId))?.mark ?? null;
}

/**
 * `boardMarkForRun` plus the thread's board (PAR-14835 Approach 5): the board id comes from core's thread issue, never
 * from the agent, and its project is the thread issue's. Two threads of different boards refuse with `board_ambiguous`.
 */
export async function boardRunFor(ctx: PluginContext, run: ToolRunContext, namedIssueId: string | null): Promise<BoardRun | null> {
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
  const boards = new Map<string, Required<BoardScope>>();
  let thread = false;
  for (const id of new Set([runIssueId, namedIssueId].filter((v): v is string => Boolean(v)))) {
    const issue = await ctx.issues.get(id, run.companyId).catch(() => null);
    // Core's shared origin list doesn't name this kind yet; the host sends it as stored.
    if ((issue?.originKind as string | undefined) !== PLANNING_CANVAS_ORIGIN) continue;
    thread = true;
    const boardId = threadBoardId((issue as { originId?: unknown }).originId);
    if (!boardId) throw new StudioError("This run works from a board's chat, but Studio can't tell which board. Nothing was started.", BOARD_AMBIGUOUS);
    const projectId = issue?.projectId ? String(issue.projectId) : null;
    const key = `${boardId}|${projectId ?? ""}`;
    if (!boards.has(key)) boards.set(key, { boardId, projectId });
  }
  if (!thread) return null;
  if (boards.size > 1) throw new StudioError("This run works from the chats of two different boards, so Studio can't tell which board pays. Nothing was started.", BOARD_AMBIGUOUS);
  const config = new StudioConfig(ctx, run.companyId);
  await assertBoardGenerationOn(config);
  if (!actingUserId) throw new StudioError("This run works from a board's chat but carries no person, so its board generation can't be counted. Nothing was started.", "board_no_person");
  return { mark: { userId: actingUserId, dailyLimit: await config.boardGenerationDailyLimit(), inputKeys: [] }, board: [...boards.values()][0]! };
}

/**
 * Whose work a board-thread run's generation is (PAR-14835 Approach 5): the board's client, as on a card click. No
 * `client` from the agent means the board's; the same client is fine; any other is refused with `wrong_client`.
 */
export async function scopeForBoardRun(ctx: PluginContext, companyId: string, board: BoardScope, requested: ClientScope | undefined): Promise<ResolvedScope> {
  const target = await boardTarget(ctx, companyId, board);
  if (requested !== undefined && !sameClient(requested, target.client)) {
    const whose = target.clientName ?? "own work";
    const param = target.client ? `client ${formatClientParam(target.client)}` : "no client";
    throw new StudioError(`This work is on a board for ${whose}, so it can only use ${whose}'s Studio files (${param}).`, "wrong_client");
  }
  return { scope: target.client, client: target.crm };
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
