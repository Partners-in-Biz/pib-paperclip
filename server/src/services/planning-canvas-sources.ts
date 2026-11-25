import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, planningCanvasItems, type Db, type planningCanvases } from "@paperclipai/db";
import {
  PLANNING_CANVAS_SOURCE_ERROR_CODES as CODES,
  type PlanningCanvasNodeFields,
  type PlanningCanvasReadAction,
  type PlanningCanvasSourceRefresh,
  type PlanningCanvasSourceRefreshResult,
  type PlanningCanvasTableData,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { planningCanvasChatOriginId, planningCanvasChatService, type PlanningCanvasChatContext } from "./planning-canvas-chat.js";
import { PLANNING_CANVAS_ISSUE_ORIGIN_KIND, type PlanningCanvasCommentsDeps } from "./planning-canvas-comments.js";
import type { PlanningCanvasSourceWriter } from "./planning-canvas-ops.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";

/**
 * Connector nodes on a board (plan PAR-14257 B.3 A, D 4a; acceptance
 * PAR-14282 s.3, s.4).
 *
 * - Read actions: the connector actions an agent may use that the catalog marks
 *   read-only, from the same gateway function the refresh re-checks with.
 * - Source writer: a table `source` is accepted only from an agent run bound to
 *   a board chat thread of the same board that works for a person; the server
 *   stamps that person (`fetchedBy`), the agent and the thread.
 * - Refresh: a comment by the refresher on the refresher's own thread with the
 *   source's agent, woken with `wakeCommentId` (the board chat path), so the
 *   refresh run works for the refresher and the gateway rule runs again.
 */

export const PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT = "planning_canvas.source_refresh";
/** Agents that would not run a wake. */
const INACTIVE_AGENT_STATUSES = new Set(["terminated", "pending_approval", "paused"]);

type BoardRow = typeof planningCanvases.$inferSelect;
type ReadActionLister = (input: { companyId: string; agentId: string }) => Promise<PlanningCanvasReadAction[]>;

export interface PlanningCanvasSourcesDeps extends PlanningCanvasCommentsDeps {
  /** Test seam; defaults to the tool gateway's `listCanvasReadActionsForAgent`. */
  listReadActions?: ReadActionLister;
}

function codeError(status: number, message: string, code: string) {
  return new HttpError(status, message, { code });
}

/** The fixed refresh message: the item key travels in the context line, never the tool, params or node text. */
export const PLANNING_CANVAS_SOURCE_REFRESH_TEXT =
  "Refresh request: run the saved read action of this source-bound table again and replace its rows. " +
  "Read the node through the board API.";

/**
 * The writer of a table `source` for one ops call, or null. Only an agent run
 * (its run id is signed or checked by the auth middleware) that works for a
 * person and whose bound issue is a live board chat thread of this board,
 * assigned to that agent.
 */
export async function planningCanvasSourceWriterFor(
  db: Db,
  actor: { type: string; agentId?: string; runId?: string; onBehalfOfUserId?: string | null },
  board: Pick<BoardRow, "id" | "companyId">,
): Promise<PlanningCanvasSourceWriter | null> {
  if (actor.type !== "agent" || !actor.agentId) return null;
  const personId = actor.onBehalfOfUserId?.trim() || null;
  const runId = actor.runId?.trim() || null;
  if (!personId || !runId) return null;
  const [row] = await db
    .select({ issueId: issues.id })
    .from(heartbeatRuns)
    .innerJoin(issues, and(sql`${issues.id}::text = ${boundRunIssueIdSql()}`, eq(issues.companyId, heartbeatRuns.companyId)))
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, board.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
        eq(issues.originKind, PLANNING_CANVAS_ISSUE_ORIGIN_KIND),
        eq(issues.originId, planningCanvasChatOriginId(board.id)),
        eq(issues.assigneeAgentId, actor.agentId),
        isNull(issues.hiddenAt),
      ),
    )
    .limit(1);
  return row ? { personId, agentId: actor.agentId, issueId: row.issueId } : null;
}

export function planningCanvasSourcesService(db: Db, deps: PlanningCanvasSourcesDeps = {}) {
  const chat = planningCanvasChatService(db, deps);
  let lister = deps.listReadActions;
  // Loaded on first use: the canvas ops route imports this file and needs no gateway.
  const listReadActions: ReadActionLister = (input) =>
    (lister ??= async (args) => (await import("./tool-gateway.js")).createToolGatewayService(db).listCanvasReadActionsForAgent(args))(input);

  async function assertActiveAgent(companyId: string, agentId: string) {
    const [agent] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent || INACTIVE_AGENT_STATUSES.has(agent.status)) {
      throw codeError(422, "Agent not found or not active in this company", CODES.unknownAgent);
    }
  }

  return {
    /** Read-only connector actions this agent may use. Names and descriptions only. */
    async readActions(companyId: string, agentId: string) {
      await assertActiveAgent(companyId, agentId);
      return listReadActions({ companyId, agentId });
    },

    async refresh(
      ctx: Omit<PlanningCanvasChatContext, "askerUserId"> & { refresherUserId: string },
      itemKey: string,
      input: PlanningCanvasSourceRefresh,
    ): Promise<PlanningCanvasSourceRefreshResult> {
      const { board } = ctx;
      const [item] = await db
        .select({ itemType: planningCanvasItems.itemType, kind: planningCanvasItems.kind, data: planningCanvasItems.data })
        .from(planningCanvasItems)
        .where(
          and(
            eq(planningCanvasItems.boardId, board.id),
            eq(planningCanvasItems.companyId, board.companyId),
            eq(planningCanvasItems.itemKey, itemKey),
            isNull(planningCanvasItems.deletedAt),
          ),
        );
      const source =
        item?.itemType === "node" && item.kind === "table"
          ? ((item.data as PlanningCanvasNodeFields).data as PlanningCanvasTableData | undefined)?.source
          : undefined;
      if (!source?.agentId || !source.tool) throw codeError(422, "This item has no connector source", CODES.noSource);
      // The same checks as a chat message, then the same list as the picker: a
      // write action or a tool no longer allowed is refused before anything is written.
      await assertActiveAgent(board.companyId, source.agentId);
      const allowed = await listReadActions({ companyId: board.companyId, agentId: source.agentId });
      if (!allowed.some((action) => action.tool === source.tool)) {
        throw codeError(409, "The source's action is not a read action this agent may use", CODES.toolNotAllowed);
      }
      const result = await chat.send(
        { board, askerUserId: ctx.refresherUserId, issuePrefix: ctx.issuePrefix, guard: ctx.guard, now: ctx.now },
        {
          agentId: source.agentId,
          body: PLANNING_CANVAS_SOURCE_REFRESH_TEXT,
          context: { itemKeys: [itemKey] },
          clientRequestId: input.clientRequestId,
        },
        { contextSource: PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT },
      );
      return { ...result, itemKey, agentId: source.agentId };
    },
  };
}
