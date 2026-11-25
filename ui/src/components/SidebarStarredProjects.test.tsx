// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ResourceMemberships } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarStarredProjects as ClassicStarredProjects } from "./SidebarStarredProjects";
import { SidebarStarredProjects as ProductionStarredProjects } from "./SidebarStarredProjects.production";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockResourceMembershipsApi = vi.hoisted(() => ({ listMine: vi.fn(), updateProject: vi.fn() }));
const mockSession = vi.hoisted(() => ({ restrictions: [] as unknown[] }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({ isMobile: false, collapsed: false, peeking: false }));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, className, to, ...props }: {
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockSidebarState.isMobile,
    setSidebarOpen: mockSetSidebarOpen,
    collapsed: mockSidebarState.collapsed,
    peeking: mockSidebarState.peeking,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: mockSession.restrictions }) } }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/resourceMemberships", () => ({ resourceMembershipsApi: mockResourceMembershipsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "project-a",
    companyId: "company-1",
    urlKey: "alpha",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Alpha",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#ef4444",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-a",
      effectiveLocalFolder: "/tmp/project-a",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  // The session read (restriction gate) and the memberships read run one after the other.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function projectLinkLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a[href$="/issues"]'))
    .map((anchor) => anchor.textContent?.trim())
    .filter(Boolean);
}

function projectLink(container: HTMLElement, projectRef: string) {
  return container.querySelector(`a[href="/projects/${projectRef}/issues"]`) as HTMLAnchorElement | null;
}

describe("SidebarStarredProjects", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let memberships: ResourceMemberships;
  let StarredProjects = ClassicStarredProjects;

  beforeEach(() => {
    mockSession.restrictions = [];
    StarredProjects = ClassicStarredProjects;
    mockSidebarState.isMobile = false;
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    memberships = {
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      starredDocumentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      documentStarredAt: {},
      updatedAt: null,
    };
    mockResourceMembershipsApi.listMine.mockImplementation(() => Promise.resolve(memberships));
    mockProjectsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <StarredProjects />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders only starred projects returned by the default active project list", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "project-a", name: "Alpha", urlKey: "alpha" }),
      makeProject({ id: "project-b", name: "Bravo", urlKey: "bravo" }),
    ]);
    memberships = { ...memberships, starredProjectIds: ["project-b", "project-c"] };

    await render();

    // project-c is starred but absent because the default project list is server-filtered.
    expect(projectLinkLabels(container)).toEqual(["Bravo"]);
    expect(document.body.querySelector('button[aria-label="Unstar Bravo"]')).not.toBeNull();
  });

  it("keeps starred projects indented only outside the collapsed rail", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "project-a", name: "Alpha", urlKey: "alpha" }),
    ]);
    memberships = { ...memberships, starredProjectIds: ["project-a"] };

    await render();

    expect(projectLink(container, "alpha")?.className).toContain("pl-6");

    await act(async () => root?.unmount());
    root = null;
    container.innerHTML = "";
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mockSidebarState.collapsed = true;

    await render();

    const railProjectLink = projectLink(container, "alpha");
    expect(railProjectLink?.className).not.toContain("pl-6");
    const nameSpan = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Alpha");
    expect(nameSpan?.className).toContain("w-0");
  });

  it("renders nothing when no projects are starred", async () => {
    mockProjectsApi.list.mockResolvedValue([makeProject({ id: "project-a", name: "Alpha" })]);

    await render();

    expect(container.textContent).not.toContain("No starred projects yet");
    expect(projectLinkLabels(container)).toEqual([]);
  });

  it.each([["classic", ClassicStarredProjects], ["production", ProductionStarredProjects]])(
    "%s shell, R under enforce: no memberships request and the section is hidden (AC-G10, PAR-13477)",
    async (_name, Section) => {
      StarredProjects = Section;
      mockSession.restrictions = [{ companyId: "company-1", restricted: true, mode: "enforce" }];
      mockProjectsApi.list.mockResolvedValue([makeProject({ id: "project-a", name: "Alpha", urlKey: "alpha" })]);
      memberships = { ...memberships, starredProjectIds: ["project-a"] };
      await render();
      expect(mockResourceMembershipsApi.listMine).not.toHaveBeenCalled();
      expect(projectLinkLabels(container)).toEqual([]);
    },
  );

  it.each([["classic", ClassicStarredProjects], ["production", ProductionStarredProjects]])(
    "%s shell, the owner: the starred project and its unstar control show",
    async (_name, Section) => {
      StarredProjects = Section;
      mockProjectsApi.list.mockResolvedValue([makeProject({ id: "project-a", name: "Alpha", urlKey: "alpha" })]);
      memberships = { ...memberships, starredProjectIds: ["project-a"] };
      await render();
      expect(projectLinkLabels(container)).toEqual(["Alpha"]);
      expect(document.body.querySelector('button[aria-label="Unstar Alpha"]')).not.toBeNull();
    },
  );
});
