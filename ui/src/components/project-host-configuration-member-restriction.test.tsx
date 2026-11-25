// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectWorkspace, SessionMemberRestriction } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { LegacyProjectRepository } from "./LegacyProjectRepository";
import { NewProjectForm } from "./NewProjectDialog";
import { ProjectProperties } from "./ProjectProperties";

// AC-G10 for the project screens (PAR-12952, PAR-12608 4.6): a restricted member
// at `enforce` sees no host-configuration control and sends no request to its
// closed reads; under `report` and for the owner every control shows as before.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C = "company-1";
const api = vi.hoisted(() => ({
  session: vi.fn(), secrets: vi.fn(), userSecrets: vi.fn(), environments: vi.fn(), gitAuth: vi.fn(),
  repoOptions: vi.fn(), create: vi.fn(),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: vi.fn().mockResolvedValue({ companyIds: ["company-1"] }) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: api.secrets, listUserSecretDefinitions: api.userSecrets, create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: api.environments } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn() } }));
// `@/api/projects` and `../api/projects` are the same module.
vi.mock("@/api/projects", () => ({ projectsApi: { gitAuthorization: api.gitAuth, repositoryOptions: api.repoOptions,
  create: api.create, setRepositories: vi.fn(), createWorkspace: vi.fn(), updateWorkspace: vi.fn(), removeWorkspace: vi.fn() } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("@/hooks/useWorkspaceIsolationControls", () => ({ useWorkspaceIsolationControls: () => ({ visible: true, loaded: true }) }));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => <div data-testid="env-editor" /> }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("./ProjectAccessMembers", () => ({ ProjectAccessMembers: () => null }));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: () => null }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const legacyWorkspace = { id: "ws-1", companyId: C, projectId: "project-1", name: "Legacy", cwd: null,
  repoUrl: "https://github.com/o/legacy", remoteWorkspaceRef: null, metadata: null } as unknown as ProjectWorkspace;
const project = {
  id: "project-1", companyId: C, urlKey: "project-1", name: "Client project", description: null, status: "in_progress",
  visibility: "open", goalIds: [], goals: [], env: { TOKEN: { type: "plain", value: "x" } }, primaryWorkspace: null,
  workspaces: [legacyWorkspace],
  codebase: { workspaceId: null, repoUrl: "https://github.com/o/legacy", repoRef: null, defaultRef: null, repoName: null,
    localFolder: "/srv/o", origin: "local_folder" },
  executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", allowIssueOverride: true },
} as unknown as Project;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
type Who = { memberRestrictions: SessionMemberRestriction[] };
const as = (mode: "report" | "enforce"): Who => ({ memberRestrictions: [{ companyId: C, restricted: true, mode }] });
const owner: Who = { memberRestrictions: [] };

async function render(session: Who, ui: ReactNode) {
  api.session.mockResolvedValue(session);
  client.setQueryData(queryKeys.auth.session, session);
  client.setQueryData(queryKeys.instance.experimentalSettings,
    { enableIsolatedWorkspaces: true, enableEnvironments: true, enableManagedSandboxOnly: false });
  await act(async () => root.render(
    <QueryClientProvider client={client}><TooltipProvider>{ui}</TooltipProvider></QueryClientProvider>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  for (const read of [api.secrets, api.userSecrets, api.environments, api.repoOptions]) read.mockResolvedValue([]);
  api.gitAuth.mockResolvedValue({ authorization: null, options: [] });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("project page host configuration", () => {
  it("hides env, repositories, codebase and execution workspaces and reads none of them for R at enforce", async () => {
    await render(as("enforce"), <ProjectProperties project={project} onFieldUpdate={() => {}} />);
    expect(container.textContent).toContain("Visibility");
    expect(container.querySelector('[data-testid="env-editor"]')).toBeNull();
    expect(container.querySelector('[aria-label="Repositories"]')).toBeNull();
    expect(container.querySelector('[aria-label="Background GitHub authorization"]')).toBeNull();
    expect(container.textContent).not.toContain("Codebase");
    expect(container.textContent).not.toContain("Execution Workspaces");
    for (const read of [api.secrets, api.userSecrets, api.environments, api.gitAuth, api.repoOptions]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each([["the owner", owner], ["R at report", as("report")]])("shows every control to %s", async (_who, session) => {
    await render(session, <ProjectProperties project={project} onFieldUpdate={() => {}} />);
    expect(container.querySelector('[data-testid="env-editor"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Repositories"]')).not.toBeNull();
    expect(container.textContent).toContain("Codebase");
    expect(api.secrets).toHaveBeenCalled();
    expect(api.gitAuth).toHaveBeenCalled();
  });
});

describe("legacy repository row", () => {
  it.each([["enforce", false], ["report", true]] as const)("offers Edit only when open, R at %s", async (mode, open) => {
    await render(as(mode), <LegacyProjectRepository workspace={legacyWorkspace} projectRef="project-1" />);
    expect(container.textContent).toContain("https://github.com/o/legacy");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(open);
  });
});

describe("new project dialog", () => {
  it.each([["enforce", false], ["report", true]] as const)(
    "shows the repository picker and reads its options only when open, R at %s; creates with repositoryIds: []",
    async (mode, open) => {
      api.create.mockResolvedValue({ id: "project-new" });
      await render(as(mode), <NewProjectForm companyId={C} onClose={() => {}} />);
      expect(Boolean(container.querySelector('[aria-label="Source repositories"]'))).toBe(open);
      expect(api.repoOptions.mock.calls.length > 0).toBe(open);
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "R project");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(api.create).toHaveBeenCalledWith(C, expect.objectContaining({ name: "R project", repositoryIds: [] }));
    },
  );
});
