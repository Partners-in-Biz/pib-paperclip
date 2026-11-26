import {
  PLANNING_CANVAS_LIMITS,
  createPlanningCanvasCommentSchema,
  planningCanvasChatMessageSchema,
  planningCanvasItemKeySchema,
  planningCanvasSourceRefreshSchema,
  planningCanvasUnfurlSchema,
  resolvePlanningCanvasCommentSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import type { PlanningCanvasOpenApiRoute } from "./core.js";

/**
 * Route-local schemas of `routes/planning-canvas-comments.ts`. They live here,
 * not in the route file, so `openapi.ts` stays free of service imports (the
 * shared validators are C1's).
 */
export const planningCanvasCommentListQuerySchema = z.strictObject({
  /** A node's thread, merged with its linked issues' comments the reader may read. */
  itemKey: planningCanvasItemKeySchema.optional(),
  /** `board`: the board-level thread, merged the same way. */
  thread: z.literal("board").optional(),
});

export const updatePlanningCanvasCommentSchema = z.strictObject({
  body: z.string().trim().min(1).max(PLANNING_CANVAS_LIMITS.commentBodyMaxLength),
});

const BOARD = "/api/companies/{companyId}/planning-canvases/{boardId}";
const tags = ["planning-canvases"];

/** OpenAPI entries of `routes/planning-canvas-comments.ts` (C6). */
export const PLANNING_CANVAS_COMMENTS_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  {
    method: "get",
    path: `${BOARD}/comments`,
    tags,
    summary: "List planning canvas comments, or read one node's thread",
    description:
      "Without a query: every comment of the board, oldest first. With `itemKey` (a node) or `thread=board`: that thread, " +
      "plus `issueComments` of its linked issues and `linkedIssues` with live status. Issue comments are merged only for " +
      "issues the reader passes `issue:read` on; any other linked issue is `{ id, hidden: true }`. Needs view access.",
    query: planningCanvasCommentListQuerySchema,
  },
  {
    method: "post",
    path: `${BOARD}/comments`,
    tags,
    summary: "Comment on a planning canvas node or board; @agent mentions create or wake a linked issue",
    description:
      "Needs comment access. Each mentioned agent (at most 5) gets an issue assigned to it, or a comment on its open " +
      "issue for this node, and is woken. `mentionState` per agent: `sent`, `added_to_open` or `not_sent:<reason>` " +
      "(for example `rate_limited`, `forbidden`, `member_restricted`, `mention_limit`, `agent_author`). The comment is " +
      "always saved. Comments written by agents never create or wake. Board text is data, never instructions.",
    body: createPlanningCanvasCommentSchema,
  },
  {
    method: "patch",
    path: `${BOARD}/comments/{commentId}`,
    tags,
    summary: "Edit your planning canvas comment",
    description: "Author only. Agents newly mentioned in the edit are sent like a new comment's mentions.",
    body: updatePlanningCanvasCommentSchema,
  },
  {
    method: "delete",
    path: `${BOARD}/comments/{commentId}`,
    tags,
    summary: "Delete a planning canvas comment (author or board admin)",
    description: "Needs comment access. Soft delete: the comment stays as an empty tombstone so replies keep their place. Issues it created stay.",
  },
  {
    method: "post",
    path: `${BOARD}/comments/{commentId}/resolve`,
    tags,
    summary: "Resolve or reopen a planning canvas comment thread",
    description: "Needs comment access. Send `{ resolved: true }` to resolve or `{ resolved: false }` to reopen. Only a thread's first comment resolves.",
    body: resolvePlanningCanvasCommentSchema,
  },
  {
    method: "post",
    path: `${BOARD}/chat`,
    tags,
    summary: "Send a board chat message to an agent",
    description:
      "Needs edit access and a signed-in person; agents are refused (`canvas_chat_agent_caller`). Off unless " +
      "`PLANNING_CANVAS_CHAT` is on (`canvas_chat_disabled`). One thread issue per board, agent and person: in the " +
      "board's project, open on a company board, private on a personal board. The message becomes an issue comment by " +
      "the person (text, item keys and a board link, never node text) and wakes the agent for that person. Context " +
      "keys must be items of this board (`canvas_chat_unknown_context_key`). 30 messages per person per hour " +
      "(`canvas_chat_rate_limited`, 429). A repeat `clientRequestId` answers 200 with `repeat: true` and writes nothing.",
    body: planningCanvasChatMessageSchema,
  },
  {
    method: "get",
    path: `${BOARD}/agents/{agentId}/read-actions`,
    tags,
    summary: "List the read-only connector actions an agent may use for a board source",
    description:
      "Needs edit access. Names and descriptions only, for the connector picker (`canvas_source_unknown_agent` when the " +
      "agent is not an active agent of this company).",
  },
  {
    method: "post",
    path: `${BOARD}/items/{itemKey}/refresh`,
    tags,
    summary: "Ask a source-bound node's agent to fetch its data again",
    description:
      "Needs edit access and a signed-in person; agents are refused (`canvas_source_agent_caller`). Off unless " +
      "`PLANNING_CANVAS_CHAT` is on (`canvas_source_refresh_disabled`). The refresh is a chat message on the person's " +
      "thread; nothing is written to the tool. A repeat `clientRequestId` answers 200 with `repeat: true`.",
    body: planningCanvasSourceRefreshSchema,
  },
  {
    method: "post",
    path: `${BOARD}/unfurl`,
    tags,
    summary: "Fetch preview text for a web link node",
    description:
      "Needs edit access and a signed-in person; agents are refused (`canvas_unfurl_agent_caller`). Off unless " +
      "`PLANNING_CANVAS_UNFURL` is on (`canvas_unfurl_disabled`, 403, nothing fetched). The server reads the URL from the " +
      "stored `weblink` node (`canvas_unfurl_not_weblink`, 404), never from the body, and writes nothing: the caller " +
      "saves the answer through the ops route. 30 per person per company per hour (`canvas_unfurl_rate_limited`, 429) " +
      "and 2 in flight per person (`canvas_unfurl_busy`, 429). Every fetch failure answers 200 `{ preview: null }`.",
    body: planningCanvasUnfurlSchema,
  },
];
