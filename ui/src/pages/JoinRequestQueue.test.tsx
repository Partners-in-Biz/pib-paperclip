// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { JoinRequestQueue } from "./JoinRequestQueue";

const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const approveJoinRequestMock = vi.hoisted(() => vi.fn());
const rejectJoinRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listJoinRequests: (companyId: string, status: string, requestType?: string) =>
      listJoinRequestsMock(companyId, status, requestType),
    approveJoinRequest: (companyId: string, requestId: string) => approveJoinRequestMock(companyId, requestId),
    rejectJoinRequest: (companyId: string, requestId: string) => rejectJoinRequestMock(companyId, requestId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: () => Promise.resolve([{ id: "agent-1", companyId: "company-1", name: "Client Agent" }]),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const pendingRequest = {
  id: "join-1",
  status: "pending_approval",
  requestType: "human",
  createdAt: "2026-04-10T00:00:00.000Z",
  requestIp: "127.0.0.1",
  requesterUser: { id: "user-2", email: "board@paperclip.local", name: "Board User", image: null },
  requestEmailSnapshot: "board@paperclip.local",
  requestingUserId: "user-2",
  invite: { allowedJoinTypes: "human", humanRole: "operator", inviteMessage: null },
};

const pendingQueueKey = queryKeys.access.joinRequests("company-1", "pending_approval:all");

describe("JoinRequestQueue", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listJoinRequestsMock.mockResolvedValue([pendingRequest]);
    approveJoinRequestMock.mockResolvedValue({});
    rejectJoinRequestMock.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage(client: QueryClient) {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <JoinRequestQueue />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("keeps loaded join requests on screen when a refetch fails transiently", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);
    expect(container.textContent).toContain("Board User");

    listJoinRequestsMock.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: pendingQueueKey });
    });
    await flushReact();

    expect(listJoinRequestsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Board User");
    expect(container.textContent).toContain("Join Request Queue");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
    expect(container.textContent).not.toContain("tenant_app_unavailable");

    await act(async () => root.unmount());
  });

  it("shows readable copy and a Retry button when join requests fail to load", async () => {
    listJoinRequestsMock.mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);

    expect(container.textContent).toContain("Couldn't load join requests");
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Board User");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("shows the invite's restriction mark and the lists before approval (PAR-12608 4.2a)", async () => {
    listJoinRequestsMock.mockResolvedValue([
      {
        ...pendingRequest,
        invite: {
          ...pendingRequest.invite,
          memberRestriction: { restricted: true, pluginKeys: ["acme.crm"], agentIds: ["agent-1"] },
        },
      },
      {
        ...pendingRequest,
        id: "join-2",
        invite: {
          ...pendingRequest.invite,
          memberRestriction: { restricted: true, pluginKeys: [], agentIds: [] },
          memberRestrictionIsDefault: true,
        },
      },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);

    const marks = Array.from(container.querySelectorAll('[data-testid="invite-restriction-mark"]'));
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toContain("restricted");
    expect(marks[0].textContent).toContain("Plugins: acme.crm");
    expect(marks[0].textContent).toContain("Agents: Client Agent");
    expect(marks[0].textContent).not.toContain("no choice was made");
    expect(marks[1].textContent).toContain("Joins restricted: no choice was made");
    expect(marks[1].textContent).toContain("Plugins: none");

    await act(async () => root.unmount());
  });

  it("shows no mark for an unmarked invite", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);
    expect(container.querySelector('[data-testid="invite-restriction-mark"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("keeps the permission copy for a forbidden queue", async () => {
    listJoinRequestsMock.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);

    expect(container.textContent).toContain(
      "You do not have permission to review join requests for this organization.",
    );
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
