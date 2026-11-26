// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const perform = vi.fn();
vi.mock("@/api/plugins", () => ({ pluginsApi: { bridgePerformAction: (...a: unknown[]) => perform(...a) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));

const slot = (pluginKey: string, kind: string, search: boolean) => ({
  type: "canvasNode", id: `card-${kind}`, displayName: kind, exportName: "Card",
  pluginId: `id-${pluginKey}`, pluginKey, pluginDisplayName: `Plugin ${pluginKey}`, pluginVersion: "1",
  entityCard: { kind, search, related: false },
});
let slots: ReturnType<typeof slot>[] = [];
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots }) }));

import { InsertLinkPanel } from "./InsertLinkPanel";

const card = (id: string, title = `Record ${id}`) => ({ type: "company", id, title, subtitle: "Sub", href: `/x/${id}` });

let root: Root; let container: HTMLDivElement; let client: QueryClient;
let insertEmbedNode: ReturnType<typeof vi.fn>;

function controller(): CanvasController {
  insertEmbedNode = vi.fn();
  return {
    insertPanelOpen: true, setInsertPanelOpen: vi.fn(), selectedCompanyId: "c1",
    agents: [], projects: [], insertLinkNode: vi.fn(), insertEmbedNode,
  } as unknown as CanvasController;
}

async function render(c = controller()) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><InsertLinkPanel c={c} /></QueryClientProvider>);
  });
}
const tabs = () => [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent || t.getAttribute("aria-label"));
async function click(el: Element | null | undefined) {
  await act(async () => { (el as HTMLElement).click(); });
}
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 300)); }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  perform.mockReset();
  slots = [slot("crm", "company", true), slot("mailbox", "email", false)];
  client = new QueryClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

describe("InsertLinkPanel entity tabs", () => {
  it("adds a tab only for kinds with search: true", async () => {
    await render();
    expect(tabs()).toEqual(["Issues", "Agents", "Projects", "Goals", "company"]);
    expect(tabs()).not.toContain("email");
  });

  it("has no plugin tab when the plugin is missing from the slot list", async () => {
    slots = [];
    await render();
    expect(tabs()).toEqual(["Issues", "Agents", "Projects", "Goals"]);
    expect(perform).not.toHaveBeenCalled();
  });

  it("searches through canvas.cards.search and writes ids only on click", async () => {
    perform.mockResolvedValue({ data: { cards: [card("co1", "Acme Holdings")] } });
    const c = controller();
    await render(c);
    await click(container.querySelector('[role="tab"][title="company"]'));
    await flush();
    expect(perform).toHaveBeenCalledWith("id-crm", "canvas.cards.search", { type: "company", q: "", limit: 20 }, "c1");
    const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Acme Holdings"));
    await click(row);
    // Path 11: plugin, type and assetId only; no title, no props.
    expect(insertEmbedNode).toHaveBeenCalledTimes(1);
    expect(insertEmbedNode).toHaveBeenCalledWith("crm", "company", "co1");
    expect(insertEmbedNode.mock.calls[0]).toHaveLength(3);
  });

  it("shows the empty state when the search returns nothing", async () => {
    perform.mockResolvedValue({ data: { cards: [] } });
    await render();
    await click(container.querySelector('[role="tab"][title="company"]'));
    await flush();
    expect(container.textContent).toContain("Nothing found.");
  });

  it("shows nothing found when the plugin refuses", async () => {
    perform.mockRejectedValue(Object.assign(new Error("403"), { status: 403 }));
    await render();
    await click(container.querySelector('[role="tab"][title="company"]'));
    await flush();
    expect(container.textContent).toContain("Nothing found.");
    expect(container.textContent).not.toContain("403");
  });

  it("shows a plugin tab as an icon with the name on hover, not text", async () => {
    await render();
    const tab = container.querySelector('[role="tab"][aria-label="company"]');
    expect(tab?.getAttribute("title")).toBe("company");
    expect(tab?.querySelector("svg")).not.toBeNull();
    expect(tab?.textContent).toBe("");
  });

  it("falls back to a generic icon for an unknown plugin kind", async () => {
    slots = [slot("x", "some-new-kind", true)];
    await render();
    const tab = container.querySelector('[role="tab"][aria-label="some-new-kind"]');
    expect(tab?.getAttribute("title")).toBe("some-new-kind");
    expect(tab?.querySelector("svg")).not.toBeNull();
    expect(tab?.textContent).toBe("");
  });
});
