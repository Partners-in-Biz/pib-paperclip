import { z } from "zod";
import { ISSUE_STATUSES } from "../constants.js";
import {
  CANVAS_NODE_COLORS,
  CANVAS_NODE_KINDS,
  CANVAS_SHAPE_VARIANTS,
  PLANNING_CANVAS_BOARD_CAPS,
  PLANNING_CANVAS_ITEM_TYPES,
  PLANNING_CANVAS_LIMITS,
  PLANNING_CANVAS_MEMBER_ACCESS,
  PLANNING_CANVAS_NODE_KINDS,
  PLANNING_CANVAS_REF_NODE_KINDS,
  PLANNING_CANVAS_SCOPES,
  PLANNING_CANVAS_TABLE_COLUMN_TYPES,
  type PlanningCanvasItemType,
  type PlanningCanvasNodeKind,
} from "../types/planning-canvas.js";

export const canvasNodeSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(CANVAS_NODE_KINDS),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(40).max(4000),
  height: z.number().finite().min(30).max(4000),
  zIndex: z.number().int().min(0).max(100_000).default(1),
  color: z.enum(CANVAS_NODE_COLORS).default("yellow"),
  title: z.string().max(300).default(""),
  content: z.string().max(20_000).default(""),
  noteId: z.string().uuid().nullable().optional(),
  shape: z.enum(CANVAS_SHAPE_VARIANTS).optional(),
  handedOffIssueId: z.string().uuid().nullable().optional(),
  handedOffIssueIdentifier: z.string().max(64).nullable().optional(),
});

export const canvasConnectorSchema = z.object({
  id: z.string().min(1).max(100),
  fromNodeId: z.string().min(1).max(100),
  toNodeId: z.string().min(1).max(100),
  label: z.string().max(120).optional(),
  color: z.enum(CANVAS_NODE_COLORS).optional(),
  dashed: z.boolean().optional(),
});

export const canvasStrokeSchema = z.object({
  id: z.string().min(1).max(100),
  points: z
    .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
    .min(1)
    .max(2000),
  color: z.enum(CANVAS_NODE_COLORS).default("slate"),
  width: z.number().min(1).max(32).default(3),
  highlighter: z.boolean().optional(),
});

export const canvasViewportSchema = z.object({
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
  zoom: z.number().finite().min(0.2).max(2.5).default(1),
});

export const planningCanvasDataSchema = z.object({
  nodes: z.array(canvasNodeSchema).max(500).default([]),
  connectors: z.array(canvasConnectorSchema).max(500).default([]),
  strokes: z.array(canvasStrokeSchema).max(500).optional(),
  viewport: canvasViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});

export const createPlanningCanvasSchema = z.object({
  title: z.string().trim().min(1, "Board title is required").max(160),
  description: z.string().max(1000).optional().default(""),
  data: planningCanvasDataSchema.optional(),
});

export type CreatePlanningCanvas = z.infer<typeof createPlanningCanvasSchema>;

export const updatePlanningCanvasSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(1000).optional(),
  data: planningCanvasDataSchema.optional(),
});

export type UpdatePlanningCanvas = z.infer<typeof updatePlanningCanvasSchema>;

// ---------------------------------------------------------------------------
// Item-row contract (PAR-13930, plan PAR-13925 section C). Every later canvas
// ticket implements these schemas; none edits them.
// ---------------------------------------------------------------------------

const L = PLANNING_CANVAS_LIMITS;

/** UTF-8 byte length of a value's JSON text (the per-item 64 KB cap). */
export function planningCanvasJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

function checkItemBytes(value: unknown, ctx: z.RefinementCtx) {
  if (planningCanvasJsonBytes(value) > L.itemDataMaxBytes) {
    ctx.addIssue({ code: "custom", message: "item_too_large" });
  }
}

export const planningCanvasItemKeySchema = z.string().min(1).max(L.itemKeyMaxLength);

export const planningCanvasIssueLinkSchema = z.strictObject({
  type: z.literal("issue"),
  issueId: z.string().uuid(),
});

export const planningCanvasRefSchema = z.strictObject({ id: z.string().uuid() });

export const planningCanvasIssueQuerySchema = z.strictObject({
  kind: z.literal("issues"),
  filter: z.strictObject({
    projectId: z.string().uuid().optional(),
    goalId: z.string().uuid().optional(),
    assigneeAgentId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
    status: z.array(z.enum(ISSUE_STATUSES)).max(ISSUE_STATUSES.length).optional(),
  }),
  limit: z.number().int().min(1).max(L.issueQueryLimitMax),
});

const tableIdSchema = z.string().min(1).max(100);
export const planningCanvasTableCellValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const planningCanvasTableColumnSchema = z.strictObject({
  id: tableIdSchema,
  name: z.string().max(200),
  type: z.enum(PLANNING_CANVAS_TABLE_COLUMN_TYPES),
});
export const planningCanvasTableRowSchema = z.strictObject({
  id: tableIdSchema,
  cells: z.record(tableIdSchema, planningCanvasTableCellValueSchema),
});

/**
 * Connector `source` of a table node (PAR-14257 C, D 4a). The ops engine
 * overwrites `fetchedAt`, `fetchedBy`, `agentId` and `issueId` from the writing
 * run; this schema only checks the stored shape and sizes.
 */
export const planningCanvasConnectorSourceSchema = z.strictObject({
  tool: z.string().trim().min(1).max(L.sourceToolMaxLength),
  params: z.record(z.string().max(200), z.unknown()).superRefine((params, ctx) => {
    let size = Infinity;
    try {
      size = new TextEncoder().encode(JSON.stringify(params)).length;
    } catch {
      // Not serializable: refused below.
    }
    if (!(size <= L.sourceParamsMaxBytes)) ctx.addIssue({ code: "custom", message: "source params over limit" });
  }),
  // Optional in an op (the server sets them); every stored source has them.
  fetchedAt: z.string().min(1).max(40).optional(),
  fetchedBy: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
});

export const planningCanvasTableDataSchema = z
  .strictObject({
    columns: z.array(planningCanvasTableColumnSchema).max(L.tableColumnsMax),
    rows: z.array(planningCanvasTableRowSchema).max(L.tableRowsMax),
    source: planningCanvasConnectorSourceSchema.optional(),
  })
  .superRefine((table, ctx) => {
    const columnIds = new Set(table.columns.map((column) => column.id));
    if (columnIds.size !== table.columns.length) ctx.addIssue({ code: "custom", message: "duplicate column id" });
    if (new Set(table.rows.map((row) => row.id)).size !== table.rows.length) {
      ctx.addIssue({ code: "custom", message: "duplicate row id" });
    }
    for (const row of table.rows) {
      for (const colId of Object.keys(row.cells)) {
        if (!columnIds.has(colId)) ctx.addIssue({ code: "custom", message: `cell for unknown column ${colId}` });
      }
    }
  });

export const planningCanvasKanbanDataSchema = z.strictObject({
  source: planningCanvasIssueQuerySchema,
  groupBy: z.enum(["status", "assignee", "priority"]),
  collapsed: z.array(z.string().max(100)).max(200),
});

const canvasDateSchema = z.string().min(1).max(40);
export const planningCanvasTimelineDataSchema = z.strictObject({
  source: z.union([planningCanvasIssueQuerySchema, z.strictObject({ kind: z.literal("projects") })]),
  scale: z.enum(["day", "week", "month"]),
  range: z.strictObject({ from: canvasDateSchema, to: canvasDateSchema }).optional(),
});

export const planningCanvasMarkdownDataSchema = z.strictObject({
  markdown: z.string().max(L.markdownMaxLength),
});

const embedPropsSchema = z
  .record(z.string().min(1).max(100), z.union([z.string().max(L.embedPropsMaxBytes), z.number().finite(), z.boolean()]))
  .superRefine((props, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(props)).length > L.embedPropsMaxBytes) {
      ctx.addIssue({ code: "custom", message: "embed props over limit" });
    }
  });

export const planningCanvasEmbedDataSchema = z.strictObject({
  plugin: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  assetId: z.string().min(1).max(200).optional(),
  props: embedPropsSchema,
});

const TYPED_DATA_SCHEMAS: Partial<Record<PlanningCanvasNodeKind, z.ZodType>> = {
  table: planningCanvasTableDataSchema,
  kanban: planningCanvasKanbanDataSchema,
  timeline: planningCanvasTimelineDataSchema,
  markdown: planningCanvasMarkdownDataSchema,
  embed: planningCanvasEmbedDataSchema,
};

export const planningCanvasTypedDataSchema = z.union([
  planningCanvasTableDataSchema,
  planningCanvasKanbanDataSchema,
  planningCanvasTimelineDataSchema,
  planningCanvasMarkdownDataSchema,
  planningCanvasEmbedDataSchema,
]);

const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

const nodeShape = {
  kind: z.enum(PLANNING_CANVAS_NODE_KINDS),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(40).max(4000),
  height: z.number().finite().min(30).max(4000),
  zIndex: z.number().int().min(0).max(100_000),
  color: z.enum(CANVAS_NODE_COLORS),
  title: z.string().max(300),
  content: z.string().max(20_000),
  noteId: z.string().uuid().nullable().optional(),
  shape: z.enum(CANVAS_SHAPE_VARIANTS).optional(),
  links: z.array(planningCanvasIssueLinkSchema).max(L.linksMax).optional(),
  ref: planningCanvasRefSchema.optional(),
  data: planningCanvasTypedDataSchema.optional(),
  legacyId: z.unknown().optional(),
};
const connectorShape = {
  fromKey: planningCanvasItemKeySchema,
  toKey: planningCanvasItemKeySchema,
  label: z.string().max(120).optional(),
  color: z.enum(CANVAS_NODE_COLORS).optional(),
  dashed: z.boolean().optional(),
  legacyId: z.unknown().optional(),
};
const strokeShape = {
  points: z.array(pointSchema).min(1).max(2000),
  color: z.enum(CANVAS_NODE_COLORS),
  width: z.number().min(1).max(32),
  highlighter: z.boolean().optional(),
  legacyId: z.unknown().optional(),
};

function refineNode(node: { kind: PlanningCanvasNodeKind; ref?: unknown; data?: unknown }, ctx: z.RefinementCtx) {
  const isRefKind = (PLANNING_CANVAS_REF_NODE_KINDS as readonly string[]).includes(node.kind);
  if (isRefKind && node.ref === undefined) ctx.addIssue({ code: "custom", message: `${node.kind} node needs ref`, path: ["ref"] });
  if (!isRefKind && node.ref !== undefined) ctx.addIssue({ code: "custom", message: `${node.kind} node takes no ref`, path: ["ref"] });
  const typed = TYPED_DATA_SCHEMAS[node.kind];
  if (!typed) {
    if (node.data !== undefined) ctx.addIssue({ code: "custom", message: `${node.kind} node takes no data`, path: ["data"] });
    return;
  }
  const parsed = typed.safeParse(node.data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: ["data", ...issue.path.map(String)] });
    }
  }
}

/** Stored fields of each item type (`planning_canvas_items.data`), with the byte cap. */
export const planningCanvasNodeFieldsSchema = z.strictObject(nodeShape).superRefine((node, ctx) => {
  refineNode(node, ctx);
  checkItemBytes(node, ctx);
});
export const planningCanvasConnectorFieldsSchema = z.strictObject(connectorShape).superRefine(checkItemBytes);
export const planningCanvasStrokeFieldsSchema = z.strictObject(strokeShape).superRefine(checkItemBytes);

/** Item as sent by an `add` op. C2 also re-checks a merged item with this schema. */
export const planningCanvasItemInputSchema = z
  .discriminatedUnion("itemType", [
    z.strictObject({ itemType: z.literal("node"), key: planningCanvasItemKeySchema, ...nodeShape }),
    z.strictObject({ itemType: z.literal("connector"), key: planningCanvasItemKeySchema, ...connectorShape }),
    z.strictObject({ itemType: z.literal("stroke"), key: planningCanvasItemKeySchema, ...strokeShape }),
  ])
  .superRefine((item, ctx) => {
    if (item.itemType === "node") refineNode(item, ctx);
    const { itemType: _itemType, key: _key, ...fields } = item;
    checkItemBytes(fields, ctx);
  });

const updateSetSchema = z
  .strictObject({
    ...Object.fromEntries(
      Object.entries({ ...strokeShape, ...connectorShape, ...nodeShape }).map(([name, schema]) => [
        name,
        (schema as z.ZodType).optional(),
      ]),
    ),
    width: z.number().finite().min(1).max(4000).optional(),
    color: z.enum(CANVAS_NODE_COLORS).optional(),
  })
  .superRefine((set, ctx) => {
    if (Object.keys(set).length === 0) ctx.addIssue({ code: "custom", message: "set is empty" });
    if ("legacyId" in set) ctx.addIssue({ code: "custom", message: "legacyId is read-only", path: ["legacyId"] });
    checkItemBytes(set, ctx);
  });

const baseVersionSchema = z.number().int().min(1).optional();
const opKey = { key: planningCanvasItemKeySchema };

export const planningCanvasOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), item: planningCanvasItemInputSchema }),
  z.strictObject({ op: z.literal("update"), ...opKey, baseVersion: baseVersionSchema, set: updateSetSchema }),
  z.strictObject({ op: z.literal("delete"), ...opKey, baseVersion: baseVersionSchema }),
  z.strictObject({ op: z.literal("restore"), ...opKey }),
  z.strictObject({
    op: z.literal("table.setCell"),
    ...opKey,
    rowId: tableIdSchema,
    colId: tableIdSchema,
    value: planningCanvasTableCellValueSchema,
  }),
  z.strictObject({
    op: z.literal("table.addRow"),
    ...opKey,
    row: planningCanvasTableRowSchema,
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({ op: z.literal("table.removeRow"), ...opKey, rowId: tableIdSchema }),
  z.strictObject({
    op: z.literal("table.addColumn"),
    ...opKey,
    column: planningCanvasTableColumnSchema,
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({ op: z.literal("table.removeColumn"), ...opKey, colId: tableIdSchema }),
  z.strictObject({ op: z.literal("table.moveRow"), ...opKey, rowId: tableIdSchema, toIndex: z.number().int().min(0) }),
]);

export const planningCanvasOpBatchSchema = z.strictObject({
  ops: z.array(planningCanvasOpSchema).min(1).max(L.opsPerBatchMax),
  atomic: z.boolean().optional(),
  clientBatchId: z.string().min(1).max(L.clientBatchIdMaxLength).optional(),
});
export type PlanningCanvasOpBatchInput = z.infer<typeof planningCanvasOpBatchSchema>;

/**
 * Board caps on live items (tombstones excluded). Returns the first item type
 * whose live count after the batch would pass its cap, or null.
 */
export function planningCanvasCapExceeded(
  liveCounts: Partial<Record<PlanningCanvasItemType, number>>,
): PlanningCanvasItemType | null {
  for (const itemType of PLANNING_CANVAS_ITEM_TYPES) {
    if ((liveCounts[itemType] ?? 0) > PLANNING_CANVAS_BOARD_CAPS[itemType]) return itemType;
  }
  return null;
}

/** `GET .../:id` query string: deltas, key and area reads, search and formats. */
export const planningCanvasReadQuerySchema = z.strictObject({
  format: z.enum(["json", "markdown", "mermaid"]).optional(),
  since: z.coerce.number().int().min(0).optional(),
  keys: z
    .string()
    .max(64_000)
    .transform((value) => value.split(",").map((key) => key.trim()).filter(Boolean))
    .pipe(z.array(planningCanvasItemKeySchema).min(1).max(L.opsPerBatchMax))
    .optional(),
  area: z
    .string()
    .max(200)
    .transform((value) => value.split(",").map((part) => Number(part.trim())))
    .pipe(z.tuple([z.number().finite(), z.number().finite(), z.number().finite().positive(), z.number().finite().positive()]))
    .transform(([x, y, width, height]) => ({ x, y, width, height }))
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type PlanningCanvasReadQuery = z.infer<typeof planningCanvasReadQuerySchema>;

/** `PATCH .../:id/sharing`. Leaving `personal` needs an explicit `memberAccess` (Q15). */
export const updatePlanningCanvasSharingSchema = z
  .strictObject({
    scope: z.enum(PLANNING_CANVAS_SCOPES),
    projectId: z.string().uuid().nullable().optional(),
    memberAccess: z.enum(PLANNING_CANVAS_MEMBER_ACCESS).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope !== "personal" && value.memberAccess === undefined) {
      ctx.addIssue({ code: "custom", message: "memberAccess is required for a shared board", path: ["memberAccess"] });
    }
    if (value.scope === "project" && !value.projectId) {
      ctx.addIssue({ code: "custom", message: "projectId is required for a project board", path: ["projectId"] });
    }
    if (value.scope !== "project" && value.projectId) {
      ctx.addIssue({ code: "custom", message: "projectId is only for project boards", path: ["projectId"] });
    }
  });
export type UpdatePlanningCanvasSharing = z.infer<typeof updatePlanningCanvasSharingSchema>;

export const createPlanningCanvasCommentSchema = z.strictObject({
  itemKey: planningCanvasItemKeySchema.nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  body: z.string().trim().min(1).max(L.commentBodyMaxLength),
});
export type CreatePlanningCanvasComment = z.infer<typeof createPlanningCanvasCommentSchema>;

export const resolvePlanningCanvasCommentSchema = z.strictObject({ resolved: z.boolean() });

/**
 * Board chat message (PAR-14257 C "Interfaces"). No person and no run id: the
 * server takes both from the signed-in caller. Item and frame keys must belong
 * to the board; the stored comment carries the keys, never node text.
 */
export const planningCanvasChatMessageSchema = z.strictObject({
  agentId: z.string().uuid(),
  body: z.string().trim().min(1).max(L.commentBodyMaxLength),
  context: z
    .strictObject({
      itemKeys: z.array(planningCanvasItemKeySchema).max(L.chatContextKeysMax).default([]),
      frameKey: planningCanvasItemKeySchema.optional(),
    })
    .optional(),
  clientRequestId: z.string().trim().min(1).max(L.chatClientRequestIdMaxLength),
});
export type PlanningCanvasChatMessage = z.infer<typeof planningCanvasChatMessageSchema>;

/** `POST .../planning-canvases/:boardId/items/:itemKey/refresh`: the refresher is the signed-in person; the agent comes from the stored source. */
export const planningCanvasSourceRefreshSchema = z.strictObject({
  clientRequestId: z.string().trim().min(1).max(L.chatClientRequestIdMaxLength),
});
export type PlanningCanvasSourceRefresh = z.infer<typeof planningCanvasSourceRefreshSchema>;

export const planningCanvasHandoffSchema = z.strictObject({
  keys: z.array(planningCanvasItemKeySchema).min(1).max(L.handoffKeysMax),
  mode: z.enum(["single", "one_per_node"]),
  idempotencyKey: z.string().min(1).max(200),
  assigneeAgentId: z.string().uuid().optional(),
});
export type PlanningCanvasHandoff = z.infer<typeof planningCanvasHandoffSchema>;

export const planningCanvasQueryBodySchema = planningCanvasIssueQuerySchema;
