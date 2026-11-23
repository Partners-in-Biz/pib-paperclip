import type {
  CreatePlanningCanvas,
  PlanningCanvasAccessLevel,
  PlanningCanvasAgentGrant,
  PlanningCanvasBoard,
  PlanningCanvasBoardSharing,
  PlanningCanvasBoardRead,
  PlanningCanvasHandoff,
  PlanningCanvasItemsRead,
  PlanningCanvasOpBatch,
  PlanningCanvasOpBatchResponse,
  UpdatePlanningCanvasSharing,
  UpdatePlanningCanvas,
} from "@paperclipai/shared";
import { api, requestResponse } from "./client";

/** A full board read: the legacy `data` blob plus the item rows and the caller's access. */
export type PlanningCanvasBoardWithItems = PlanningCanvasBoardRead & { access?: PlanningCanvasAccessLevel };

/** A board in the list: the board plus its sharing fields and the caller's access (C3). */
export type PlanningCanvasListItem = PlanningCanvasBoard & Partial<PlanningCanvasBoardSharing> & { access?: PlanningCanvasAccessLevel };
export interface PlanningCanvasListFilter { archived?: boolean; scope?: PlanningCanvasBoardSharing["scope"]; projectId?: string }
export interface PlanningCanvasAgentGrantsRead { enabled: boolean; grants: PlanningCanvasAgentGrant[] }

/** `{ id, hidden: true }` stands for an id the reader may not read (or that does not exist). */
export type PlanningCanvasHiddenRef = { id: string; hidden: true };
export interface PlanningCanvasIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
}
export interface PlanningCanvasAgentRef { id: string; name: string; title: string | null; icon: string | null; status: string }
export interface PlanningCanvasProjectRef { id: string; name: string; status: string; color: string | null; targetDate: string | null; archivedAt: string | null }
export interface PlanningCanvasGoalRef { id: string; title: string; level: string; status: string; parentId: string | null }
/** `GET .../refs` (C8): live summaries of every entity the board links to, for this reader. */
export interface PlanningCanvasRefsRead {
  issues: Array<PlanningCanvasIssueRef | PlanningCanvasHiddenRef>;
  agents: Array<PlanningCanvasAgentRef | PlanningCanvasHiddenRef>;
  projects: Array<PlanningCanvasProjectRef | PlanningCanvasHiddenRef>;
  goals: Array<PlanningCanvasGoalRef | PlanningCanvasHiddenRef>;
  truncated: boolean;
}
export interface PlanningCanvasHandoffRead {
  mode: PlanningCanvasHandoff["mode"];
  replayed: boolean;
  issues: Array<(PlanningCanvasIssueRef | PlanningCanvasHiddenRef) & { itemKeys: string[] }>;
}

const boardPath = (companyId: string, boardId: string) => `/companies/${companyId}/planning-canvases/${boardId}`;

export const planningCanvasesApi = {
  list: (companyId: string, filter: PlanningCanvasListFilter = {}) => {
    const query = new URLSearchParams();
    if (filter.archived) query.set("archived", "true");
    if (filter.scope) query.set("scope", filter.scope);
    if (filter.projectId) query.set("projectId", filter.projectId);
    const suffix = query.size > 0 ? `?${query}` : "";
    return api.get<PlanningCanvasListItem[]>(`/companies/${companyId}/planning-canvases${suffix}`, { cache: "no-store" });
  },

  /** Owner widens; owner or admin narrows. Leaving `personal` needs an explicit `memberAccess` (Q15). */
  setSharing: (companyId: string, boardId: string, body: UpdatePlanningCanvasSharing) =>
    api.patch<PlanningCanvasBoardSharing & { id: string; userId: string | null }>(`${boardPath(companyId, boardId)}/sharing`, body),

  agentGrants: (companyId: string, boardId: string) =>
    api.get<PlanningCanvasAgentGrantsRead>(`${boardPath(companyId, boardId)}/agent-grants`, { cache: "no-store" }),

  revokeAgentGrant: (companyId: string, boardId: string, grantId: string) =>
    api.delete<PlanningCanvasAgentGrant>(`${boardPath(companyId, boardId)}/agent-grants/${grantId}`),

  archive: (companyId: string, boardId: string) =>
    api.post<{ id: string; archivedAt: string | null }>(`${boardPath(companyId, boardId)}/archive`, {}),

  restore: (companyId: string, boardId: string) =>
    api.post<{ id: string; archivedAt: string | null }>(`${boardPath(companyId, boardId)}/restore`, {}),

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

  refs: (companyId: string, boardId: string) =>
    api.get<PlanningCanvasRefsRead>(`${boardPath(companyId, boardId)}/refs`, { cache: "no-store" }),

  handoff: (companyId: string, boardId: string, body: PlanningCanvasHandoff) =>
    api.post<PlanningCanvasHandoffRead>(`${boardPath(companyId, boardId)}/handoff`, body),

  create: (companyId: string, data: CreatePlanningCanvas) =>
    api.post<PlanningCanvasBoard>(`/companies/${companyId}/planning-canvases`, data),

  update: (companyId: string, boardId: string, data: UpdatePlanningCanvas) =>
    api.patch<PlanningCanvasBoard>(boardPath(companyId, boardId), data),

  remove: (companyId: string, boardId: string) =>
    api.delete<{ deleted: true }>(boardPath(companyId, boardId)),
};
