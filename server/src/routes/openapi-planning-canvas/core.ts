import type { z } from "zod";
import { createPlanningCanvasSchema, planningCanvasOpBatchSchema, updatePlanningCanvasSchema } from "@paperclipai/shared";
import { PLANNING_CANVAS_BLUEPRINTS_OPENAPI_ROUTES } from "./blueprints.js";
import { PLANNING_CANVAS_COMMENTS_OPENAPI_ROUTES } from "./comments.js";
import { PLANNING_CANVAS_LINKS_OPENAPI_ROUTES } from "./links.js";
import { PLANNING_CANVAS_SHARING_OPENAPI_ROUTES } from "./sharing.js";

/**
 * OpenAPI entries of the Planning Canvas routes (plan PAR-13925 G). One file
 * per route file, so the canvas tickets never edit `openapi.ts`: it imports
 * `PLANNING_CANVAS_OPENAPI_ROUTES` once and registers each entry. C3 registers
 * the paths; C3b writes the full descriptions and the runner catalog test.
 */
export interface PlanningCanvasOpenApiRoute {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
}

const COMPANY = "/api/companies/{companyId}/planning-canvases";
const BOARD = `${COMPANY}/{boardId}`;
const tags = ["planning-canvases"];

const PLANNING_CANVAS_CORE_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  { method: "get", path: COMPANY, tags, summary: "List the planning canvas boards the caller can open" },
  { method: "post", path: COMPANY, tags, summary: "Create a personal planning canvas board", body: createPlanningCanvasSchema },
  { method: "get", path: BOARD, tags, summary: "Read a planning canvas board as JSON, markdown or Mermaid" },
  { method: "patch", path: BOARD, tags, summary: "Legacy whole-board update (old tabs)", body: updatePlanningCanvasSchema },
  { method: "delete", path: BOARD, tags, summary: "Delete a planning canvas board" },
  { method: "post", path: `${BOARD}/ops`, tags, summary: "Apply a batch of merge-safe ops to a planning canvas board", body: planningCanvasOpBatchSchema },
  { method: "post", path: `${BOARD}/archive`, tags, summary: "Archive a planning canvas board" },
  { method: "post", path: `${BOARD}/restore`, tags, summary: "Restore an archived planning canvas board" },
];

export const PLANNING_CANVAS_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  ...PLANNING_CANVAS_CORE_OPENAPI_ROUTES,
  ...PLANNING_CANVAS_SHARING_OPENAPI_ROUTES,
  ...PLANNING_CANVAS_COMMENTS_OPENAPI_ROUTES,
  ...PLANNING_CANVAS_LINKS_OPENAPI_ROUTES,
  ...PLANNING_CANVAS_BLUEPRINTS_OPENAPI_ROUTES,
];
