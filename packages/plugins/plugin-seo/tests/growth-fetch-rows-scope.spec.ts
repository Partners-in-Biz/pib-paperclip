/**
 * Scope filtering in createFetchRowsFunction: verifies that fetchRows
 * correctly filters sprints by scope (own, client:company:ref, etc.) and
 * that the scope parameter is passed through to listSprints correctly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createFetchRowsFunction, seoGrowthHandlers } from "../src/growth-host.js";
import { NAMESPACE } from "../src/namespace.js";
import * as dbModule from "../src/db.js";
import * as commonModule from "../src/service/common.js";
import * as gscModule from "../src/service/gsc.js";

describe("createFetchRowsFunction: scope filtering", () => {
  let mockContext: PluginContext;

  beforeEach(() => {
    mockContext = {
      db: {
        namespace: NAMESPACE,
        query: vi.fn(),
        execute: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      companies: { get: vi.fn() },
      events: { emit: vi.fn() },
      issues: { get: vi.fn(), createComment: vi.fn() },
    } as unknown as PluginContext;
  });

  it("passes client:company:a scope to listSprints when scopeKey is client:company:a", async () => {
    const sprintA = { id: "sprint-a", site_name: "Site A", scope_key: "client:company:a" } as any;

    // Track the scope parameter passed to listSprints
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId, filter) => {
      if (companyId === "co-1" && filter?.scope?.kind === "company" && filter?.scope?.id === "a") {
        return [sprintA] as any;
      }
      return [];
    });

    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(
      new Map([["https://example.com/page-a", { clicks: 10, impressions: 100 }]]),
    );

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("client:company:a", "2026-10-21", "2026-11-04");

    // Verify listSprints was called with the correct scope
    expect(listSprintsMock).toHaveBeenCalledWith(mockContext.db, "co-1", expect.objectContaining({
      scope: { kind: "company", id: "a" },
    }));

    // Verify results include data from scope A sprints
    expect(result.size).toBe(1);
    expect(result.get("https://example.com/page-a")).toEqual({ clicks: 10, impressions: 100 });

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("passes null scope to listSprints when scopeKey is own", async () => {
    const sprintOwn = { id: "sprint-own", site_name: "Site Own", scope_key: "own" } as any;

    // Track the scope parameter passed to listSprints
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId, filter) => {
      if (companyId === "co-1" && filter?.scope === null) {
        return [sprintOwn] as any;
      }
      return [];
    });

    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(
      new Map([["https://example.com/page-own", { clicks: 5, impressions: 50 }]]),
    );

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify listSprints was called with null scope
    expect(listSprintsMock).toHaveBeenCalledWith(mockContext.db, "co-1", expect.objectContaining({
      scope: null,
    }));

    // Verify results include data from own sprints
    expect(result.size).toBe(1);
    expect(result.get("https://example.com/page-own")).toEqual({ clicks: 5, impressions: 50 });

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("scope A sprints do not appear in results for scope B query", async () => {
    const sprintA = { id: "sprint-a", site_name: "Site A", scope_key: "client:company:a" } as any;
    const sprintB = { id: "sprint-b", site_name: "Site B", scope_key: "client:company:b" } as any;

    // Return different sprints based on the scope requested
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId, filter) => {
      if (companyId === "co-1") {
        if (filter?.scope?.id === "a") return [sprintA] as any;
        if (filter?.scope?.id === "b") return [sprintB] as any;
      }
      return [];
    });

    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    // Return different metrics for each sprint
    let gscCallCount = 0;
    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockImplementation(async (env, info, sprint) => {
      gscCallCount++;
      if (sprint.id === "sprint-a") {
        return new Map([["https://example.com/page-a", { clicks: 10, impressions: 100 }]]);
      }
      if (sprint.id === "sprint-b") {
        return new Map([["https://example.com/page-b", { clicks: 20, impressions: 200 }]]);
      }
      return new Map();
    });

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");

    // Query for scope A
    const resultA = await fetchRows("client:company:a", "2026-10-21", "2026-11-04");

    // Verify only scope A data is present
    expect(resultA.size).toBe(1);
    expect(resultA.get("https://example.com/page-a")).toEqual({ clicks: 10, impressions: 100 });
    expect(resultA.get("https://example.com/page-b")).toBeUndefined();

    // Query for scope B
    const resultB = await fetchRows("client:company:b", "2026-10-21", "2026-11-04");

    // Verify only scope B data is present
    expect(resultB.size).toBe(1);
    expect(resultB.get("https://example.com/page-b")).toEqual({ clicks: 20, impressions: 200 });
    expect(resultB.get("https://example.com/page-a")).toBeUndefined();

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("scope filter is correctly passed through on 'own' scope", async () => {
    const sprintOwn1 = { id: "sprint-own-1", site_name: "Own Site 1", scope_key: "own" } as any;
    const sprintOwn2 = { id: "sprint-own-2", site_name: "Own Site 2", scope_key: "own" } as any;

    // Track what scope is passed to listSprints
    let passedScopes: any[] = [];
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId, filter) => {
      passedScopes.push(filter?.scope);
      if (companyId === "co-1" && filter?.scope === null) {
        return [sprintOwn1, sprintOwn2] as any;
      }
      return [];
    });

    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(new Map());

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify null scope was passed (not undefined or any other value)
    expect(passedScopes).toContain(null);
    expect(passedScopes.length).toBeGreaterThan(0);

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("with companyId 'co-1', createFetchRowsFunction calls listSprints ONLY with 'co-1', never with DISTINCT query", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site 1", scope_key: "own" } as any;

    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId) => {
      if (companyId === "co-1") {
        return [sprint1] as any;
      }
      if (companyId === "co-2") {
        throw new Error("Should not reach co-2");
      }
      return [];
    });

    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(
      new Map([["https://example.com/page", { clicks: 5, impressions: 50 }]]),
    );

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify listSprints was called only with co-1
    expect(listSprintsMock).toHaveBeenCalledWith(mockContext.db, "co-1", expect.any(Object));
    expect(listSprintsMock).not.toHaveBeenCalledWith(mockContext.db, "co-2", expect.any(Object));

    // Verify db.query was never called (no DISTINCT company_id query)
    expect(mockContext.db.query).not.toHaveBeenCalled();

    // Verify results include data
    expect(result.size).toBe(1);
    expect(result.get("https://example.com/page")).toEqual({ clicks: 5, impressions: 50 });

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("seoGrowthHandlers(envFor) with actor {companyId:'co-9'} calls envFor with 'co-9'", async () => {
    const envForMock = vi.fn().mockReturnValue({
      ctx: mockContext,
      store: {} as any,
      now: () => new Date(),
      channel: "seo",
      objective: "default",
      metric: "default",
      scopes: { fromParams: async () => ({ scope: null, client: null }), toParam: () => "own" },
      issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
    } as any);

    const { "performance-review": performanceReviewHandler } = seoGrowthHandlers(envForMock) as any;

    const actor = { companyId: "co-9", userId: null, agentId: "agent1", isAgent: true };
    const params = { scope: "own" };

    // Call the handler to trigger envFor
    try {
      await performanceReviewHandler(actor, params);
    } catch {
      // Ignore any errors from the actual handler; we're just testing the envFor call
    }

    // Verify envFor was called with co-9
    expect(envForMock).toHaveBeenCalledWith("co-9");
  });
});
