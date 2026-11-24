import type { IssueStatus } from "../constants.js";

export const CANVAS_NODE_KINDS = [
  "sticky",
  "note",
  "frame",
  "shape",
  "text",
] as const;

export type CanvasNodeKind = (typeof CANVAS_NODE_KINDS)[number];

export const CANVAS_NODE_COLORS = [
  "yellow",
  "amber",
  "blue",
  "emerald",
  "rose",
  "violet",
  "slate",
] as const;

export type CanvasNodeColor = (typeof CANVAS_NODE_COLORS)[number];

export const CANVAS_SHAPE_VARIANTS = [
  "rect",
  "pill",
  "diamond",
] as const;

export type CanvasShapeVariant = (typeof CANVAS_SHAPE_VARIANTS)[number];

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  color: CanvasNodeColor;
  title: string;
  content: string;
  /** When kind === "note", references a PersonalNote.id */
  noteId?: string | null;
  /** When kind === "shape", selects rect / pill / diamond */
  shape?: CanvasShapeVariant;
  /** Linked Paperclip issue identifier if this sticky/frame was handed to an agent */
  handedOffIssueId?: string | null;
  handedOffIssueIdentifier?: string | null;
}

export interface CanvasConnector {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  color?: CanvasNodeColor;
  dashed?: boolean;
}

export interface CanvasStroke {
  id: string;
  points: Array<{ x: number; y: number }>;
  color: CanvasNodeColor;
  width: number;
  highlighter?: boolean;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PlanningCanvasData {
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  strokes?: CanvasStroke[];
  viewport: CanvasViewport;
}

export interface PlanningCanvasBoard {
  id: string;
  companyId: string;
  /** Owner. Null only on non-personal boards (agent-created or owner removed). */
  userId: string | null;
  title: string;
  description: string;
  data: PlanningCanvasData;
  createdAt: string;
  updatedAt: string;
}

// Planning Canvas item-row contract (PAR-13930, plan PAR-13925 section C).
// Item rows replace the legacy jsonb blob from C2 on. Item data stores ids
// only (links, ref); identifiers, titles and status are hydrated per reader.

/** Every node kind items may carry. The legacy blob keeps `CANVAS_NODE_KINDS`. */
export const PLANNING_CANVAS_NODE_KINDS = [
  "sticky",
  "note",
  "frame",
  "shape",
  "text",
  "issue",
  "agent",
  "project",
  "goal",
  "table",
  "kanban",
  "timeline",
  "markdown",
  "embed",
] as const;
export type PlanningCanvasNodeKind = (typeof PLANNING_CANVAS_NODE_KINDS)[number];

/** False for a stored kind this build does not know (newer build, or a kind removed on rollback). */
export function isKnownPlanningCanvasNodeKind(kind: unknown): kind is PlanningCanvasNodeKind {
  return typeof kind === "string" && (PLANNING_CANVAS_NODE_KINDS as readonly string[]).includes(kind);
}

/** Node kinds whose `ref.id` points at a Paperclip entity. */
export const PLANNING_CANVAS_REF_NODE_KINDS = ["issue", "agent", "project", "goal"] as const;
export type PlanningCanvasRefNodeKind = (typeof PLANNING_CANVAS_REF_NODE_KINDS)[number];

export const PLANNING_CANVAS_ITEM_TYPES = ["node", "connector", "stroke"] as const;
export type PlanningCanvasItemType = (typeof PLANNING_CANVAS_ITEM_TYPES)[number];

export const PLANNING_CANVAS_SCOPES = ["personal", "project", "company"] as const;
export type PlanningCanvasScope = (typeof PLANNING_CANVAS_SCOPES)[number];

export const PLANNING_CANVAS_MEMBER_ACCESS = ["edit", "comment", "view"] as const;
export type PlanningCanvasMemberAccess = (typeof PLANNING_CANVAS_MEMBER_ACCESS)[number];

export const PLANNING_CANVAS_ACCESS_LEVELS = ["none", "view", "comment", "edit", "admin"] as const;
export type PlanningCanvasAccessLevel = (typeof PLANNING_CANVAS_ACCESS_LEVELS)[number];

/** Limits. Board caps count live items only; tombstones do not count. */
export const PLANNING_CANVAS_LIMITS = {
  itemKeyMaxLength: 100,
  itemDataMaxBytes: 64 * 1024,
  linksMax: 50,
  tableColumnsMax: 50,
  tableRowsMax: 500,
  markdownMaxLength: 50_000,
  embedPropsMaxBytes: 2048,
  issueQueryLimitMax: 200,
  opsPerBatchMax: 500,
  clientBatchIdMaxLength: 100,
  commentBodyMaxLength: 10_000,
  mentionsPerCommentMax: 5,
  handoffKeysMax: 50,
  tombstoneRetentionDays: 30,
  tombstonePurgePerBatchMax: 500,
  opBatchRetentionHours: 24,
} as const;

export const PLANNING_CANVAS_BOARD_CAPS: Record<PlanningCanvasItemType, number> = {
  node: 5_000,
  connector: 5_000,
  stroke: 2_000,
};

export interface PlanningCanvasIssueLink {
  type: "issue";
  issueId: string;
}

export interface PlanningCanvasRef {
  id: string;
}

export interface PlanningCanvasIssueQuery {
  kind: "issues";
  filter: {
    projectId?: string;
    goalId?: string;
    assigneeAgentId?: string;
    parentId?: string;
    status?: IssueStatus[];
  };
  limit: number;
}

export const PLANNING_CANVAS_TABLE_COLUMN_TYPES = ["text", "number", "status", "person", "date"] as const;
export type PlanningCanvasTableColumnType = (typeof PLANNING_CANVAS_TABLE_COLUMN_TYPES)[number];
export type PlanningCanvasTableCellValue = string | number | boolean | null;

export interface PlanningCanvasTableColumn {
  id: string;
  name: string;
  type: PlanningCanvasTableColumnType;
}

export interface PlanningCanvasTableRow {
  id: string;
  cells: Record<string, PlanningCanvasTableCellValue>;
}

export interface PlanningCanvasTableData {
  columns: PlanningCanvasTableColumn[];
  rows: PlanningCanvasTableRow[];
}

export interface PlanningCanvasKanbanData {
  source: PlanningCanvasIssueQuery;
  groupBy: "status" | "assignee" | "priority";
  collapsed: string[];
}

export interface PlanningCanvasTimelineData {
  source: PlanningCanvasIssueQuery | { kind: "projects" };
  scale: "day" | "week" | "month";
  range?: { from: string; to: string };
}

export interface PlanningCanvasMarkdownData {
  markdown: string;
}

/** One flat prop of an embed node: text, number or boolean only (core never interprets it). */
export type PlanningCanvasEmbedProp = string | number | boolean;

/**
 * A plugin card on the board (P2 plan C). `plugin` is the stable plugin key, never an install id.
 * `props` is flat and at most `embedPropsMaxBytes` as JSON; only the plugin reads it.
 */
export interface PlanningCanvasEmbedData {
  plugin: string;
  type: string;
  assetId?: string;
  props: Record<string, PlanningCanvasEmbedProp>;
}

export type PlanningCanvasTypedData =
  | PlanningCanvasTableData
  | PlanningCanvasKanbanData
  | PlanningCanvasTimelineData
  | PlanningCanvasMarkdownData
  | PlanningCanvasEmbedData;

/** Fields a node item stores in `planning_canvas_items.data`. */
export interface PlanningCanvasNodeFields {
  kind: PlanningCanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  color: CanvasNodeColor;
  title: string;
  content: string;
  noteId?: string | null;
  shape?: CanvasShapeVariant;
  links?: PlanningCanvasIssueLink[];
  ref?: PlanningCanvasRef;
  data?: PlanningCanvasTypedData;
  /** Set by the C1 backfill when the legacy element had no usable id. */
  legacyId?: unknown;
}

export interface PlanningCanvasConnectorFields {
  fromKey: string;
  toKey: string;
  label?: string;
  color?: CanvasNodeColor;
  dashed?: boolean;
  legacyId?: unknown;
}

export interface PlanningCanvasStrokeFields {
  points: Array<{ x: number; y: number }>;
  color: CanvasNodeColor;
  width: number;
  highlighter?: boolean;
  legacyId?: unknown;
}

export type PlanningCanvasItemFields =
  | PlanningCanvasNodeFields
  | PlanningCanvasConnectorFields
  | PlanningCanvasStrokeFields;

/** Geometry is last writer wins and never bumps `version` (plan B.3). */
export const PLANNING_CANVAS_GEOMETRY_FIELDS = ["x", "y", "width", "height", "zIndex", "points"] as const;
/** Content fields bump `version` and need `baseVersion` on update (plan B.3). */
export const PLANNING_CANVAS_CONTENT_FIELDS = [
  "title",
  "content",
  "color",
  "kind",
  "data",
  "links",
  "ref",
  "fromKey",
  "toKey",
  "label",
  "noteId",
  "shape",
  "dashed",
  "highlighter",
] as const;

/** Item as written by an `add` op. `kind` and `zIndex` are copied to columns. */
export type PlanningCanvasItemInput =
  | ({ itemType: "node"; key: string } & PlanningCanvasNodeFields)
  | ({ itemType: "connector"; key: string } & PlanningCanvasConnectorFields)
  | ({ itemType: "stroke"; key: string } & PlanningCanvasStrokeFields);

/** Item as read back. `data` is the row's jsonb; `kind`/`zIndex` mirror it. */
export interface PlanningCanvasItem {
  key: string;
  itemType: PlanningCanvasItemType;
  kind: PlanningCanvasNodeKind | null;
  data: PlanningCanvasItemFields;
  zIndex: number | null;
  version: number;
  fieldVersions: Record<string, number>;
  revision: number;
  deletedAt: string | null;
  deletedWithKey: string | null;
  updatedByUserId: string | null;
  updatedByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningCanvasBoardSharing {
  scope: PlanningCanvasScope;
  projectId: string | null;
  memberAccess: PlanningCanvasMemberAccess;
  revision: number;
  purgedThroughRevision: number;
  archivedAt: string | null;
  createdByAgentId: string | null;
}

export type PlanningCanvasOp =
  | { op: "add"; item: PlanningCanvasItemInput }
  | { op: "update"; key: string; baseVersion?: number; set: Partial<PlanningCanvasItemFields> & Record<string, unknown> }
  | { op: "delete"; key: string; baseVersion?: number }
  | { op: "restore"; key: string }
  | { op: "table.setCell"; key: string; rowId: string; colId: string; value: PlanningCanvasTableCellValue }
  | { op: "table.addRow"; key: string; row: PlanningCanvasTableRow; index?: number }
  | { op: "table.removeRow"; key: string; rowId: string }
  | { op: "table.addColumn"; key: string; column: PlanningCanvasTableColumn; index?: number }
  | { op: "table.removeColumn"; key: string; colId: string }
  | { op: "table.moveRow"; key: string; rowId: string; toIndex: number };

export type PlanningCanvasOpName = PlanningCanvasOp["op"];

export interface PlanningCanvasOpBatch {
  ops: PlanningCanvasOp[];
  atomic?: boolean;
  clientBatchId?: string;
}

export const PLANNING_CANVAS_OP_REJECT_REASONS = [
  "base_version_required",
  "not_found",
  "already_exists",
  "deleted",
  "not_deleted",
  "wrong_item_type",
  "invalid_item",
  "unknown_kind",
  "item_too_large",
  "cap_exceeded",
  "missing_endpoint",
  "table_row_not_found",
  "table_column_not_found",
  "table_row_exists",
  "table_column_exists",
  "table_cap_exceeded",
  "atomic_aborted",
] as const;
export type PlanningCanvasOpRejectReason = (typeof PLANNING_CANVAS_OP_REJECT_REASONS)[number];

export type PlanningCanvasOpResult =
  | { status: "applied"; key: string; version: number; revision: number }
  | { status: "conflict"; key: string; current: PlanningCanvasItem; conflictingFields: string[] }
  | { status: "rejected"; key: string; reason: PlanningCanvasOpRejectReason };

export interface PlanningCanvasOpBatchResponse {
  revision: number;
  results: PlanningCanvasOpResult[];
  /** True when `clientBatchId` was seen before: stored results, nothing applied. */
  replayed: boolean;
}

export type PlanningCanvasDeltaResponse =
  | { resync: true; revision: number }
  | { resync?: false; revision: number; items: PlanningCanvasItem[] };

export const PLANNING_CANVAS_MENTION_STATES = ["sent", "added_to_open"] as const;
/** Per agent: `sent`, `added_to_open` or `not_sent:<reason>`. */
export type PlanningCanvasMentionState =
  | (typeof PLANNING_CANVAS_MENTION_STATES)[number]
  | `not_sent:${string}`;

export interface PlanningCanvasComment {
  id: string;
  companyId: string;
  boardId: string;
  itemKey: string | null;
  parentId: string | null;
  body: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  linkedIssueId: string | null;
  mentionState: Record<string, PlanningCanvasMentionState>;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export const PLANNING_CANVAS_AGENT_GRANT_SOURCES = ["mention", "handoff"] as const;
export type PlanningCanvasAgentGrantSource = (typeof PLANNING_CANVAS_AGENT_GRANT_SOURCES)[number];

export interface PlanningCanvasAgentGrant {
  id: string;
  companyId: string;
  boardId: string;
  agentId: string;
  issueId: string;
  grantedByUserId: string;
  source: PlanningCanvasAgentGrantSource;
  createdAt: string;
  revokedAt: string | null;
}
