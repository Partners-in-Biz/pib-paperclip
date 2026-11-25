// PAR-13949 (C19): the keyboard map (plan section F) as data. The cheat sheet renders it and a
// test checks that no two entries share a key.
export type KeyGroup = "Tools" | "Edit" | "Select and move" | "View" | "Panels";

export type KeyBinding = {
  /** Unique id; also the command palette action id. */
  id: string;
  group: KeyGroup;
  label: string;
  /** Key caps, in order. `Mod` shows as Cmd on a Mac and Ctrl elsewhere. */
  keys: string[];
  /** Alternative chords for the same action; each must also be unique. */
  alt?: string[][];
};

export const KEY_BINDINGS: KeyBinding[] = [
  { id: "tool-select", group: "Tools", label: "Select", keys: ["V"] },
  { id: "tool-hand", group: "Tools", label: "Pan tool", keys: ["H"] },
  { id: "pan-drag", group: "Tools", label: "Pan while held, then drag", keys: ["Space"] },
  { id: "tool-sticky", group: "Tools", label: "Sticky note", keys: ["N"] },
  { id: "tool-frame", group: "Tools", label: "Frame", keys: ["F"] },
  { id: "tool-shape", group: "Tools", label: "Shape", keys: ["S"] },
  { id: "tool-text", group: "Tools", label: "Text", keys: ["T"] },
  { id: "tool-connect", group: "Tools", label: "Connector", keys: ["L"] },
  { id: "tool-pen", group: "Tools", label: "Pen", keys: ["D"] },
  { id: "add-markdown", group: "Tools", label: "Add markdown node", keys: ["M"] },
  { id: "comment", group: "Tools", label: "Comment on the selected node", keys: ["C"] },
  { id: "undo", group: "Edit", label: "Undo", keys: ["Mod", "Z"] },
  { id: "redo", group: "Edit", label: "Redo", keys: ["Mod", "Shift", "Z"] },
  { id: "duplicate", group: "Edit", label: "Duplicate", keys: ["Mod", "D"] },
  { id: "frame-selection", group: "Edit", label: "Frame the selection", keys: ["Mod", "G"] },
  { id: "delete", group: "Edit", label: "Delete", keys: ["Delete"], alt: [["Backspace"]] },
  { id: "edit", group: "Edit", label: "Edit the selected node", keys: ["Enter"] },
  { id: "select-all", group: "Select and move", label: "Select all", keys: ["Mod", "A"] },
  { id: "next-node", group: "Select and move", label: "Next node", keys: ["Tab"] },
  { id: "prev-node", group: "Select and move", label: "Previous node", keys: ["Shift", "Tab"] },
  { id: "nudge", group: "Select and move", label: "Nudge 1 px", keys: ["Arrow"] },
  { id: "nudge-big", group: "Select and move", label: "Nudge 10 px", keys: ["Shift", "Arrow"] },
  { id: "deselect", group: "Select and move", label: "Clear selection and tool", keys: ["Esc"] },
  { id: "fit", group: "View", label: "Fit board to screen", keys: ["0"] },
  { id: "zoom-100", group: "View", label: "Zoom to 100%", keys: ["1"] },
  { id: "find", group: "View", label: "Find on board", keys: ["Mod", "F"] },
  { id: "notes", group: "Panels", label: "Personal notes", keys: ["P"] },
  { id: "outline", group: "Panels", label: "Outline", keys: ["O"] },
  { id: "cheat-sheet", group: "Panels", label: "Keyboard shortcuts", keys: ["?"] },
];

/** The chord strings of every binding, for the no-clash test. */
export function allChords(): string[] {
  return KEY_BINDINGS.flatMap((b) => [b.keys, ...(b.alt ?? [])].map((chord) => chord.join("+").toLowerCase()));
}

export const KEY_GROUPS: KeyGroup[] = ["Tools", "Edit", "Select and move", "View", "Panels"];

/** Window event the command palette uses to run a canvas action (palette and canvas are separate trees). */
export const CANVAS_COMMAND_EVENT = "planning-canvas:command";
/** Window event the `C` key raises; the comments panel (C14) listens for it. */
export const CANVAS_COMMENT_EVENT = "planning-canvas:comment";

export type CanvasCommandId = "cheat-sheet" | "outline" | "fit" | "zoom-100" | "select-all" | "frame-selection" | "duplicate" | "add-markdown" | "find";

/** Palette entries. Ids are binding ids, so the palette shows the same key caps. */
export const CANVAS_COMMANDS: { id: CanvasCommandId; label: string }[] = [
  { id: "cheat-sheet", label: "Canvas: keyboard shortcuts" },
  { id: "outline", label: "Canvas: toggle Outline" },
  { id: "fit", label: "Canvas: fit board to screen" },
  { id: "zoom-100", label: "Canvas: zoom to 100%" },
  { id: "select-all", label: "Canvas: select all" },
  { id: "frame-selection", label: "Canvas: frame the selection" },
  { id: "duplicate", label: "Canvas: duplicate selection" },
  { id: "add-markdown", label: "Canvas: add markdown node" },
  { id: "find", label: "Canvas: find on board" },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true;
}

/** Arrow key to a world-unit step, or null. Shift is 10. */
export function nudgeDelta(e: Pick<KeyboardEvent, "key" | "shiftKey">): { dx: number; dy: number } | null {
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case "ArrowLeft": return { dx: -step, dy: 0 };
    case "ArrowRight": return { dx: step, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: -step };
    case "ArrowDown": return { dx: 0, dy: step };
    default: return null;
  }
}
