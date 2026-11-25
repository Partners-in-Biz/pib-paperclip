// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), documents: vi.fn(), products: vi.fn(), attachments: vi.fn() }));
vi.mock("@/api/issues", () => ({
  issuesApi: { list: api.list, listDocuments: api.documents, listWorkProducts: api.products, listAttachments: api.attachments },
}));
vi.mock("@/lib/router", () => ({ Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => <a href={to} className={className}>{children as never}</a> }));
vi.mock("@/components/StatusBadge", () => ({ IssueStatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { CanvasRefsContext } from "@/components/planning-canvas/nodes/canvas-refs";
import { IssueNode } from "@/components/planning-canvas/nodes/IssueNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const parent = { id: "p1", identifier: "PAR-1", title: "Parent", status: "todo" };
const child = (n: number) => ({ id: `c${n}`, identifier: `PAR-${100 + n}`, title: `Child ${n}`, status: "todo" });

async function mount(canEdit: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CanvasRefContext.Provider value={{ current: { selectedCompanyId: "co", canEdit } } as never}>
          <CanvasRefsContext.Provider value={new Map([[parent.id, parent]])}>
            <IssueNode refId="p1" />
          </CanvasRefsContext.Provider>
        </CanvasRefContext.Provider>
      </QueryClientProvider>,
    );
  });
  return host;
}
const open = async (host: HTMLElement) => {
  await act(async () => {
    (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click();
  });
};

describe("IssueNode expand", () => {
  it("reads nothing until the first open, then lists subtasks and artifact links", async () => {
    api.list.mockResolvedValue([child(1), child(2)]);
    api.documents.mockResolvedValue([{ id: "d1", key: "plan", title: "Plan" }]);
    api.products.mockResolvedValue([{ id: "w1", title: "PR 12" }]);
    api.attachments.mockResolvedValue([{ id: "a1", originalFilename: "shot.png" }]);
    const host = await mount(true);
    expect(api.list).not.toHaveBeenCalled();
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Child 2"));
    expect(api.list).toHaveBeenCalledWith("co", expect.objectContaining({ parentIds: ["p1"] }));
    await vi.waitFor(() => expect(host.textContent).toContain("shot.png"));
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/issues/PAR-101");
    expect(hrefs).toContain("/issues/PAR-1#document-plan");
    expect(host.textContent).toContain("PR 12");
  });

  it("lets a view-only viewer expand", async () => {
    api.list.mockResolvedValue([child(1)]);
    api.documents.mockResolvedValue([]);
    api.products.mockResolvedValue([]);
    api.attachments.mockResolvedValue([]);
    const host = await mount(false);
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Child 1"));
    expect(host.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows 20 of 21 subtasks and a count", async () => {
    api.list.mockResolvedValue(Array.from({ length: 21 }, (_, i) => child(i + 1)));
    api.documents.mockResolvedValue([]);
    api.products.mockResolvedValue([]);
    api.attachments.mockResolvedValue([]);
    const host = await mount(true);
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Child 20"));
    expect(host.textContent).not.toContain("Child 21");
    expect(host.textContent).toContain("1 more");
  });

  it("shows the empty states", async () => {
    api.list.mockResolvedValue([]);
    api.documents.mockResolvedValue([]);
    api.products.mockResolvedValue([]);
    api.attachments.mockResolvedValue([]);
    const host = await mount(true);
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("No artifacts."));
    expect(host.textContent).toContain("No subtasks.");
  });

  it("shows an error when a read fails and keeps what loaded", async () => {
    api.list.mockRejectedValue(new Error("boom"));
    api.documents.mockResolvedValue([{ id: "d1", key: "plan", title: "Plan" }]);
    api.products.mockRejectedValue(new Error("boom"));
    api.attachments.mockResolvedValue([]);
    const host = await mount(true);
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Couldn't load subtasks."));
    await vi.waitFor(() => expect(host.textContent).toContain("Couldn't load all artifacts."));
    expect(host.textContent).toContain("Plan");
  });
});
