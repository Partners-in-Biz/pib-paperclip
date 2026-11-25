// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemberRestrictionMode, Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "../lib/queryKeys";

/**
 * PAR-12727 (PAR-12608 4.4): the sharing panel shows on an open project once
 * the company's restriction switch is not off, and always on a private one.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = vi.hoisted(() => () => undefined);

vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), removeWorkspace: vi.fn(), updateWorkspace: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn().mockResolvedValue([]), listUserSecretDefinitions: vi.fn().mockResolvedValue([]), create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("./ProjectAccessMembers", () => ({
  ProjectAccessMembers: ({ project }: { project: Project }) => <div data-testid="access-members">{project.visibility}</div>,
}));

const makeProject = (visibility: "open" | "private") => ({
  id: "project-1", companyId: "company-1", urlKey: "project-1", name: "Client project", description: null, status: "in_progress",
  visibility, privacyOwnerUserId: "owner", goalIds: [], goals: [], env: null, primaryWorkspace: null, workspaces: [],
  codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null },
  executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", allowIssueOverride: true },
}) as unknown as Project;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(visibility: "open" | "private", mode: MemberRestrictionMode | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.health, { hiddenSettings: [] });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: true });
  client.setQueryData(queryKeys.auth.session, {
    session: { id: "s", userId: "owner" },
    user: { id: "owner", email: null, name: "Owner", image: null },
    memberRestrictions: mode ? [{ companyId: "company-1", restricted: false, mode }, { companyId: "company-2", restricted: false, mode: "enforce" }] : [],
  });
  client.setQueryData(queryKeys.access.currentBoardAccess, { source: "session", isInstanceAdmin: false, memberships: [] });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ProjectProperties project={makeProject(visibility)} onFieldUpdate={noop} onArchive={noop} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
}

const panel = () => container.querySelector('[data-testid="access-members"]');

describe("ProjectProperties sharing panel", () => {
  it.each(["report", "enforce"] as const)("shows the panel on an open project when the company is on %s", (mode) => {
    render("open", mode);
    expect(panel()?.textContent).toBe("open");
  });

  it.each(["off", null] as const)("hides the panel on an open project when this company is %s (another is on enforce)", (mode) => {
    render("open", mode);
    expect(panel()).toBeNull();
  });

  it("always shows the panel on a private project", () => {
    render("private", "off");
    expect(panel()?.textContent).toBe("private");
  });
});
