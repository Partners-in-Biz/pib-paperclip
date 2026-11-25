// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { MobileBottomNav } from "@/components/MobileBottomNav";

// AC-G10 (PAR-13264): the coordinator attention badge (mobile bottom nav and
// coordinator sidebar, both through useCoordinatorAttentionCount) sends no
// `attention/summary` request for a restricted member under `enforce`.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  summary: vi.fn(async () => ({ totalCount: 3, deskBadgeCount: 0, generatedAt: "2026-11-18T00:00:00Z" })),
  list: vi.fn(async () => ({ items: [] })),
  taskIndex: vi.fn(async () => ({ items: [] })),
}));

vi.mock("@/api/attention", () => ({ attentionApi: { summary: api.summary, list: api.list, taskIndex: api.taskIndex } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: api.restrictions }) } }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/chats", search: "" }),
  NavLink: ({ to, children }: { to: string; children: (state: { isActive: boolean }) => ReactNode }) => <a href={to}>{children({ isActive: false })}</a>,
}));

const ENFORCED = { companyId: "company-1", restricted: true, mode: "enforce" as const };

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderNav(entry: SessionMemberRestriction | null) {
  api.restrictions = entry ? [entry] : [];
  await act(async () => { root.render(<QueryClientProvider client={client}><MobileBottomNav visible /></QueryClientProvider>); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const decisionsText = () => container.querySelector('a[href="/decisions"]')?.textContent;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.summary.mockClear();
  api.list.mockClear();
  api.taskIndex.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("useCoordinatorAttentionCount on the mobile bottom nav", () => {
  it("R under enforce: no attention/summary request and no badge", async () => {
    await renderNav(ENFORCED);
    expect(api.summary).not.toHaveBeenCalled();
    expect(decisionsText()).toBe("Inbox");
  });

  it.each([
    ["the owner", null],
    ["R under report", { ...ENFORCED, mode: "report" as const }],
  ])("%s: attention/summary is requested and the badge shows", async (_who, entry) => {
    await renderNav(entry);
    expect(api.summary).toHaveBeenCalledWith("company-1");
    expect(decisionsText()).toBe("3Inbox");
  });

  it.each([["the owner", null], ["R under enforce", ENFORCED]])(
    "%s: the full feed and task index stay cache-only (never requested)",
    async (_who, entry) => {
      await renderNav(entry);
      expect(api.list).not.toHaveBeenCalled();
      expect(api.taskIndex).not.toHaveBeenCalled();
    },
  );
});
