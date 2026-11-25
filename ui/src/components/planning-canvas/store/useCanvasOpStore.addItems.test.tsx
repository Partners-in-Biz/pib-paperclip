// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanvasConnector, CanvasNode, CanvasStroke } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { placeRelated } from "@/components/planning-canvas/state/placeRelated";

vi.mock("@/api/planningCanvases", () => ({
  planningCanvasesApi: {
    get: vi.fn(async () => ({ id: "b1", revision: 1, items: [], data: { nodes: [], connectors: [], strokes: [] } })),
    applyOps: vi.fn(async () => ({ revision: 2, results: [] })),
    readSince: vi.fn(async () => ({ revision: 1, items: [] })),
    applyOpsKeepalive: vi.fn(),
  },
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn(async () => ({ user: { id: "u1" } })) } }));

import { useCanvasOpStore } from "./useCanvasOpStore";

type Handle = ReturnType<typeof useCanvasOpStore>;
let handle: Handle;
let state: { nodes: CanvasNode[]; connectors: CanvasConnector[] };

function Probe() {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [connectors, setConnectors] = useState<CanvasConnector[]>([]);
  const [strokes, setStrokes] = useState<CanvasStroke[]>([]);
  handle = useCanvasOpStore({ companyId: "c1", boardId: "b1", nodes, connectors, strokes, setNodes, setConnectors, setStrokes, notify: vi.fn(), onHydrate: vi.fn() });
  state = { nodes, connectors };
  return null;
}

let root: Root; let container: HTMLDivElement; let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

it("addItems puts nodes and connectors on the page and in the meta maps, and one undo removes them all", async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(handle.loaded).toBe(true);

  const source = { key: "src", kind: "embed", x: 0, y: 0, width: 280, height: 160 };
  let n = 0;
  const placed = placeRelated({
    source,
    nodes: [source],
    records: [
      { relation: "contact", plugin: "crm", type: "contact", assetId: "p1" },
      { relation: "subtask", refKind: "issue", refId: "i1" },
    ],
    newKey: () => `k${++n}`,
  });
  await act(async () => {
    // The source must exist for the connector; add it first as the board would have it.
    handle.addItem("src", { kind: "embed", data: { plugin: "crm", type: "company", assetId: "co1", props: {} }, x: 0, y: 0, width: 280, height: 160, zIndex: 1, color: "slate", title: "", content: "" });
  });
  await act(async () => { handle.addItems(placed.items); });

  expect(state.nodes.map((x) => x.id).sort()).toEqual(["k1", "k3", "src"]);
  expect(state.connectors).toHaveLength(2);
  expect(state.connectors[0]).toMatchObject({ fromNodeId: "src", label: "contact" });
  expect(state.connectors.map((c) => c.toNodeId).sort()).toEqual(["k1", "k3"]);
  expect(handle.typedMeta.get("k1")).toMatchObject({ kind: "embed", data: { plugin: "crm", type: "contact", assetId: "p1" } });
  expect(handle.linkMeta.get("k3")).toMatchObject({ refKind: "issue", refId: "i1" });

  await act(async () => { handle.undo(); });
  expect(state.nodes.map((x) => x.id)).toEqual(["src"]);
  expect(state.connectors).toHaveLength(0);
});
