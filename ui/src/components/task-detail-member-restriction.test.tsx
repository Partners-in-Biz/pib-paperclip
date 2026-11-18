// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Issue, SessionMemberRestriction } from "@paperclipai/shared";
import { ApiError } from "@/api/api-error";
import { queryKeys } from "@/lib/queryKeys";
import { IssuePlanDecompositionsSection } from "./IssuePlanDecompositionsSection";
import { IssuePrivacyActions } from "./IssuePrivacyActions";
import { IssueShareSheet } from "./IssueShareSheet";
import { RunWorkspaceSourceInspection } from "./RunWorkspaceSourceInspection";
import { IssuePropertiesPlansTab } from "./issue-properties/IssuePropertiesPlansTab";
import { RoutineOriginRow } from "./issue-properties/routine-origin-row";
import { TaskSkillPanel } from "./task-side-panel/TaskSkillPanel";

// AC-G10 on task detail (PAR-12932): each panel below reads a route closed to a
// restricted member. Under `enforce` it sends no request and shows nothing; under
// `report` and for the owner it works as before; a stale session's 403 is no error.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C = "company-1";
const api = vi.hoisted(() => ({
  session: vi.fn(), routine: vi.fn(), skill: vi.fn(), plans: vi.fn(), constraints: vi.fn(),
  grants: vi.fn(), recovery: vi.fn(),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/api/routines", () => ({ routinesApi: { get: api.routine } }));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: { detail: api.skill } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listAcceptedPlanDecompositions: api.plans,
  privacyConstraints: api.constraints, listAccessGrants: api.grants, recoveryActions: api.recovery,
  listInteractions: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: vi.fn(), getCurrentBoardAccess: vi.fn() } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null, isLoading: false }) }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(), useLocation: () => ({ pathname: "/", hash: "", search: "" }),
}));

const issue = { id: "issue-1", identifier: "PAP-1", companyId: C, visibility: "private" } as Issue;
type Case = { name: string; call: Mock; data: unknown; shown: string | null; ui: () => ReactNode; click?: string };
const cases: Case[] = [
  { name: "routine origin row", call: api.routine, data: { title: "Nightly report" }, shown: "Nightly report",
    ui: () => <RoutineOriginRow routineId="routine-1" companyId={C} /> },
  { name: "skill panel", call: api.skill, data: { id: "s", name: "Release helper", slug: "rh", markdown: "x" },
    shown: "Release helper", ui: () => <TaskSkillPanel companyId={C} skillId="s" /> },
  { name: "plans tab", call: api.plans, data: [], shown: null, ui: () => <IssuePropertiesPlansTab issue={issue} /> },
  { name: "plan decompositions", call: api.plans, data: [], shown: null,
    ui: () => <IssuePlanDecompositionsSection issueId="issue-1" issueIdentifier="PAP-1" companyId={C} /> },
  { name: "privacy actions", call: api.constraints, data: { publicBlockedBy: null, leavesPersonalProject: false },
    shown: "Share…", ui: () => <IssuePrivacyActions issue={issue} companyId={C} canManage closeMenu={() => {}}>
      {(items) => <div>{items}</div>}</IssuePrivacyActions> },
  { name: "share sheet grants", call: api.grants, data: [], shown: null,
    ui: () => <IssueShareSheet issueId="issue-1" companyId={C} canManage open onOpenChange={() => {}} /> },
  { name: "recovery inspection", call: api.recovery, data: { active: null, actions: [] }, shown: "Inspect recovery",
    click: "Inspect recovery", ui: () => <RunWorkspaceSourceInspection issueId="issue-1" runId="run-1" companyId={C} /> },
];

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let session: { memberRestrictions: SessionMemberRestriction[] };

async function render(c: Case) {
  client.setQueryData(queryKeys.auth.session, session);
  await act(async () => root.render(<QueryClientProvider client={client}>{c.ui()}</QueryClientProvider>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === c.click);
  if (button) {
    await act(async () => button.click());
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}
const as = (restricted: boolean, mode: "off" | "report" | "enforce") => ({ memberRestrictions: [{ companyId: C, restricted, mode }] });

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  api.session.mockImplementation(async () => session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe.each(cases)("task detail, $name", (c) => {
  it("sends no request and shows nothing for a person restricted under enforce", async () => {
    session = as(true, "enforce");
    c.call.mockResolvedValue(c.data);
    await render(c);
    expect(c.call).not.toHaveBeenCalled();
    if (c.shown) expect(container.textContent).not.toContain(c.shown);
  });

  it.each([["the owner", { memberRestrictions: [] }], ["R at report", as(true, "report")]])("works as today for %s", async (_who, s) => {
    session = s;
    c.call.mockResolvedValue(c.data);
    await render(c);
    expect(c.call).toHaveBeenCalled();
    if (c.shown) expect(container.textContent).toContain(c.shown);
  });

  it("answers a stale session's 403 MEMBER_RESTRICTED with no error and refreshes the session", async () => {
    session = as(true, "report");
    c.call.mockRejectedValue(new ApiError("Not available", 403, { error: "Not available", code: "MEMBER_RESTRICTED" }));
    await render(c);
    expect(c.call).toHaveBeenCalled();
    expect(api.session).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"], [data-query-view="error"]')).toBeNull();
  });
});
