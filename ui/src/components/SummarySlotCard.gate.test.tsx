// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCachedSession, verifyCachedSession } from "@/lib/cached-session";
import { queryKeys } from "@/lib/queryKeys";
import { SummarySlotCard } from "./SummarySlotCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  settings: vi.fn(),
  get: vi.fn(),
  revisions: vi.fn(),
  generate: vi.fn(),
  builtIns: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/api/auth", () => ({ authApi: { getSession: mocks.session } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.settings } }));
vi.mock("@/api/summarySlots", () => ({ summarySlotsApi: { get: mocks.get, revisions: mocks.revisions, generate: mocks.generate } }));
vi.mock("@/api/builtInAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/builtInAgents")>()),
  builtInAgentsApi: { list: mocks.builtIns },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { resume: mocks.resume } }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/ConfigureBuiltInAgentModal", () => ({ ConfigureBuiltInAgentModal: () => null }));

const sessionFor = (mode: "enforce" | "report" | null) => ({
  user: { id: "u" },
  session: { userId: "u" },
  memberRestrictions: mode ? [{ companyId: "company-1", restricted: true, mode }] : [],
});
const wait = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

// AC-G10 (PAR-13476): the whole card is closed for a restricted member under `enforce`.
describe("SummarySlotCard member restriction gate", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.settings.mockResolvedValue({ enableSummaries: true, enableBuiltInAgents: true });
    mocks.builtIns.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ slot: null, document: null, generatingIssue: null });
    mocks.revisions.mockResolvedValue({ slot: null, revisions: [] });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    verifyCachedSession(client);
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  const render = async () => {
    root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <SummarySlotCard companyId="company-1" scopeKind="project" scopeId="project-1" title="Project summary" />
      </QueryClientProvider>,
    ));
    await wait();
  };

  it("R under enforce: renders nothing and sends no summary-slots, built-in-agents or resume request", async () => {
    mocks.session.mockResolvedValue(sessionFor("enforce"));
    await render();
    expect(container.textContent).toBe("");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.revisions).not.toHaveBeenCalled();
    expect(mocks.builtIns).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it.each([["the owner", null], ["R under report", "report"]] as const)("%s: the card renders and requests summary-slots", async (_who, mode) => {
    mocks.session.mockResolvedValue(sessionFor(mode));
    await render();
    expect(mocks.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Project summary");
  });

  it("session pending: nothing rendered and no request; after it resolves as not enforced the card renders", async () => {
    let resolve!: (value: unknown) => void;
    mocks.session.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render();
    expect(container.textContent).toBe("");
    expect(mocks.get).not.toHaveBeenCalled();
    await act(async () => resolve(sessionFor(null)));
    await wait();
    expect(mocks.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Project summary");
  });

  it("session restored from cache but unconfirmed: nothing rendered and no request until confirmed", async () => {
    let resolve!: (value: unknown) => void;
    mocks.session.mockReturnValue(new Promise((r) => { resolve = r; }));
    client.setQueryData(queryKeys.auth.session, sessionFor(null));
    markCachedSession(client);
    await render();
    expect(container.textContent).toBe("");
    expect(mocks.get).not.toHaveBeenCalled();
    verifyCachedSession(client);
    await act(async () => { resolve({ ...sessionFor(null), confirmed: true }); });
    await wait();
    expect(mocks.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Project summary");
  });
});
