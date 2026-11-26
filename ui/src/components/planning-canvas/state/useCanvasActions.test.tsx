// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasActions, type CanvasActions } from "./useCanvasActions";

vi.mock("@/api/personalNotes", () => ({ personalNotesApi: {} }));

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function drive() {
  const addItem = vi.fn();
  const setSelectedNodeIds = vi.fn();
  const setTool = vi.fn();
  const ctx = {
    nodes: [], connectors: [], notesSearch: "", personalNotes: [], notesById: new Map(),
    viewport: { x: 0, y: 0, zoom: 1 }, canvasRef: { current: null },
    selectedNodeIds: [], setSelectedNodeIds, setTool,
    opStore: { addItem }, activeBoard: null,
  };
  let actions: CanvasActions | undefined;
  function Harness() { actions = useCanvasActions(ctx as never); return null; }
  await act(async () => { root.render(<Harness />); });
  return { actions: actions!, addItem, setSelectedNodeIds, setTool };
}

describe("insertEmbedNode (path 11)", () => {
  it("writes one embed node holding plugin, type and assetId only", async () => {
    const { actions, addItem, setSelectedNodeIds, setTool } = await drive();
    act(() => actions.insertEmbedNode("crm", "company", "co1"));
    expect(addItem).toHaveBeenCalledTimes(1);
    const [, item] = addItem.mock.calls[0]!;
    expect(item.kind).toBe("embed");
    expect(item.data).toStrictEqual({ plugin: "crm", type: "company", assetId: "co1", props: {} });
    expect(item.title).toBe("");
    expect(setSelectedNodeIds).toHaveBeenCalledTimes(1);
    expect(setTool).toHaveBeenCalledWith("select");
  });
});
