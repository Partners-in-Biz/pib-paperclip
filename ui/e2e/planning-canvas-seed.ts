import type { PlanningCanvasData } from "@paperclipai/shared";

/** Deterministic PRNG (mulberry32) so every run, and every branch, draws the same board. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = ["yellow", "amber", "blue", "emerald", "rose", "violet", "slate"] as const;
const WORDS = ["plan", "ship", "review", "scope", "risk", "draft", "agent", "board", "launch", "metric"];
/** Board caps (plan PAR-13925 section C): 5,000 live nodes and 5,000 connectors. */
const MAX_ITEMS = 5000;
/** The create body still takes at most 500 nodes and 500 connectors; the rest go in as `add` ops. */
const CREATE_MAX = 500;
const OPS_PER_BATCH = 500;

/**
 * Seeded Planning Canvas board, up to the 5,000-node board cap. Layout is a grid so screenshots at
 * any width show the same first screen. Up to 500 nodes this draws exactly the board the e33502365
 * baseline was measured on. `longTitles` makes every seventh title long (screenshot stress data).
 */
export function buildPlanningCanvasSeed(opts: { nodes: number; seed?: number; longTitles?: boolean }): PlanningCanvasData {
  const rand = mulberry32(opts.seed ?? 20261123);
  const count = Math.min(opts.nodes, MAX_ITEMS);
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const nodes: PlanningCanvasData["nodes"] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    const kind = roll < 0.03 ? "frame" : roll < 0.6 ? "sticky" : roll < 0.8 ? "shape" : "text";
    const col = i % cols;
    const row = Math.floor(i / cols);
    const word = () => WORDS[Math.floor(rand() * WORDS.length)]!;
    // Property order is the PRNG draw order (color, title, content, shape): keep it.
    const long = opts.longTitles && i % 7 === 3 ? " with a very long title that has to wrap or truncate inside its card without spilling" : "";
    nodes.push({
      id: `seed-node-${String(i).padStart(4, "0")}`,
      kind,
      x: col * 300,
      y: row * 220,
      width: kind === "frame" ? 280 : kind === "text" ? 240 : 230,
      height: kind === "frame" ? 200 : kind === "text" ? 52 : 150,
      zIndex: kind === "frame" ? 1 : i + 2,
      color: COLORS[Math.floor(rand() * COLORS.length)]!,
      title: `${word()} ${i + 1}${long}`,
      content: kind === "sticky" ? `${word()} ${word()} ${word()} ${word()}` : "",
      shape: kind === "shape" ? (["rect", "pill", "diamond"] as const)[Math.floor(rand() * 3)] : undefined,
    });
  }
  const connectors: PlanningCanvasData["connectors"] = [];
  for (let i = 1; i < count && connectors.length < MAX_ITEMS; i += 1) {
    const from = i;
    const to = Math.max(0, i - 1 - Math.floor(rand() * cols));
    connectors.push({
      id: `seed-conn-${String(i).padStart(4, "0")}`,
      fromNodeId: nodes[from]!.id,
      toNodeId: nodes[to]!.id,
      color: "slate",
      dashed: rand() < 0.2,
    });
  }
  return { nodes, connectors, strokes: [], viewport: { x: 40, y: 40, zoom: 1 } };
}

type SeedOp = { op: "add"; item: Record<string, unknown> };

/**
 * Splits a seed into the create body (the first 500 nodes and the connectors between them) and
 * `add` op batches of at most 500 for the rest, nodes before the connectors that point at them.
 */
export function splitPlanningCanvasSeed(seed: PlanningCanvasData): { create: PlanningCanvasData; batches: SeedOp[][] } {
  const head = new Set(seed.nodes.slice(0, CREATE_MAX).map((n) => n.id));
  const headConnectors = seed.connectors.filter((c) => head.has(c.fromNodeId) && head.has(c.toNodeId)).slice(0, CREATE_MAX);
  const inHead = new Set(headConnectors.map((c) => c.id));
  const ops: SeedOp[] = [
    ...seed.nodes.slice(CREATE_MAX).map(({ id, ...rest }) => ({ op: "add" as const, item: { itemType: "node", key: id, ...rest } })),
    ...seed.connectors
      .filter((c) => !inHead.has(c.id))
      .map(({ id, fromNodeId, toNodeId, ...rest }) => ({
        op: "add" as const,
        item: { itemType: "connector", key: id, fromKey: fromNodeId, toKey: toNodeId, ...rest },
      })),
  ];
  const batches: SeedOp[][] = [];
  for (let i = 0; i < ops.length; i += OPS_PER_BATCH) batches.push(ops.slice(i, i + OPS_PER_BATCH));
  return { create: { ...seed, nodes: seed.nodes.slice(0, CREATE_MAX), connectors: headConnectors }, batches };
}
