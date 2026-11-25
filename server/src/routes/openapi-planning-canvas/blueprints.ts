import { planningCanvasFromBlueprintSchema } from "@paperclipai/shared";
import type { PlanningCanvasOpenApiRoute } from "./core.js";

/** OpenAPI entries of `routes/planning-canvas-blueprints.ts` (C14). */
export const PLANNING_CANVAS_BLUEPRINTS_OPENAPI_ROUTES: PlanningCanvasOpenApiRoute[] = [
  {
    method: "post",
    path: "/api/companies/{companyId}/planning-canvases/from-blueprint",
    tags: ["planning-canvases"],
    summary: "Create a planning canvas board from a built-in blueprint, with issues for its marked nodes",
    description:
      "Only a signed-in person who may create boards (viewers cannot), plus the same guards as creating an issue for every " +
      "issue it makes. Blueprints: `sprint_plan`, `okr_workshop`, `roadmap`, `retro`, `launch_checklist`, `agent_workflow_map`. " +
      "Creates a personal board owned by the caller, an optional parent issue (`parentIssue: true`; the node issues become its " +
      "children) and one issue per chosen marked node (`issues: [{ key, assigneeAgentId? }]`, default every marked node, " +
      "unassigned); those nodes become `issue` cards. Assigned agents are woken. `idempotencyKey` is required: a second call by " +
      "the same caller returns the same board and issues (`replayed: true`, 200) and creates nothing. Limits per caller: 50 issues " +
      "per call (parent included) and 100 per rolling hour; over a limit the call answers 409 `canvas_issue_rate_limited` and " +
      "creates nothing, not even the board.",
    body: planningCanvasFromBlueprintSchema,
  },
];
