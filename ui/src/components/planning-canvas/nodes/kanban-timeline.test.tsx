// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn(), projects: vi.fn() }));
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { query: api.query } }));
vi.mock("@/api/issues", () => ({ issuesApi: { update: api.update } }));
vi.mock("@/api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: api.projects } }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a> }));
vi.mock("@/components/StatusIcon", () => ({ StatusIcon: () => null }));
vi.mock("@/components/PriorityIcon", () => ({ PriorityIcon: () => null }));
import { ApiError } from "@/api/client";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { KanbanNode } from "@/components/planning-canvas/nodes/KanbanNode";
import { TimelineNode } from "@/components/planning-canvas/nodes/TimelineNode";
import { cardTitle } from "@/components/planning-canvas/nodes/typed-meta";
import { activeFilterCount, boardProjectDefault, defaultQueryFor, toggleStatus, withFilter, groupIssues, issueBars, newKanban, newTimeline, projectMilestones, timelineLayout, type QueriedIssue } from "@/components/planning-canvas/nodes/issue-board";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

const issue = (n: number, over: Partial<QueriedIssue> = {}): QueriedIssue => ({
  id: `i${n}`,
  identifier: `PAR-${n}`,
  title: `Issue ${n}`,
  status: "todo",
  priority: "medium",
  projectId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

describe("issue filter mapping", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  it("sets and clears each filter key without touching the rest", () => {
    let q = newKanban().source;
    q = withFilter(q, { projectId: A, assigneeAgentId: A, goalId: A, parentId: A, status: ["todo", "done"] });
    expect(q.filter).toEqual({ projectId: A, assigneeAgentId: A, goalId: A, parentId: A, status: ["todo", "done"] });
    expect(activeFilterCount(q.filter)).toBe(5);
    q = withFilter(q, { projectId: null, status: [], goalId: "" });
    expect(q.filter).toEqual({ assigneeAgentId: A, parentId: A });
    expect(q.limit).toBe(newKanban().source.limit);
  });
  it("toggles statuses in workflow order and drops an empty list", () => {
    const on = toggleStatus({ status: ["done"] }, "todo");
    expect(on).toEqual(["todo", "done"]);
    expect(toggleStatus({ status: ["todo"] }, "todo")).toBeUndefined();
  });
  it("defaults a node added from a project board to that project", () => {
    expect(newKanban(A).source.filter).toEqual({ projectId: A });
    expect(newTimeline(A).source).toMatchObject({ kind: "issues", filter: { projectId: A } });
    expect(newKanban().source.filter).toEqual({});
    expect(defaultQueryFor(null).filter).toEqual({});
    expect(boardProjectDefault({ scope: "project", projectId: A })).toBe(A);
    expect(boardProjectDefault({ scope: "company", projectId: null })).toBeNull();
    expect(boardProjectDefault({ scope: "project", projectId: null })).toBeNull();
    expect(boardProjectDefault(null)).toBeNull();
  });
});

describe("issue-board model", () => {
  it("groups by status in workflow order and by assignee with an unassigned column", () => {
    const cols = groupIssues([issue(1), issue(2, { status: "done", assigneeAgentId: "a1" })], "status");
    expect(cols.find((c) => c.key === "todo")!.issues).toHaveLength(1);
    expect(cols.find((c) => c.key === "done")!.issues).toHaveLength(1);
    expect(groupIssues([issue(1), issue(2, { assigneeAgentId: "a1" })], "assignee").map((c) => c.key)).toEqual(["unassigned", "a1"]);
    expect(groupIssues([issue(1, { priority: "high" })], "priority").find((c) => c.key === "high")!.issues).toHaveLength(1);
  });

  it("draws bars startedAt|createdAt to completedAt|now and project targetDate milestones", () => {
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    const bars = issueBars([issue(1), issue(2, { startedAt: "2026-11-05T00:00:00.000Z", completedAt: "2026-11-10T00:00:00.000Z" })], now);
    expect(bars[0]).toMatchObject({ id: "i1", start: Date.parse("2026-11-01T00:00:00.000Z"), end: now, done: false });
    expect(bars[1]).toMatchObject({ id: "i2", start: Date.parse("2026-11-05T00:00:00.000Z"), end: Date.parse("2026-11-10T00:00:00.000Z"), done: true });
    const ms = projectMilestones([{ id: "p", name: "Launch", targetDate: "2026-12-01", createdAt: "2026-10-01" }, { id: "q", name: "No date", targetDate: null, createdAt: "2026-10-01" }], null);
    expect(ms).toEqual([{ id: "p", label: "Launch", at: Date.parse("2026-12-01") }]);
    const day = timelineLayout(bars, ms, "day", now);
    const month = timelineLayout(bars, ms, "month", now);
    expect(day.widthRem).toBeGreaterThan(month.widthRem);
    expect(month.ticks.length).toBeLessThan(day.ticks.length);
  });
});

async function mount(node: ReactElement, controller: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CanvasRefContext.Provider value={{ current: { selectedCompanyId: "c", activeBoard: { id: "b" }, agents: [], opStore: { setNodeData: vi.fn() }, ...controller } } as never}>
          {node}
        </CanvasRefContext.Provider>
      </QueryClientProvider>,
    );
  });
  return host;
}

const drop = async (host: HTMLElement, from: string, to: string) => {
  const card = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(from))!;
  const column = host.querySelector(`section[aria-label="${to}"]`)!;
  await act(async () => {
    card.dispatchEvent(new Event("dragstart", { bubbles: true }));
  });
  await act(async () => {
    column.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    column.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  });
};

describe("KanbanNode", () => {
  it("moves a card with PATCH {status} and keeps it there", async () => {
    api.query.mockResolvedValueOnce({ issues: [issue(1)], limit: 200 }).mockResolvedValue({ issues: [issue(1, { status: "done" })], limit: 200 });
    api.update.mockResolvedValue({});
    const host = await mount(<KanbanNode nodeKey="k" title="" data={newKanban()} />, { pushToast: vi.fn() });
    await vi.waitFor(() => expect(host.textContent).toContain("Issue 1"));
    await drop(host, "Issue 1", "Done");
    expect(api.update).toHaveBeenCalledWith("i1", { status: "done" });
    await vi.waitFor(() => expect(host.querySelector('section[aria-label="Done"]')!.textContent).toContain("Issue 1"));
  });

  it("reverts the card and toasts when the server answers 403", async () => {
    api.query.mockResolvedValue({ issues: [issue(1)], limit: 200 });
    api.update.mockRejectedValue(new ApiError("Forbidden", 403, {}));
    const pushToast = vi.fn();
    const host = await mount(<KanbanNode nodeKey="k" title="" data={newKanban()} />, { pushToast });
    await vi.waitFor(() => expect(host.textContent).toContain("Issue 1"));
    await drop(host, "Issue 1", "Done");
    await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", title: "You can't move this issue" })));
    expect(host.querySelector('section[aria-label="Todo"]')!.textContent).toContain("Issue 1");
    expect(host.querySelector('section[aria-label="Done"]')!.textContent).not.toContain("Issue 1");
  });

  it("shows the empty, error and 200-cap states", async () => {
    api.query.mockResolvedValueOnce({ issues: [], limit: 200 });
    let host = await mount(<KanbanNode nodeKey="k" title="" data={newKanban()} />, {});
    await vi.waitFor(() => expect(host.textContent).toContain("No issues match"));
    api.query.mockRejectedValueOnce(new Error("boom"));
    host = await mount(<KanbanNode nodeKey="k2" title="" data={{ ...newKanban(), groupBy: "priority" }} />, {});
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load issues"));
    api.query.mockResolvedValueOnce({ issues: Array.from({ length: 200 }, (_, i) => issue(i)), limit: 200 });
    host = await mount(<KanbanNode nodeKey="k3" title="" data={{ ...newKanban(), groupBy: "assignee" }} />, {});
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain("first 200"));
  });
});

describe("TimelineNode", () => {
  it("renders bars, a milestone and the empty state", async () => {
    api.projects.mockResolvedValue([{ id: "p", name: "Launch", targetDate: "2026-12-01", createdAt: "2026-10-01T00:00:00Z" }]);
    api.query.mockResolvedValueOnce({ issues: [issue(1, { projectId: "p" })], limit: 200 });
    let host = await mount(<TimelineNode nodeKey="t" title="" data={newTimeline()} />, {});
    await vi.waitFor(() => expect(host.textContent).toContain("PAR-1 Issue 1"));
    expect(host.textContent).toContain("Launch");
    api.query.mockResolvedValueOnce({ issues: [], limit: 200 });
    api.projects.mockResolvedValue([]);
    host = await mount(<TimelineNode nodeKey="t2" title="" data={newTimeline()} />, {});
    await vi.waitFor(() => expect(host.textContent).toContain("Nothing to show"));
  });
});

describe("card header title (PAR-14836)", () => {
  it.each(["", "(untitled)", "Untitled", " (Untitled) "])("falls back to the kind label for stored title %j", async (stored) => {
    api.query.mockResolvedValue({ issues: [], limit: 200 });
    let host = await mount(<KanbanNode nodeKey="k" title={cardTitle(stored)} data={newKanban()} />, {});
    expect(host.textContent).toContain("Kanban");
    expect(host.textContent?.toLowerCase()).not.toContain("untitled");
    host = await mount(<TimelineNode nodeKey="t" title={cardTitle(stored)} data={newTimeline()} />, {});
    expect(host.textContent).toContain("Timeline");
    expect(host.textContent?.toLowerCase()).not.toContain("untitled");
  });
  it("keeps a real title", async () => {
    api.query.mockResolvedValue({ issues: [], limit: 200 });
    const host = await mount(<KanbanNode nodeKey="k" title={cardTitle("Sprint 4")} data={newKanban()} />, {});
    expect(host.textContent).toContain("Sprint 4");
  });
});
