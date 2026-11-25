// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Agent, MemberRestrictionMode } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { InvitesSection } from "./InvitesSection";

// The restriction choice on the invite form and the mark in the invite list (PAR-12608 4.2a, AC-I8 UI half).

const listInvitesMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const listPluginsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string, options?: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: (companyId: string, input: unknown) => createCompanyInviteMock(companyId, input),
    revokeInvite: vi.fn(),
  },
}));

vi.mock("@/api/plugins", () => ({ pluginsApi: { list: () => listPluginsMock() } }));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } }),
}));

vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_ID = "6f1c3c1e-8d6e-4a55-9b4e-0d7b1c9a0001";
const agents = [
  { id: AGENT_ID, companyId: "company-1", name: "Client Agent", status: "idle", adapterType: "claude_api", reportsTo: null, permissions: {} },
] as unknown as Agent[];

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InvitesSection restriction choice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listInvitesMock.mockResolvedValue({
      invites: [
        {
          id: "invite-1",
          companyId: "company-1",
          inviteType: "company_join",
          allowedJoinTypes: "human",
          humanRole: "operator",
          defaultsPayload: null,
          memberRestriction: { restricted: true, pluginKeys: ["acme.crm"], agentIds: [AGENT_ID] },
          expiresAt: "2026-12-01T00:00:00.000Z",
          invitedByUserId: "user-1",
          revokedAt: null,
          acceptedAt: null,
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
          companyName: "Paperclip",
          inviteMessage: null,
          state: "active",
          invitedByUser: null,
          relatedJoinRequestId: null,
        },
      ],
      nextOffset: null,
    });
    createCompanyInviteMock.mockResolvedValue({ inviteUrl: "https://paperclip.local/invite/t", humanRole: "operator" });
    listPluginsMock.mockResolvedValue([
      { pluginKey: "acme.crm", status: "ready", manifestJson: { displayName: "Acme CRM" } },
    ]);
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn() } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderSection(props: {
    restrictionMode?: MemberRestrictionMode;
    forcedOff?: boolean;
    canManageMembers?: boolean;
  }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <InvitesSection agents={agents} {...props} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
  }

  const createButton = () =>
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Create invite")!;
  const radio = (name: string, value: string) =>
    container.querySelector(`input[type="radio"][name="${name}"][value="${value}"]`) as HTMLInputElement;

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it.each(["report", "enforce"] as const)("cannot submit without a choice when the mode is %s", async (mode) => {
    await renderSection({ restrictionMode: mode });

    expect(radio("invite-restriction", "full").checked).toBe(false);
    expect(radio("invite-restriction", "restricted").checked).toBe(false);
    expect(createButton().disabled).toBe(true);
    expect(container.textContent).toContain("Choose full access or restricted to create the invite.");
    await click(createButton());
    expect(createCompanyInviteMock).not.toHaveBeenCalled();

    await click(radio("invite-restriction", "restricted"));
    expect(createButton().disabled).toBe(false);
    await click(createButton());
    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "human",
      humanRole: "operator",
      agentMessage: null,
      restriction: { restricted: true, pluginKeys: [], agentIds: [] },
    });
    // The next invite needs a fresh choice.
    expect(radio("invite-restriction", "restricted").checked).toBe(false);
    expect(createButton().disabled).toBe(true);
  });

  it("shows the per-company line under the choice", async () => {
    await renderSection({ restrictionMode: "report" });
    expect(container.textContent).toContain(
      "This applies to this company only. A person restricted elsewhere joins here as you choose.",
    );
  });

  it("keeps the choice optional under off and under the kill switch", async () => {
    await renderSection({ restrictionMode: "enforce", forcedOff: true });
    expect(createButton().disabled).toBe(false);
    await click(createButton());
    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "human",
      humanRole: "operator",
      agentMessage: null,
    });

    await renderSection({ restrictionMode: "off" });
    expect(createButton().disabled).toBe(false);
    await click(radio("invite-restriction", "full"));
    await click(createButton());
    expect(createCompanyInviteMock).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      restriction: { restricted: false, pluginKeys: [], agentIds: [] },
    }));
  });

  it("requires the choice after the server answers MEMBER_RESTRICTION_REQUIRED when the mode is unknown", async () => {
    createCompanyInviteMock.mockRejectedValueOnce(
      new ApiError("Choose whether the person joins restricted", 422, {
        error: "Choose whether the person joins restricted",
        details: { code: "MEMBER_RESTRICTION_REQUIRED" },
      }),
    );
    await renderSection({});
    expect(createButton().disabled).toBe(false);
    await click(createButton());
    expect(createButton().disabled).toBe(true);
    expect(container.textContent).toContain("Choose full access or restricted to create the invite.");
  });

  it("refuses restricted for owner and admin roles", async () => {
    await renderSection({ restrictionMode: "report" });
    await click(radio("invite-restriction", "restricted"));
    await click(radio("invite-role", "admin"));
    expect(radio("invite-restriction", "restricted").disabled).toBe(true);
    expect(radio("invite-restriction", "restricted").checked).toBe(false);
    expect(container.textContent).toContain("An admin cannot be restricted.");
  });

  it("sends the lists chosen by someone who manages member permissions", async () => {
    await renderSection({ restrictionMode: "report", canManageMembers: true });
    await click(radio("invite-restriction", "restricted"));
    const pluginBox = container.querySelector('[data-choice="acme.crm"] button') as HTMLElement;
    const agentBox = container.querySelector(`[data-choice="${AGENT_ID}"] button`) as HTMLElement;
    await click(pluginBox);
    await click(agentBox);
    await click(createButton());
    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      restriction: { restricted: true, pluginKeys: ["acme.crm"], agentIds: [AGENT_ID] },
    }));
  });

  it("offers no lists to someone who cannot manage member permissions", async () => {
    await renderSection({ restrictionMode: "report" });
    await click(radio("invite-restriction", "restricted"));
    expect(container.querySelector("[data-choice]")).toBeNull();
    expect(listPluginsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The person joins with no plugins and no agents.");
  });

  it("shows restricted and the two lists in the invite list", async () => {
    await renderSection({});
    const mark = container.querySelector('[data-testid="invite-restriction-mark"]');
    expect(mark?.textContent).toContain("restricted");
    expect(mark?.textContent).toContain("Plugins: acme.crm");
    expect(mark?.textContent).toContain("Agents: Client Agent");
  });
});
