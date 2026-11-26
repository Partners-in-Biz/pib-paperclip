// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PLANNING_CANVAS_BLUEPRINTS, planningCanvasFromBlueprintSchema } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintsDialog } from "./BlueprintsDialog";
import { blueprintLayout } from "./BlueprintPreview";
import { stubSearchableSelectDom, pickSearchableOption } from "@/test-utils/searchable-select";

const fromBlueprint = vi.hoisted(() => vi.fn());
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { fromBlueprint } }));

let container: HTMLDivElement;
let root: Root;
const agentId = "11111111-1111-4111-8111-111111111111";
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fromBlueprint.mockReset();
  stubSearchableSelectDom();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("blueprints", () => {
  it("lays out all six built-ins", () => {
    expect(PLANNING_CANVAS_BLUEPRINTS).toHaveLength(6);
    for (const bp of PLANNING_CANVAS_BLUEPRINTS) {
      const layout = blueprintLayout(bp);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);
    }
  });

  it("applies the ticked nodes with assignees and opens the new board", async () => {
    const board = { id: "b-new", title: "Sprint plan" };
    fromBlueprint.mockResolvedValue({ replayed: false, blueprintId: "sprint_plan", board, parentIssue: null, issues: [] });
    const setActiveBoardId = vi.fn();
    const setBlueprintsOpen = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const c = {
      blueprintsOpen: true,
      setBlueprintsOpen,
      selectedCompanyId: "c1",
      agents: [{ id: agentId, name: "Sam", status: "idle" }],
      pushToast: vi.fn(),
      queryClient: client,
      setActiveBoardId,
    } as never;
    await act(async () => root.render(<QueryClientProvider client={client}><BlueprintsDialog c={c} /></QueryClientProvider>));
    const body = document.body;
    const off = body.querySelector<HTMLButtonElement>('button[aria-label="Create an issue for Story 2"]')!;
    await act(async () => off.click());
    await pickSearchableOption(body, "Assign Story 1 to", "Sam");
    const create = [...body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Create board"))!;
    await act(async () => create.click());
    await flush();
    const sent = fromBlueprint.mock.calls[0]![1];
    expect(planningCanvasFromBlueprintSchema.safeParse(sent).success).toBe(true);
    expect(sent.parentIssue).toBe(true);
    expect(sent.issues).toEqual([{ key: "story-1", assigneeAgentId: agentId }, { key: "story-3" }, { key: "story-4" }]);
    expect(setActiveBoardId).toHaveBeenCalledWith("b-new");
    expect(setBlueprintsOpen).toHaveBeenCalledWith(false);
  });
});
