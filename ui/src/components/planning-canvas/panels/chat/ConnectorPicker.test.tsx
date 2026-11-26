// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { stubSearchableSelectDom, openSearchableSelect, pickSearchableOption } from "@/test-utils/searchable-select";

const readActions = vi.fn();
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { readActions: (...a: unknown[]) => readActions(...a) } }));

import { ConnectorPicker, pullAsk } from "./ConnectorPicker";
import { personalRefusalIn, sourceRefusalMessage } from "@/components/planning-canvas/nodes/source-errors";

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  stubSearchableSelectDom();
  readActions.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function mount(send = vi.fn(async () => true)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ConnectorPicker companyId="c1" boardId="b1" agentId="a1" sending={false} send={send} /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return send;
}

describe("ConnectorPicker", () => {
  it("lists the agent's read actions and asks the agent through chat", async () => {
    readActions.mockResolvedValue({ actions: [{ tool: "sheets-get-values", name: "Get values", description: "Read a range", application: "Google Sheets" }] });
    const send = await mount();
    await openSearchableSelect(container, "Read action");
    expect(document.body.textContent).toContain("Google Sheets: Get values");
    await pickSearchableOption(container, "Read action", "Google Sheets: Get values");
    await act(async () => { (Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Pull"))!).click(); });
    expect(send).toHaveBeenCalledWith(pullAsk("sheets-get-values"));
    expect(pullAsk("sheets-get-values")).toContain("Never write to the outside tool");
    expect(pullAsk("sheets-get-values")).toContain("table node, with its source set");
    expect(pullAsk("sheets-get-values")).not.toContain("markdown doc node");
    expect(pullAsk("sheets-get-values")).toContain("markdown node and say in this chat");
    expect(container.querySelector('[data-testid="canvas-connector-sent"]')).not.toBeNull();
  });
  it("says so when there are no read actions", async () => {
    readActions.mockResolvedValue({ actions: [] });
    await mount();
    expect(container.querySelector('[data-testid="canvas-connector-empty"]')).not.toBeNull();
  });
  it("shows a plain message when the list fails", async () => {
    readActions.mockRejectedValue(new ApiError("no", 404, {}, { code: "canvas_source_unknown_agent" }));
    await mount();
    expect(container.querySelector('[data-testid="canvas-connector-error"]')?.textContent).toContain("no longer active");
  });
});

describe("source refusals", () => {
  it("names why a personal source is refused", () => {
    expect(sourceRefusalMessage("canvas_personal_source_refused")).toMatch(/shared.*personal connections/);
    expect(personalRefusalIn("Failed: canvas_personal_source_refused")).toMatch(/shared/);
    expect(personalRefusalIn("all good")).toBeNull();
  });
});
