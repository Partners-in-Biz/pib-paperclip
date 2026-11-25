import type {
  CanvasConnector,
  CanvasNode,
  CanvasNodeColor,
  PersonalNote,
  PlanningCanvasData,
} from "@paperclipai/shared";

export interface CanvasColorTheme {
  label: string;
  swatch: string;
  stickyBg: string;
  stickyBorder: string;
  stickyText: string;
  frameBg: string;
  frameBorder: string;
  frameHeader: string;
  shapeBg: string;
  shapeBorder: string;
  strokeHex: string;
}

export const CANVAS_COLOR_THEMES: Record<CanvasNodeColor, CanvasColorTheme> = {
  yellow: {
    label: "Yellow",
    swatch: "bg-yellow-300",
    stickyBg: "bg-yellow-100 dark:bg-yellow-950/75",
    stickyBorder: "border-yellow-300 dark:border-yellow-700/80",
    stickyText: "text-yellow-950 dark:text-yellow-100",
    frameBg: "bg-yellow-500/[0.05]",
    frameBorder: "border-yellow-400/50",
    frameHeader: "text-yellow-700 dark:text-yellow-300",
    shapeBg: "bg-yellow-500/15",
    shapeBorder: "border-yellow-500/50",
    strokeHex: "#eab308",
  },
  amber: {
    label: "Amber",
    swatch: "bg-amber-400",
    stickyBg: "bg-amber-100 dark:bg-amber-950/75",
    stickyBorder: "border-amber-300 dark:border-amber-700/80",
    stickyText: "text-amber-950 dark:text-amber-100",
    frameBg: "bg-amber-500/[0.05]",
    frameBorder: "border-amber-400/50",
    frameHeader: "text-amber-700 dark:text-amber-300",
    shapeBg: "bg-amber-500/15",
    shapeBorder: "border-amber-500/50",
    strokeHex: "#f59e0b",
  },
  blue: {
    label: "Blue",
    swatch: "bg-sky-400",
    stickyBg: "bg-sky-100 dark:bg-sky-950/75",
    stickyBorder: "border-sky-300 dark:border-sky-700/80",
    stickyText: "text-sky-950 dark:text-sky-100",
    frameBg: "bg-sky-500/[0.05]",
    frameBorder: "border-sky-400/50",
    frameHeader: "text-sky-700 dark:text-sky-300",
    shapeBg: "bg-sky-500/15",
    shapeBorder: "border-sky-500/50",
    strokeHex: "#0ea5e9",
  },
  emerald: {
    label: "Green",
    swatch: "bg-emerald-400",
    stickyBg: "bg-emerald-100 dark:bg-emerald-950/75",
    stickyBorder: "border-emerald-300 dark:border-emerald-700/80",
    stickyText: "text-emerald-950 dark:text-emerald-100",
    frameBg: "bg-emerald-500/[0.05]",
    frameBorder: "border-emerald-400/50",
    frameHeader: "text-emerald-700 dark:text-emerald-300",
    shapeBg: "bg-emerald-500/15",
    shapeBorder: "border-emerald-500/50",
    strokeHex: "#10b981",
  },
  rose: {
    label: "Pink",
    swatch: "bg-rose-400",
    stickyBg: "bg-rose-100 dark:bg-rose-950/75",
    stickyBorder: "border-rose-300 dark:border-rose-700/80",
    stickyText: "text-rose-950 dark:text-rose-100",
    frameBg: "bg-rose-500/[0.05]",
    frameBorder: "border-rose-400/50",
    frameHeader: "text-rose-700 dark:text-rose-300",
    shapeBg: "bg-rose-500/15",
    shapeBorder: "border-rose-500/50",
    strokeHex: "#f43f5e",
  },
  violet: {
    label: "Purple",
    swatch: "bg-violet-400",
    stickyBg: "bg-violet-100 dark:bg-violet-950/75",
    stickyBorder: "border-violet-300 dark:border-violet-700/80",
    stickyText: "text-violet-950 dark:text-violet-100",
    frameBg: "bg-violet-500/[0.05]",
    frameBorder: "border-violet-400/50",
    frameHeader: "text-violet-700 dark:text-violet-300",
    shapeBg: "bg-violet-500/15",
    shapeBorder: "border-violet-500/50",
    strokeHex: "#8b5cf6",
  },
  slate: {
    label: "Neutral",
    swatch: "bg-slate-400",
    stickyBg: "bg-card",
    stickyBorder: "border-border",
    stickyText: "text-foreground",
    frameBg: "bg-muted/25",
    frameBorder: "border-border",
    frameHeader: "text-muted-foreground",
    shapeBg: "bg-muted/50",
    shapeBorder: "border-border",
    strokeHex: "#64748b",
  },
};

export function createCanvasId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function snapToGrid(value: number, gridSize = 20): number {
  return Math.round(value / gridSize) * gridSize;
}

/**
 * Returns nodes whose center lies inside a given frame node (excluding frames themselves).
 */
export function getNodesInsideFrame(frame: CanvasNode, allNodes: CanvasNode[]): CanvasNode[] {
  if (frame.kind !== "frame") return [];
  return allNodes.filter((node) => {
    if (node.id === frame.id || node.kind === "frame") return false;
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    return (
      cx >= frame.x &&
      cx <= frame.x + frame.width &&
      cy >= frame.y &&
      cy <= frame.y + frame.height
    );
  });
}

/**
 * Computes a smooth Miro-style cubic Bezier SVG path between the closest edges of two nodes.
 */
export function computeConnectorPath(
  from: CanvasNode,
  to: CanvasNode,
): { path: string; midX: number; midY: number; startX: number; startY: number; endX: number; endY: number } {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;

  let startX = fromCx;
  let startY = fromCy;
  let endX = toCx;
  let endY = toCy;
  let c1x = fromCx;
  let c1y = fromCy;
  let c2x = toCx;
  let c2y = toCy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    startX = dir > 0 ? from.x + from.width : from.x;
    startY = fromCy;
    endX = dir > 0 ? to.x : to.x + to.width;
    endY = toCy;
    const offset = Math.max(48, Math.abs(endX - startX) * 0.45);
    c1x = startX + dir * offset;
    c1y = startY;
    c2x = endX - dir * offset;
    c2y = endY;
  } else {
    const dir = dy >= 0 ? 1 : -1;
    startX = fromCx;
    startY = dir > 0 ? from.y + from.height : from.y;
    endX = toCx;
    endY = dir > 0 ? to.y : to.y + to.height;
    const offset = Math.max(48, Math.abs(endY - startY) * 0.45);
    c1x = startX;
    c1y = startY + dir * offset;
    c2x = endX;
    c2y = endY - dir * offset;
  }

  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const path = `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`;
  return { path, midX, midY, startX, startY, endX, endY };
}

/**
 * Bundles a frame's child stickies/notes/shapes into a single structured agent brief.
 */
export function buildFrameAgentBrief(
  frame: CanvasNode,
  allNodes: CanvasNode[],
  notesById: Map<string, PersonalNote>,
): { title: string; description: string } {
  const children = getNodesInsideFrame(frame, allNodes);
  const title = frame.title.trim() || "Canvas Plan";
  const lines: string[] = [
    `## Goal`,
    `Execute the planned items grouped inside the **${title}** frame on the Planning Canvas.`,
    "",
    `## Items in this Frame`,
  ];

  if (children.length === 0) {
    lines.push("- _(No cards inside this frame yet)_");
  } else {
    for (const child of children) {
      if (child.kind === "note" && child.noteId) {
        const linkedNote = notesById.get(child.noteId);
        const heading = linkedNote?.title ?? child.title ?? "Personal Note";
        const body = linkedNote?.body?.trim() || child.content.trim();
        lines.push(`- [ ] **${heading}**${body ? `\n  ${body.replace(/\n/g, "\n  ")}` : ""}`);
      } else {
        const text = [child.title, child.content].filter(Boolean).join(" — ").trim();
        if (text) lines.push(`- [ ] ${text}`);
      }
    }
  }

  return { title, description: lines.join("\n") };
}

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getNodesInRect(allNodes: CanvasNode[], rect: WorldRect): CanvasNode[] {
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;
  return allNodes.filter((node) => {
    const nx2 = node.x + node.width;
    const ny2 = node.y + node.height;
    return node.x < rx2 && nx2 > rect.x && node.y < ry2 && ny2 > rect.y;
  });
}

export type CanvasAlignMode = "left" | "top" | "distribute-h" | "tidy-grid";

export function alignSelectedNodes(
  allNodes: CanvasNode[],
  selectedIds: string[],
  mode: CanvasAlignMode,
): CanvasNode[] {
  const selected = allNodes.filter((n) => selectedIds.includes(n.id));
  if (selected.length < 2) return allNodes;

  const updates = new Map<string, { x: number; y: number }>();

  if (mode === "left") {
    const minX = Math.min(...selected.map((n) => n.x));
    for (const n of selected) updates.set(n.id, { x: minX, y: n.y });
  } else if (mode === "top") {
    const minY = Math.min(...selected.map((n) => n.y));
    for (const n of selected) updates.set(n.id, { x: n.x, y: minY });
  } else if (mode === "distribute-h") {
    const sorted = [...selected].sort((a, b) => a.x - b.x);
    let cursorX = sorted[0]!.x;
    const baseY = sorted[0]!.y;
    for (const n of sorted) {
      updates.set(n.id, { x: Math.round(cursorX), y: baseY });
      cursorX += n.width + 28;
    }
  } else if (mode === "tidy-grid") {
    const sorted = [...selected].sort((a, b) => a.y - b.y || a.x - b.x);
    const cols = Math.ceil(Math.sqrt(sorted.length));
    const startX = Math.min(...sorted.map((n) => n.x));
    const startY = Math.min(...sorted.map((n) => n.y));
    const cellW = Math.max(...sorted.map((n) => n.width)) + 28;
    const cellH = Math.max(...sorted.map((n) => n.height)) + 28;
    sorted.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      updates.set(n.id, {
        x: Math.round(startX + col * cellW),
        y: Math.round(startY + row * cellH),
      });
    });
  }

  return allNodes.map((n) => {
    const pos = updates.get(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });
}

export function buildSelectionAgentBrief(
  selectedNodes: CanvasNode[],
  notesById: Map<string, PersonalNote>,
): { title: string; description: string } {
  const title =
    selectedNodes.length === 1
      ? selectedNodes[0]!.title.trim() || "Canvas Plan"
      : `Canvas Plan (${selectedNodes.length} items)`;

  const lines: string[] = [
    "## Goal",
    `Execute the ${selectedNodes.length} selected items from the Planning Canvas.`,
    "",
    "## Selected Items",
  ];

  for (const node of selectedNodes) {
    if (node.kind === "note" && node.noteId) {
      const linked = notesById.get(node.noteId);
      const heading = linked?.title ?? node.title ?? "Personal Note";
      const body = linked?.body?.trim() || node.content.trim();
      lines.push(`- [ ] **${heading}**${body ? `\n  ${body.replace(/\n/g, "\n  ")}` : ""}`);
    } else {
      const text = [node.title, node.content].filter(Boolean).join(" — ").trim();
      if (text) lines.push(`- [ ] ${text}`);
    }
  }

  return { title, description: lines.join("\n") };
}

export function strokePointsToSvgPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0]!;
    return `M ${p.x} ${p.y} L ${p.x + 0.5} ${p.y + 0.5}`;
  }
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const midX = (prev.x + curr.x) / 2;
    const midY = (prev.y + curr.y) / 2;
    d += ` Q ${prev.x} ${prev.y}, ${midX} ${midY}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/**
 * Exports an entire Planning Canvas board (frames, grouped items, unframed items,
 * and connector relationships) into a structured Markdown document.
 */
export function exportBoardToMarkdown(
  boardTitle: string,
  nodes: CanvasNode[],
  connectors: CanvasConnector[],
  notesById: Map<string, PersonalNote>,
): string {
  const sections: string[] = [`# ${boardTitle.trim() || "Planning Canvas"}`];
  const frames = nodes.filter((n) => n.kind === "frame");
  const claimedIds = new Set<string>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  function formatNodeLine(node: CanvasNode): string {
    if (node.kind === "note" && node.noteId) {
      const linked = notesById.get(node.noteId);
      const title = linked?.title ?? node.title ?? "Personal Note";
      return `- [ ] [[${title}]]`;
    }
    const text = [node.title, node.content].filter(Boolean).join(" — ").trim();
    return `- [ ] ${text || "(Untitled item)"}`;
  }

  for (const frame of frames) {
    const children = getNodesInsideFrame(frame, nodes);
    sections.push("", `## ${frame.title.trim() || "Untitled Frame"}`);
    if (children.length === 0) {
      sections.push("_No items in this frame._");
    } else {
      for (const child of children) {
        claimedIds.add(child.id);
        sections.push(formatNodeLine(child));
      }
    }
  }

  const unframed = nodes.filter((n) => n.kind !== "frame" && !claimedIds.has(n.id));
  if (unframed.length > 0) {
    sections.push("", "## Canvas Items");
    for (const item of unframed) {
      sections.push(formatNodeLine(item));
    }
  }

  if (connectors.length > 0) {
    sections.push("", "## Flow & Dependencies");
    for (const conn of connectors) {
      const from = nodeById.get(conn.fromNodeId);
      const to = nodeById.get(conn.toNodeId);
      if (!from || !to) continue;
      const fromLabel = from.title.trim() || from.kind;
      const toLabel = to.title.trim() || to.kind;
      const edgeLabel = conn.label?.trim() ? ` (${conn.label.trim()})` : "";
      sections.push(`- ${fromLabel} → ${toLabel}${edgeLabel}`);
    }
  }

  return sections.join("\n");
}

export interface CanvasBoardTemplate {
  id: string;
  label: string;
  description: string;
  build: () => PlanningCanvasData;
}

export const CANVAS_BOARD_TEMPLATES: CanvasBoardTemplate[] = [
  {
    id: "roadmap",
    label: "Now / Next / Later",
    description: "3-column strategic roadmap with frames & starter stickies",
    build: () => {
      const fNow = createCanvasId("frame");
      const fNext = createCanvasId("frame");
      const fLater = createCanvasId("frame");
      const s1 = createCanvasId("sticky");
      const s2 = createCanvasId("sticky");
      const s3 = createCanvasId("sticky");
      const nodes: CanvasNode[] = [
        { id: fNow, kind: "frame", x: 60, y: 60, width: 320, height: 420, zIndex: 1, color: "emerald", title: "Now (This Week)", content: "" },
        { id: fNext, kind: "frame", x: 420, y: 60, width: 320, height: 420, zIndex: 1, color: "blue", title: "Next (This Month)", content: "" },
        { id: fLater, kind: "frame", x: 780, y: 60, width: 320, height: 420, zIndex: 1, color: "violet", title: "Later (Backlog)", content: "" },
        { id: s1, kind: "sticky", x: 90, y: 120, width: 260, height: 150, zIndex: 5, color: "yellow", title: "Ship key priority", content: "Double-click to edit, or click Give to agent." },
        { id: s2, kind: "sticky", x: 450, y: 120, width: 260, height: 150, zIndex: 5, color: "blue", title: "Next milestone", content: "Connect cards with arrows (L) to map dependencies." },
        { id: s3, kind: "sticky", x: 810, y: 120, width: 260, height: 150, zIndex: 5, color: "violet", title: "Big bet idea", content: "Drag any Personal Note from the drawer onto this board." },
      ];
      const connectors: CanvasConnector[] = [
        { id: createCanvasId("conn"), fromNodeId: s1, toNodeId: s2, label: "unlocks", color: "slate" },
      ];
      return { nodes, connectors, viewport: { x: 20, y: 20, zoom: 0.9 } };
    },
  },
  {
    id: "mindmap",
    label: "Mind Map",
    description: "Central goal branching out into connected initiatives",
    build: () => {
      const center = createCanvasId("shape");
      const b1 = createCanvasId("sticky");
      const b2 = createCanvasId("sticky");
      const b3 = createCanvasId("sticky");
      const b4 = createCanvasId("sticky");
      const nodes: CanvasNode[] = [
        { id: center, kind: "shape", shape: "pill", x: 440, y: 240, width: 240, height: 90, zIndex: 5, color: "violet", title: "Core Objective", content: "" },
        { id: b1, kind: "sticky", x: 100, y: 100, width: 220, height: 130, zIndex: 5, color: "yellow", title: "Growth & Marketing", content: "Campaigns, SEO, content" },
        { id: b2, kind: "sticky", x: 800, y: 100, width: 220, height: 130, zIndex: 5, color: "blue", title: "Product & Engineering", content: "Features, reliability, UX" },
        { id: b3, kind: "sticky", x: 100, y: 360, width: 220, height: 130, zIndex: 5, color: "emerald", title: "Sales & Clients", content: "Pipeline, onboarding" },
        { id: b4, kind: "sticky", x: 800, y: 360, width: 220, height: 130, zIndex: 5, color: "rose", title: "Operations & Agents", content: "Routines, automation" },
      ];
      const connectors: CanvasConnector[] = [
        { id: createCanvasId("conn"), fromNodeId: center, toNodeId: b1, color: "amber" },
        { id: createCanvasId("conn"), fromNodeId: center, toNodeId: b2, color: "blue" },
        { id: createCanvasId("conn"), fromNodeId: center, toNodeId: b3, color: "emerald" },
        { id: createCanvasId("conn"), fromNodeId: center, toNodeId: b4, color: "rose" },
      ];
      return { nodes, connectors, viewport: { x: 0, y: 0, zoom: 0.9 } };
    },
  },
  {
    id: "workflow",
    label: "Agent Workflow",
    description: "End-to-end flowchart with decision nodes & handoffs",
    build: () => {
      const n1 = createCanvasId("shape");
      const n2 = createCanvasId("shape");
      const n3 = createCanvasId("shape");
      const n4 = createCanvasId("sticky");
      const nodes: CanvasNode[] = [
        { id: n1, kind: "shape", shape: "pill", x: 80, y: 200, width: 200, height: 80, zIndex: 5, color: "blue", title: "1. Idea / Trigger", content: "" },
        { id: n2, kind: "shape", shape: "rect", x: 370, y: 200, width: 210, height: 80, zIndex: 5, color: "amber", title: "2. Research & Draft", content: "" },
        { id: n3, kind: "shape", shape: "diamond", x: 670, y: 175, width: 150, height: 130, zIndex: 5, color: "violet", title: "Ready?", content: "" },
        { id: n4, kind: "sticky", x: 910, y: 180, width: 230, height: 120, zIndex: 5, color: "emerald", title: "3. Ship & Measure", content: "Delegate directly to your agent team." },
      ];
      const connectors: CanvasConnector[] = [
        { id: createCanvasId("conn"), fromNodeId: n1, toNodeId: n2, color: "slate" },
        { id: createCanvasId("conn"), fromNodeId: n2, toNodeId: n3, color: "slate" },
        { id: createCanvasId("conn"), fromNodeId: n3, toNodeId: n4, label: "Yes", color: "emerald" },
      ];
      return { nodes, connectors, viewport: { x: 0, y: 20, zoom: 0.9 } };
    },
  },
];
