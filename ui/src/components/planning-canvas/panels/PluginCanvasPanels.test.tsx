// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { _resetPluginModuleLoader, registerPluginReactComponent } from "@/plugins/slots";
import { PluginCanvasPanels } from "./PluginCanvasPanels";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));

const contribution: PluginUiContribution = {
  pluginId: "fixture", pluginKey: "fixture.canvas", displayName: "Fixture", version: "1", uiEntryFile: "index.js",
  slots: [{ type: "canvasPanel", id: "panel", displayName: "Panel", exportName: "Panel" }],
  launchers: [],
};
const controller = {
  selectedCompanyId: "c1", selectedNodeIds: ["n1", "n2"], opStore: { catchUp: vi.fn() },
  activeBoard: { id: "b1", scope: "project", projectId: "p1", memberAccess: "view" },
};
let root: Root; let container: HTMLDivElement; let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("__paperclipPluginBridge__", {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); client.clear(); _resetPluginModuleLoader(); vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><PluginCanvasPanels c={controller as never} /></MemoryRouter></QueryClientProvider>,
  ));
}

it("mounts a canvasPanel slot with the board props, without an iframe", async () => {
  client.setQueryData(queryKeys.plugins.uiContributions, [contribution]);
  registerPluginReactComponent("fixture.canvas", "Panel", (p: Record<string, unknown>) => (
    <span data-testid="panel">{`${p.boardId}|${p.accessLevel}|${p.boardProjectId}|${(p.selection as string[]).join(",")}|${typeof p.applyOps}`}</span>
  ));
  await render();
  expect(container.querySelector('[data-testid="panel"]')?.textContent).toBe("b1|view|p1|n1,n2|function");
  expect(container.querySelector("iframe")).toBeNull();
});

it("renders nothing without a canvasPanel slot", async () => {
  client.setQueryData(queryKeys.plugins.uiContributions, [{ ...contribution, slots: [] }]);
  await render();
  expect(container.innerHTML).toBe("");
});
