// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";

/**
 * PAR-14342 (AC-G10): on a task of a company where he is restricted under
 * `enforce`, a person's own session sends none of the task-detail reads the
 * route table keeps closed for him (email thread, task browsers) or leaves to
 * his runs (runner goal). Under `report`, and in a company where he is not
 * restricted, they are sent as before.
 */

const mocks = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  thread: vi.fn(async () => null),
  browsers: vi.fn(async () => []),
  runnerGoal: vi.fn(async () => ({ goal: null, capability: null })),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ memberRestrictions: mocks.restrictions }) } }));
vi.mock("@/api/email", () => ({ emailApi: { thread: mocks.thread } }));
vi.mock("@/api/browser-use", () => ({ browserUseApi: { list: mocks.browsers } }));
vi.mock("@/api/issues", () => ({ issuesApi: { getRunnerGoal: mocks.runnerGoal } }));
vi.mock("@/context/LiveUpdatesProvider", () => ({ useCompanyLiveEvent: () => undefined }));

const { useEmailThread } = await import("./useEmailThread");
const { useTaskBrowsers } = await import("./useTaskBrowsers");
const { useRunnerGoalControl } = await import("@/components/task-chat/RunnerGoalWidget");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "company-y";
const TASK = "12345678-1234-4234-8234-123456789abc";
const unmounts: Array<() => void> = [];

function Harness({ companyId }: { companyId: string }) {
  useEmailThread(companyId, TASK);
  useTaskBrowsers(TASK, companyId);
  useRunnerGoalControl(TASK, "agent-1", companyId);
  return null;
}

async function renderTaskReads(restrictions: SessionMemberRestriction[], companyId = COMPANY) {
  mocks.restrictions = restrictions;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Harness, { companyId })));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  unmounts.push(() => { act(() => root.unmount()); host.remove(); client.clear(); });
}

const sent = () => ({
  thread: mocks.thread.mock.calls.length,
  browsers: mocks.browsers.mock.calls.length,
  runnerGoal: mocks.runnerGoal.mock.calls.length,
});

beforeEach(() => {
  mocks.thread.mockClear();
  mocks.browsers.mockClear();
  mocks.runnerGoal.mockClear();
});
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

it("restricted here under enforce: no email thread, task browsers or runner goal read", async () => {
  await renderTaskReads([{ companyId: COMPANY, restricted: true, mode: "enforce" }]);
  expect(sent()).toEqual({ thread: 0, browsers: 0, runnerGoal: 0 });
});

it("under report, and restricted only in another company: the reads are sent as before", async () => {
  await renderTaskReads([{ companyId: COMPANY, restricted: true, mode: "report" }]);
  expect(sent()).toEqual({ thread: 1, browsers: 1, runnerGoal: 1 });
  mocks.thread.mockClear();
  mocks.browsers.mockClear();
  mocks.runnerGoal.mockClear();
  await renderTaskReads([{ companyId: "company-x", restricted: true, mode: "enforce" }]);
  expect(sent()).toEqual({ thread: 1, browsers: 1, runnerGoal: 1 });
});
