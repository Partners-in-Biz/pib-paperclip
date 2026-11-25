import { describe, expect, it } from "vitest";
import {
  PLANNING_CANVAS_BOARD_CAPS,
  PLANNING_CANVAS_LIMITS,
  PLANNING_CANVAS_NODE_KINDS,
  type PlanningCanvasNodeKind,
} from "../types/planning-canvas.js";
import {
  createPlanningCanvasCommentSchema,
  planningCanvasCapExceeded,
  planningCanvasDataSchema,
  planningCanvasItemInputSchema,
  planningCanvasJsonBytes,
  planningCanvasNodeFieldsSchema,
  planningCanvasOpBatchSchema,
  planningCanvasOpSchema,
  planningCanvasReadQuerySchema,
  updatePlanningCanvasSharingSchema,
} from "./planning-canvas.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const issueQuery = { kind: "issues", filter: { projectId: UUID, status: ["todo", "in_progress"] }, limit: 50 };

const typedPayload: Partial<Record<PlanningCanvasNodeKind, Record<string, unknown>>> = {
  issue: { ref: { id: UUID } },
  agent: { ref: { id: UUID } },
  project: { ref: { id: UUID } },
  goal: { ref: { id: UUID } },
  table: {
    data: {
      columns: [{ id: "c1", name: "Owner", type: "person" }, { id: "c2", name: "Points", type: "number" }],
      rows: [{ id: "r1", cells: { c1: "Leo", c2: 3 } }],
    },
  },
  kanban: { data: { source: issueQuery, groupBy: "status", collapsed: ["done"] } },
  timeline: { data: { source: { kind: "projects" }, scale: "week", range: { from: "2026-11-01", to: "2026-12-01" } } },
  embed: { data: { plugin: "pib.studio", type: "card", props: { label: "x" } } },
  markdown: { data: { markdown: "# Plan\n\n```mermaid\nflowchart TD\nA-->B\n```" } },
};

function nodeItem(kind: PlanningCanvasNodeKind, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemType: "node",
    key: `${kind}_1`,
    kind,
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    zIndex: 1,
    color: "blue",
    title: kind,
    content: "",
    ...(typedPayload[kind] ?? {}),
    ...extra,
  };
}

describe("planning canvas item contract", () => {
  it("accepts every node kind with its typed data", () => {
    for (const kind of PLANNING_CANVAS_NODE_KINDS) {
      const parsed = planningCanvasItemInputSchema.safeParse(nodeItem(kind));
      expect(parsed.success, `${kind}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("accepts connectors, strokes and issue links (ids only)", () => {
    expect(planningCanvasItemInputSchema.safeParse({ itemType: "connector", key: "c1", fromKey: "a", toKey: "b" }).success).toBe(true);
    expect(planningCanvasItemInputSchema.safeParse({
      itemType: "stroke", key: "s1", points: [{ x: 1, y: 1 }], color: "slate", width: 3,
    }).success).toBe(true);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("sticky", { links: [{ type: "issue", issueId: UUID }] })).success).toBe(true);
    expect(planningCanvasItemInputSchema.safeParse(
      nodeItem("sticky", { links: [{ type: "issue", issueId: UUID, identifier: "PAR-1" }] }),
    ).success).toBe(false);
    const tooManyLinks = Array.from({ length: PLANNING_CANVAS_LIMITS.linksMax + 1 }, () => ({ type: "issue", issueId: UUID }));
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("sticky", { links: tooManyLinks })).success).toBe(false);
  });

  it("refuses data that does not fit the kind", () => {
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("issue", { ref: undefined })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("sticky", { ref: { id: UUID } })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("sticky", { data: { markdown: "x" } })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("table", { data: { markdown: "x" } })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("kanban", {
      data: { source: { ...issueQuery, limit: PLANNING_CANVAS_LIMITS.issueQueryLimitMax + 1 }, groupBy: "status", collapsed: [] },
    })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("table", {
      data: { columns: [{ id: "c1", name: "A", type: "text" }], rows: [{ id: "r1", cells: { nope: "x" } }] },
    })).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("markdown", {
      data: { markdown: "x".repeat(PLANNING_CANVAS_LIMITS.markdownMaxLength + 1) },
    })).success).toBe(false);
  });

  it("enforces table caps", () => {
    const columns = Array.from({ length: PLANNING_CANVAS_LIMITS.tableColumnsMax + 1 }, (_, i) => ({ id: `c${i}`, name: "", type: "text" }));
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("table", { data: { columns, rows: [] } })).success).toBe(false);
    const rows = Array.from({ length: PLANNING_CANVAS_LIMITS.tableRowsMax + 1 }, (_, i) => ({ id: `r${i}`, cells: {} }));
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("table", { data: { columns: [], rows } })).success).toBe(false);
  });

  it("refuses an item over 64 KB in bytes, not characters", () => {
    // "€" is 1 character and 3 UTF-8 bytes.
    const underBytes = nodeItem("sticky", { content: "€".repeat(19_000) }); // ~57,000 bytes
    expect(planningCanvasItemInputSchema.safeParse(underBytes).success).toBe(true);

    // 30,000 characters is under the 50,000-character markdown limit, but 90,000 bytes.
    const hugeData = { markdown: "€".repeat(30_000) };
    const { itemType: _t, key: _k, ...huge } = nodeItem("markdown", { data: hugeData });
    expect(planningCanvasJsonBytes(huge)).toBeGreaterThan(PLANNING_CANVAS_LIMITS.itemDataMaxBytes);
    const result = planningCanvasItemInputSchema.safeParse({ itemType: "node", key: "m", ...huge });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("item_too_large");
    const stored = planningCanvasNodeFieldsSchema.safeParse(huge);
    expect(stored.success).toBe(false);
    expect(JSON.stringify(stored.error?.issues)).toContain("item_too_large");
    const set = planningCanvasOpSchema.safeParse({ op: "update", key: "m", baseVersion: 1, set: { data: hugeData } });
    expect(set.success).toBe(false);
    expect(JSON.stringify(set.error?.issues)).toContain("item_too_large");
  });
});

describe("planning canvas ops", () => {
  const ops = [
    { op: "add", item: nodeItem("sticky") },
    { op: "update", key: "a", baseVersion: 2, set: { title: "New", x: 5 } },
    { op: "update", key: "a", set: { x: 5, y: 6 } },
    { op: "delete", key: "a", baseVersion: 1 },
    { op: "restore", key: "a" },
    { op: "table.setCell", key: "t", rowId: "r1", colId: "c1", value: "x" },
    { op: "table.addRow", key: "t", row: { id: "r2", cells: {} }, index: 0 },
    { op: "table.removeRow", key: "t", rowId: "r1" },
    { op: "table.addColumn", key: "t", column: { id: "c3", name: "Due", type: "date" } },
    { op: "table.removeColumn", key: "t", colId: "c1" },
    { op: "table.moveRow", key: "t", rowId: "r2", toIndex: 3 },
  ];

  it("accepts every op shape in one batch with a clientBatchId", () => {
    const parsed = planningCanvasOpBatchSchema.safeParse({ ops, atomic: true, clientBatchId: "batch-1" });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("refuses unknown op shapes", () => {
    for (const bad of [
      { op: "move", key: "a" },
      { op: "update", key: "a", set: {} },
      { op: "update", key: "a", set: { unknownField: 1 } },
      { op: "update", key: "a", set: { legacyId: "x" } },
      { op: "delete", key: "a", extra: true },
      { op: "table.setCell", key: "t", rowId: "r1", colId: "c1", value: { nested: true } },
      { op: "add", item: { ...nodeItem("sticky"), itemType: "widget" } },
      { op: "restore", key: "" },
      { op: "restore", key: "k".repeat(101) },
    ]) {
      expect(planningCanvasOpSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("caps a batch at 500 ops and refuses empty, unknown keys and long batch ids", () => {
    const restore = { op: "restore", key: "a" };
    expect(planningCanvasOpBatchSchema.safeParse({ ops: Array(PLANNING_CANVAS_LIMITS.opsPerBatchMax).fill(restore) }).success).toBe(true);
    expect(planningCanvasOpBatchSchema.safeParse({ ops: Array(PLANNING_CANVAS_LIMITS.opsPerBatchMax + 1).fill(restore) }).success).toBe(false);
    expect(planningCanvasOpBatchSchema.safeParse({ ops: [] }).success).toBe(false);
    expect(planningCanvasOpBatchSchema.safeParse({ ops: [restore], clientBatchId: "x".repeat(101) }).success).toBe(false);
    expect(planningCanvasOpBatchSchema.safeParse({ ops: [restore], dryRun: true }).success).toBe(false);
  });

  it("reports board caps on live item counts", () => {
    expect(planningCanvasCapExceeded({ node: PLANNING_CANVAS_BOARD_CAPS.node, connector: 10, stroke: 0 })).toBeNull();
    expect(planningCanvasCapExceeded({ node: PLANNING_CANVAS_BOARD_CAPS.node + 1 })).toBe("node");
    expect(planningCanvasCapExceeded({ connector: PLANNING_CANVAS_BOARD_CAPS.connector + 1 })).toBe("connector");
    expect(planningCanvasCapExceeded({ stroke: 2_001 })).toBe("stroke");
  });
});

describe("planning canvas sharing, reads and comments", () => {
  it("needs memberAccess whenever a board leaves personal scope", () => {
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "personal" }).success).toBe(true);
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "company" }).success).toBe(false);
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "company", memberAccess: "edit" }).success).toBe(true);
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "project", memberAccess: "view" }).success).toBe(false);
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "project", projectId: UUID, memberAccess: "comment" }).success).toBe(true);
    expect(updatePlanningCanvasSharingSchema.safeParse({ scope: "company", projectId: UUID, memberAccess: "edit" }).success).toBe(false);
  });

  it("parses read query strings", () => {
    expect(planningCanvasReadQuerySchema.parse({ since: "12", keys: "a, b", area: "0,0,100,50", format: "mermaid" })).toEqual({
      since: 12,
      keys: ["a", "b"],
      area: { x: 0, y: 0, width: 100, height: 50 },
      format: "mermaid",
    });
    expect(planningCanvasReadQuerySchema.safeParse({ area: "0,0,100" }).success).toBe(false);
    expect(planningCanvasReadQuerySchema.safeParse({ format: "yaml" }).success).toBe(false);
  });

  it("caps comment bodies at 10,000 characters", () => {
    expect(createPlanningCanvasCommentSchema.safeParse({ itemKey: "a", body: "hi @agent" }).success).toBe(true);
    expect(createPlanningCanvasCommentSchema.safeParse({ body: "x".repeat(10_001) }).success).toBe(false);
    expect(createPlanningCanvasCommentSchema.safeParse({ body: "   " }).success).toBe(false);
  });

  it("leaves the legacy blob validator unchanged", () => {
    expect(planningCanvasDataSchema.safeParse({ nodes: [{ id: "n", kind: "table", x: 0, y: 0, width: 50, height: 50 }] }).success).toBe(false);
    expect(planningCanvasDataSchema.safeParse({ nodes: [{ id: "n", kind: "sticky", x: 0, y: 0, width: 50, height: 50 }] }).success).toBe(true);
  });
});

describe("embed node (P2 W1-3a)", () => {
  const embed = (data: unknown) => planningCanvasItemInputSchema.safeParse(nodeItem("embed", { data }));
  it("accepts a plugin key, type and flat props", () => {
    expect(embed({ plugin: "pib.studio", type: "card", assetId: "a1", props: { label: "x", n: 2, on: true } }).success).toBe(true);
  });
  it("refuses nested props, null, arrays and props over 2 KB", () => {
    expect(embed({ plugin: "p", type: "t", props: { a: { b: 1 } } }).success).toBe(false);
    expect(embed({ plugin: "p", type: "t", props: { a: [1] } }).success).toBe(false);
    expect(embed({ plugin: "p", type: "t", props: { a: null } }).success).toBe(false);
    expect(embed({ plugin: "p", type: "t", props: { a: "x".repeat(1500), b: "y".repeat(1500) } }).success).toBe(false);
  });
  it("refuses missing props and unknown fields; other kinds take no embed data", () => {
    expect(embed({ plugin: "p", type: "t" }).success).toBe(false);
    expect(embed({ plugin: "p", type: "t", props: {}, extra: 1 }).success).toBe(false);
    expect(planningCanvasItemInputSchema.safeParse(nodeItem("sticky", { data: { plugin: "p", type: "t", props: {} } })).success).toBe(false);
  });
});
