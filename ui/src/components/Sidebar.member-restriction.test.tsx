// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MemberRestrictionProvider } from "../context/MemberRestrictionContext";
import { Sidebar } from "./Sidebar.production";

// AC-G10 (PAR-12608 4.6), the menu half: R sees no menu entry for a page of
// AC-G1. The page half is `MemberRestrictionGate.test.tsx`.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = { id: "company-1", issuePrefix: "PAR", name: "Partners", status: "active" };

const session = vi.hoisted(() => ({ memberRestrictions: [] as SessionMemberRestriction[] }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: false, peeking: false }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ memberRestrictions: session.memberRestrictions }) },
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("../api/attention", () => ({ attentionApi: { list: async () => ({ items: [] }) } }));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: async () => ({ enableConferenceRoomChat: true, enableStatusCards: true }) },
}));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }) }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("./SidebarCompanyMenu.production", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("./SidebarAgents.production", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarProjects", () => ({ SidebarProjects: () => null }));
vi.mock("./SidebarStarredProjects.production", () => ({ SidebarStarredProjects: () => null }));

/** The AC-G1 pages that have a menu entry, by their screen address (company-relative). */
const AC_G1_MENU_PAGES = ["/dashboard", "/costs", "/skills", "/routines", "/activity", "/org", "/company/settings"];

let container: HTMLDivElement;
let root: Root;

async function menuHrefsFor(entry: SessionMemberRestriction): Promise<string[]> {
  session.memberRestrictions = [entry];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/PAR/inbox"]}>
            <Routes>
              <Route path=":companyPrefix" element={<MemberRestrictionProvider><Sidebar /><Outlet /></MemberRestrictionProvider>}>
                <Route path="inbox" element={null} />
              </Route>
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return [...container.querySelectorAll("aside a[href]")].map((link) => link.getAttribute("href") ?? "");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("sidebar for a restricted member (AC-G10)", () => {
  it("R under enforce: no menu entry for an AC-G1 page, his own pages stay", async () => {
    const hrefs = await menuHrefsFor({ companyId: COMPANY.id, restricted: true, mode: "enforce" });
    expect(hrefs).toContain("/PAR/inbox");
    expect(hrefs).toContain("/PAR/issues");
    for (const closed of AC_G1_MENU_PAGES) {
      expect(hrefs, closed).not.toContain(`/PAR${closed}`);
    }
  });

  it.each([
    ["flag set, mode report", { restricted: true, mode: "report" as const }],
    ["flag set, mode off (kill switch reads as off)", { restricted: true, mode: "off" as const }],
    ["not restricted, mode enforce", { restricted: false, mode: "enforce" as const }],
  ])("%s: menu unchanged", async (_label, entry) => {
    const hrefs = await menuHrefsFor({ companyId: COMPANY.id, ...entry });
    for (const page of AC_G1_MENU_PAGES) {
      expect(hrefs, page).toContain(`/PAR${page}`);
    }
  });
});
