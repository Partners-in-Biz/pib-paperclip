// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";

const refreshSource = vi.fn();
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { refreshSource: (...a: unknown[]) => refreshSource(...a) } }));

import { SourceBadge } from "./SourceBadge";

const source = { tool: "sheets-get-values", fetchedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), fetchedBy: "toby" };
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  refreshSource.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function mount(memberAccess: string) {
  const c = { selectedCompanyId: "c1", activeBoard: { id: "b1", scope: "project", memberAccess } };
  await act(async () => { root.render(<CanvasRefContext.Provider value={{ current: c } as never}><SourceBadge nodeKey="t1" source={source} /></CanvasRefContext.Provider>); });
}
const btn = () => container.querySelector('button[aria-label="Refresh from source"]') as HTMLButtonElement | null;

describe("SourceBadge", () => {
  it("shows tool, fetched time and who fetched", async () => {
    await mount("view");
    const text = container.textContent ?? "";
    expect(text).toContain("sheets-get-values");
    expect(text).toContain("by toby");
    expect(text).toMatch(/3h ago|hours? ago/);
  });
  it("shows Refresh only with edit access", async () => {
    await mount("comment");
    expect(btn()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount("edit");
    expect(btn()).not.toBeNull();
  });
  it("refresh calls the route with the node key and says the agent was asked", async () => {
    refreshSource.mockResolvedValue({});
    await mount("edit");
    await act(async () => { btn()!.click(); });
    expect(refreshSource).toHaveBeenCalledWith("c1", "b1", "t1", expect.any(String));
    expect(container.querySelector('[data-testid="canvas-source-asked"]')).not.toBeNull();
  });
  it("hides Refresh when the server says refresh is off, with a plain message", async () => {
    refreshSource.mockRejectedValue(new ApiError("x", 403, {}, { code: "canvas_source_refresh_disabled" }));
    await mount("edit");
    await act(async () => { btn()!.click(); });
    expect(btn()).toBeNull();
    expect(container.querySelector('[data-testid="canvas-source-notice"]')?.textContent).toContain("switched off");
  });
});
