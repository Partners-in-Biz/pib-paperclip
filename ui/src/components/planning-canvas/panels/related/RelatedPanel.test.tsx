// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const perform = vi.fn();
const listIssues = vi.fn();
vi.mock("@/api/plugins", () => ({ pluginsApi: { bridgePerformAction: (...a: unknown[]) => perform(...a) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: (...a: unknown[]) => listIssues(...a) } }));

const slot = (pluginKey: string, related: boolean) => ({
  type: "canvasNode", id: "card", displayName: pluginKey, exportName: "Card",
  pluginId: `id-${pluginKey}`, pluginKey, pluginDisplayName: `Plugin ${pluginKey}`, pluginVersion: "1",
  entityCard: { kind: "card", search: true, related },
});
let slots: ReturnType<typeof slot>[] = [];
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots }) }));

import { RelatedButton, RelatedPanel } from "./RelatedPanel";

const card = (id: string, title = `Record ${id}`) => ({ type: "contact", id, title, href: `/x/${id}` });
const answer = (cards: ReturnType<typeof card>[]) => ({ data: { groups: [{ relation: "contact", label: "Contacts", type: "contact", cards, more: false }] } });

function node(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, x: 0, y: 0, width: 280, height: 160, zIndex: 1, color: "slate", title: "", content: "", ...extra };
}

function controller(opts: { access?: string; source?: "embed" | "issue"; nodes?: unknown[]; connectors?: unknown[]; typed?: [string, unknown][] } = {}) {
  const source = opts.source ?? "embed";
  const typed = new Map<string, unknown>(opts.typed ?? []);
  const link = new Map<string, unknown>();
  const nodes: unknown[] = [source === "embed" ? node("src", "embed") : node("src", "issue"), ...(opts.nodes ?? [])];
  if (source === "embed") typed.set("src", { kind: "embed", data: { plugin: "crm", type: "company", assetId: "co1", props: {} } });
  else link.set("src", { refKind: "issue", refId: "i1", links: [] });
  const addItems = vi.fn();
  const c = {
    selectedCompanyId: "c1",
    relatedFor: "src",
    setRelatedFor: vi.fn(),
    nodes,
    connectors: opts.connectors ?? [],
    nodeById: new Map((nodes as { id: string }[]).map((n) => [n.id, n])),
    activeBoard: { id: "b1", scope: "project", memberAccess: opts.access ?? "edit" },
    opStore: { typedMeta: typed, linkMeta: link, addItems },
  };
  return { c: c as unknown as CanvasController, addItems };
}

let root: Root; let container: HTMLDivElement; let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  perform.mockReset(); listIssues.mockReset();
  slots = [slot("crm", true), slot("billing", true), slot("social", false)];
  client = new QueryClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

async function render(c: CanvasController) {
  await act(async () => root.render(<QueryClientProvider client={client}><RelatedPanel c={c} /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
const addButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Add "));

describe("RelatedPanel", () => {
  it("asks every plugin with entityCard.related, in parallel, with the source record", async () => {
    perform.mockImplementation(async (id: string) => answer([card(id === "id-crm" ? "p1" : "p2")]));
    await render(controller().c);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(perform.mock.calls.map((a) => a[0]).sort()).toEqual(["id-billing", "id-crm"]);
    expect(perform).toHaveBeenCalledWith("id-crm", "canvas.cards.related", { of: { plugin: "crm", type: "company", id: "co1" } }, "c1");
    expect(container.textContent).toContain("Record p1");
    expect(container.textContent).toContain("Record p2");
  });

  it("leaves a refusing plugin out with a note and keeps the others", async () => {
    perform.mockImplementation(async (id: string) => {
      if (id === "id-billing") throw new Error("refused");
      return answer([card("p1")]);
    });
    await render(controller().c);
    expect(container.textContent).toContain("Record p1");
    expect(container.textContent).toContain("Plugin billing could not be asked.");
  });

  it("writes plugin, type and assetId only, one connector per record, and nothing for the rest", async () => {
    perform.mockImplementation(async (id: string) => (id === "id-crm" ? answer([card("p1"), card("p2")]) : answer([])));
    const { c, addItems } = controller();
    await render(c);
    await click(container.querySelector('input[aria-label^="All"]'));
    await click(addButton());
    const items = addItems.mock.calls[0]![0] as Array<Record<string, unknown>>;
    const nodes = items.filter((i) => i.itemType === "node");
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.kind).toBe("embed");
      expect(Object.keys(n.data as object).sort()).toEqual(["assetId", "plugin", "props", "type"]);
      expect(n.data).toMatchObject({ plugin: "crm", type: "contact", props: {} });
    }
    expect(items.filter((i) => i.itemType === "connector").map((i) => i.label)).toEqual(["contact", "contact"]);
  });

  it("connects a record already on the board instead of adding it twice", async () => {
    perform.mockImplementation(async (id: string) => (id === "id-crm" ? answer([card("p1")]) : answer([])));
    const { c, addItems } = controller({
      nodes: [node("dup", "embed", { x: 900 })],
      typed: [["dup", { kind: "embed", data: { plugin: "crm", type: "contact", assetId: "p1", props: {} } }]],
    });
    await render(c);
    await click(container.querySelector('input[aria-label^="All"]'));
    await click(addButton());
    const items = addItems.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(items.filter((i) => i.itemType === "node")).toHaveLength(0);
    expect(items).toEqual([expect.objectContaining({ itemType: "connector", fromKey: "src", toKey: "dup" })]);
  });

  it("gets an issue card's subtasks from the issues list and adds at most 50 per add", async () => {
    listIssues.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, identifier: `PAR-${i}`, title: `Sub ${i}` })));
    const { c, addItems } = controller({ source: "issue" });
    await render(c);
    expect(listIssues).toHaveBeenCalledWith("c1", expect.objectContaining({ parentIds: ["i1"] }));
    expect(perform).not.toHaveBeenCalled();
    await click(container.querySelector('input[aria-label^="All"]'));
    expect(addButton()?.textContent).toBe("Add 50 to board");
    await click(addButton());
    const items = addItems.mock.calls[0]![0] as Array<Record<string, unknown>>;
    const nodes = items.filter((i) => i.itemType === "node");
    expect(nodes).toHaveLength(50);
    expect(nodes[0]).toMatchObject({ kind: "issue", ref: { id: "s0" } });
    expect(items.filter((i) => i.itemType === "connector").every((i) => i.label === "subtask")).toBe(true);
    expect(container.textContent).toContain("10 left out");
  });

  it("renders nothing and asks nobody without edit access", async () => {
    await render(controller({ access: "view" }).c);
    expect(container.querySelector('[data-testid="canvas-related-panel"]')).toBeNull();
    expect(perform).not.toHaveBeenCalled();
  });
});

describe("RelatedButton", () => {
  const mount = async (c: CanvasController, nodeId = "src") => {
    await act(async () => root.render(<RelatedButton c={c} nodeId={nodeId} />));
  };
  it("shows for an entity card with edit access", async () => {
    await mount(controller().c);
    expect(container.textContent).toContain("Related");
  });
  it("is hidden without edit access", async () => {
    await mount(controller({ access: "comment" }).c);
    expect(container.textContent).toBe("");
  });
  it("is hidden on a node that has no related source", async () => {
    await mount(controller({ nodes: [node("s1", "sticky")] }).c, "s1");
    expect(container.textContent).toBe("");
  });
});
