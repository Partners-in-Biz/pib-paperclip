import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DELETE_KEYS, deleteConfirmText, History, isTypingTarget, removeCards, removeConnections, type FlowNode, type Snapshot } from "../src/ui/board.js";

const card = (id: string, type: FlowNode["type"], data: Record<string, string> = {}): FlowNode => ({ id, type, position: { x: 0, y: 0 }, data });
const board = (): Snapshot => ({
  nodes: [card("p", "prompt", { text: "A shop front" }), card("i", "image", { assetId: "a1" }), card("o", "output", { assetId: "a2", generated: "1" })],
  edges: [{ id: "e1", source: "p", target: "i" }, { id: "e2", source: "i", target: "o" }],
});

/** The same element.closest() a browser gives, for a focused element with these ancestors (innermost first). */
const focused = (...tags: string[]) => ({
  closest: (selector: string) => {
    const wanted = selector.split(",").map((s) => s.trim());
    return tags.find((t) => wanted.some((w) => w === t || (w.startsWith("[contenteditable]") && t === "[contenteditable]"))) ?? null;
  },
});

describe("deleting cards and connections (PAR-8104)", () => {
  it("deletes on both Backspace and Delete", () => {
    expect(DELETE_KEYS).toEqual(["Backspace", "Delete"]);
  });

  it("does not delete while typing in a field", () => {
    for (const field of ["input", "textarea", "select", "[contenteditable]"]) expect(isTypingTarget(focused(field, "div"))).toBe(true);
    expect(isTypingTarget(focused("button", "div"))).toBe(false);
    expect(isTypingTarget(focused("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("removes a card with every connection to or from it, and nothing else", () => {
    const after = removeCards(board(), ["i"]);
    expect(after.nodes.map((n) => n.id)).toEqual(["p", "o"]);
    expect(after.edges).toEqual([]);
    expect(removeCards(board(), ["o"]).edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("removes a connection and keeps both cards", () => {
    const after = removeConnections(board(), ["e2"]);
    expect(after.nodes.map((n) => n.id)).toEqual(["p", "i", "o"]);
    expect(after.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("one Undo brings a deleted card back with its connections, Redo deletes it again", () => {
    const h = new History();
    const before = board();
    // React Flow reports the node removal and its edge removals in the same tick; both push the same snapshot.
    h.push(before);
    h.push(before);
    const after = removeCards(before, ["i"]);
    const back = h.undo(after);
    expect(back).toEqual(before);
    expect(back?.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(h.canUndo).toBe(false);
    expect(h.redo(back as Snapshot)).toEqual(after);
  });

  it("Undo brings a deleted connection back", () => {
    const h = new History();
    const before = board();
    h.push(before);
    const back = h.undo(removeConnections(before, ["e1"]));
    expect(back?.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("asks first only for cards that show a file, and says the library file stays", () => {
    expect(deleteConfirmText([card("p", "prompt", { text: "x" })])).toBeNull();
    expect(deleteConfirmText([card("i", "image", { assetId: "" })])).toBeNull();
    const one = deleteConfirmText([card("o", "output", { assetId: "a2", generated: "1" })]);
    expect(one).toMatch(/^Delete this card from the board\?/);
    expect(one).toMatch(/library file stays/);
    expect(deleteConfirmText([card("o", "output", { assetId: "a2" }), card("i", "image", { assetId: "a1" }), card("p", "prompt")])).toMatch(/these 3 cards.*library files stay/);
  });

  it("calls no asset action from the canvas page or side panel, so deleting a card can't delete a library file", () => {
    for (const file of ["../src/ui/CanvasPage.tsx", "../src/ui/SidePanel.tsx"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const actions = [...src.matchAll(/use(?:Plugin|Studio)Action\(\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.filter((a) => /delete|remove|archive-asset|asset-archive|trash|purge/i.test(a))).toEqual([]);
    }
  });
});
