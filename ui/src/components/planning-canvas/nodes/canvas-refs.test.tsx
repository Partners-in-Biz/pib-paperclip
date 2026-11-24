// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningCanvasRefsRead } from "@/api/planningCanvases";
import { useCanvasRefs, type CanvasRefMap } from "./canvas-refs";
import type { NodeLinkMeta } from "./link-meta";

const refs = vi.hoisted(() => vi.fn());
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { refs } }));

const empty: PlanningCanvasRefsRead = { issues: [], agents: [], projects: [], goals: [], truncated: false };
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  refs.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

function mount(meta: ReadonlyMap<string, NodeLinkMeta>) {
  const out = { current: new Map() as CanvasRefMap };
  // One component type for every render: a new type would remount and reset the hook's save tracking.
  function Probe({ state }: { state: "saved" | "saving" }) {
    out.current = useCanvasRefs("c1", "b1", meta, state);
    return null;
  }
  const render = (state: "saved" | "saving") =>
    act(async () => root.render(<QueryClientProvider client={client}><Probe state={state} /></QueryClientProvider>));
  return { out, render };
}

describe("useCanvasRefs", () => {
  it("resolves a card inserted before its op batch was saved, once the store reports saved", async () => {
    const meta = new Map<string, NodeLinkMeta>([["n1", { refKind: "issue", refId: "i1", links: [] }]]);
    // The first read predates the flush: the server does not know the new node yet.
    refs.mockResolvedValueOnce(empty);
    refs.mockResolvedValue({ ...empty, issues: [{ id: "i1", identifier: "PAR-5", title: "T", status: "todo", priority: "low", assigneeAgentId: null }] });
    const { out, render } = mount(meta);
    await render("saved");
    await flush();
    expect(out.current.get("i1")).toBeUndefined();
    await render("saving");
    await render("saved");
    await flush();
    expect(out.current.get("i1")).toMatchObject({ identifier: "PAR-5" });
    expect(refs).toHaveBeenCalledTimes(2);
  });

  it("marks ids a truncated read did not reach as not loaded", async () => {
    const meta = new Map<string, NodeLinkMeta>([["n1", { refKind: "issue", refId: "i9", links: [] }]]);
    refs.mockResolvedValue({ ...empty, truncated: true });
    const { out, render } = mount(meta);
    await render("saved");
    await flush();
    expect(out.current.get("i9")).toEqual({ id: "i9", notLoaded: true });
  });
});
