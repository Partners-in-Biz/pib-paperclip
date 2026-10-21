/**
 * Growth Lab measurement with GSC data: tests for error handling when
 * GSC read fails. Ensures warnings are logged, failed sprints are skipped,
 * and measurement continues for other sprints.
 *
 * Tests the real fetchRows function from createFetchRowsFunction, which
 * aggregates metrics from all companies' sprints and catches errors.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createFetchRowsFunction } from "../src/growth-host.js";
import { NAMESPACE } from "../src/namespace.js";
import * as commonModule from "../src/service/common.js";
import * as gscModule from "../src/service/gsc.js";
import * as dbModule from "../src/db.js";

describe("Growth Lab measurement: GSC error handling", () => {
  let mockContext: PluginContext;
  let warnLogs: Array<{ message: string; data: any }>;

  beforeEach(() => {
    warnLogs = [];
    mockContext = {
      db: {
        namespace: NAMESPACE,
        query: vi.fn(),
        execute: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn((message: string, data?: any) => {
          warnLogs.push({ message, data });
        }),
        error: vi.fn(),
      },
      companies: { get: vi.fn() },
      events: { emit: vi.fn() },
      issues: { get: vi.fn(), createComment: vi.fn() },
    } as unknown as PluginContext;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning when companyInfo throws, continues with other sprints", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site1", scope_key: "own" } as any;
    const sprint2 = { id: "sprint-2", site_name: "Site2", scope_key: "own" } as any;

    // Mock listSprints to return two sprints for co-1
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockImplementation(async (db, companyId) => {
      if (companyId === "co-1") return [sprint1, sprint2] as any;
      return [];
    });

    // Mock companyInfo to throw for sprint1, succeed for sprint2
    let callCount = 0;
    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockImplementation(async (env, companyId) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Config load failed for co-1");
      }
      return {
        companyId,
        loaded: { config: { timezone: "UTC" } } as any,
        timezone: "UTC",
        today: "2026-10-21",
        hour: 8,
        prefix: null,
      };
    });

    // Mock gscPageQueryRows to succeed
    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(
      new Map([["https://example.com/page", { clicks: 10, impressions: 100 }]]),
    );

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify warning was logged for co-1
    const co1Warning = warnLogs.find((log) => log.data?.companyId === "co-1");
    expect(co1Warning).toBeDefined();
    expect(co1Warning?.message).toBe("GSC data fetch failed, skipping sprint");
    expect(co1Warning?.data?.sprintId).toBe("sprint-1");
    expect(co1Warning?.data?.scopeKey).toBe("own");
    expect(co1Warning?.data?.error).toBe("Config load failed for co-1");

    // Verify no secrets in the logged error message
    expect(co1Warning?.data?.error).not.toContain("secret");
    expect(co1Warning?.data?.error).not.toContain("token");

    // Verify results include data from sprint2 (the successful one)
    expect(result.size).toBe(1);
    expect(result.get("https://example.com/page")).toEqual({ clicks: 10, impressions: 100 });

    // Verify functions were called appropriately
    expect(listSprintsMock).toHaveBeenCalledWith(mockContext.db, "co-1", { scope: null });
    expect(companyInfoMock).toHaveBeenCalledTimes(2);
    expect(gscMock).toHaveBeenCalledOnce();

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("returns empty metrics when all GSC reads throw", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site1", scope_key: "own" } as any;
    const sprint2 = { id: "sprint-2", site_name: "Site2", scope_key: "own" } as any;

    // Mock listSprints to return two sprints for co-1
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockResolvedValue([sprint1, sprint2] as any);

    // Mock both companyInfo and gscPageQueryRows to throw
    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockRejectedValue(new Error("GSC config missing"));

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Should return empty, not throw
    expect(result.size).toBe(0);

    // Verify warnings were logged for both sprints
    expect(warnLogs.length).toBeGreaterThanOrEqual(2);
    const sprint1Warning = warnLogs.find((log) => log.data?.sprintId === "sprint-1");
    const sprint2Warning = warnLogs.find((log) => log.data?.sprintId === "sprint-2");
    expect(sprint1Warning).toBeDefined();
    expect(sprint2Warning).toBeDefined();

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
  });

  it("propagates correct date window to GSC fetch", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site1", scope_key: "own" } as any;

    // Mock listSprints
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockResolvedValue([sprint1] as any);

    // Mock companyInfo to succeed
    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    // Mock gscPageQueryRows and verify the date window passed to it
    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockResolvedValue(new Map());

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    await fetchRows("own", "2026-10-08", "2026-10-22");

    // Verify the date window passed to gscPageQueryRows matches the input
    expect(gscMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), sprint1, "2026-10-08", "2026-10-22");

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("aggregates metrics from multiple sprints correctly", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site1", scope_key: "own" } as any;
    const sprint2 = { id: "sprint-2", site_name: "Site2", scope_key: "own" } as any;

    // Mock listSprints to return two sprints for the same company
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockResolvedValue([sprint1, sprint2] as any);

    // Mock companyInfo to succeed
    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    // Mock gscPageQueryRows with different metrics for each call
    let gscCallCount = 0;
    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockImplementation(async () => {
      gscCallCount++;
      if (gscCallCount === 1) {
        return new Map([
          ["https://example.com/page1", { clicks: 10, impressions: 100 }],
          ["https://example.com/page2", { clicks: 5, impressions: 50 }],
        ]);
      }
      // Second call
      return new Map([["https://example.com/page1", { clicks: 15, impressions: 150 }]]);
    });

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify aggregation: page1 should have combined clicks/impressions
    expect(result.get("https://example.com/page1")).toEqual({ clicks: 25, impressions: 250 });
    expect(result.get("https://example.com/page2")).toEqual({ clicks: 5, impressions: 50 });

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });

  it("gscPageQueryRows error does not prevent other sprints from being measured", async () => {
    const sprint1 = { id: "sprint-1", site_name: "Site1", scope_key: "own" } as any;
    const sprint2 = { id: "sprint-2", site_name: "Site2", scope_key: "own" } as any;

    // Mock listSprints to return two sprints
    const listSprintsMock = vi.spyOn(dbModule, "listSprints").mockResolvedValue([sprint1, sprint2] as any);

    // Mock companyInfo to always succeed
    const companyInfoMock = vi.spyOn(commonModule, "companyInfo").mockResolvedValue({
      companyId: "co-1",
      loaded: { config: { timezone: "UTC" } } as any,
      timezone: "UTC",
      today: "2026-10-21",
      hour: 8,
      prefix: null,
    });

    // Mock gscPageQueryRows to fail for sprint1, succeed for sprint2
    let gscCallCount = 0;
    const gscMock = vi.spyOn(gscModule, "gscPageQueryRows").mockImplementation(async (env, info, sprint) => {
      gscCallCount++;
      if (sprint.id === "sprint-1") {
        throw new Error("GSC API error for sprint 1");
      }
      return new Map([["https://example.com/page", { clicks: 20, impressions: 200 }]]);
    });

    const fetchRows = createFetchRowsFunction(mockContext, "co-1");
    const result = await fetchRows("own", "2026-10-21", "2026-11-04");

    // Verify warning was logged for sprint1
    const sprint1Warning = warnLogs.find((log) => log.data?.sprintId === "sprint-1");
    expect(sprint1Warning).toBeDefined();
    expect(sprint1Warning?.data?.error).toBe("GSC API error for sprint 1");

    // Verify results still include data from sprint2
    expect(result.size).toBe(1);
    expect(result.get("https://example.com/page")).toEqual({ clicks: 20, impressions: 200 });

    listSprintsMock.mockRestore();
    companyInfoMock.mockRestore();
    gscMock.mockRestore();
  });
});
