import type {
  CreatePlanningCanvas,
  PlanningCanvasAccessLevel,
  PlanningCanvasBoard,
  PlanningCanvasBoardRead,
  PlanningCanvasComment,
  PlanningCanvasItemsRead,
  PlanningCanvasOpBatch,
  PlanningCanvasOpBatchResponse,
  UpdatePlanningCanvas,
  CreatePlanningCanvasComment,
} from "@paperclipai/shared";
import { api, requestResponse } from "./client";

/** A full board read: the legacy `data` blob plus the item rows and the caller's access. */
export type PlanningCanvasBoardWithItems = PlanningCanvasBoardRead & { access?: PlanningCanvasAccessLevel };

/** A linked issue of a thread: live status, or `hidden` when the reader may not see it. */
export type PlanningCanvasLinkedIssue =
  | { id: string; identifier: string | null; title: string; status: string; assigneeAgentId: string | null; hidden?: undefined }
  | { id: string; hidden: true };

export interface PlanningCanvasIssueComment {
  issueId: string;
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

/** `GET .../comments`: with a thread query, also the linked issues and their comments. */
export interface PlanningCanvasCommentsRead {
  comments: PlanningCanvasComment[];
  linkedIssues: PlanningCanvasLinkedIssue[];
  issueComments: PlanningCanvasIssueComment[];
}

const boardPath = (companyId: string, boardId: string) => `/companies/${companyId}/planning-canvases/${boardId}`;

export const planningCanvasesApi = {
  list: (companyId: string) =>
    api.get<PlanningCanvasBoard[]>(`/companies/${companyId}/planning-canvases`, { cache: "no-store" }),

  get: (companyId: string, boardId: string) =>
    api.get<PlanningCanvasBoardWithItems>(boardPath(companyId, boardId), { cache: "no-store" }),

  /** Items changed after `since` (tombstones included), or `{ resync: true }` below the purge line. */
  readSince: (companyId: string, boardId: string, since: number) =>
    api.get<PlanningCanvasItemsRead>(`${boardPath(companyId, boardId)}?since=${since}`, { cache: "no-store" }),

  /** One op batch (plan B.2-B.4). The same `clientBatchId` replays the stored results. */
  applyOps: (companyId: string, boardId: string, batch: PlanningCanvasOpBatch) =>
    api.post<PlanningCanvasOpBatchResponse>(`${boardPath(companyId, boardId)}/ops`, batch),

  /** Fire-and-forget batch for `beforeunload`: the browser keeps it alive after the page goes. */
  applyOpsKeepalive: (companyId: string, boardId: string, batch: PlanningCanvasOpBatch) => {
    void requestResponse(`${boardPath(companyId, boardId)}/ops`, {
      method: "POST",
      body: JSON.stringify(batch),
      keepalive: true,
    }).catch(() => undefined);
  },

  /** Every comment of the board (no linked issues): drives the pins. */
  listComments: (companyId: string, boardId: string) =>
    api.get<PlanningCanvasCommentsRead>(`${boardPath(companyId, boardId)}/comments`, { cache: "no-store" }),

  /** One thread (a node, or `null` for the board thread) with its linked issues and their comments. */
  readThread: (companyId: string, boardId: string, itemKey: string | null) =>
    api.get<PlanningCanvasCommentsRead>(
      `${boardPath(companyId, boardId)}/comments?${itemKey === null ? "thread=board" : `itemKey=${encodeURIComponent(itemKey)}`}`,
      { cache: "no-store" },
    ),

  createComment: (companyId: string, boardId: string, data: CreatePlanningCanvasComment) =>
    api.post<PlanningCanvasComment>(`${boardPath(companyId, boardId)}/comments`, data),

  resolveComment: (companyId: string, boardId: string, commentId: string, resolved: boolean) =>
    api.post<PlanningCanvasComment>(`${boardPath(companyId, boardId)}/comments/${commentId}/resolve`, { resolved }),

  create: (companyId: string, data: CreatePlanningCanvas) =>
    api.post<PlanningCanvasBoard>(`/companies/${companyId}/planning-canvases`, data),

  update: (companyId: string, boardId: string, data: UpdatePlanningCanvas) =>
    api.patch<PlanningCanvasBoard>(boardPath(companyId, boardId), data),

  remove: (companyId: string, boardId: string) =>
    api.delete<{ deleted: true }>(boardPath(companyId, boardId)),
};
