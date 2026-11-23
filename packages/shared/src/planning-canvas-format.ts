import {
  CANVAS_NODE_KINDS,
  PLANNING_CANVAS_REF_NODE_KINDS,
  type CanvasConnector,
  type CanvasNode,
  type CanvasStroke,
  type CanvasViewport,
  type PlanningCanvasBoard,
  type PlanningCanvasBoardSharing,
  type PlanningCanvasConnectorFields,
  type PlanningCanvasIssueLink,
  type PlanningCanvasItem,
  type PlanningCanvasItemType,
  type PlanningCanvasKanbanData,
  type PlanningCanvasMarkdownData,
  type PlanningCanvasNodeFields,
  type PlanningCanvasStrokeFields,
  type PlanningCanvasTableData,
  type PlanningCanvasTimelineData,
} from "./types/planning-canvas.js";

/**
 * Planning Canvas formats (plan PAR-13925 B.5, C, J.2, J.7, Q17).
 *
 * - Legacy shape: item rows to and from the old `{ nodes, connectors, strokes }`
 *   blob, for the one-release legacy PATCH, the catch-up sync and the rollback
 *   rebuild script.
 * - Markdown (outline plus a Mermaid flowchart, item keys inline) and Mermaid.
 *
 * Item data stores ids only (Q17). Titles, identifiers and status of linked
 * entities come from a per-reader `refs` map; a ref the reader cannot read is
 * `{ hidden: true }` and renders "No access" without its title.
 */

/** A ref as one reader may see it. Hidden refs carry nothing else. */
export type PlanningCanvasRefSummary =
  | { hidden: true }
  | { hidden?: false; label: string; identifier?: string | null; status?: string | null };

/** Entity id (issue, agent, project or goal) to its summary for this reader. */
export type PlanningCanvasRefMap = Record<string, PlanningCanvasRefSummary>;

/** Full board read: the legacy `data` (built from live items) plus the items. */
export type PlanningCanvasBoardRead = PlanningCanvasBoard &
  PlanningCanvasBoardSharing & { items: PlanningCanvasItem[] };

/** Filtered JSON read (`keys`, `area`, `q`, `since`). */
export type PlanningCanvasItemsRead =
  | { resync: true; revision: number; purgedThroughRevision: number }
  | { resync?: false; revision: number; purgedThroughRevision: number; items: PlanningCanvasItem[] };

export type PlanningCanvasFormatItem = Pick<PlanningCanvasItem, "key" | "itemType" | "data" | "zIndex">;

const LEGACY_KINDS = new Set<string>(CANVAS_NODE_KINDS);
const REF_KINDS = new Set<string>(PLANNING_CANVAS_REF_NODE_KINDS);
const LEGACY_CONTENT_MAX = 20_000;
const MARKDOWN_TABLE_ROWS_MAX = 100;
const MERMAID_LABEL_MAX = 100;

export function isLegacyPlanningCanvasNodeKind(kind: string | null | undefined): boolean {
  return typeof kind === "string" && LEGACY_KINDS.has(kind);
}

function oneLine(value: string) {
  return value.replace(/[\r\n\t\u2028\u2029]+/g, " ").trim();
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function byPosition(a: PlanningCanvasFormatItem, b: PlanningCanvasFormatItem) {
  const na = a.data as PlanningCanvasNodeFields;
  const nb = b.data as PlanningCanvasNodeFields;
  return na.y - nb.y || na.x - nb.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function byDrawOrder(a: PlanningCanvasFormatItem, b: PlanningCanvasFormatItem) {
  return (a.zIndex ?? 0) - (b.zIndex ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function ofType(items: PlanningCanvasFormatItem[], itemType: PlanningCanvasItemType) {
  return items.filter((item) => item.itemType === itemType);
}

// ---------------------------------------------------------------------------
// Ref labels and summaries
// ---------------------------------------------------------------------------

function refLabel(summary: PlanningCanvasRefSummary | undefined): string {
  if (!summary || summary.hidden) return "No access";
  const parts = [summary.identifier, summary.label].filter((part): part is string => Boolean(part));
  const text = oneLine(parts.join(" "));
  return summary.status ? `${text} (${summary.status})` : text;
}

/** The label a reader sees for a node. Ref nodes never show their stored title. */
export function planningCanvasNodeLabel(node: PlanningCanvasNodeFields, refs: PlanningCanvasRefMap): string {
  if (REF_KINDS.has(node.kind)) return refLabel(node.ref ? refs[node.ref.id] : undefined);
  return oneLine(node.title) || "(untitled)";
}

function linkLabels(links: PlanningCanvasIssueLink[] | undefined, refs: PlanningCanvasRefMap) {
  return (links ?? []).map((link) => refLabel(refs[link.issueId]));
}

function issueQueryText(source: PlanningCanvasKanbanData["source"] | PlanningCanvasTimelineData["source"]) {
  if (source.kind === "projects") return "projects";
  const filters = Object.entries(source.filter)
    .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join("|") : value}`)
    .join(", ");
  return `issues${filters ? ` (${filters})` : ""}, limit ${source.limit}`;
}

function escapeTableCell(value: unknown) {
  return oneLine(value === null || value === undefined ? "" : String(value)).replace(/\|/g, "\\|");
}

function tableLines(table: PlanningCanvasTableData): string[] {
  if (table.columns.length === 0) return ["(empty table)"];
  const header = `| ${table.columns.map((column) => escapeTableCell(column.name)).join(" | ")} |`;
  const rule = `| ${table.columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows
    .slice(0, MARKDOWN_TABLE_ROWS_MAX)
    .map((row) => `| ${table.columns.map((column) => escapeTableCell(row.cells[column.id])).join(" | ")} |`);
  const more = table.rows.length - MARKDOWN_TABLE_ROWS_MAX;
  return more > 0 ? [header, rule, ...rows, `(${more} more rows)`] : [header, rule, ...rows];
}

/** Plain-text body of a node, as markdown lines (used in the outline and the legacy note). */
function nodeBodyLines(node: PlanningCanvasNodeFields, quoteMarkdown = true): string[] {
  switch (node.kind) {
    case "table":
      return tableLines((node.data as PlanningCanvasTableData | undefined) ?? { columns: [], rows: [] });
    case "markdown": {
      const lines = ((node.data as PlanningCanvasMarkdownData | undefined)?.markdown ?? "").split(/\r?\n/);
      return quoteMarkdown ? lines.map((line) => `> ${line}`.trimEnd()) : lines;
    }
    case "kanban": {
      const data = node.data as PlanningCanvasKanbanData | undefined;
      return data ? [`Kanban of ${issueQueryText(data.source)}, grouped by ${data.groupBy}`] : [];
    }
    case "timeline": {
      const data = node.data as PlanningCanvasTimelineData | undefined;
      return data ? [`Timeline of ${issueQueryText(data.source)}, by ${data.scale}`] : [];
    }
    default:
      return node.content ? node.content.split(/\r?\n/) : [];
  }
}

// ---------------------------------------------------------------------------
// Legacy blob shape (J.2 legacy PATCH and catch-up; J.7 rebuild)
// ---------------------------------------------------------------------------

export interface PlanningCanvasLegacyBlobOptions {
  viewport?: CanvasViewport | null;
  refs: PlanningCanvasRefMap;
}

function legacyNote(node: PlanningCanvasNodeFields, refs: PlanningCanvasRefMap): Pick<CanvasNode, "kind" | "title" | "content"> {
  const label = planningCanvasNodeLabel(node, refs);
  const title = REF_KINDS.has(node.kind) ? `${node.kind}: ${label}` : label;
  return {
    kind: "note",
    title: truncate(title, 300),
    content: truncate(nodeBodyLines(node, false).join("\n"), LEGACY_CONTENT_MAX),
  };
}

/**
 * Live items in the old blob shape. New kinds become `note` nodes with a text
 * summary; `links[0]` becomes `handedOffIssueId`, and its identifier is set
 * only when `refs` (the reader's view) shows that issue.
 */
export function planningCanvasItemsToLegacyBlob(
  items: PlanningCanvasFormatItem[],
  options: PlanningCanvasLegacyBlobOptions,
): { nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[]; viewport: CanvasViewport } {
  const nodes = ofType(items, "node").sort(byDrawOrder).map((item): CanvasNode => {
    const fields = item.data as PlanningCanvasNodeFields;
    const firstLink = fields.links?.[0];
    const linked = firstLink ? options.refs[firstLink.issueId] : undefined;
    const legacy = isLegacyPlanningCanvasNodeKind(fields.kind);
    const base = legacy
      ? { kind: fields.kind as CanvasNode["kind"], title: fields.title, content: fields.content }
      : legacyNote(fields, options.refs);
    return {
      id: item.key,
      ...base,
      x: fields.x,
      y: fields.y,
      width: fields.width,
      height: fields.height,
      zIndex: fields.zIndex,
      color: fields.color,
      ...(legacy && fields.noteId !== undefined ? { noteId: fields.noteId } : {}),
      ...(legacy && fields.shape !== undefined ? { shape: fields.shape } : {}),
      ...(firstLink
        ? {
            handedOffIssueId: firstLink.issueId,
            ...(linked && !linked.hidden && linked.identifier ? { handedOffIssueIdentifier: linked.identifier } : {}),
          }
        : {}),
    };
  });
  const nodeKeys = new Set(nodes.map((node) => node.id));
  const connectors = ofType(items, "connector")
    .sort(byDrawOrder)
    .flatMap((item): CanvasConnector[] => {
      const { fromKey, toKey, label, color, dashed } = item.data as PlanningCanvasConnectorFields;
      if (!nodeKeys.has(fromKey) || !nodeKeys.has(toKey)) return [];
      return [{
        id: item.key,
        fromNodeId: fromKey,
        toNodeId: toKey,
        ...(label !== undefined ? { label } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(dashed !== undefined ? { dashed } : {}),
      }];
    });
  const strokes = ofType(items, "stroke").sort(byDrawOrder).map((item): CanvasStroke => {
    const { points, color, width, highlighter } = item.data as PlanningCanvasStrokeFields;
    return { id: item.key, points, color, width, ...(highlighter !== undefined ? { highlighter } : {}) };
  });
  return { nodes, connectors, strokes, viewport: options.viewport ?? { x: 0, y: 0, zoom: 1 } };
}

/**
 * One legacy blob element as item fields, mirroring the C1 backfill:
 * node `handedOffIssueId` becomes `links` (other existing links are kept after
 * it), connector `fromNodeId`/`toNodeId` become `fromKey`/`toKey`.
 */
export function planningCanvasLegacyElementFields(
  itemType: PlanningCanvasItemType,
  element: CanvasNode | CanvasConnector | CanvasStroke,
  existingLinks?: PlanningCanvasIssueLink[],
): Record<string, unknown> {
  if (itemType === "connector") {
    const { id: _id, fromNodeId, toNodeId, ...rest } = element as CanvasConnector;
    return { ...rest, fromKey: fromNodeId, toKey: toNodeId };
  }
  if (itemType === "stroke") {
    const { id: _id, ...rest } = element as CanvasStroke;
    return rest;
  }
  const { id: _id, handedOffIssueId, handedOffIssueIdentifier: _identifier, ...rest } = element as CanvasNode;
  const links = existingLinks ?? [];
  if (!handedOffIssueId) return links.length > 0 ? { ...rest, links } : rest;
  if (links[0]?.issueId === handedOffIssueId) return { ...rest, links };
  return {
    ...rest,
    links: [{ type: "issue", issueId: handedOffIssueId }, ...links.filter((link) => link.issueId !== handedOffIssueId)].slice(0, 50),
  };
}

// ---------------------------------------------------------------------------
// Markdown and Mermaid (B.5)
// ---------------------------------------------------------------------------

function center(node: PlanningCanvasNodeFields) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/** Each non-frame node goes to the smallest frame that holds its centre. */
function groupByFrame(nodes: PlanningCanvasFormatItem[]) {
  const frames = nodes.filter((item) => (item.data as PlanningCanvasNodeFields).kind === "frame").sort(byPosition);
  const members = new Map<string, PlanningCanvasFormatItem[]>(frames.map((frame) => [frame.key, []]));
  const loose: PlanningCanvasFormatItem[] = [];
  for (const item of nodes.filter((candidate) => (candidate.data as PlanningCanvasNodeFields).kind !== "frame").sort(byPosition)) {
    const point = center(item.data as PlanningCanvasNodeFields);
    let best: { key: string; area: number } | null = null;
    for (const frame of frames) {
      const f = frame.data as PlanningCanvasNodeFields;
      const inside = point.x >= f.x && point.x <= f.x + f.width && point.y >= f.y && point.y <= f.y + f.height;
      if (inside && (!best || f.width * f.height < best.area)) best = { key: frame.key, area: f.width * f.height };
    }
    if (best) members.get(best.key)!.push(item);
    else loose.push(item);
  }
  return { frames, members, loose };
}

function codeSpan(value: string) {
  const text = oneLine(value);
  if (!text.includes("`")) return `\`${text}\``;
  const longest = Math.max(...(text.match(/`+/g) ?? [""]).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

function outlineEntry(item: PlanningCanvasFormatItem, refs: PlanningCanvasRefMap): string[] {
  const node = item.data as PlanningCanvasNodeFields;
  const links = linkLabels(node.links, refs);
  const head = `- [${node.kind}] ${planningCanvasNodeLabel(node, refs)} ${codeSpan(item.key)}${
    links.length > 0 ? ` → ${links.join(", ")}` : ""
  }`;
  return [head, ...nodeBodyLines(node).map((line) => (line ? `  ${line}` : ""))];
}

const MERMAID_RESERVED = new Set(["end", "graph", "flowchart", "subgraph", "style", "class", "classdef", "click", "linkstyle", "direction", "default"]);

function mermaidIds(keys: string[]) {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    let id = /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !MERMAID_RESERVED.has(key.toLowerCase())
      ? key
      : `k_${key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60)}`;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    used.add(id);
    ids.set(key, id);
  }
  return ids;
}

/** Mermaid label text: no line breaks, entity-escaped so text never becomes syntax. */
function mermaidText(value: string) {
  return truncate(oneLine(value), MERMAID_LABEL_MAX)
    .replace(/#/g, "#35;")
    .replace(/%/g, "#37;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\|/g, "#124;");
}

function mermaidNode(id: string, node: PlanningCanvasNodeFields, refs: PlanningCanvasRefMap) {
  const label = `"${mermaidText(planningCanvasNodeLabel(node, refs))}"`;
  if (node.kind === "shape" && node.shape === "diamond") return `${id}{${label}}`;
  if (node.kind === "shape" && node.shape === "pill") return `${id}([${label}])`;
  return `${id}[${label}]`;
}

/** `?format=mermaid`: frames as subgraphs, nodes, then connectors. Strokes are not drawn. */
export function planningCanvasToMermaid(items: PlanningCanvasFormatItem[], refs: PlanningCanvasRefMap): string {
  const nodes = ofType(items, "node");
  const { frames, members, loose } = groupByFrame(nodes);
  const ids = mermaidIds([...frames, ...frames.flatMap((frame) => members.get(frame.key)!), ...loose].map((item) => item.key));
  const lines = ["flowchart LR"];
  for (const frame of frames) {
    lines.push(`  subgraph ${ids.get(frame.key)}["${mermaidText(planningCanvasNodeLabel(frame.data as PlanningCanvasNodeFields, refs))}"]`);
    for (const item of members.get(frame.key)!) {
      lines.push(`    ${mermaidNode(ids.get(item.key)!, item.data as PlanningCanvasNodeFields, refs)}`);
    }
    lines.push("  end");
  }
  for (const item of loose) lines.push(`  ${mermaidNode(ids.get(item.key)!, item.data as PlanningCanvasNodeFields, refs)}`);
  for (const item of ofType(items, "connector").sort(byDrawOrder)) {
    const { fromKey, toKey, label, dashed } = item.data as PlanningCanvasConnectorFields;
    const from = ids.get(fromKey);
    const to = ids.get(toKey);
    if (!from || !to) continue;
    const text = label && oneLine(label) ? `|${mermaidText(label)}|` : "";
    lines.push(`  ${from} ${dashed ? "-.->" : "-->"}${text} ${to}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `?format=markdown`: title, outline grouped by frame (item keys inline), then the flowchart. */
export function planningCanvasToMarkdown(
  board: { title: string; description?: string | null },
  items: PlanningCanvasFormatItem[],
  refs: PlanningCanvasRefMap,
): string {
  const nodes = ofType(items, "node");
  const { frames, members, loose } = groupByFrame(nodes);
  const out = [`# ${oneLine(board.title) || "(untitled)"}`, ""];
  const description = board.description?.trim();
  if (description) out.push(description, "");
  for (const frame of frames) {
    const fields = frame.data as PlanningCanvasNodeFields;
    out.push(`## ${planningCanvasNodeLabel(fields, refs)} ${codeSpan(frame.key)}`, "");
    if (fields.content.trim()) out.push(fields.content.trim(), "");
    const entries = members.get(frame.key)!;
    if (entries.length > 0) out.push(...entries.flatMap((item) => outlineEntry(item, refs)), "");
  }
  if (loose.length > 0) {
    out.push(frames.length > 0 ? "## Other items" : "## Items", "");
    out.push(...loose.flatMap((item) => outlineEntry(item, refs)), "");
  }
  if (nodes.length === 0) out.push("_This board is empty._", "");
  const strokes = ofType(items, "stroke").length;
  if (strokes > 0) out.push(`_${strokes} drawing stroke${strokes === 1 ? "" : "s"} not shown._`, "");
  if (ofType(items, "connector").length > 0) {
    out.push("## Flowchart", "", "```mermaid", planningCanvasToMermaid(items, refs).trimEnd(), "```", "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
