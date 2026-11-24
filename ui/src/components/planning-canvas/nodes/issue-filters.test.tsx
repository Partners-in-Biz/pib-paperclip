// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: api.get } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([{ id: "a1", name: "Agent One" }]) } }));
vi.mock("@/api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([{ id: "p1", name: "Launch" }]) } }));
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { IssueFilters } from "@/components/planning-canvas/nodes/IssueFilters";
import { defaultQuery } from "@/components/planning-canvas/nodes/issue-board";
import type { PlanningCanvasIssueQuery } from "@paperclipai/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const P = "22222222-2222-4222-8222-222222222222";

async function mount(query: PlanningCanvasIssueQuery, onChange: (q: PlanningCanvasIssueQuery) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CanvasRefContext.Provider value={{ current: { selectedCompanyId: "c" } } as never}>
          <IssueFilters query={query} onChange={onChange} />
        </CanvasRefContext.Provider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return host;
}
const change = async (el: Element, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("IssueFilters", () => {
  it("writes the project and assignee choice, and clearing removes the key", async () => {
    const onChange = vi.fn();
    const host = await mount(defaultQuery(), onChange);
    await change(host.querySelector('[aria-label="Filter by project"]')!, "p1");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { projectId: "p1" } }));
    await change(host.querySelector('[aria-label="Filter by assignee"]')!, "a1");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { assigneeAgentId: "a1" } }));
  });

  it("clears the project default with the empty option and with Clear filters", async () => {
    const onChange = vi.fn();
    const q = { ...defaultQuery(), filter: { projectId: "p1" } };
    const host = await mount(q, onChange);
    await change(host.querySelector('[aria-label="Filter by project"]')!, "");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filter: {} }));
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filter: {} }));
  });

  it("resolves a parent identifier to its id, ignores a failed lookup, and clears the chip", async () => {
    const onChange = vi.fn();
    api.get.mockRejectedValueOnce(new Error("nope"));
    const host = await mount(defaultQuery(), onChange);
    const input = host.querySelector<HTMLInputElement>('[aria-label="Filter by parent issue"]')!;
    const type = async (v: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    };
    await type("PAR-9");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    api.get.mockResolvedValue({ id: P, identifier: "PAR-9" });
    await type("PAR-9");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { parentId: P } }));

    const onChange2 = vi.fn();
    const host2 = await mount({ ...defaultQuery(), filter: { parentId: P } }, onChange2);
    await act(async () => {
      host2.querySelector<HTMLButtonElement>('[aria-label="Clear parent filter"]')!.click();
    });
    expect(onChange2).toHaveBeenLastCalledWith(expect.objectContaining({ filter: {} }));
  });

  it("lists agents that load after mount and closes the status list on Escape", async () => {
    const host = await mount(defaultQuery(), vi.fn());
    expect(host.querySelector('[aria-label="Filter by assignee"]')!.textContent).toContain("Agent One");
    const status = host.querySelector<HTMLButtonElement>('[aria-label="Filter by status"]')!;
    await act(async () => status.click());
    expect(host.querySelector("ul")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector("ul")).toBeNull();
  });
});
