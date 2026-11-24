// @vitest-environment jsdom

import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { initPluginBridge } from "./bridge-init";

// AC-G10 (PAR-13264): the plugin SDK task list (plugin pages) sends no
// `live-runs` request for a restricted member under `enforce`, and marks no task live.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  liveRunsForCompany: vi.fn(async () => [{ id: "run-1", agentId: "agent-1", issueId: "issue-1", status: "running" }]),
  liveIssueIds: null as ReadonlySet<string> | null,
}));

vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: api.restrictions }) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: api.liveRunsForCompany } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: async () => [{ id: "issue-1", parentId: null, status: "in_progress" }], update: vi.fn() } }));
vi.mock("@/components/IssuesList", () => ({
  IssuesList: ({ liveIssueIds }: { liveIssueIds: ReadonlySet<string> }) => {
    api.liveIssueIds = liveIssueIds;
    return null;
  },
}));

const ENFORCED = { companyId: "company-1", restricted: true, mode: "enforce" as const };

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderPluginList(entry: SessionMemberRestriction | null) {
  api.restrictions = entry ? [entry] : [];
  initPluginBridge(React, ReactDOM);
  const IssuesList = globalThis.__paperclipPluginBridge__!.sdkUi!.IssuesList as React.ComponentType<{ companyId: string }>;
  await act(async () => {
    root.render(<QueryClientProvider client={client}><IssuesList companyId="company-1" /></QueryClientProvider>);
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.liveRunsForCompany.mockClear();
  api.liveIssueIds = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("plugin SDK IssuesList (bridge-init)", () => {
  it("R under enforce: no live-runs request and no live task", async () => {
    await renderPluginList(ENFORCED);
    expect(api.liveRunsForCompany).not.toHaveBeenCalled();
    expect([...(api.liveIssueIds ?? [])]).toEqual([]);
  });

  it.each([
    ["the owner", null],
    ["R under report", { ...ENFORCED, mode: "report" as const }],
  ])("%s: live-runs is requested and the task is live", async (_who, entry) => {
    await renderPluginList(entry);
    expect(api.liveRunsForCompany).toHaveBeenCalledWith("company-1");
    expect([...(api.liveIssueIds ?? [])]).toEqual(["issue-1"]);
  });
});
