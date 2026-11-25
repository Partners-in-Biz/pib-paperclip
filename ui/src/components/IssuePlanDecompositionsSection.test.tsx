// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AcceptedPlanDecompositionSummary } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { IssuePlanDecompositionsSection } from "./IssuePlanDecompositionsSection";
import { queryKeys } from "../lib/queryKeys";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("../api/issues", () => ({
  issuesApi: { listAcceptedPlanDecompositions: vi.fn(async () => []) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function decomposition(childIssues: AcceptedPlanDecompositionSummary["childIssues"]): AcceptedPlanDecompositionSummary {
  return {
    id: "decomp-1",
    companyId: "company-1",
    sourceIssueId: "source-1",
    acceptedPlanRevisionId: "rev-1",
    acceptedInteractionId: null,
    acceptedPlanRevisionNumber: 1,
    status: "completed",
    requestFingerprint: "fp",
    requestedChildCount: 2,
    childIssueIds: childIssues.map((child) => child.id),
    ownerAgentId: null,
    ownerUserId: null,
    ownerRunId: null,
    completedAt: "2026-11-18T00:00:00.000Z",
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    childIssues,
  };
}

async function renderSection(record: AcceptedPlanDecompositionSummary) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.issues.acceptedPlanDecompositions("source-1"), [record]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(() => root.unmount());
    host.remove();
    client.clear();
  });
  await act(() => root.render(
    <QueryClientProvider client={client}>
      <IssuePlanDecompositionsSection issueId="source-1" issueIdentifier="PAR-1" companyId="company-1" />
    </QueryClientProvider>,
  ));
  return host;
}

it("renders a locked child as an identifier-only chip with no title, status or link", async () => {
  const host = await renderSection(decomposition([
    {
      id: "child-open",
      identifier: "PAR-2",
      title: "Open child title",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    { id: "child-private", identifier: "PAR-3", locked: true },
  ]));

  expect(host.textContent).toContain("Plan decomposition");
  expect(host.textContent).toContain("Open child title");
  expect(host.querySelector('a[href="/issues/PAR-2"]')).not.toBeNull();

  const chips = host.querySelectorAll('[data-testid="locked-issue-chip"]');
  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe("PAR-3");
  expect(host.querySelector('a[href="/issues/PAR-3"]')).toBeNull();
  expect(chips[0]?.closest("li")?.querySelector("[title]")).toBeNull();
});
