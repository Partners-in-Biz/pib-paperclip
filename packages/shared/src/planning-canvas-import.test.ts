import { describe, expect, it } from "vitest";
import { planningCanvasItemInputSchema } from "./validators/planning-canvas.js";
import { PlanningCanvasImportError, importMarkdownOutline, importMermaidFlowchart } from "./planning-canvas-import.js";

const summary = (items: ReturnType<typeof importMarkdownOutline>) =>
  items.map((i) => {
    if (i.itemType === "connector") return `${i.key}: ${i.fromKey}->${i.toKey}${i.label ? ` [${i.label}]` : ""}${i.dashed ? " dashed" : ""}`;
    if (i.itemType !== "node") return i.key;
    return `${i.key}: ${i.kind}${i.shape ? `/${i.shape}` : ""} "${i.title}" @${i.x},${i.y}`;
  });
const validAll = (items: ReturnType<typeof importMarkdownOutline>) => items.forEach((i) => expect(planningCanvasItemInputSchema.safeParse(i).success, i.key).toBe(true));
const lineOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof PlanningCanvasImportError ? e.line : -1; } return 0; };

describe("markdown outline import", () => {
  it("golden: headings become frames, bullets become stickies inside", () => {
    const items = importMarkdownOutline("# Plan\n- one\n- two\n\n## Later\n1. three\n", { keyPrefix: "t" });
    expect(summary(items)).toEqual([
      't-h1: frame "Plan" @0,0',
      't-h1-b1: sticky "one" @30,40',
      't-h1-b2: sticky "two" @270,40',
      't-h2: frame "Later" @0,270',
      't-h2-b1: sticky "three" @30,310',
    ]);
    validAll(items);
  });
  it("honours at", () => {
    expect(importMarkdownOutline("# A", { at: { x: 100, y: 50 }, keyPrefix: "t" })[0]).toMatchObject({ x: 100, y: 50 });
  });
  it("422 case names the line", () => {
    expect(lineOf(() => importMarkdownOutline("# A\n- ok\nplain prose\n"))).toBe(3);
    expect(lineOf(() => importMarkdownOutline("- orphan\n# A"))).toBe(1);
  });
});

describe("import limits (422 naming the limit)", () => {
  it("markdown over 500 items names the line that crosses the cap", () => {
    const source = "# A\n" + Array.from({ length: 600 }, (_, i) => `- b${i}`).join("\n");
    expect(lineOf(() => importMarkdownOutline(source))).toBe(501);
    expect(() => importMarkdownOutline(source)).toThrow(/500 items/);
    expect(importMarkdownOutline("# A\n" + Array.from({ length: 499 }, (_, i) => `- b${i}`).join("\n"))).toHaveLength(500);
  });
  it("mermaid over 500 nodes and edges is rejected", () => {
    const source = "graph TD\n" + Array.from({ length: 300 }, (_, i) => `N${i} --> M${i}`).join("\n");
    expect(lineOf(() => importMermaidFlowchart(source))).toBe(168);
  });
  it("long mermaid ids are rejected so item keys stay under 100 characters", () => {
    expect(lineOf(() => importMermaidFlowchart(`graph TD\nA-->${"x".repeat(61)}`))).toBe(2);
    expect(lineOf(() => importMermaidFlowchart(`graph TD\nsubgraph ${"s".repeat(61)} [T]\nend`))).toBe(2);
    const ok = importMermaidFlowchart(`graph TD\nA-->${"x".repeat(60)}\nsubgraph ${"s".repeat(60)} [T]\nB\nend`, { keyPrefix: "imp-abcdef12" });
    expect(Math.max(...ok.map((i) => i.key.length))).toBeLessThanOrEqual(100);
  });
});

describe("mermaid flowchart import", () => {
  it("golden: flowchart with shapes, labels, dashed edges and a subgraph", () => {
    const items = importMermaidFlowchart(
      ["flowchart LR", "%% c", "A[Start] --> B{Ok?}", "B -->|yes| C((Done));", "subgraph S [Group]", "D(Round)", "end", "C -.-> D", "A ==> D"].join("\n"),
      { keyPrefix: "t" },
    );
    expect(summary(items)).toEqual([
      't-sub-S-1: frame "Group" @840,0',
      't-n-A: sticky "Start" @30,70',
      't-n-B: shape/diamond "Ok?" @310,70',
      't-n-C: shape/pill "Done" @590,70',
      't-n-D: shape/pill "Round" @870,70',
      "t-e1: t-n-A->t-n-B",
      "t-e2: t-n-B->t-n-C [yes]",
      "t-e3: t-n-C->t-n-D dashed",
      "t-e4: t-n-A->t-n-D",
    ]);
    validAll(items);
  });
  it("lays out TD vertically and BT reversed", () => {
    const td = importMermaidFlowchart("graph TD\nA-->B", { keyPrefix: "t" });
    const bt = importMermaidFlowchart("graph BT\nA---B", { keyPrefix: "t" });
    const y = (items: typeof td, key: string) => (items.find((i) => i.key === key) as { y: number }).y;
    expect(y(td, "t-n-B")).toBeGreaterThan(y(td, "t-n-A"));
    expect(y(bt, "t-n-B")).toBeLessThan(y(bt, "t-n-A"));
  });
  it("survives cycles", () => {
    validAll(importMermaidFlowchart("graph TB\nA-->B\nB-->A", { keyPrefix: "t" }));
  });
  it("422 case names the line", () => {
    expect(lineOf(() => importMermaidFlowchart("flowchart TD\nA-->B\nA x--x C"))).toBe(3);
    expect(lineOf(() => importMermaidFlowchart("sequenceDiagram\nA->>B: hi"))).toBe(1);
    expect(lineOf(() => importMermaidFlowchart("graph TD\nsubgraph X\nA-->B"))).toBe(3);
    expect(lineOf(() => importMermaidFlowchart("graph XY\nA"))).toBe(1);
  });
});
