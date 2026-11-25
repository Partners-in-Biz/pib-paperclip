// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { _resetPluginModuleLoader, registerPluginReactComponent } from "@/plugins/slots";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { EmbedNode } from "./EmbedNode";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));

const contribution: PluginUiContribution = {
  pluginId: "fixture", pluginKey: "fixture.canvas", displayName: "Fixture", version: "1", uiEntryFile: "index.js",
  slots: [{ type: "canvasNode", id: "card", displayName: "Card", exportName: "Card" }],
  launchers: [],
};
const controller = {
  selectedCompanyId: "c1", selectedNodeIds: ["n1"], opStore: { catchUp: vi.fn() },
  activeBoard: { id: "b1", scope: "project", projectId: "p1", memberAccess: "comment" },
};
let root: Root; let container: HTMLDivElement; let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("__paperclipPluginBridge__", {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.plugins.uiContributions, [contribution]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); client.clear(); _resetPluginModuleLoader(); vi.unstubAllGlobals();
});

async function render(plugin: string, type = "card") {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter>
      <CanvasRefContext.Provider value={{ current: controller } as never}>
        <EmbedNode nodeKey="n1" isSelected data={{ plugin, type, props: { label: "<b>hi</b>" } }} />
      </CanvasRefContext.Provider>
    </MemoryRouter></QueryClientProvider>,
  ));
}

it("mounts the plugin card with board props and draws props as text", async () => {
  registerPluginReactComponent("fixture.canvas", "Card", (p: Record<string, unknown>) => (
    <span data-testid="card">{`${(p.props as { label: string }).label}|${p.boardId}|${p.accessLevel}|${p.boardProjectId}|${(p.selection as string[]).join(",")}|${typeof p.applyOps}`}</span>
  ));
  await render("fixture.canvas");
  expect(container.querySelector('[data-testid="card"]')?.textContent).toBe("<b>hi</b>|b1|comment|p1|n1|function");
  expect(container.querySelector("b")).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
});

it("shows the placeholder when the plugin is not installed", async () => {
  await render("other.plugin");
  expect(container.querySelector('[data-canvas-placeholder="embed"]')).not.toBeNull();
  expect(container.textContent).toContain("Plugin not installed");
});
