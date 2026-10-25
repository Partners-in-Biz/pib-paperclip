import { describe, expect, it, vi } from "vitest";
import { registerClientProjectWatch, rememberClientProjects, type ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { projectForScope } from "../src/issues.js";

const CO = "co-1";
const ADS_PROJECT = "ads-managed";
const acmeScope = { kind: "company" as const, id: "acme" };

const event = (patch: Record<string, unknown> = {}): ClientProjectsEvent => ({
  clientKind: "company",
  clientRef: "acme",
  projects: [{ projectId: "p-acme", kind: "crm" }],
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...patch,
}) as ClientProjectsEvent;

function createMockCtx(options: { projects?: Record<string, { archivedAt?: string | null }>; adsProject?: string | null } = {}) {
  const state = new Map<string, unknown>();
  const handlers = new Map<string, Array<(e: unknown) => Promise<void>>>();

  const ctx = {
    state: {
      get: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        const keyStr = `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
        return state.get(keyStr) ?? null;
      },
      set: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        const keyStr = `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
        state.set(keyStr, value);
      },
    },
    events: {
      on: (name: string, handler: (e: unknown) => Promise<void>) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name)!.push(handler);
      },
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => {
        const handlers_list = handlers.get(name) ?? [];
        for (const h of handlers_list) {
          await h({ companyId, payload } as never);
        }
      },
    },
    projects: {
      managed: { get: async () => ({ projectId: options.adsProject ?? null }) },
      get: async (id: string) => {
        const proj = options.projects?.[id];
        return proj ? { id, ...proj } : null;
      },
    },
  } as unknown as PluginContext;

  return { ctx, state };
}

describe("projectForScope with kind resolution", () => {
  it("chooses ads project when client has ads+website links", async () => {
    const { ctx } = createMockCtx({
      projects: {
        "p-ads": {},
        "p-web": {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    // Setup ads project ID (would be done in bootstrap)
    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // Emit client projects with ads and website kinds
    await rememberClientProjects(ctx, CO, event({
      projects: [
        { projectId: "p-ads", kind: "ads" },
        { projectId: "p-web", kind: "website" },
      ],
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBe("p-ads");
  });

  it("falls back to platform if no ads kind match, but platform exists", async () => {
    const { ctx } = createMockCtx({
      projects: {
        "p-platform": {},
        "p-web": {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // Only platform and website, no ads
    await rememberClientProjects(ctx, CO, event({
      projects: [
        { projectId: "p-platform", kind: "platform" },
        { projectId: "p-web", kind: "website" },
      ],
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBe("p-platform");
  });

  it("returns fallback when client has no linked projects", async () => {
    const { ctx } = createMockCtx({
      projects: {
        [ADS_PROJECT]: {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // No projects linked for acme
    await rememberClientProjects(ctx, CO, event({
      projects: [],
      updatedAt: "2026-10-02T10:00:00.000Z",
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBe(ADS_PROJECT);
  });

  it("returns fallback when no suitable link exists for the requested kind", async () => {
    const { ctx } = createMockCtx({
      projects: {
        [ADS_PROJECT]: {},
        "p-crm": {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // Only crm kind, no ads or platform
    await rememberClientProjects(ctx, CO, event({
      projects: [{ projectId: "p-crm", kind: "crm" }],
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBe(ADS_PROJECT);
  });

  it("skips archived ads project and falls back to platform", async () => {
    const { ctx } = createMockCtx({
      projects: {
        "p-ads-old": { archivedAt: "2026-09-30T00:00:00.000Z" },
        "p-platform": {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // Archived ads project with platform fallback
    await rememberClientProjects(ctx, CO, event({
      projects: [
        { projectId: "p-ads-old", kind: "ads" },
        { projectId: "p-platform", kind: "platform" },
      ],
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBe("p-platform");
  });

  it("returns undefined when no fallback project exists", async () => {
    const { ctx } = createMockCtx({
      projects: {
        "p-web": {},
      },
      adsProject: null,
    });
    registerClientProjectWatch(ctx);

    // No ads project set up
    await rememberClientProjects(ctx, CO, event({
      projects: [{ projectId: "p-web", kind: "website" }],
    }));

    const result = await projectForScope(ctx, CO, "company:acme");
    expect(result).toBeUndefined();
  });

  it("works with own scope (no client link) using fallback", async () => {
    const { ctx } = createMockCtx({
      projects: {
        [ADS_PROJECT]: {},
      },
      adsProject: ADS_PROJECT,
    });
    registerClientProjectWatch(ctx);

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: CO,
        namespace: "partnersinbiz.ads",
        stateKey: "managed-project",
      },
      { projectId: ADS_PROJECT },
    );

    // Using the special "own" scope key
    const result = await projectForScope(ctx, CO, "own");
    expect(result).toBe(ADS_PROJECT);
  });
});
