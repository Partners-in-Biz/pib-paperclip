import type { Agent, AgentDetail } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentDisplayAdapterType, getAdapterDisplay, getAdapterLabel, isKnownAdapterType } from "../adapters/adapter-display-registry";
import { bulkAgentDisabledReason, bulkAgentHarness } from "../lib/bulk-agent-settings";
import { agentRouteRef } from "../lib/utils";
import { ApiError } from "./client";
import {
  REDUCED_AGENT_ADAPTER_TYPE,
  agentsApi,
  completeAgentBody,
  isReducedAgent,
  type ReducedAgentBody,
} from "./agents";

// PAR-13474 (AC-G10, decision PAR-13469 B part 1): a reduced agent body is
// completed at the API boundary, so no screen reads a missing field.

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({ ...await importOriginal<typeof import("./client")>(), api: mockApi }));

const AGENT_ID = "6b0d2b4e-6a35-4e8f-9f0c-1b2a3c4d5e6f";
const reduced = (overrides: Partial<ReducedAgentBody> = {}): ReducedAgentBody => ({
  id: AGENT_ID, companyId: "company-1", name: "Client Writer (Acme)", title: "Writer", icon: "pen", status: "idle", ...overrides,
});

function fullAgent(): AgentDetail {
  return {
    id: AGENT_ID, companyId: "company-1", name: "Alpha", urlKey: "alpha", role: "engineer", title: null, icon: null,
    status: "active", reportsTo: null, capabilities: null, adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" },
    runtimeConfig: {}, budgetMonthlyCents: 100, spentMonthlyCents: 5, pauseReason: null, pausedAt: null,
    permissions: { canCreateAgents: true }, lastHeartbeatAt: null, metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    chainOfCommand: [], access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
  };
}

beforeEach(() => {
  mockApi.get.mockReset();
});

describe("completeAgentBody", () => {
  it("completes a six-field body: every field set, the marker on, the urlKey derived", () => {
    const agent = completeAgentBody(reduced(), "detail");
    expect(isReducedAgent(agent)).toBe(true);
    expect(agent).toMatchObject({
      id: AGENT_ID, companyId: "company-1", name: "Client Writer (Acme)", title: "Writer", icon: "pen", status: "idle",
      urlKey: "client-writer-acme", adapterType: REDUCED_AGENT_ADAPTER_TYPE,
      adapterConfig: {}, runtimeConfig: {}, permissions: { canCreateAgents: false },
      budgetMonthlyCents: 0, spentMonthlyCents: 0, reportsTo: null, capabilities: null, pauseReason: null,
      pausedAt: null, lastHeartbeatAt: null, metadata: null, defaultEnvironmentId: null, chainOfCommand: [],
      access: { canAssignTasks: false, taskAssignSource: "none", membership: null, grants: [] },
    });
    expect(Object.entries(agent).filter(([, value]) => value === undefined)).toEqual([]);
    // The urlKey is the one `agentRouteRef` would derive from the name.
    expect(agent.urlKey).toBe(agentRouteRef({ id: AGENT_ID, name: "Client Writer (Acme)" }));
  });

  it("gives the adapter readers a type no adapter registers, and they do not throw", () => {
    const agent = completeAgentBody(reduced());
    expect(isKnownAdapterType(agent.adapterType)).toBe(false);
    expect(() => getAdapterLabel(agent.adapterType)).not.toThrow();
    expect(getAdapterDisplay(agent.adapterType).description).toBe("External adapter");
    expect(agentDisplayAdapterType(agent)).toBe(REDUCED_AGENT_ADAPTER_TYPE);
    expect(() => bulkAgentHarness(agent)).not.toThrow();
    expect(bulkAgentDisabledReason(agent)).toBe("Connection and model are managed externally");
  });

  it("returns a full body untouched: the same object, no new keys", () => {
    const body = fullAgent();
    const snapshot = structuredClone(body);
    const result = completeAgentBody(body, "detail");
    expect(result).toBe(body);
    expect(result).toStrictEqual(snapshot);
    expect(isReducedAgent(result)).toBe(false);
  });

  it("decides by shape, not by the session: an empty title and icon stay null", () => {
    const agent = completeAgentBody(reduced({ title: null, icon: null }));
    expect(agent).toMatchObject({ title: null, icon: null });
    expect(isReducedAgent(agent)).toBe(true);
  });
});

describe("agentsApi reads", () => {
  it("list completes each body and leaves full ones as they are", async () => {
    const full: Agent = fullAgent();
    mockApi.get.mockResolvedValue([reduced(), full]);
    const [first, second] = await agentsApi.list("company-1");
    expect(isReducedAgent(first!)).toBe(true);
    expect(second).toBe(full);
  });

  it("get completes a reduced detail body", async () => {
    mockApi.get.mockResolvedValue(reduced());
    const agent = await agentsApi.get(AGENT_ID, "company-1");
    expect(isReducedAgent(agent)).toBe(true);
    expect(agent.chainOfCommand).toEqual([]);
  });

  it("the 409 fallback resolves a reduced list by the derived urlKey", async () => {
    const other = reduced({ id: "11111111-2222-4333-8444-555555555555", name: "Someone Else" });
    mockApi.get.mockImplementation(async (path: string) => {
      if (path === "/agents/client-writer-acme?companyId=company-1") throw new ApiError("Ambiguous", 409, null);
      if (path === "/companies/company-1/agents") return [other, reduced()];
      if (path === `/agents/${AGENT_ID}?companyId=company-1`) return reduced();
      throw new Error(`unexpected ${path}`);
    });
    const agent = await agentsApi.get("client-writer-acme", "company-1");
    expect(agent.id).toBe(AGENT_ID);
    expect(isReducedAgent(agent)).toBe(true);
  });
});
