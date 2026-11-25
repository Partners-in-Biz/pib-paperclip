// @vitest-environment jsdom

import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar as ClassicShellSidebar } from "./Sidebar";
import { Sidebar as ProductionShellSidebar } from "./Sidebar.production";

// AC-G10 (PAR-13264): both shells send no `live-runs` and no `attention`
// request for a restricted member under `enforce`, and show no Decisions entry.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  liveRunsForCompany: vi.fn(async () => []),
  attentionList: vi.fn(async () => ({ items: [], deskBadgeCount: 2 })),
}));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className }: { to: string; children: ReactNode; className?: unknown }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : (className as string)}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/PAP/inbox", search: "", hash: "" }),
}));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ openNewIssue: vi.fn() }), useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" } }),
}));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, collapsed: false, peeking: false, setSidebarOpen: vi.fn() }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: api.restrictions }) } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: api.liveRunsForCompany } }));
vi.mock("../api/attention", () => ({ attentionApi: { list: api.attentionList } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableDecisions: true }) } }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }) }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("./SidebarCompanyMenu.production", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("./SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarAgents.production", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarProjects", () => ({ SidebarProjects: () => null }));
vi.mock("./SidebarStarredProjects", () => ({ SidebarStarredProjects: () => null }));
vi.mock("./SidebarStarredProjects.production", () => ({ SidebarStarredProjects: () => null }));
vi.mock("./SidebarRecentTasks", () => ({ SidebarRecentTasks: () => null }));

const SHELLS: Array<[string, ComponentType]> = [["Layout (Sidebar.tsx)", ClassicShellSidebar], ["ProductionLayout (Sidebar.production.tsx)", ProductionShellSidebar]];
const ENFORCED = { companyId: "company-1", restricted: true, mode: "enforce" as const };

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderShell(Shell: ComponentType, entry: SessionMemberRestriction | null) {
  api.restrictions = entry ? [entry] : [];
  await act(async () => {
    root.render(<QueryClientProvider client={client}><TooltipProvider><Shell /></TooltipProvider></QueryClientProvider>);
  });
  await settle();
}

const decisionsLink = () => container.querySelector('a[href="/decisions"]');

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.liveRunsForCompany.mockClear();
  api.attentionList.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe.each(SHELLS)("%s with enableDecisions on", (_name, Shell) => {
  it("R under enforce: no live-runs or attention request, no Decisions entry", async () => {
    await renderShell(Shell, ENFORCED);
    expect(api.liveRunsForCompany).not.toHaveBeenCalled();
    expect(api.attentionList).not.toHaveBeenCalled();
    expect(decisionsLink()).toBeNull();
  });

  it.each([
    ["the owner", null],
    ["R under report", { ...ENFORCED, mode: "report" as const }],
  ])("%s: both requests go out and the Decisions entry shows", async (_who, entry) => {
    await renderShell(Shell, entry);
    expect(api.liveRunsForCompany).toHaveBeenCalledWith("company-1");
    expect(api.attentionList).toHaveBeenCalledWith("company-1");
    expect(decisionsLink()?.textContent).toContain("2");
  });

  it("a stale session switched to enforce stops the next refetch and shows no error", async () => {
    await renderShell(Shell, { ...ENFORCED, mode: "report" });
    api.liveRunsForCompany.mockClear();
    api.attentionList.mockClear();
    await act(async () => {
      client.setQueryData(["auth", "session"], { session: { id: "s", userId: "u" }, user: null, memberRestrictions: [ENFORCED] });
    });
    await settle();
    await act(async () => { await client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" }); });
    await settle();
    expect(api.liveRunsForCompany).not.toHaveBeenCalled();
    expect(api.attentionList).not.toHaveBeenCalled();
    expect(decisionsLink()).toBeNull();
    expect(container.textContent).not.toMatch(/couldn.t load|error/i);
  });
});
