import { z } from "zod";
import type { CanvasNodeColor, CanvasShapeVariant, PlanningCanvasItemInput } from "./types/planning-canvas.js";
import { planningCanvasItemKeySchema } from "./validators/planning-canvas.js";

/**
 * Planning Canvas blueprints (plan PAR-13925 G, J.4, Q11; C14). Six built-in
 * boards. Applying one (`POST /companies/:companyId/planning-canvases/from-blueprint`)
 * creates a personal board with these items, an optional parent issue and one
 * issue per chosen marked node, and turns those nodes into `issue` cards.
 * Saved and company templates are cut (plan section N).
 */

export const PLANNING_CANVAS_BLUEPRINT_IDS = [
  "sprint_plan",
  "okr_workshop",
  "roadmap",
  "retro",
  "launch_checklist",
  "agent_workflow_map",
] as const;
export type PlanningCanvasBlueprintId = (typeof PLANNING_CANVAS_BLUEPRINT_IDS)[number];

/** J.4 batch bucket: issues one apply may create, the parent included. */
export const PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX = 50;

export interface PlanningCanvasBlueprint {
  id: PlanningCanvasBlueprintId;
  title: string;
  description: string;
  items: PlanningCanvasItemInput[];
  /** The marked nodes: each may become an issue. All of them by default. */
  issueKeys: string[];
}

type NodeOpts = { color?: CanvasNodeColor; width?: number; height?: number; shape?: CanvasShapeVariant };

function node(kind: "frame" | "sticky" | "text" | "shape", key: string, x: number, y: number, title: string, content: string, opts: NodeOpts = {}): PlanningCanvasItemInput {
  const frame = kind === "frame";
  return {
    itemType: "node",
    key,
    kind,
    x,
    y,
    width: opts.width ?? (frame ? 760 : 220),
    height: opts.height ?? (frame ? 420 : 120),
    zIndex: frame ? 0 : 1,
    color: opts.color ?? (frame ? "slate" : "yellow"),
    title,
    content,
    ...(opts.shape ? { shape: opts.shape } : {}),
  };
}

function edge(key: string, fromKey: string, toKey: string, label?: string): PlanningCanvasItemInput {
  return { itemType: "connector", key, fromKey, toKey, ...(label ? { label } : {}) };
}

/** Stickies laid out in a frame, two per row. */
function column(frameKey: string, x: number, y: number, title: string, color: CanvasNodeColor, stickies: Array<[key: string, title: string, content: string]>) {
  const height = 80 + Math.ceil(stickies.length / 2) * 150;
  return [
    node("frame", frameKey, x, y, title, "", { width: 520, height }),
    ...stickies.map(([key, stickyTitle, content], i) => node("sticky", key, x + 20 + (i % 2) * 250, y + 60 + Math.floor(i / 2) * 150, stickyTitle, content, { color })),
  ];
}

const keysOf = (rows: Array<[string, string, string]>) => rows.map(([key]) => key);

const SPRINT_COMMITTED: Array<[string, string, string]> = [
  ["story-1", "Story 1", "As a user, I can ... so that ...\nAcceptance: ..."],
  ["story-2", "Story 2", "As a user, I can ... so that ...\nAcceptance: ..."],
  ["story-3", "Story 3", "As a user, I can ... so that ...\nAcceptance: ..."],
  ["story-4", "Story 4", "As a user, I can ... so that ...\nAcceptance: ..."],
];
const OKR_INITIATIVES: Array<[string, string, string]> = [
  ["init-1", "Initiative for KR 1", "What we will do to move key result 1."],
  ["init-2", "Initiative for KR 2", "What we will do to move key result 2."],
  ["init-3", "Initiative for KR 3", "What we will do to move key result 3."],
];
const ROADMAP_NOW: Array<[string, string, string]> = [
  ["now-1", "Now: first bet", "Problem, outcome, owner."],
  ["now-2", "Now: second bet", "Problem, outcome, owner."],
];
const RETRO_ACTIONS: Array<[string, string, string]> = [
  ["action-1", "Action 1", "One change we will make next sprint, and who owns it."],
  ["action-2", "Action 2", "One change we will make next sprint, and who owns it."],
  ["action-3", "Action 3", "One change we will make next sprint, and who owns it."],
];
const LAUNCH_BEFORE: Array<[string, string, string]> = [
  ["before-qa", "Final QA pass", "Test the main journeys on desktop and mobile."],
  ["before-docs", "Docs and help pages", "Update the docs and the changelog."],
  ["before-comms", "Launch announcement", "Draft the email, post and in-app note."],
  ["before-rollback", "Rollback plan", "Write down how to undo the launch."],
];
const LAUNCH_DAY: Array<[string, string, string]> = [
  ["day-ship", "Ship it", "Release and confirm it is live."],
  ["day-monitor", "Watch errors and metrics", "Check errors, latency and sign-ups for the first hours."],
];
const LAUNCH_AFTER: Array<[string, string, string]> = [
  ["after-feedback", "Collect feedback", "Gather what users say in the first week."],
  ["after-review", "Launch review", "What worked, what did not, what next."],
];

const AGENT_STEPS: Array<[string, string, string]> = [
  ["step-research", "Research", "Agent gathers the facts and sources the work needs."],
  ["step-build", "Build", "Agent does the work and attaches the result."],
  ["step-review", "Review", "Reviewer agent checks the result against the brief."],
];

export const PLANNING_CANVAS_BLUEPRINTS: readonly PlanningCanvasBlueprint[] = [
  {
    id: "sprint_plan",
    title: "Sprint plan",
    description: "Sprint goal, committed stories, backlog and risks. Committed stories become issues.",
    items: [
      node("text", "goal", 0, -140, "Sprint goal", "One sentence: what this sprint delivers and why it matters.", { width: 1060, height: 100 }),
      ...column("committed", 0, 0, "Committed", "yellow", SPRINT_COMMITTED),
      ...column("backlog", 540, 0, "Backlog (not this sprint)", "slate", [
        ["backlog-1", "Later idea", "Parked; revisit at the next planning."],
        ["backlog-2", "Later idea", "Parked; revisit at the next planning."],
      ]),
      ...column("risks", 540, 260, "Risks", "rose", [["risk-1", "Risk", "What could stop us, and what we do about it."]]),
    ],
    issueKeys: keysOf(SPRINT_COMMITTED),
  },
  {
    id: "okr_workshop",
    title: "OKR workshop",
    description: "One objective, three key results and an initiative for each. Initiatives become issues.",
    items: [
      node("frame", "objective-frame", 0, 0, "Objective", "", { width: 820, height: 560 }),
      node("text", "objective", 20, 60, "Objective", "Qualitative and inspiring: where we want to be by the end of the quarter.", { width: 780, height: 100 }),
      ...[1, 2, 3].flatMap((n) => [
        node("sticky", `kr-${n}`, 20 + (n - 1) * 270, 190, `Key result ${n}`, "Metric: from X to Y by <date>.", { color: "blue" }),
        node("sticky", `init-${n}`, 20 + (n - 1) * 270, 380, OKR_INITIATIVES[n - 1]![1], OKR_INITIATIVES[n - 1]![2], { color: "emerald" }),
        edge(`kr-${n}-init`, `kr-${n}`, `init-${n}`, "moved by"),
      ]),
    ],
    issueKeys: keysOf(OKR_INITIATIVES),
  },
  {
    id: "roadmap",
    title: "Roadmap",
    description: "Now, next and later. The bets in Now become issues.",
    items: [
      ...column("now", 0, 0, "Now", "emerald", ROADMAP_NOW),
      ...column("next", 540, 0, "Next", "blue", [
        ["next-1", "Next: bet", "Shape it before it moves to Now."],
        ["next-2", "Next: bet", "Shape it before it moves to Now."],
      ]),
      ...column("later", 1080, 0, "Later", "slate", [["later-1", "Later: idea", "A direction, not a commitment."]]),
    ],
    issueKeys: keysOf(ROADMAP_NOW),
  },
  {
    id: "retro",
    title: "Retro",
    description: "What went well, what to improve, and action items. Action items become issues.",
    items: [
      ...column("well", 0, 0, "Went well", "emerald", [["well-1", "Went well", ""], ["well-2", "Went well", ""]]),
      ...column("improve", 540, 0, "To improve", "rose", [["improve-1", "To improve", ""], ["improve-2", "To improve", ""]]),
      ...column("actions", 1080, 0, "Action items", "amber", RETRO_ACTIONS),
    ],
    issueKeys: keysOf(RETRO_ACTIONS),
  },
  {
    id: "launch_checklist",
    title: "Launch checklist",
    description: "Before launch, launch day and after. Every checklist item becomes an issue.",
    items: [
      ...column("before", 0, 0, "Before launch", "yellow", LAUNCH_BEFORE),
      ...column("day", 540, 0, "Launch day", "amber", LAUNCH_DAY),
      ...column("after", 1080, 0, "After launch", "blue", LAUNCH_AFTER),
    ],
    issueKeys: [...keysOf(LAUNCH_BEFORE), ...keysOf(LAUNCH_DAY), ...keysOf(LAUNCH_AFTER)],
  },
  {
    id: "agent_workflow_map",
    title: "Agent workflow map",
    description: "Trigger, agent steps, a person's approval and the outcome. Agent steps become issues to assign.",
    items: [
      node("shape", "trigger", 0, 0, "Trigger", "What starts the work: a request, a schedule or an event.", { shape: "pill", color: "slate" }),
      ...AGENT_STEPS.map(([key, title, content], i) => node("sticky", key, 280 * (i + 1), 0, title, content, { color: "violet" })),
      node("shape", "approval", 1120, 0, "Approval", "A person approves before anything goes out.", { shape: "diamond", color: "amber", height: 160 }),
      node("shape", "outcome", 1400, 0, "Outcome", "What done looks like.", { shape: "pill", color: "emerald" }),
      edge("e-trigger", "trigger", "step-research"),
      edge("e-research", "step-research", "step-build"),
      edge("e-build", "step-build", "step-review"),
      edge("e-review", "step-review", "approval"),
      edge("e-approval", "approval", "outcome", "approved"),
    ],
    issueKeys: keysOf(AGENT_STEPS),
  },
];

export function planningCanvasBlueprint(id: string): PlanningCanvasBlueprint | null {
  return PLANNING_CANVAS_BLUEPRINTS.find((blueprint) => blueprint.id === id) ?? null;
}

/** Body of `POST .../planning-canvases/from-blueprint`. */
export const planningCanvasFromBlueprintSchema = z
  .strictObject({
    blueprintId: z.enum(PLANNING_CANVAS_BLUEPRINT_IDS),
    /** Per caller: a second call with the same key returns the same board and creates nothing. */
    idempotencyKey: z.string().min(1).max(200),
    /** Board title; the blueprint's title when left out. Also the parent issue's title. */
    title: z.string().trim().min(1).max(160).optional(),
    /** Also create one parent issue; the node issues become its children. */
    parentIssue: z.boolean().optional(),
    /** Marked nodes to turn into issues, each with an optional assignee. Left out: every marked node, unassigned. */
    issues: z
      .array(z.strictObject({ key: planningCanvasItemKeySchema, assigneeAgentId: z.string().uuid().optional() }))
      .max(PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX)
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.issues) return;
    const marked = new Set(planningCanvasBlueprint(body.blueprintId)?.issueKeys ?? []);
    const seen = new Set<string>();
    body.issues.forEach((issue, index) => {
      if (!marked.has(issue.key)) ctx.addIssue({ code: "custom", message: "not a marked node of this blueprint", path: ["issues", index, "key"] });
      if (seen.has(issue.key)) ctx.addIssue({ code: "custom", message: "duplicate key", path: ["issues", index, "key"] });
      seen.add(issue.key);
    });
  });
export type PlanningCanvasFromBlueprint = z.infer<typeof planningCanvasFromBlueprintSchema>;
