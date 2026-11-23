import { updatePlanningCanvasSharingSchema } from "@paperclipai/shared";
import type { PlanningCanvasOpenApiRoute } from "./core.js";

const BOARD = "/api/companies/{companyId}/planning-canvases/{boardId}";

/** OpenAPI entries of `routes/planning-canvas-sharing.ts`. C3 registers the paths; C3b writes the full descriptions. */
export const PLANNING_CANVAS_SHARING_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  {
    method: "patch",
    path: `${BOARD}/sharing`,
    tags: ["planning-canvases"],
    summary: "Change who can open a planning canvas board",
    body: updatePlanningCanvasSharingSchema,
  },
  {
    method: "get",
    path: `${BOARD}/agent-grants`,
    tags: ["planning-canvases"],
    summary: "List the agent grants of a personal planning canvas board",
  },
  {
    method: "delete",
    path: `${BOARD}/agent-grants/{grantId}`,
    tags: ["planning-canvases"],
    summary: "Revoke one agent grant of a planning canvas board",
  },
];
