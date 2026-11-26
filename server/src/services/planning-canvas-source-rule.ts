import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, planningCanvases, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";

/**
 * Connector rule of Planning Canvas phase 2 (plan PAR-14257 C "Interfaces",
 * G.2; acceptance PAR-14282 s.2). A run started from a board that is not the
 * acting person's own personal board may not use a personal credential.
 *
 * The board is read from the run's bound issue (`boundRunIssueIdSql`), never
 * from an `issueId` a caller supplied when it opened the gateway session.
 * Origin kinds the rule covers: `planning_canvas` (board chat threads, phase 1
 * mention issues and the single hand-off issue: every origin id starts with the
 * board id) and `planning_canvas_flow` (wave 3). `planning_canvas_handoff` and
 * `planning_canvas_blueprint` are out of scope and pass unchanged.
 *
 * Fail closed: when the lookup throws, the run is unknown, the bound issue is
 * missing or hidden, the board is missing, or the session names an issue the
 * run is not bound to, the answer is a refusal. A run with no bound issue and
 * no session issue is no board run, so the rule does not apply (it keeps
 * delegated personal grants of timer runs working).
 */

export const PLANNING_CANVAS_FLOW_ORIGIN_KIND = "planning_canvas_flow";
export const CANVAS_SOURCE_RULE_ORIGIN_KINDS: ReadonlySet<string> = new Set(["planning_canvas", PLANNING_CANVAS_FLOW_ORIGIN_KIND]);

export type CanvasPersonalSourceVerdict =
  | { refused: false; reason: "not_board_run" | "own_personal_board" }
  | {
      refused: true;
      reason:
        | "lookup_failed"
        | "run_not_found"
        | "unbound_run_with_issue"
        | "issue_missing"
        | "board_missing"
        | "not_own_personal_board";
    };

export interface CanvasPersonalSourceInput {
  companyId: string;
  runId: string | null;
  /** The session's issue. Only used to detect a session that names an issue its run is not bound to. */
  sessionIssueId: string | null;
  /** The person whose grant would be used (the run's acting person). */
  actingUserId: string | null;
}

type OriginRow = {
  issueId: string | null;
  originKind: string | null;
  originId: string | null;
  hiddenAt: Date | null;
  boardId: string | null;
  boardScope: string | null;
  boardUserId: string | null;
};

const refused = (reason: Extract<CanvasPersonalSourceVerdict, { refused: true }>["reason"]): CanvasPersonalSourceVerdict => ({
  refused: true,
  reason,
});

/** The board's id is the origin id up to the first `:` (`<boardId>`, `<boardId>:<itemKey>`, `<boardId>:chat`). */
export function canvasOriginBoardId(originId: string | null) {
  const head = (originId ?? "").split(":", 1)[0]?.trim() ?? "";
  return head || null;
}

/** Own personal board: scope personal and owned by the acting person. A personal board has no per-person shares; widening it changes its scope. */
export function isOwnPersonalCanvasBoard(board: { scope: string | null; userId: string | null }, actingUserId: string | null) {
  return Boolean(actingUserId) && board.scope === "personal" && board.userId === actingUserId;
}

function verdictForRow(row: OriginRow | undefined, actingUserId: string | null): CanvasPersonalSourceVerdict {
  if (!row?.issueId || row.hiddenAt) return refused("issue_missing");
  if (!row.originKind || !CANVAS_SOURCE_RULE_ORIGIN_KINDS.has(row.originKind)) return { refused: false, reason: "not_board_run" };
  if (!row.boardId) return refused("board_missing");
  if (!isOwnPersonalCanvasBoard({ scope: row.boardScope, userId: row.boardUserId }, actingUserId)) {
    return refused("not_own_personal_board");
  }
  return { refused: false, reason: "own_personal_board" };
}

function originColumns() {
  return {
    issueId: issues.id,
    originKind: issues.originKind,
    originId: issues.originId,
    hiddenAt: issues.hiddenAt,
    boardId: planningCanvases.id,
    boardScope: planningCanvases.scope,
    boardUserId: planningCanvases.userId,
  };
}

const boardJoin = () =>
  and(
    sql`${planningCanvases.id}::text = split_part(${issues.originId}, ':', 1)`,
    eq(planningCanvases.companyId, issues.companyId),
  );

export async function canvasPersonalSourceVerdict(db: Db, input: CanvasPersonalSourceInput): Promise<CanvasPersonalSourceVerdict> {
  try {
    if (input.runId) {
      // One select: the run's bound issue, its origin and the board the origin names.
      const [row] = await db
        .select({ runId: heartbeatRuns.id, boundIssueId: boundRunIssueIdSql(), ...originColumns() })
        .from(heartbeatRuns)
        .leftJoin(issues, and(sql`${issues.id}::text = ${boundRunIssueIdSql()}`, eq(issues.companyId, heartbeatRuns.companyId)))
        .leftJoin(planningCanvases, boardJoin())
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .limit(1);
      if (!row) return refused("run_not_found");
      if (!row.boundIssueId) return input.sessionIssueId ? refused("unbound_run_with_issue") : { refused: false, reason: "not_board_run" };
      return verdictForRow(row, input.actingUserId);
    }
    // No run (a gateway token bound by the server): its issue, if any, decides.
    if (!input.sessionIssueId) return { refused: false, reason: "not_board_run" };
    const [row] = await db
      .select(originColumns())
      .from(issues)
      .leftJoin(planningCanvases, boardJoin())
      .where(and(eq(issues.id, input.sessionIssueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    return verdictForRow(row, input.actingUserId);
  } catch (err) {
    logger.warn({ err, companyId: input.companyId, runId: input.runId }, "planning canvas source rule lookup failed; refusing personal credentials");
    return refused("lookup_failed");
  }
}
