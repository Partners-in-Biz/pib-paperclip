import type {
  CreatePlanningCanvas,
  PlanningCanvasBoard,
  UpdatePlanningCanvas,
} from "@paperclipai/shared";
import { api } from "./client";

export const planningCanvasesApi = {
  list: (companyId: string) =>
    api.get<PlanningCanvasBoard[]>(`/companies/${companyId}/planning-canvases`, { cache: "no-store" }),

  get: (companyId: string, boardId: string) =>
    api.get<PlanningCanvasBoard>(`/companies/${companyId}/planning-canvases/${boardId}`, { cache: "no-store" }),

  create: (companyId: string, data: CreatePlanningCanvas) =>
    api.post<PlanningCanvasBoard>(`/companies/${companyId}/planning-canvases`, data),

  update: (companyId: string, boardId: string, data: UpdatePlanningCanvas) =>
    api.patch<PlanningCanvasBoard>(`/companies/${companyId}/planning-canvases/${boardId}`, data),

  remove: (companyId: string, boardId: string) =>
    api.delete<{ deleted: true }>(`/companies/${companyId}/planning-canvases/${boardId}`),
};
