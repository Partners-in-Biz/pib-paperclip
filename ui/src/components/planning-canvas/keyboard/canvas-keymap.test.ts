import { describe, expect, it } from "vitest";
import { allChords, CANVAS_COMMANDS, KEY_BINDINGS, nudgeDelta } from "./canvas-keymap";

describe("canvas keymap", () => {
  it("has no two bindings on the same chord", () => {
    const chords = allChords();
    expect(new Set(chords).size).toBe(chords.length);
  });
  it("lists every key of plan section F plus today's keys", () => {
    const have = new Set(allChords());
    for (const c of ["?", "tab", "shift+tab", "enter", "mod+d", "mod+g", "mod+a", "mod+f", "0", "1", "space", "c", "m", "arrow", "shift+arrow", "v", "h", "n", "f", "s", "t", "l", "d", "p", "esc", "delete"]) {
      expect(have.has(c), c).toBe(true);
    }
  });
  it("every palette command id is a binding id", () => {
    const ids = new Set(KEY_BINDINGS.map((b) => b.id));
    const map: Record<string, string> = { "cheat-sheet": "cheat-sheet", outline: "outline", fit: "fit", "zoom-100": "zoom-100", "select-all": "select-all", "frame-selection": "frame-selection", duplicate: "duplicate", "add-markdown": "add-markdown", find: "find" };
    for (const cmd of CANVAS_COMMANDS) expect(ids.has(map[cmd.id]!)).toBe(true);
  });
  it("nudges 1 px, or 10 with Shift", () => {
    expect(nudgeDelta({ key: "ArrowLeft", shiftKey: false })).toEqual({ dx: -1, dy: 0 });
    expect(nudgeDelta({ key: "ArrowDown", shiftKey: true })).toEqual({ dx: 0, dy: 10 });
    expect(nudgeDelta({ key: "a", shiftKey: false })).toBeNull();
  });
});
