// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { markCachedSession } from "../lib/cached-session";
import { queryKeys } from "../lib/queryKeys";
import {
  EMPTY_RESOURCE_MEMBERSHIPS,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "./useResourceMemberships";

// AC-G10 (PAR-13477): `resource-memberships/me` is closed for a restricted member under
// `enforce`: no request, a fixed empty answer returned at once, never written to the cache.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-1";
const SERVER = { ...EMPTY_RESOURCE_MEMBERSHIPS, starredAgentIds: ["agent-1"] };
const api = vi.hoisted(() => ({
  restrictions: [] as SessionMemberRestriction[],
  listMine: vi.fn(),
  updateAgent: vi.fn(),
  updateProject: vi.fn(),
  sessionGate: null as Promise<void> | null,
}));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => { await api.sessionGate; return session(api.restrictions); } },
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: { listMine: api.listMine, updateAgent: api.updateAgent, updateProject: api.updateProject },
}));

function session(memberRestrictions: SessionMemberRestriction[]) {
  return { session: { id: "s", userId: "u" }, user: null, memberRestrictions };
}
const ENFORCED: SessionMemberRestriction = { companyId: COMPANY_ID, restricted: true, mode: "enforce" };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let result: ReturnType<typeof useResourceMemberships> | null = null;
let mutation: ReturnType<typeof useResourceMembershipMutation> | null = null;

function Harness() {
  result = useResourceMemberships(COMPANY_ID);
  mutation = useResourceMembershipMutation(COMPANY_ID);
  return null;
}

async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  });
}
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.listMine.mockReset().mockResolvedValue(SERVER);
  api.updateAgent.mockReset().mockResolvedValue({});
  api.updateProject.mockReset().mockResolvedValue({});
  api.restrictions = [];
  api.sessionGate = null;
  result = null;
  mutation = null;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("useResourceMemberships", () => {
  it("R under enforce, session known: success on the first render, idle, EMPTY, no request", async () => {
    client.setQueryData(queryKeys.auth.session, session([ENFORCED]));
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    });
    // No await between render and these reads beyond act's own flush.
    expect(result?.status).toBe("success");
    expect(result?.isSuccess).toBe(true);
    expect(result?.fetchStatus).toBe("idle");
    expect(result?.data).toBe(EMPTY_RESOURCE_MEMBERSHIPS);
    await settle();
    expect(api.listMine).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID))).toBeUndefined();
  });

  it.each([
    ["the owner", [] as SessionMemberRestriction[]],
    ["R under report", [{ ...ENFORCED, mode: "report" as const }]],
  ])("%s: one request, the server data", async (_who, restrictions) => {
    api.restrictions = restrictions;
    await render();
    await settle();
    expect(api.listMine).toHaveBeenCalledTimes(1);
    expect(result?.data).toEqual(SERVER);
  });

  it("session pending: no request, nothing cached; then not enforced: one request, server data", async () => {
    let release: () => void = () => {};
    api.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    await render();
    await settle();
    expect(api.listMine).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID))).toBeUndefined();
    release();
    await settle();
    expect(api.listMine).toHaveBeenCalledTimes(1);
    expect(result?.data).toEqual(SERVER);
  });

  it("session restored from cache but unconfirmed: no request, nothing cached", async () => {
    client.setQueryData(queryKeys.auth.session, session([]));
    markCachedSession(client);
    await render();
    expect(api.listMine).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID))).toBeUndefined();
  });

  it("the mutation as R under enforce sends nothing", async () => {
    client.setQueryData(queryKeys.auth.session, session([ENFORCED]));
    await render();
    await act(async () => {
      mutation?.mutate({ resourceType: "agent", resourceId: "agent-1", resourceName: "A", starred: true });
      mutation?.mutate({ resourceType: "project", resourceId: "p-1", resourceName: "P", state: "left" });
    });
    await settle();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID))).toBeUndefined();
  });
});
