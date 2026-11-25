// @vitest-environment jsdom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { MemberRestrictionProvider } from "@/context/MemberRestrictionContext";
import { ToastProvider } from "@/context/ToastContext";
import { DialogProvider } from "@/context/DialogContext";
import { AGENT_DETAIL_NAVIGATION } from "./agent-detail-navigation";
import { AgentContextualSidebar } from "@/components/AgentContextualSidebar";
import { AgentDetail } from "./AgentDetail";
import { AgentDetail as ProductionAgentDetail } from "./AgentDetail.production";
import { markCachedSession } from "../lib/cached-session";
import { startPersistedQueryCache } from "../lib/persisted-query-cache";
import { queryKeys } from "../lib/queryKeys";

// AC-G10 (PAR-13266): on an agent page, R (restricted under `enforce`) gets the
// overview only and sends no request the route table refuses. Every request
// goes through `fetch`, so the test records the real requests of the real page.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = { id: "company-1", issuePrefix: "PAR", name: "Partners", status: "active" };
const AGENT = {
  id: "agent-1", companyId: COMPANY.id, name: "Alpha", urlKey: "alpha", role: "engineer", title: null, icon: null,
  status: "idle", reportsTo: null, capabilities: null, adapterType: "process", adapterConfig: {}, runtimeConfig: {},
  budgetMonthlyCents: 0, spentMonthlyCents: 0, permissions: { canCreateAgents: false }, lastHeartbeatAt: null,
  metadata: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", createdByUserId: null,
  lifecycleVersion: 0,
};

const state = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[], requests: [] as string[], urls: [] as string[],
  agentBody: null as Record<string, unknown> | null, experimental: {} as Record<string, unknown>, sessionPending: null as Promise<void> | null,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY, setSelectedCompanyId: vi.fn() }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn(), openPanel: vi.fn() }) }));
vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: async () => {
    if (state.sessionPending) await state.sessionPending;
    return { session: { id: "s", userId: "user-1" }, user: { id: "user-1" }, memberRestrictions: state.restrictions };
  } } };
});
vi.mock("../components/AgentCharacter", () => ({ AgentCharacter: () => null }));

/** Reads the matcher classes `open` (route-table.ts rows 351-352, the session and user rows). */
const OPEN_FOR_R = [
  /^GET \/api\/cli-auth\/me$/,
  /^GET \/api\/agents\/(agent-1|alpha)$/,
  /^GET \/api\/companies\/company-1\/agents$/,
  /^GET \/api\/companies\/company-1\/issues$/,
  /^GET \/api\/companies\/company-1\/user-directory$/,
];
/**
 * Shell reads with no row (refused for R), sent by every page, not by a tab:
 * left to C4g-2c-1 / Ada (PAR-13266 comment). They are not gated here.
 */
const SHELL_READS = [
  /^GET \/api\/instance\/settings\/experimental$/,
  /^GET \/api\/companies\/company-1\/resource-memberships\/me$/,
  /^GET \/api\/plugins\/ui-contributions$/,
];

function respond(path: string): unknown {
  // The agent by id, by `alpha`, or by the canonical ref the page navigates to.
  if (/^\/api\/agents\/[^/]+$/.test(path)) return state.agentBody ?? AGENT;
  if (path.endsWith("/budgets/overview")) return { companyId: COMPANY.id, policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 };
  if (path.endsWith("/resource-memberships/me")) return { projectMemberships: {}, agentMemberships: {}, updatedAt: null };
  if (path === "/api/instance/settings/experimental") return state.experimental;
  if (path === "/api/cli-auth/me") return { source: "session", isInstanceAdmin: false };
  if (path.endsWith("/user-directory")) return { users: [] };
  return [];
}

let container: HTMLDivElement;
let root: Root;
let location = "";

function Location() {
  location = useLocation().pathname;
  return null;
}

async function renderAgentPage(address: string) {
  state.requests = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ToastProvider><DialogProvider><BreadcrumbProvider companyName="Partners">
          <MemoryRouter initialEntries={[address]}>
            <Location />
            <Routes>
              <Route path=":companyPrefix" element={<MemberRestrictionProvider><Outlet /></MemberRestrictionProvider>}>
                <Route path="agents/:agentId/:tab" element={<><AgentContextualSidebar agentRef="alpha" agentId="agent-1" agentName="Alpha" /><AgentDetail /></>} />
                <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider></DialogProvider></ToastProvider></TooltipProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { client.clear(); });
  return [...new Set(state.requests)];
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    state.requests.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
    state.urls.push(`${url.pathname}${url.search}`);
    return new Response(JSON.stringify(respond(url.pathname)), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  state.restrictions = [];
  state.urls = [];
  state.agentBody = null;
  state.experimental = {};
  state.sessionPending = null;
});

const ALL_TABS = AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items.map((item) => `/PAR/agents/alpha/${item.value === "instructions" ? "identity" : item.value}`));
function tabLinks() {
  return [...container.querySelectorAll('nav[aria-label="Alpha navigation"] a[href]')].map((link) => link.getAttribute("href"));
}

function sectionLabels() {
  return [...container.querySelectorAll('nav[aria-label="Alpha navigation"] [data-slot="contextual-sidebar-section-label"]')].map((label) => label.textContent);
}

/** Every tab address of the agent page: the visible tabs, the hidden ones, the run view. */
const TAB_ADDRESSES = [
  ...AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items.map((item) => item.value === "instructions" ? "identity" : item.value)),
  "skills", "tools", "channels", "api-keys", "revisions", "runs/run-1",
];

describe("agent page for R under enforce", () => {
  beforeEach(() => {
    state.restrictions = [{ companyId: COMPANY.id, restricted: true, mode: "enforce" }];
  });

  it.each(TAB_ADDRESSES)("/agents/alpha/%s sends no refused request and lands on the overview", async (tab) => {
    const requests = await renderAgentPage(`/PAR/agents/alpha/${tab}`);
    const refused = requests.filter((request) => ![...OPEN_FOR_R, ...SHELL_READS].some((pattern) => pattern.test(request)));
    expect(refused).toEqual([]);
    expect(requests).toContain("GET /api/agents/alpha");
    expect(location).toBe("/PAR/agents/alpha/overview");
    expect(container.querySelector('[aria-label="Recent tasks"]')).not.toBeNull();
  });

  it("shows only the Overview tab in the tab bar", async () => {
    await renderAgentPage("/PAR/agents/alpha/overview");
    expect(tabLinks()).toEqual(["/PAR/agents/alpha/overview"]);
    expect(sectionLabels()).toEqual(["Agent"]);
  });

  it("renders the reduced view and does not mount the operator view (PAR-13475)", async () => {
    await renderAgentPage("/PAR/agents/alpha/overview");
    expect(container.querySelector('[data-testid="reduced-agent-view"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Budget used");
    expect(container.querySelector('[aria-label="Skills"]')).toBeNull();
    expect(container.querySelector('a[href$="/agents/alpha/runtime"]')).toBeNull();
    expect(container.querySelector('[aria-label="Profile"]')).toBeNull();
  });
});

describe.each([
  ["the owner", [] as SessionMemberRestriction[]],
  ["R under report", [{ companyId: COMPANY.id, restricted: true, mode: "report" as const }]],
])("agent page for %s", (_who, restrictions) => {
  beforeEach(() => { state.restrictions = restrictions; });

  it("reads runs, skills, runtime state and activity on the overview and shows every card", async () => {
    const requests = await renderAgentPage("/PAR/agents/alpha/overview");
    expect(requests).toEqual(expect.arrayContaining([
      "GET /api/companies/company-1/heartbeat-runs",
      "GET /api/agents/agent-1/skills",
      "GET /api/companies/company-1/skills",
      "GET /api/agents/agent-1/runtime-state",
      "GET /api/companies/company-1/activity",
    ]));
    expect(container.textContent).toContain("Budget used");
    expect(container.querySelector('[aria-label="Skills"]')).not.toBeNull();
  });

  it("shows every tab in the tab bar and keeps a tab's address", async () => {
    await renderAgentPage("/PAR/agents/alpha/api-keys");
    expect(location).toBe("/PAR/agents/alpha/api-keys");
    expect(tabLinks()).toEqual(ALL_TABS);
    expect(sectionLabels()).toEqual(["Agent", "Audit"]);
  });
});

// PAR-13475 (C4g-2d-2, AC-G10): the reduced agent page. A six-field body runs through the real
// `completeAgentBody` (the real `agentsApi.get`), on both agent pages.
const LONG_NAME = "Acme Content Writer For The Northern Region Accounts And Partners";
const SIX_FIELD_BODY = { id: "agent-1", companyId: COMPANY.id, name: LONG_NAME, title: null, icon: "brain", status: "paused" };
const PAGES: Array<[string, ComponentType]> = [["AgentDetail.tsx", AgentDetail], ["AgentDetail.production.tsx", ProductionAgentDetail]];
/** Reads the reduced page must not send: closed rows, and any URL that lost its company. */
const GATED = [
  /\/built-in-agents/, /\/budgets\/overview/, /\/ai-connections/, /^\/api\/instance\/settings(\?|$)/, /\/org(\?|$)/,
  /\/companies\/[^/]+\/activity/, /\/undefined(\/|\?|$)/, /\/heartbeat-runs/, /\/runtime-state/, /\/agents\/agent-1\/skills/,
];
const gatedUrls = () => state.urls.filter((url) => GATED.some((pattern) => pattern.test(url)));
const firstTab = (Page: ComponentType) => (Page === AgentDetail ? "overview" : "dashboard");

async function flush() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountPage(Page: ComponentType, address: string, client: QueryClient) {
  state.requests = [];
  state.urls = [];
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ToastProvider><DialogProvider><BreadcrumbProvider companyName="Partners">
          <MemoryRouter initialEntries={[address]}>
            <Location />
            <Routes>
              <Route path=":companyPrefix" element={<MemberRestrictionProvider><Outlet /></MemberRestrictionProvider>}>
                <Route path="agents/:agentId/:tab" element={<Page />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider></DialogProvider></ToastProvider></TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

describe.each(PAGES)("%s: reduced agent page (PAR-13475)", (_file, Page) => {
  beforeEach(() => { state.experimental = { enableBuiltInAgents: true }; });

  it.each([
    ["gate closed (session at enforce)", [{ companyId: COMPANY.id, restricted: true, mode: "enforce" as const }]],
    ["gate open (stale session, the server already enforces)", [] as SessionMemberRestriction[]],
  ])("%s: shows the four values from a six-field body and sends no gated request", async (_session, restrictions) => {
    state.restrictions = restrictions;
    state.agentBody = SIX_FIELD_BODY;
    for (const tab of [firstTab(Page), "configuration", "budgets"]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await mountPage(Page, `/PAR/agents/agent-1/${tab}`, client);
      await flush();
      const view = container.querySelector('[data-testid="reduced-agent-view"]');
      expect(view, tab).not.toBeNull();
      expect(container.querySelector('[data-query-view="error"]')).toBeNull();
      expect(view!.querySelector("h1")!.textContent).toBe(LONG_NAME);
      expect(view!.querySelector('[data-agent-icon="brain"]')).not.toBeNull();
      expect(view!.textContent).toContain("paused");
      expect(view!.querySelector('a[href*="/chats/"]')).not.toBeNull();
      expect(view!.querySelector('[aria-label="Recent tasks"]')).not.toBeNull();
      expect(state.urls).toContain("/api/companies/company-1/issues?participantAgentId=agent-1");
      expect(gatedUrls(), tab).toEqual([]);
      await act(async () => { client.clear(); });
    }
  });

  it("the owner gets the full page and its requests", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountPage(Page, `/PAR/agents/agent-1/${firstTab(Page)}`, client);
    await flush();
    expect(container.querySelector('[data-testid="reduced-agent-view"]')).toBeNull();
    expect(state.requests).toContain("GET /api/companies/company-1/built-in-agents");
    expect(state.requests).toContain(Page === AgentDetail ? "GET /api/companies/company-1/activity" : "GET /api/companies/company-1/budgets/overview");
  });

  it.each(["pending", "restored from the saved cache"])("session %s: the owner sees the loading state, then the full page once", async (session) => {
    let release!: () => void;
    state.sessionPending = new Promise<void>((resolve) => { release = resolve; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cache = session === "pending" ? null : startPersistedQueryCache(client, { storage: null, buildId: "test", eventTarget: null });
    if (cache) {
      client.setQueryData(queryKeys.auth.session, { session: { id: "s", userId: "user-1" }, user: { id: "user-1" }, memberRestrictions: [] });
      void client.invalidateQueries({ queryKey: queryKeys.auth.session, refetchType: "none" });
      markCachedSession(client);
    }
    let reducedPainted = false;
    const observer = new MutationObserver(() => {
      if (container.querySelector('[data-testid="reduced-agent-view"]')) reducedPainted = true;
    });
    observer.observe(container, { childList: true, subtree: true });
    // The full page names the agent; the loading state names nothing.
    const fullPage = () => (container.textContent?.includes("Alpha") ? container.firstElementChild : null);
    try {
      await mountPage(Page, `/PAR/agents/agent-1/${firstTab(Page)}`, client);
      await flush();
      expect(state.requests).toContain("GET /api/agents/agent-1");
      expect(container.querySelector('[data-testid="reduced-agent-view"]')).toBeNull();
      expect(fullPage()).toBeNull();
      expect(gatedUrls()).toEqual([]);

      await act(async () => { release(); });
      await flush();
      expect(fullPage()).not.toBeNull();
      expect(state.requests).toContain("GET /api/companies/company-1/built-in-agents");
      expect(state.requests.filter((request) => request === "GET /api/companies/company-1/built-in-agents")).toHaveLength(1);
      expect(reducedPainted).toBe(false);
    } finally {
      observer.disconnect();
      state.sessionPending = null;
      cache?.dispose();
    }
  });
});

it("AgentDetail.tsx: the overview's activity read keys on the company in the route, not only on the body (PAR-13475)", async () => {
  const { companyId: _dropped, ...withoutCompany } = AGENT;
  state.agentBody = withoutCompany;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await mountPage(AgentDetail, "/PAR/agents/agent-1/overview", client);
  await flush();
  expect(state.urls.some((url) => url.startsWith("/api/companies/company-1/activity"))).toBe(true);
  expect(state.urls.filter((url) => /\/undefined\/activity/.test(url))).toEqual([]);
});
