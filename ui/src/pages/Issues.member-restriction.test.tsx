// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Issue, SessionMemberRestriction } from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { Issues } from "./Issues";

// AC-G10 (PAR-13266): the task list sends no live-runs request for a person
// restricted under `enforce`, and shows no live mark; everyone else keeps them.

const mocks = vi.hoisted(() => ({
  liveRuns: vi.fn(),
  restrictions: [] as SessionMemberRestriction[],
}));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ memberRestrictions: mocks.restrictions }) } }));
vi.mock("../api/issues", () => ({ issuesApi: { listCompact: async () => [{ id: "task-1", status: "in_progress" }] } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRuns } }));
vi.mock("../hooks/useUpdateIssueMutation", () => ({ useUpdateIssueMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("../components/IssuesList", () => ({
  IssuesList: ({ issues, liveIssueIds }: { issues: Issue[]; liveIssueIds?: Set<string> }) => (
    <output data-live={[...(liveIssueIds ?? [])].join(",")}>{issues.map((issue) => issue.id).join(",")}</output>
  ),
}));

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

async function renderIssues(restrictions: SessionMemberRestriction[]) {
  mocks.restrictions = restrictions;
  mocks.liveRuns.mockResolvedValue([{ id: "run-1", status: "running", agentId: "agent-1", issueId: "task-1" }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all"]}><Issues /></MemoryRouter></QueryClientProvider>));
  await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("task-1"));
  return { host, cleanup: () => { flushSync(() => root.unmount()); client.clear(); host.remove(); } };
}

it("sends no live-runs request and shows no live mark for R under enforce", async () => {
  const { host, cleanup } = await renderIssues([{ companyId: "company", restricted: true, mode: "enforce" }]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.liveRuns).not.toHaveBeenCalled();
    expect(host.querySelector("output")?.getAttribute("data-live")).toBe("");
  } finally { cleanup(); }
});

it.each([
  ["the owner", [] as SessionMemberRestriction[]],
  ["R under report", [{ companyId: "company", restricted: true, mode: "report" as const }]],
])("requests live runs and shows the live mark for %s", async (_who, restrictions) => {
  const { host, cleanup } = await renderIssues(restrictions);
  try {
    await vi.waitFor(() => expect(host.querySelector("output")?.getAttribute("data-live")).toBe("task-1"));
    expect(mocks.liveRuns).toHaveBeenCalledWith("company");
  } finally { cleanup(); }
});
