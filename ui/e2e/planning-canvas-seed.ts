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

/**
 * Seeded Planning Canvas board. Server limits: 500 nodes, 500 connectors.
 * Layout is a grid so screenshots at any width show the same first screen.
 */
export function buildPlanningCanvasSeed(opts: { nodes: number; seed?: number }): PlanningCanvasData {
  const rand = mulberry32(opts.seed ?? 20261123);
  const count = Math.min(opts.nodes, 500);
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const nodes: PlanningCanvasData["nodes"] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    const kind = roll < 0.03 ? "frame" : roll < 0.6 ? "sticky" : roll < 0.8 ? "shape" : "text";
    const col = i % cols;
    const row = Math.floor(i / cols);
    const word = () => WORDS[Math.floor(rand() * WORDS.length)]!;
    nodes.push({
      id: `seed-node-${String(i).padStart(4, "0")}`,
      kind,
      x: col * 300,
      y: row * 220,
      width: kind === "frame" ? 280 : kind === "text" ? 240 : 230,
      height: kind === "frame" ? 200 : kind === "text" ? 52 : 150,
      zIndex: kind === "frame" ? 1 : i + 2,
      color: COLORS[Math.floor(rand() * COLORS.length)]!,
      title: `${word()} ${i + 1}`,
      content: kind === "sticky" ? `${word()} ${word()} ${word()} ${word()}` : "",
      shape: kind === "shape" ? (["rect", "pill", "diamond"] as const)[Math.floor(rand() * 3)] : undefined,
    });
  };
  const connectors: PlanningCanvasData["connectors"] = [];
  for (let i = 1; i < count && connectors.length < 500; i += 1) {
    const from = i;
    const to = Math.max(0, i - 1 - Math.floor(rand() * cols));
    connectors.push({
      id: `seed-conn-${String(i).padStart(4, "0")}`,
      fromNodeId: nodes[from]!.id,
      toNodeId: nodes[to]!.id,
      color: "slate",
      dashed: rand() < 0.2,
    });
  };
  return { nodes, connectors, strokes: [], viewport: { x: 40, y: 40, zoom: 1 } };
}
