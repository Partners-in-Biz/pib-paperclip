// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const perform = vi.fn();
vi.mock("@/api/plugins", () => ({ pluginsApi: { bridgePerformAction: (...a: unknown[]) => perform(...a) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: vi.fn(async () => []) } }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots: [] }) }));

import { CanvasContextMenu } from "@/components/planning-canvas/toolbar/CanvasContextMenu";
import { ContextToolbar } from "@/components/planning-canvas/toolbar/FloatingToolbars";
import { PANEL_SLOTS } from "@/components/planning-canvas/panels/panel-slots";

const card = { id: "src", kind: "embed", x: 0, y: 0, width: 280, height: 160, zIndex: 1, color: "slate", title: "", content: "" };
function controller(access = "edit", extra: Record<string, unknown> = {}) {
  const setRelatedFor = vi.fn();
  const c = {
    selectedCompanyId: "c1",
    notesById: new Map(), nodes: [card], connectors: [], setConnectors: vi.fn(), selectedConnectorId: null,
    setScheduleNote: vi.fn(), promoteStickyToNoteMutation: { isPending: false, mutate: vi.fn() },
    commitCanvasChange: vi.fn(), deleteSelection: vi.fn(), duplicateSelection: vi.fn(), handleGiveNodeToAgent: vi.fn(),
    setHandoffOpen: vi.fn(), setChatAsk: vi.fn(), setEditingNodeId: vi.fn(), setContextMenu: vi.fn(),
    selectedNodeIds: ["src"], primarySelectedNode: card, nodeById: new Map([["src", card]]),
    contextMenu: { nodeId: "src", x: 10, y: 10 },
    activeBoard: { id: "b1", scope: "project", memberAccess: access },
    opStore: { linkMeta: new Map(), addItems: vi.fn(), typedMeta: new Map([["src", { kind: "embed", data: { plugin: "crm", type: "company", assetId: "co1", props: {} } }]]) },
    relatedFor: null, setRelatedFor,
    ...extra,
  };
  return { c: c as unknown as CanvasController, setRelatedFor };
}

let root: Root; let container: HTMLDivElement; let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  perform.mockReset(); perform.mockResolvedValue({ data: { groups: [] } });
  client = new QueryClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });
const render = (node: React.ReactNode) => act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
const related = () => [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Related"));

it("the real ContextToolbar shows Related and opens it for the selected card", async () => {
  const { c, setRelatedFor } = controller();
  await render(<ContextToolbar c={c} />);
  expect(related()).toHaveLength(1);
  await act(async () => related()[0]!.click());
  expect(setRelatedFor).toHaveBeenCalledWith("src");
});

it("the real ContextToolbar hides Related without edit access", async () => {
  await render(<ContextToolbar c={controller("view").c} />);
  expect(related()).toHaveLength(0);
});

it("the real CanvasContextMenu has a Related menu item that opens it and closes the menu", async () => {
  const { c, setRelatedFor } = controller();
  await render(<CanvasContextMenu c={c} />);
  const item = [...container.querySelectorAll('[role="menuitem"]')].filter((b) => b.textContent?.includes("Related"));
  expect(item).toHaveLength(1);
  await act(async () => (item[0] as HTMLElement).click());
  expect(setRelatedFor).toHaveBeenCalledWith("src");
  expect((c as unknown as { setContextMenu: ReturnType<typeof vi.fn> }).setContextMenu).toHaveBeenCalledWith(null);
});

it("the right panel slot list mounts the Related panel", async () => {
  const entry = PANEL_SLOTS.right.find((p) => p.id === "related-panel");
  expect(entry).toBeDefined();
  const { c } = controller("edit", { relatedFor: "src" });
  const Slot = entry!.Component;
  await render(<Slot c={c} />);
  expect(container.querySelector('[data-testid="canvas-related-panel"]')).not.toBeNull();
});
