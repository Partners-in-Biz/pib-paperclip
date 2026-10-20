/**
 * Tests for client project link/unlink: drive real linkClientProject/unlinkClientProject,
 * assert on ctx.events.emit, verify company isolation, and kit round-trip.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import { registerClientProjectWatch, resolveClientProjectId } from "@partnersinbiz/pib-plugin-kit";
import { linkClientProject, unlinkClientProject } from "../src/sites.js";
import { boot, CO } from "./helpers/crm.js";

/** Minimal fake context for kit tests: state, events, projects. */
function minimalKitContext(projects: Record<string, Record<string, unknown>> = {}) {
  const state = new Map<string, unknown>();
  const handlers = new Map<string, Array<(event: PluginEvent) => Promise<void>>>();

  const ctx = {
    state: {
      get: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => state.get(`${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`) ?? null,
      set: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) =>
        state.set(`${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`, value),
    },
    events: {
      on: (name: string, fn: (event: PluginEvent) => Promise<void>) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      emit: () => {},
    },
    projects: {
      get: async (id: string) => projects[id] ? { id, ...projects[id] } : null,
    },
  } as unknown as PluginContext;

  const deliver = async (name: string, companyId: string, payload: unknown) => {
    for (const fn of handlers.get(name) ?? []) await fn({ eventType: name, companyId, payload, occurredAt: new Date().toISOString() } as unknown as PluginEvent);
  };

  return { ctx, deliver };
}

describe("link and unlink client projects with emit", () => {
  it("flag off is silent", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: false } });
    const ctx = { ...harness.ctx, projects: { get: async () => ({ id: "p1", name: "Project 1" }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    const result = await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" });
    expect(result).toMatchObject({ linked: true });
    expect(emit.mock.calls.filter((call) => call[0] === "client.projects.updated")).toHaveLength(0);
  });

  it("link emits both shapes", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    const result = await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1", kind: "seo" });
    expect(result).toMatchObject({ linked: true, kind: "seo" });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual(["p1"]);
    expect(payload.projects).toEqual([{ projectId: "p1", kind: "seo" }]);
    expect(payload.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(payload.clientKind).toBe("company");
    expect(payload.clientRef).toBe("acme");
  });

  it("unlink emits the remaining set", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    // Link p1 and p2
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" });
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p2" });
    emit.mockClear();

    // Unlink p1
    const result = await unlinkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" }, "human");
    expect(result).toMatchObject({ unlinked: true });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual(["p2"]);
  });

  it("unlinking the last link emits an empty set", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" });
    emit.mockClear();

    const result = await unlinkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" }, "human");
    expect(result).toMatchObject({ unlinked: true });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as ClientProjectsEvent;
    expect(payload.projectIds).toEqual([]);
    expect(payload.projects).toEqual([]);
  });

  it("unlinking a link that does not exist emits nothing", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    const result = await unlinkClientProject(ctx, viewer, { client: "company:acme", projectId: "p-gone" }, "human");
    expect(result).toMatchObject({ unlinked: true });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(0);
  });

  it("re-linking the same project with same kind emits nothing", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1", kind: "seo" });
    emit.mockClear();

    const result = await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1", kind: "seo" });
    expect(result).toMatchObject({ alreadyLinked: true, kind: "seo" });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(0);
  });

  it("two rapid emits are both applied and later timestamp wins", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    emit.mockClear();
    vi.useFakeTimers();
    const time1 = new Date("2026-10-20T10:00:00Z");
    vi.setSystemTime(time1);
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" });

    const time2 = new Date("2026-10-20T10:00:00Z");
    vi.setSystemTime(time2);
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p2" });
    vi.useRealTimers();

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events.length).toBe(2);
    const payload1 = events[0]![2] as ClientProjectsEvent;
    const payload2 = events[1]![2] as ClientProjectsEvent;
    expect(payload1.projectIds).toEqual(["p1"]);
    expect(new Set(payload2.projectIds)).toEqual(new Set(["p1", "p2"]));
  });

  it("an emit error is swallowed and logged without values", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    const warnSpy = vi.spyOn(ctx.logger, "warn");
    const MARKER = "MARKER-SECRET-VALUE";
    const originalFn = emit.getMockImplementation();
    emit.mockImplementation(async (name: string, companyId: string, payload: unknown) => {
      if (name === "client.projects.updated") throw new Error(MARKER);
      return originalFn?.(name, companyId, payload);
    });

    emit.mockClear();
    const result = await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "p1" });
    expect(result).toMatchObject({ linked: true });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    const loggedStr = JSON.stringify(warnSpy.mock.calls[warnSpy.mock.calls.length - 1]!);
    expect(loggedStr).not.toContain(MARKER);
    expect(loggedStr).not.toContain("acme");
    expect(loggedStr).not.toContain("p1");
  });

  it("kit round trip: CRM payload delivers to listener and resolveClientProjectId picks by kind", async () => {
    const { harness, emit } = await boot({ config: { emitClientProjects: true } });
    const ctx = { ...harness.ctx, projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) } } as unknown as PluginContext;
    const viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };

    // Build minimal kit context with projects
    const { ctx: kitCtx, deliver } = minimalKitContext({ "proj-seo": {}, "proj-social": {} });
    registerClientProjectWatch(kitCtx);

    emit.mockClear();
    // Link seo and social with kinds
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "proj-seo", kind: "seo" });
    await linkClientProject(ctx, viewer, { client: "company:acme", projectId: "proj-social", kind: "social" });

    const events = emit.mock.calls.filter((call) => call[0] === "client.projects.updated");
    expect(events.length).toBe(2);

    // Deliver payloads in order to kit listener
    const payload1 = events[0]![2] as ClientProjectsEvent;
    const payload2 = events[1]![2] as ClientProjectsEvent;
    await deliver("plugin.partnersinbiz.crm.client.projects.updated", CO, payload1);
    await deliver("plugin.partnersinbiz.crm.client.projects.updated", CO, payload2);

    // Assert resolveClientProjectId picks correctly by kind
    const seoResolve = await resolveClientProjectId(kitCtx, CO, { kind: "company", id: "acme" }, { kind: "seo" });
    expect(seoResolve.projectId).toBe("proj-seo");
    expect(seoResolve.kind).toBe("seo");
    expect(seoResolve.source).toBe("client-link");

    const socialResolve = await resolveClientProjectId(kitCtx, CO, { kind: "company", id: "acme" }, { kind: "social" });
    expect(socialResolve.projectId).toBe("proj-social");
    expect(socialResolve.kind).toBe("social");
    expect(socialResolve.source).toBe("client-link");

    // Fallback returns one of the linked projects (may vary based on order)
    const fallbackResolve = await resolveClientProjectId(kitCtx, CO, { kind: "company", id: "acme" });
    expect(fallbackResolve.source).toBe("client-link");
    expect(["proj-seo", "proj-social"]).toContain(fallbackResolve.projectId);
  });
});
