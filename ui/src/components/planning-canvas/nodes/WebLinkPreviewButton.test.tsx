// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningCanvasWebLinkData } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";

const unfurl = vi.fn();
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { unfurl: (...a: unknown[]) => unfurl(...a) } }));

import { WebLinkNode } from "./WebLinkNode";

const PREVIEW = { title: "<img src=x onerror=alert(1)> Title", description: "About the page", siteName: "Example", fetchedAt: "2026-11-26T00:00:00.000Z" };
let root: Root;
let container: HTMLDivElement;
const setNodeData = vi.fn();
let nodes: Array<{ id: string; height: number }> = [];
const setNodes = (fn: (prev: typeof nodes) => typeof nodes) => { nodes = fn(nodes); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  unfurl.mockReset();
  setNodeData.mockReset();
  nodes = [{ id: "w1", height: 132 }, { id: "other", height: 100 }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(data: PlanningCanvasWebLinkData, memberAccess = "edit") {
  const c = { selectedCompanyId: "c1", activeBoard: { id: "b1", scope: "project", memberAccess }, opStore: { setNodeData }, setNodes };
  await act(async () => {
    root.render(
      <CanvasRefContext.Provider value={{ current: c } as never}>
        <WebLinkNode nodeKey="w1" data={data} />
      </CanvasRefContext.Provider>,
    );
  });
}
const button = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Get preview")) ?? null;
const notice = () => container.querySelector('[data-testid="weblink-preview-notice"]')?.textContent ?? null;
const click = async () => act(async () => button()!.click());

describe("Get preview (D3)", () => {
  it("is offered with edit access only, and never on a YouTube card", async () => {
    await mount({ url: "https://example.com/a" }, "view");
    expect(button()).toBeNull();
    await mount({ url: "https://example.com/a" }, "comment");
    expect(button()).toBeNull();
    await mount({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(button()).toBeNull();
    await mount({ url: "https://example.com/a" });
    expect(button()).not.toBeNull();
    expect(unfurl).not.toHaveBeenCalled();
  });

  it("sends only the node key and saves the answer on the node through the op store", async () => {
    unfurl.mockResolvedValue({ preview: PREVIEW });
    await mount({ url: "https://example.com/a" });
    await click();
    expect(unfurl).toHaveBeenCalledWith("c1", "b1", "w1");
    expect(setNodeData).toHaveBeenCalledWith("w1", { url: "https://example.com/a", preview: PREVIEW });
    expect(notice()).toBeNull();
    // The 132-high card grows so the text is not cut; other nodes and taller cards keep their size.
    expect(nodes).toEqual([{ id: "w1", height: 220 }, { id: "other", height: 100 }]);
    nodes = [{ id: "w1", height: 300 }];
    await click();
    expect(nodes).toEqual([{ id: "w1", height: 300 }]);
  });

  it("says there is no preview when the server answers null, and saves nothing", async () => {
    unfurl.mockResolvedValue({ preview: null });
    await mount({ url: "https://example.com/a" });
    await click();
    expect(setNodeData).not.toHaveBeenCalled();
    expect(nodes[0]!.height).toBe(132);
    expect(notice()).toBe("No preview for this link.");
  });

  it("hides the button when the switch is off, from the code in the response body", async () => {
    unfurl.mockRejectedValue(new ApiError("Link previews are switched off", 403, { error: "Link previews are switched off", code: "canvas_unfurl_disabled" }));
    await mount({ url: "https://example.com/a" });
    await click();
    expect(button()).toBeNull();
    expect(notice()).toBe("Link previews are switched off.");
  });

  it("explains the rate limit and the in-flight cap, and keeps the button", async () => {
    unfurl.mockRejectedValueOnce(new ApiError("x", 429, { error: "x", code: "canvas_unfurl_rate_limited" }));
    await mount({ url: "https://example.com/a" });
    await click();
    expect(notice()).toBe("Too many previews this hour. Try again later.");
    unfurl.mockRejectedValueOnce(new ApiError("x", 429, { error: "x", code: "canvas_unfurl_busy" }));
    await click();
    expect(notice()).toBe("Previews are busy. Try again in a moment.");
    expect(button()).not.toBeNull();
  });

  it("draws a saved preview as text under the real host", async () => {
    await mount({ url: "https://evil.test/login", preview: PREVIEW });
    expect(container.querySelector("[data-weblink-host]")?.getAttribute("data-weblink-host")).toBe("evil.test");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)> Title");
    expect(container.querySelector("img")).toBeNull();
  });
});
