/**
 * Tests for emitClientProjects and emitClientProjectsForCompany.
 * Tests the core contract: flag checking, querying, emitting, error handling, company isolation.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import { emitClientProjects, emitClientProjectsForCompany } from "../src/client-projects-emit.js";
import { boot, CO } from "./helpers/crm.js";

describe("emitClientProjects and emitClientProjectsForCompany", () => {
  it("flag off is silent", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: false } });
    const ctx = harness.ctx;

    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(false);
    expect(emit.mock.calls.filter((call) => call[0] === "client.projects.updated")).toHaveLength(0);
  });

  it("link emits both shapes", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    // Seed one project link
    (store.client_projects ??= []).push({
      id: "link-1",
      company_id: CO,
      client_kind: "company",
      client_ref: "acme",
      project_id: "p1",
      kind: "seo",
      created_at: "2026-01-01T00:00:00Z",
    });

    emit.mockClear();
    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(true);

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual(["p1"]);
    expect(payload.projects).toEqual([{ projectId: "p1", kind: "seo" }]);
    expect(payload.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("unlink emits the remaining set", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    (store.client_projects ??= []).push(
      { id: "l1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p1", kind: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "l2", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p2", kind: null, created_at: "2026-01-01T00:01:00Z" }
    );

    emit.mockClear();
    // Remove p1 from store to simulate unlink
    store.client_projects = [(store.client_projects as any[])[1]];

    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(true);

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual(["p2"]);
  });

  it("unlinking the last link emits an empty set", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    (store.client_projects ??= []).push({ id: "l1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p1", kind: null, created_at: "2026-01-01T00:00:00Z" });

    emit.mockClear();
    // Remove all links
    store.client_projects = [];

    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(true);

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual([]);
    expect(payload.projects).toEqual([]);
  });

  it("two rapid emits are both applied", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    // Clear any emits from boot setup
    emit.mockClear();

    // First emit with p1
    (store.client_projects ??= []).push({ id: "l1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p1", kind: null, created_at: "2026-01-01T00:00:00Z" });
    await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });

    // Freeze the clock to ensure the second emit has the same timestamp
    const now = new Date();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Second emit with p1 and p2
    (store.client_projects as any[]).push({ id: "l2", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p2", kind: null, created_at: "2026-01-01T00:01:00Z" });
    await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });

    vi.useRealTimers();

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event has p1
    const firstPayload = events[0]![2] as ClientProjectsEvent;
    expect(firstPayload.projectIds).toEqual(["p1"]);

    // Find the last event - it should have both p1 and p2
    const lastEvent = events[events.length - 1]!;
    const lastPayload = lastEvent[2] as ClientProjectsEvent;
    expect(lastPayload.projectIds ?? []).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect((lastPayload.projects ?? []).map((p) => p.projectId).sort()).toEqual(["p1", "p2"].sort());
  });

  it("companies are isolated", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    // Seed data from both companies
    (store.client_projects ??= []).push(
      { id: "l1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p1", kind: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "l2", company_id: "co-2", client_kind: "company", client_ref: "acme", project_id: "p2", kind: null, created_at: "2026-01-01T00:00:00Z" }
    );

    emit.mockClear();
    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(true);

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    expect(events[0]![1]).toBe(CO);
    const payload = events[0]![2] as ClientProjectsEvent;
    // Should only contain p1 from CO, not p2 from co-2
    expect(payload.projectIds).toEqual(["p1"]);
  });

  it("an emit error is swallowed and logged without values", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    // Mock the logger to capture warnings
    const warnSpy = vi.spyOn(ctx.logger, "warn");

    const MARKER = "MARKER-SECRET-VALUE";
    const originalFn = emit.getMockImplementation();
    emit.mockImplementation(async (name: string, companyId: string, payload: unknown) => {
      if (name === "client.projects.updated") throw new Error(MARKER);
      return originalFn?.(name, companyId, payload);
    });

    (store.client_projects ??= []).push({ id: "l1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "p1", kind: null, created_at: "2026-01-01T00:00:00Z" });

    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(false);

    expect(warnSpy).toHaveBeenCalled();
    const loggedStr = JSON.stringify(warnSpy.mock.calls[warnSpy.mock.calls.length - 1]!);
    expect(loggedStr).not.toContain(MARKER);
    expect(loggedStr).not.toContain("acme");
    expect(loggedStr).not.toContain("p1");
  });

  it("kit round trip: CRM payload resolves by kind", async () => {
    const { harness, emit, store } = await boot({ config: { emitClientProjects: true } });
    const ctx = harness.ctx;

    (store.client_projects ??= []).push({
      id: "link-1",
      company_id: CO,
      client_kind: "company",
      client_ref: "acme",
      project_id: "proj-seo",
      kind: "seo",
      created_at: "2026-01-01T00:00:00Z",
    });

    const result = await emitClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme" });
    expect(result).toBe(true);

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual(["proj-seo"]);
    expect(payload.projects).toEqual([{ projectId: "proj-seo", kind: "seo" }]);
    expect(payload.clientKind).toBe("company");
    expect(payload.clientRef).toBe("acme");
  });
});
