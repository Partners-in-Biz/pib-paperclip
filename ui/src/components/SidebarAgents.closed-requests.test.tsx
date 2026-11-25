// @vitest-environment jsdom

import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarAgents as ClassicSidebarAgents } from "./SidebarAgents";
import { SidebarAgents as ProductionSidebarAgents } from "./SidebarAgents.production";

// AC-G10 (PAR-13264): the sidebar agent list sends no `live-runs` request for a
// restricted member under `enforce`, and shows no live mark.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  builtInList: vi.fn(async () => [] as unknown[]),
  listMine: vi.fn(async () => ({ projectMemberships: {}, agentMemberships: {}, starredAgentIds: [], starredDocumentIds: [], documentStarredAt: {}, updatedAt: null })),
  liveRunsForCompany: vi.fn(async () => [{ id: "run-1", agentId: "agent-1", issueId: null, status: "running" }]),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  NavLink: ({ children, to, className }: { children: ReactNode; to: string; className?: unknown }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : (className as string)}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/PAP/inbox", search: "", hash: "", state: null }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ openNewAgent: vi.fn() }), useDialogActions: () => ({ openNewAgent: vi.fn() }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: false, peeking: false }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../api/agents", () => ({
  agentsApi: { list: async () => [{ id: "agent-1", companyId: "company-1", name: "Alpha", urlKey: "alpha", role: "engineer", status: "active", icon: null }] },
}));
vi.mock("../api/builtInAgents", () => ({ builtInAgentsApi: { list: api.builtInList } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableBuiltInAgents: true }) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: { id: "u" }, memberRestrictions: api.restrictions }) } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: api.liveRunsForCompany } }));
vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: { listMine: api.listMine, updateAgent: vi.fn() },
}));

const VARIANTS: Array<[string, ComponentType]> = [["SidebarAgents.tsx", ClassicSidebarAgents], ["SidebarAgents.production.tsx", ProductionSidebarAgents]];
const ENFORCED = { companyId: "company-1", restricted: true, mode: "enforce" as const };

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderAgents(List: ComponentType, entry: SessionMemberRestriction | null) {
  api.restrictions = entry ? [entry] : [];
  await act(async () => {
    root.render(<QueryClientProvider client={client}><TooltipProvider><List /></TooltipProvider></QueryClientProvider>);
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.liveRunsForCompany.mockClear();
  api.builtInList.mockClear();
  api.listMine.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe.each(VARIANTS)("%s", (_name, List) => {
  it("R under enforce: no live-runs request and no live mark, the agent still lists", async () => {
    await renderAgents(List, ENFORCED);
    expect(api.liveRunsForCompany).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).not.toContain("live");
  });

  it.each([
    ["the owner", null],
    ["R under report", { ...ENFORCED, mode: "report" as const }],
  ])("%s: live-runs is requested and the live mark shows", async (_who, entry) => {
    await renderAgents(List, entry);
    expect(api.liveRunsForCompany).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("1 live");
  });

  // AC-G10 (PAR-13477): `built-in-agents` and `resource-memberships/me` are closed under `enforce`.
  async function openRowMenu() {
    const trigger = document.body.querySelector('button[aria-label="Open actions for Alpha"]');
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
  }

  it("R under enforce, flag on: no built-in-agents and no memberships request, no star or leave control", async () => {
    await renderAgents(List, ENFORCED);
    expect(api.builtInList).not.toHaveBeenCalled();
    expect(api.listMine).not.toHaveBeenCalled();
    await openRowMenu();
    expect(document.body.textContent).not.toContain("Star agent");
    expect(document.body.textContent).not.toContain("Leave agent");
  });

  it("the owner, flag on: built-in-agents is requested, star and leave controls show", async () => {
    await renderAgents(List, null);
    expect(api.builtInList).toHaveBeenCalledWith("company-1");
    expect(api.listMine).toHaveBeenCalled();
    await openRowMenu();
    expect(document.body.textContent).toContain("Star agent");
    expect(document.body.textContent).toContain("Leave agent");
  });
});
