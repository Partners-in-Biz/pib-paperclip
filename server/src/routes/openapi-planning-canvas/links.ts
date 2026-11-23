import { planningCanvasHandoffSchema, planningCanvasItemKeySchema, planningCanvasQueryBodySchema } from "@paperclipai/shared";
import { z } from "zod";
import type { PlanningCanvasOpenApiRoute } from "./core.js";

/**
 * Route-local schemas of `routes/planning-canvas-links.ts`. They live here,
 * not in the route file, so `openapi.ts` stays free of service imports.
 */
export const planningCanvasRefsQuerySchema = z.strictObject({
  /** Comma-separated node keys; without it every live node of the board. */
  keys: z
    .string()
    .max(64_000)
    .transform((value) => value.split(",").map((key) => key.trim()).filter(Boolean))
    .pipe(z.array(planningCanvasItemKeySchema).min(1).max(500))
    .optional(),
});

const BOARD = "/api/companies/{companyId}/planning-canvases/{boardId}";
const tags = ["planning-canvases"];

/** OpenAPI entries of `routes/planning-canvas-links.ts` (C8). */
export const PLANNING_CANVAS_LINKS_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  {
    method: "get",
    path: `${BOARD}/refs`,
    tags,
    summary: "Hydrate the issue, agent, project and goal ids a planning canvas board links to",
    description:
      "Needs view access. Item data stores ids only (`ref.id` of issue/agent/project/goal nodes and `links[].issueId`). " +
      "This answers `{ issues, agents, projects, goals, truncated }` with a live summary for every id the reader may read, " +
      "and `{ id, hidden: true }` for any other id (unreadable and unknown look the same). At most 500 distinct ids; " +
      "`truncated` is true when the board names more. `keys` limits it to some nodes.",
    query: planningCanvasRefsQuerySchema,
  },
  {
    method: "post",
    path: `${BOARD}/handoff`,
    tags,
    summary: "Turn planning canvas nodes into issues (one for all, or one per node) and link them",
    description:
      "Needs edit access on a board that is not archived, and the same guards as creating an issue. `mode: single` makes " +
      "one issue holding every node's text; `one_per_node` makes one per node (at most 50 per call). With " +
      "`assigneeAgentId` the agent is assigned and woken. Each node gets the issue in its `links`. `idempotencyKey` is " +
      "required: a replay by the same caller returns the same issues (`replayed: true`) and creates nothing. Limits per " +
      "board per rolling hour: 20 issues for `single` (shared with @agent mentions) and 100 for `one_per_node`; over a " +
      "limit the call answers 409 `canvas_issue_rate_limited` and creates nothing.",
    body: planningCanvasHandoffSchema,
  },
  {
    method: "post",
    path: `${BOARD}/query`,
    tags,
    summary: "List issues for a planning canvas kanban or timeline node",
    description:
      "Needs view access. Body is an `IssueQuery` (`{ kind: 'issues', filter: { projectId?, goalId?, assigneeAgentId?, " +
      "parentId?, status? }, limit <= 200 }`). Answers only issues the reader may read, most recently updated first.",
    body: planningCanvasQueryBodySchema,
  },
];
