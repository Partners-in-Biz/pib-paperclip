/**
 * SEO plugin now joins the client-project watch: it resolves the client's linked
 * projects by kind instead of just matching names.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { rememberClientProjects, type ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import * as dbm from "../src/db.js";
import { createEnv } from "../src/service/common.js";
import { findClientProject, findSeoClientProject } from "../src/service/site.js";

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1",
  companyId: "co-1",
  name: "Acme",
  siteUrl: "https://acme.co.za",
  siteName: "Acme",
  clientRef: "c-acme",
  clientName: "Acme Corp",
  clientKind: "company",
  status: "active",
  startDate: "2026-09-01",
  templateId: "outrank-90",
  templateVersion: 4,
  autopilotMode: "safe",
  ownerUserId: "user-1",
  projectId: "proj-1",
  rootIssueId: null,
  rootIssueIdentifier: null,
  agentId: null,
  notes: null,
  pausedReason: null,
  health: {},
  scoreboard: {},
  today: {},
  currentDay: 25,
  currentWeek: 4,
  currentPhase: 1,
  lastDailyOn: null,
  lastWeeklyOn: null,
  auditDaysDone: [0],
  seededAt: "2026-09-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  siteAccess: "unlinked",
  defaultBranch: "main",
  changePolicy: "merge_seo_scope",
};

function toSprint(row: Row): dbm.Sprint {
  return row as unknown as dbm.Sprint;
}

/**
 * Minimal PluginContext with in-memory state storage matching the kit's state key format:
 * scopeKind|scopeId|namespace|stateKey
 */
function createFakeContext(
  projectsSpec: Record<string, { name?: string; urlKey?: string | null; archivedAt?: string | null }> = {}
) {
  const state = new Map<string, unknown>();

  const ctx = {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    projects: {
      list: async () =>
        Object.entries(projectsSpec).map(([id, meta]) => ({
          id,
          name: meta.name ?? id,
          urlKey: meta.urlKey ?? null,
          archivedAt: meta.archivedAt ?? null,
        })),
      get: async (id: string) => {
        const found = projectsSpec[id];
        return found
          ? {
              id,
              name: found.name ?? id,
              urlKey: found.urlKey ?? null,
              archivedAt: found.archivedAt ?? null,
            }
          : null;
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
  } as unknown as PluginContext;

  return { ctx, state };
}

/**
 * Creates a test setup. The in-memory kit state uses the kit's own state key format.
 */
function host(setup: {
  sprint?: Row;
  projects?: Record<string, { name?: string; urlKey?: string | null; archivedAt?: string | null }>;
  clientProjectsEvent?: ClientProjectsEvent;
}) {
  const sprint = { ...SPRINT, ...(setup.sprint ?? {}) };
  const { ctx, state } = createFakeContext(setup.projects ?? {});

  const env = createEnv(ctx, {
    now: () => new Date("2026-10-03T08:00:00Z"),
    fetch: (() => {}) as never,
    site: (() => {}) as never,
  });

  return { env, ctx, state, sprint, clientProjectsEvent: setup.clientProjectsEvent };
}

describe("findSeoClientProject", () => {
  it("cold cache (no event), a single active project named like client_name -> findSeoClientProject equals findClientProject and equals that project id (not null)", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: "company", clientName: "Acme Corp" },
      projects: { "proj-acme": { name: "Acme Corp" } },
    });
    const sprint = toSprint(h.sprint);

    const viaName = await findClientProject(h.env, sprint);
    const viaSeo = await findSeoClientProject(h.env, sprint);

    expect(viaSeo).toBe(viaName);
    expect(viaSeo).toBe("proj-acme");
  });

  it("cold cache, no name match -> both null", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: "company", clientName: "NonExistent" },
      projects: { "proj-other": { name: "Other Corp" } },
    });
    const sprint = toSprint(h.sprint);

    const viaName = await findClientProject(h.env, sprint);
    const viaSeo = await findSeoClientProject(h.env, sprint);

    expect(viaSeo).toBeNull();
    expect(viaName).toBeNull();
  });

  it("synthetic event with {projectId:'proj-seo', kind:'seo'} and a different name-matching project 'proj-acme' present -> returns 'proj-seo'", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: "company", clientName: "Acme Corp" },
      projects: {
        "proj-seo": { name: "SEO Project" },
        "proj-acme": { name: "Acme Corp" },
      },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [{ projectId: "proj-seo", kind: "seo" }],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    const sprint = toSprint(h.sprint);

    // Seed the synthetic link via the kit's rememberClientProjects
    await rememberClientProjects(h.ctx, "co-1", h.clientProjectsEvent!);

    const viaSeo = await findSeoClientProject(h.env, sprint);
    expect(viaSeo).toBe("proj-seo");
  });

  it("event with only {kind:'social'} link -> the resolver result is not a seo link; returns null, falls back to name match", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: "company", clientName: "NonMatching" },
      projects: { "proj-social": { name: "Social Project" } },
      clientProjectsEvent: {
        clientKind: "company",
        clientRef: "c-acme",
        projects: [{ projectId: "proj-social", kind: "social" }],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    });
    const sprint = toSprint(h.sprint);

    // Seed the social-only link
    await rememberClientProjects(h.ctx, "co-1", h.clientProjectsEvent!);

    const viaSeo = await findSeoClientProject(h.env, sprint);
    // Resolver will not return a seo link; helper falls back to name match which also fails
    expect(viaSeo).toBeNull();
  });

  it("state read rejecting -> falls to the name match", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: "company", clientName: "Acme Corp" },
      projects: { "proj-acme": { name: "Acme Corp" } },
    });
    const sprint = toSprint(h.sprint);

    // Manually make state.get reject for this test
    const originalGet = h.ctx.state.get;
    h.ctx.state.get = async () => {
      throw new Error("state down");
    };

    const viaSeo = await findSeoClientProject(h.env, sprint);
    const viaName = await findClientProject(h.env, sprint);

    expect(viaSeo).toBe(viaName);
    expect(viaSeo).toBe("proj-acme");

    h.ctx.state.get = originalGet;
  });

  it("no client_ref -> the name-match path; when clientRef missing, findClientProject returns null", async () => {
    const h = host({
      sprint: { clientRef: null, clientKind: "company", clientName: "Acme Corp" },
      projects: { "proj-acme": { name: "Acme Corp" } },
    });
    const sprint = toSprint(h.sprint);

    const viaName = await findClientProject(h.env, sprint);
    const viaSeo = await findSeoClientProject(h.env, sprint);

    expect(viaSeo).toBe(viaName);
    expect(viaName).toBeNull();
  });

  it("no client_kind -> the name-match path; falls back to name match", async () => {
    const h = host({
      sprint: { clientRef: "c-acme", clientKind: null, clientName: "Acme Corp" },
      projects: { "proj-acme": { name: "Acme Corp" } },
    });
    const sprint = toSprint(h.sprint);

    const viaSeo = await findSeoClientProject(h.env, sprint);
    const viaName = await findClientProject(h.env, sprint);

    expect(viaSeo).toBe(viaName);
    expect(viaSeo).toBe("proj-acme");
  });
});
