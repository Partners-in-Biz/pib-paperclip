// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPluginSlot } from "@/plugins/slots";
import { TASK_SIDE_PANEL_PLUGIN_TAB_REFRESH_MS, taskSidePanelPluginTabId, useTaskSidePanelPluginTabs } from "./useTaskSidePanelPluginTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  bridgeGetData: vi.fn(),
  slots: { slots: [] as unknown[], errorMessage: null as string | null, isLoading: false },
}));
vi.mock("@/api/plugins", () => ({ pluginsApi: { bridgeGetData: mocks.bridgeGetData } }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => mocks.slots }));

const slot = { pluginId: "plugin-1", pluginKey: "example.cockpit", pluginVersion: "1.0.0", pluginDisplayName: "Cockpit", type: "taskSidePanelTab", id: "browser", displayName: "Browser", exportName: "BrowserTab", sidePanelTab: { visibilityDataKey: "browser-visible" } } as ResolvedPluginSlot;
const task = { id: "task-1", companyId: "company-1", projectId: "project-1" };

describe("useTaskSidePanelPluginTabs", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let visible: string[][];

  function Probe({ issue = task }: { issue?: typeof task }) {
    visible.push(useTaskSidePanelPluginTabs(issue).map(taskSidePanelPluginTabId));
    return null;
  }
  // React Query batches notifications on a timer; let them land.
  const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const render = async (issue = task) => {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Probe issue={issue} /></QueryClientProvider>));
    await settle();
  };
  const last = () => visible[visible.length - 1];

  beforeEach(() => {
    mocks.bridgeGetData.mockReset();
    mocks.slots = { slots: [slot], errorMessage: null, isLoading: false };
    visible = [];
    container = document.createElement("div");
    root = createRoot(container);
    queryClient = new QueryClient();
  });
  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
  });

  it("asks the plugin with issue context and lists the tab only after it answers visible", async () => {
    let answer!: (value: { data: unknown }) => void;
    mocks.bridgeGetData.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    await render();
    expect(visible.every(ids => ids.length === 0)).toBe(true);
    expect(mocks.bridgeGetData).toHaveBeenCalledWith("plugin-1", "browser-visible", { issueId: "task-1", projectId: "project-1" }, "company-1");
    await act(async () => answer({ data: { visible: true } }));
    await settle();
    expect(last()).toEqual(["plugin-tab:example.cockpit:browser"]);
    expect(TASK_SIDE_PANEL_PLUGIN_TAB_REFRESH_MS).toBe(10_000);
  });

  it("removes the tab when the plugin stops reporting it", async () => {
    mocks.bridgeGetData.mockResolvedValue({ data: { visible: true } });
    await render();
    expect(last()).toHaveLength(1);
    mocks.bridgeGetData.mockResolvedValue({ data: { visible: false } });
    await act(async () => { await queryClient.refetchQueries(); });
    await settle();
    expect(last()).toEqual([]);
  });

  it.each([
    ["a truthy non-boolean", { data: { visible: "yes" } }],
    ["a bare true", { data: true }],
    ["no data", { data: null }],
  ])("fails closed on %s", async (_label, answer) => {
    mocks.bridgeGetData.mockResolvedValue(answer);
    await render();
    expect(last()).toEqual([]);
  });

  it("fails closed when the plugin errors, even after it was visible", async () => {
    mocks.bridgeGetData.mockResolvedValue({ data: { visible: true } });
    await render();
    expect(last()).toHaveLength(1);
    mocks.bridgeGetData.mockRejectedValue(new Error("worker crashed"));
    await act(async () => { await queryClient.refetchQueries().catch(() => {}); });
    await settle(700);
    expect(last()).toEqual([]);
  });

  it("asks nothing for chat conversations or when slots fail to load", async () => {
    await render({ ...task, id: "chat:agent-1" });
    mocks.slots = { slots: [slot], errorMessage: "Plugins unavailable", isLoading: false };
    await render();
    expect(mocks.bridgeGetData).not.toHaveBeenCalled();
    expect(last()).toEqual([]);
  });
});
