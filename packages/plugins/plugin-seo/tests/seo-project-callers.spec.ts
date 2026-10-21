/**
 * SEO project resolution regression tests: verify that all five services
 * resolve client projects through the shared helper, never bypassing it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { rememberClientProjects, type ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import * as dbm from "../src/db.js";
import { createEnv } from "../src/service/common.js";
import { autoLinkClientProject, findSeoClientProject } from "../src/service/site.js";

vi.mock("../src/db.js", async () => {
  const actual = await vi.importActual<typeof dbm>("../src/db.js");
  return { ...actual, updateSprint: vi.fn() };
});

const SPRINT: Record<string, unknown> = {
  id: "sp-1",
  companyId: "co-1",
  name: "Acme",
  siteUrl: "https://acme.co.za",
  clientRef: "c-acme",
  clientName: "Acme Corp",
  clientKind: "company",
  projectId: "proj-1",
  clientProjectId: null,
  status: "active",
  startDate: "2026-09-01",
  templateId: "outrank-90",
  templateVersion: 4,
  autopilotMode: "safe",
  ownerUserId: "user-1",
  rootIssueId: null,
  rootIssueIdentifier: null,
  agentId: null,
  siteAccess: "unlinked",
  defaultBranch: "main",
  changePolicy: "merge_seo_scope",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

function createFakeContext(
  projectsSpec: Record<string, { name?: string; urlKey?: string | null; archivedAt?: string | null }> = {}
) {
  const state = new Map<string, unknown>();
  return {
    ctx: {
      db: {} as unknown,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      projects: {
        list: vi.fn(async () =>
          Object.entries(projectsSpec).map(([id, meta]) => ({
            id,
            name: meta.name ?? id,
            urlKey: meta.urlKey ?? null,
            archivedAt: meta.archivedAt ?? null,
          }))
        ),
        get: async (id: string) => {
          const found = projectsSpec[id];
          return found ? { id, name: found.name ?? id, urlKey: found.urlKey ?? null, archivedAt: found.archivedAt ?? null } : null;
        },
      },
      state: {
        get: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
          const fullKey = `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
          return state.get(fullKey) ?? null;
        },
        set: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
          const fullKey = `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
          state.set(fullKey, value);
        },
        delete: async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
          const fullKey = `${key.scopeKind}|${key.scopeId ?? ""}|${key.namespace ?? "default"}|${key.stateKey}`;
          state.delete(fullKey);
        },
      },
    } as unknown as PluginContext,
    state,
  };
}

function host(setup: { sprint?: Record<string, unknown>; projects?: Record<string, any>; clientProjectsEvent?: ClientProjectsEvent }) {
  const sprint = { ...SPRINT, ...(setup.sprint ?? {}) };
  const { ctx, state } = createFakeContext(setup.projects ?? {});
  const env = createEnv(ctx, { now: () => new Date("2026-10-03T08:00:00Z"), fetch: (() => {}) as never, site: (() => {}) as never });
  return { env, ctx, state, sprint, clientProjectsEvent: setup.clientProjectsEvent };
}

describe("seo-project-callers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sprints.ts and jobs.ts call autoLinkClientProject; no other service bypasses the helper", async () => {
    const fs = await import("fs/promises");
    const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/service");

    const sprints = await fs.readFile(`${base}/sprints.ts`, "utf-8");
    expect(sprints).toContain("import { autoLinkClientProject");
    expect(sprints).toMatch(/autoLinkClientProject\s*\(/);

    const jobs = await fs.readFile(`${base}/jobs.ts`, "utf-8");
    expect(jobs).toContain("import { autoLinkClientProject");
    expect(jobs).toMatch(/autoLinkClientProject\s*\(/);

    for (const file of ["tasks.ts", "redesign.ts", "wordpress.ts", "build.ts", "chunks.ts"]) {
      const content = await fs.readFile(`${base}/${file}`, "utf-8");
      expect(content).not.toMatch(/findClientProject\s*\(|findSeoClientProject\s*\(|resolveClientProjectId\s*\(|projects\.list\s*\(/);
    }
  });

  it("cached seo-kind link: sprint without clientProjectId gets set; website-kind not picked", async () => {
    const h = host({
      sprint: { clientProjectId: null },
      projects: { "proj-seo": { name: "SEO Project" }, "proj-web": { name: "Website Project" } },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [
          { projectId: "proj-web", kind: "website" },
          { projectId: "proj-seo", kind: "seo" },
        ],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    await rememberClientProjects(h.ctx, "co-1", h.clientProjectsEvent!);

    const result = await autoLinkClientProject(h.env, h.sprint as unknown as dbm.Sprint);

    expect(result.clientProjectId).toBe("proj-seo");
    expect(vi.mocked(dbm.updateSprint)).toHaveBeenCalledWith(
      h.ctx.db,
      "co-1",
      "sp-1",
      { client_project_id: "proj-seo", project_id: "proj-seo" }
    );
  });

  it("sprint with existing clientProjectId: no updateSprint call, resolver not consulted", async () => {
    const h = host({
      sprint: { clientProjectId: "proj-existing" },
      projects: { "proj-seo": { name: "SEO Project" } },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [{ projectId: "proj-seo", kind: "seo" }],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    await rememberClientProjects(h.ctx, "co-1", h.clientProjectsEvent!);

    const result = await autoLinkClientProject(h.env, h.sprint as unknown as dbm.Sprint);
    expect(result).toEqual(h.sprint);
    expect(vi.mocked(dbm.updateSprint)).not.toHaveBeenCalled();
    expect(vi.mocked(h.ctx.projects.list)).not.toHaveBeenCalled();
  });

  it("cold cache, no name match or two matches: stays unlinked", async () => {
    const h1 = host({ sprint: { clientProjectId: null }, projects: { "proj-other": { name: "Other" } } });
    const r1 = await autoLinkClientProject(h1.env, h1.sprint as unknown as dbm.Sprint);
    expect(r1.clientProjectId).toBeNull();

    const h2 = host({
      sprint: { clientProjectId: null },
      projects: { "proj-1": { name: "Acme Corp" }, "proj-2": { name: "Acme Corp" } },
    });
    const r2 = await autoLinkClientProject(h2.env, h2.sprint as unknown as dbm.Sprint);
    expect(r2.clientProjectId).toBeNull();
  });

  it("at most one same-kind link reaches the helper (B1 unique index); if the cache ever held two, the kit takes the first", async () => {
    const h1 = host({
      sprint: { clientProjectId: null, clientName: "NoMatch" },
      projects: { "proj-seo": { name: "SEO" } },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [{ projectId: "proj-seo", kind: "seo" }],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    await rememberClientProjects(h1.ctx, "co-1", h1.clientProjectsEvent!);
    const r1 = await findSeoClientProject(h1.env, h1.sprint as unknown as dbm.Sprint);
    expect(r1).toBe("proj-seo");

    // documents the kit's behaviour only; B1's unique (client, kind) index in the CRM means this state cannot be produced
    const h2 = host({
      sprint: { clientProjectId: null, clientName: "NoMatch" },
      projects: { "proj-seo-1": { name: "SEO 1" }, "proj-seo-2": { name: "SEO 2" } },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [
          { projectId: "proj-seo-1", kind: "seo" },
          { projectId: "proj-seo-2", kind: "seo" },
        ],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    await rememberClientProjects(h2.ctx, "co-1", h2.clientProjectsEvent!);
    const r2 = await findSeoClientProject(h2.env, h2.sprint as unknown as dbm.Sprint);
    expect(r2).toBe("proj-seo-1");
  });
});
