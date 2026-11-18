// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { MemberRestrictionProvider } from "../context/MemberRestrictionContext";
import {
  isPageHiddenForMember,
  isPageOpenForRestrictedMember,
  memberRestrictionFor,
} from "../lib/member-restriction";
import { MemberRestrictionGate } from "./MemberRestrictionGate";

// AC-G10 (PAR-12608 4.6), the page half: on typing the address of a page of
// AC-G1, R sees a plain "not available for your access level" page. The menu
// half is `Sidebar.member-restriction.test.tsx`.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = { id: "company-1", issuePrefix: "PAR", name: "Partners", status: "active" };

const session = vi.hoisted(() => ({ memberRestrictions: [] as SessionMemberRestriction[] }));
const contributions = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/auth", () => ({
  authApi: {
    getSession: async () => ({
      session: { id: "s", userId: "user-r" },
      user: { id: "user-r", email: "r@example.com", name: "R", image: null },
      memberRestrictions: session.memberRestrictions,
    }),
  },
}));
vi.mock("../api/plugins", () => ({ pluginsApi: { listUiContributions: async () => contributions.rows } }));

/** The pages AC-G1 names, by their screen address (company-relative). */
const AC_G1_PAGES = [
  "/dashboard",
  "/costs",
  "/company/settings/secrets",
  "/skills",
  "/company/settings/members",
  "/company/settings/invites",
  "/company/settings",
  "/routines",
  "/activity",
  "/company/settings/instance/plugins",
  "/company/settings/instance/plugins/plugin-a",
  "/agents/agent-a/configuration",
  "/agents/new",
  "/org",
];

function Shell() {
  return (
    <main data-testid="page">
      <Outlet />
    </main>
  );
}

function page(name: string) {
  return <div>{name} page</div>;
}

let container: HTMLDivElement;
let root: Root;

async function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter key={path} initialEntries={[path]}>
          <Routes>
            <Route path=":companyPrefix" element={<MemberRestrictionProvider><Shell /></MemberRestrictionProvider>}>
              <Route element={<MemberRestrictionGate />}>
                <Route path="dashboard" element={page("Dashboard")} />
                <Route path="inbox" element={page("Inbox")} />
                <Route path="issues" element={page("Tasks")} />
                <Route path="costs" element={page("Costs")} />
                <Route path="skills/*" element={page("Skills")} />
                <Route path="routines" element={page("Routines")} />
                <Route path="activity" element={page("Activity")} />
                <Route path="org" element={page("Org")} />
                <Route path="company/settings/*" element={page("Settings")} />
                <Route path="agents/:agentId/:tab" element={page("Agent tab")} />
                <Route path="agents/new" element={page("Hire")} />
                <Route path=":pluginRoutePath/*" element={page("Plugin")} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function pageText(): string {
  return container.querySelector("[data-testid=page]")?.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  contributions.rows = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("member restriction on the screen (AC-G10)", () => {
  it.each(AC_G1_PAGES)("R typing %s gets the plain not-available page", async (closed) => {
    session.memberRestrictions = [{ companyId: COMPANY.id, restricted: true, mode: "enforce" }];
    await renderAt(`/PAR${closed}`);
    const text = pageText();
    expect(text).toContain("Not available for your access level");
    expect(text).not.toMatch(/page not found|something went wrong|error/i);
    expect(container.querySelector("[data-testid=member-restriction-not-available]")).not.toBeNull();
  });

  it("R lands on an open page as usual", async () => {
    session.memberRestrictions = [{ companyId: COMPANY.id, restricted: true, mode: "enforce" }];
    await renderAt("/PAR/issues");
    expect(pageText()).toBe("Tasks page");
  });

  it("R reaches an open plugin's page and not a closed one", async () => {
    session.memberRestrictions = [{ companyId: COMPANY.id, restricted: true, mode: "enforce" }];
    contributions.rows = [{ pluginId: "crm", slots: [{ type: "page", routePath: "crm" }], launchers: [] }];
    await renderAt("/PAR/crm");
    expect(pageText()).toBe("Plugin page");
    await renderAt("/PAR/billing");
    expect(pageText()).toContain("Not available for your access level");
  });

  it.each([
    ["flag set, mode report", { restricted: true, mode: "report" as const }],
    ["flag set, mode off (kill switch reads as off)", { restricted: true, mode: "off" as const }],
    ["not restricted, mode enforce", { restricted: false, mode: "enforce" as const }],
  ])("%s: menu and pages unchanged", async (_label, entry) => {
    session.memberRestrictions = [{ companyId: COMPANY.id, ...entry }];
    await renderAt("/PAR/costs");
    expect(pageText()).toBe("Costs page");
  });

  it("restricted in another company only: this company is unchanged", async () => {
    session.memberRestrictions = [
      { companyId: COMPANY.id, restricted: false, mode: "enforce" },
      { companyId: "company-2", restricted: true, mode: "enforce" },
    ];
    await renderAt("/PAR/dashboard");
    expect(pageText()).toBe("Dashboard page");
  });
});

describe("member-restriction helpers", () => {
  it("reads the session entry of one company; a missing entry is not restricted", () => {
    const entries = [{ companyId: "c1", restricted: true, mode: "enforce" as const }];
    expect(memberRestrictionFor(entries, "c1")).toEqual({ restricted: true, mode: "enforce", enforced: true });
    expect(memberRestrictionFor(entries, "c2").enforced).toBe(false);
    expect(memberRestrictionFor(undefined, "c1").enforced).toBe(false);
  });

  it("classifies prefixed and relative addresses alike", () => {
    expect(isPageOpenForRestrictedMember("/PAR/issues/PAR-1")).toBe(true);
    expect(isPageOpenForRestrictedMember("/issues/PAR-1?tab=chat")).toBe(true);
    expect(isPageOpenForRestrictedMember("/agents/new")).toBe(false);
    expect(isPageOpenForRestrictedMember("/agents/a1/dashboard")).toBe(true);
    expect(isPageOpenForRestrictedMember("/agents/a1/configuration")).toBe(false);
    expect(isPageOpenForRestrictedMember("/u/someone")).toBe(false);
    const enforced = memberRestrictionFor([{ companyId: "c1", restricted: true, mode: "enforce" }], "c1");
    expect(isPageHiddenForMember(enforced, "/dashboard")).toBe(true);
    expect(isPageHiddenForMember({ ...enforced, enforced: false }, "/dashboard")).toBe(false);
  });
});
