import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, environments, executionWorkspaces, issueComments, issues,
  projectAccessMembers, projects, projectWorkspaces, workspaceRuntimeServices,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { agentRoutes } from "../routes/agents.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { publishLiveEvent } from "../services/live-events.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import {
  MEMBER_RESTRICTION_BODY_ALLOWLISTS, MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS, TASK_KEPT_OBJECTS,
} from "../services/member-restriction/body-allowlist.js";
import {
  MEMBER_RESTRICTION_POLICY_FIELDS, MEMBER_RESTRICTION_PROJECTED_KEYS, MEMBER_RESTRICTION_STRIPPED_KEYS, hasHostKeys, withoutHostKeys,
} from "../services/member-restriction/response-strip.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12951 (C4i-c): no host or secret key reaches a caller bound by R under
 * `enforce`, at any depth of a JSON response or a live-event frame. Spec
 * PAR-12608 rev 3, 4.5, 4.6, AC-F2, AC-G12, AC-F8, AC-X1. Real routes, the real
 * route-table middleware and the real resolver.
 */

const resolverFails = vi.hoisted(() => ({ on: false, reads: 0 }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionEnforcedCompanyIds: (...args: Parameters<typeof actual.memberRestrictionEnforcedCompanyIds>) => {
      resolverFails.reads += 1;
      return resolverFails.on ? fail() : actual.memberRestrictionEnforcedCompanyIds(...args);
    },
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) => {
      const resolve = actual.memberRestrictionResolver(db);
      return (personId: string, companyId: string) => (resolverFails.on ? fail() : resolve(personId, companyId));
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("response strip database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

it("tripwire: every `refused` and `keep-stored` key of the C4i maps is in the strip set", () => {
  const expected: string[] = [];
  for (const { fields } of Object.values(MEMBER_RESTRICTION_BODY_ALLOWLISTS)) {
    for (const [key, kind] of Object.entries(fields)) if (kind === "refused") expected.push(key);
  }
  for (const { fields } of Object.values(MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS)) {
    for (const [key, kind] of Object.entries(fields as Record<string, string>)) {
      if (kind === "refused") expected.push(key);
      // A top-level `keep-stored` key is a kept object: its keys are walked below.
      if (kind === "keep-stored") expect(Object.keys(TASK_KEPT_OBJECTS), key).toContain(key);
    }
  }
  const walk = (map: object) => {
    for (const [key, kind] of Object.entries(map)) {
      if (kind === "refused" || kind === "keep-stored") expected.push(key);
      else if (kind && typeof kind === "object") walk(kind);
    }
  };
  walk(TASK_KEPT_OBJECTS);
  expect(expected.length).toBeGreaterThan(10);
  for (const key of expected) expect(MEMBER_RESTRICTION_STRIPPED_KEYS.has(key), key).toBe(true);
});

describe("execution workspace policy projection (PAR-14313)", () => {
  const policy = {
    enabled: true, allowIssueOverride: false, defaultMode: "isolated_workspace", environmentId: "env-1",
    storageProviderPluginId: "plugin-1", defaultProjectWorkspaceId: "pw-1", sharedWorkspaceConcurrency: "serial",
    workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/srv/o", provisionCommand: "make o" },
    workspaceRuntime: { services: [] }, branchPolicy: { prefix: "o/" }, pullRequestPolicy: { base: "main" },
    runtimePolicy: { x: 1 }, cleanupPolicy: { y: 1 }, authorizationPolicy: { trustPreset: "standard" },
  };
  const safe = { enabled: true, allowIssueOverride: false, defaultMode: "isolated_workspace" };

  it("keeps only enabled, allowIssueOverride and defaultMode, at any depth", () => {
    const body = { executionWorkspacePolicy: policy, workspaceProvider: { pluginId: "plugin-1", effectivePolicy: policy },
      issues: [{ project: { executionWorkspacePolicy: policy } }] };
    expect(hasHostKeys(body)).toBe(true);
    expect(withoutHostKeys(body)).toEqual({ executionWorkspacePolicy: safe, workspaceProvider: { pluginId: "plugin-1", effectivePolicy: safe },
      issues: [{ project: { executionWorkspacePolicy: safe } }] });
  });

  it("fails closed on a field of the wrong type and on a value that is not an object", () => {
    expect(withoutHostKeys({ executionWorkspacePolicy: { enabled: "yes", allowIssueOverride: 1, defaultMode: "/srv/o" } }))
      .toEqual({ executionWorkspacePolicy: {} });
    expect(withoutHostKeys({ executionWorkspacePolicy: null })).toEqual({ executionWorkspacePolicy: null });
    expect(withoutHostKeys({ executionWorkspacePolicy: "/srv/o", effectivePolicy: ["/srv/o"] })).toEqual({});
  });
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce" | "kill";
const ALLOWED_ADAPTER_KEYS = Object.keys(TASK_KEPT_OBJECTS.assigneeAdapterOverrides.adapterConfig);

/** A projected policy: null, or an object of the projection's fields only. */
const isProjected = (value: unknown) => value === null || (Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value as object).every((name) => MEMBER_RESTRICTION_POLICY_FIELDS.includes(name)));

/**
 * Every strip-set key found at any depth (a projected key only when it carries more than
 * the projection), `adapterConfig.<key>` for a key outside the four allows, and the
 * parent-bound keys of PAR-13327: `command`/`stopPolicy` of a `runtimeServices` entry, an execution workspace's
 * `metadata`, and a project workspace `metadata` key other than `githubRepositoryId`.
 */
function hostKeys(value: unknown, found = new Set<string>()): string[] {
  if (Array.isArray(value)) value.forEach((item) => hostKeys(item, found));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (MEMBER_RESTRICTION_PROJECTED_KEYS.has(key) ? !isProjected(inner) : MEMBER_RESTRICTION_STRIPPED_KEYS.has(key)) found.add(key);
      if (key === "adapterConfig" && inner && typeof inner === "object") {
        for (const name of Object.keys(inner)) if (!ALLOWED_ADAPTER_KEYS.includes(name)) found.add(`adapterConfig.${name}`);
      }
      for (const entry of (Array.isArray(inner) ? inner : [inner]) as Record<string, unknown>[]) {
        if (!entry || typeof entry !== "object") continue;
        if (key === "runtimeServices") for (const name of ["command", "stopPolicy"]) if (name in entry) found.add(`${key}[].${name}`);
        if (["executionWorkspace", "currentExecutionWorkspace"].includes(key) && "metadata" in entry) found.add(`${key}.metadata`);
        if (["workspaces", "primaryWorkspace"].includes(key) && entry.metadata && typeof entry.metadata === "object") {
          for (const name of Object.keys(entry.metadata)) if (name !== "githubRepositoryId") found.add(`${key}.metadata.${name}`);
        }
      }
      hostKeys(inner, found);
    }
  }
  return [...found].sort();
}
/** Routes whose whole body is one workspace object or a list of them: walked as if under that parent key. */
const BODY_PARENT: Record<string, string> = { "execution workspace": "executionWorkspace", "project workspaces": "workspaces" };
const bodyKeys = (route: string, body: unknown) => hostKeys(BODY_PARENT[route] ? { [BODY_PARENT[route]!]: body } : body);

(support.supported ? describe : describe.skip)("host and secret keys left out for a restricted member (PAR-12951)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const [O, R, U] = ["owner", "restricted", "member"].map((name) => `${name}-${randomUUID()}`);
  let Y = "", projectId = "", taskId = "", workspaceId = "", agentId = "";

  let unknownFields = false;
  afterEach(() => { unknownFields = false; });
  const board = async (userId: string): Promise<Actor> => {
    const memberships = (await loadActorMemberships(db, { userId, activeOnly: true }))
      .map(({ restricted: _flag, restrictionMode: _mode, ...row }) => (unknownFields ? row : { ...row, restricted: _flag, restrictionMode: _mode }));
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  const as = async (userId: string) => { actor = await board(userId); return request(app); };
  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode === "kill" ? "enforce" : mode });
    if (mode === "kill") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    else vi.unstubAllEnvs();
  };

  /** Each response named in the ticket, for one caller. Writes go to a project and a task of his own. */
  const responses = async (userId: string) => {
    const get = async (path: string) => (await as(userId)).get(path);
    const out: Record<string, request.Response> = {
      "project": await get(`/api/projects/${projectId}`),
      "project list": await get(`/api/companies/${Y}/projects`),
      "project list summary": await get(`/api/companies/${Y}/projects?view=summary`),
      "project workspaces": await get(`/api/projects/${projectId}/workspaces`),
      "task": await get(`/api/issues/${taskId}`),
      "task list": await get(`/api/companies/${Y}/issues`),
      "execution workspace": await get(`/api/execution-workspaces/${workspaceId}`),
      "agent": await get(`/api/agents/${agentId}`),
    };
    out["project create"] = await (await as(userId)).post(`/api/companies/${Y}/projects`).send({ name: `P ${randomUUID().slice(0, 8)}` });
    const ownProject = out["project create"].body?.id ?? projectId;
    await db.update(projects).set({ env: STORED_ENV, executionWorkspacePolicy: storedPolicy() } as Partial<typeof projects.$inferInsert>)
      .where(eq(projects.id, ownProject));
    out["project patch"] = await (await as(userId)).patch(`/api/projects/${ownProject}`).send({ description: "d" });
    out["task create"] = await (await as(userId)).post(`/api/companies/${Y}/issues`)
      .send({ title: `T ${randomUUID().slice(0, 8)}`, projectId });
    const ownTask = await task(userId);
    out["task patch"] = await (await as(userId)).patch(`/api/issues/${ownTask}`).send({ description: "d" });
    return out;
  };

  let envId = "";
  const COMMENT_METADATA = { version: 1, sections: [{ title: "Run", rows: [{ type: "code", code: "ls -la" }] }] };
  const STORED_ENV = { TOKEN: { type: "secret_ref", secretId: randomUUID() }, PLAIN: { type: "plain", value: "o" } };
  const storedPolicy = () => ({ enabled: true, allowIssueOverride: true, defaultMode: "isolated_workspace", environmentId: envId,
    branchPolicy: { prefix: "o/" }, cleanupPolicy: { removeAfterDays: 3 },
    workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/srv/o", provisionCommand: "make o", teardownCommand: "make clean" },
    authorizationPolicy: { trustPreset: "standard" } });
  /** A task the person is responsible for, with O's workspace settings and adapter overrides. */
  const task = async (userId: string) => (await db.insert(issues).values({
    companyId: Y, projectId, title: "Own task", status: "todo", createdByUserId: O, responsibleUserId: userId,
    executionWorkspaceId: workspaceId || null,
    executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: envId, networkEgress: { allowFqdns: ["o.example"] },
      workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/srv/o", provisionCommand: "make o" } },
    assigneeAdapterOverrides: { adapterConfig: { model: "o-model", env: { KEY: "v" }, chrome: true } },
    executionPolicy: { mode: "normal", commentRequired: true, stages: [], authorizationPolicy: { trustPreset: "standard" } },
  } as typeof issues.$inferInsert).returning())[0]!.id;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-response-strip-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", memberRestrictionRouteGuard(db));
    app.use("/api", projectRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    Y = (await db.insert(companies).values({ name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}` }).returning())[0]!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, U].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    agentId = (await db.insert(agents).values({ companyId: Y, name: "Agent of R", role: "engineer", adapterType: "process",
      status: "active", adapterConfig: { model: "m", command: "/usr/bin/o", cwd: "/srv/o", env: { KEY: "v" } },
      runtimeConfig: { heartbeat: { enabled: false } } }).returning())[0]!.id;
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true,
        restrictedAgentIds: [agentId] },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
    ]);
    envId = (await db.insert(environments).values({ name: "O's box", driver: "ssh", status: "active",
      config: { host: "o.example", username: "o" } }).returning())[0]!.id;
    projectId = (await db.insert(projects).values({ companyId: Y, name: "O's project", status: "backlog", privacyOwnerUserId: O,
      env: STORED_ENV, executionWorkspacePolicy: storedPolicy() } as typeof projects.$inferInsert).returning())[0]!.id;
    await db.insert(projectAccessMembers).values([R, U].map((subjectId) => ({ companyId: Y, projectId, subjectType: "user", subjectId })));
    const projectWorkspaceId = (await db.insert(projectWorkspaces).values({ companyId: Y, projectId, name: "main", isPrimary: true,
      cwd: "/srv/o/repo", repoUrl: "https://example.test/o.git", setupCommand: "make setup", cleanupCommand: "make clean",
      runtimeConfig: { workspaceRuntime: { services: [] } }, metadata: { githubRepositoryId: "gh-1", hostNote: "/srv/o/notes" },
    } as typeof projectWorkspaces.$inferInsert).returning())[0]!.id;
    const firstTask = await task(R);
    workspaceId = (await db.insert(executionWorkspaces).values({ companyId: Y, projectId, projectWorkspaceId, sourceIssueId: firstTask,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "R's work", cwd: "/srv/o/wt/r", repoUrl: "https://example.test/o.git",
      providerRef: "/srv/o/wt/r", metadata: { remoteWorkspace: { locations: ["s3://o/r"], snapshotId: "snap-1" } },
      config: { provisionCommand: "make o", teardownCommand: "make clean", cleanupCommand: null, workspaceRuntime: null, desiredState: null },
    } as typeof executionWorkspaces.$inferInsert).returning())[0]!.id;
    const service = { companyId: Y, projectId, status: "running", lifecycle: "shared", command: "pnpm dev --host 0.0.0.0",
      cwd: "/srv/o/repo", provider: "local_process", providerRef: "pid:4242", stopPolicy: { type: "idle", idleSeconds: 60 },
      healthStatus: "healthy" };
    await db.insert(workspaceRuntimeServices).values([
      { ...service, id: randomUUID(), projectWorkspaceId, scopeType: "project_workspace", scopeId: projectWorkspaceId,
        serviceName: "web", port: 3100, url: "http://127.0.0.1:3100" },
      { ...service, id: randomUUID(), projectWorkspaceId, executionWorkspaceId: workspaceId, issueId: firstTask,
        scopeType: "execution_workspace", scopeId: workspaceId, serviceName: "api", port: 3200, url: "http://127.0.0.1:3200" },
    ]);
    await db.insert(issueComments).values({ companyId: Y, issueId: firstTask, authorUserId: O, body: "note",
      metadata: COMMENT_METADATA } as typeof issueComments.$inferInsert);
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, firstTask));
    taskId = firstTask;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  /** Routes whose fixture puts strip-set keys in O's answer; the others prove only that R gets none. */
  const CARRY_KEYS = ["project", "project list", "project workspaces", "task", "task list", "execution workspace", "agent",
    "project create", "project patch", "task patch"];

  it("AC-F2, AC-G12, AC-F8: R under `enforce` gets no strip-set key in any response; O, U, R elsewhere get them", async () => {
    const base: Record<string, string[]> = {};
    for (const mode of ["off", "report", "enforce", "kill"] as Mode[]) {
      await setMode(mode);
      for (const [name, who] of [["O", O], ["U", U], ["R", R]] as const) {
        for (const [route, res] of Object.entries(await responses(who))) {
          const cell = `${name} ${mode} ${route}`;
          expect(res.status, `${cell}: ${JSON.stringify(res.body).slice(0, 300)}`).toBeLessThan(300);
          if (mode === "off" && name === "O") {
            base[route] = bodyKeys(route, res.body);
            if (CARRY_KEYS.includes(route)) expect(base[route]!.length, cell).toBeGreaterThan(0);
          }
          expect(bodyKeys(route, res.body), cell).toEqual(mode === "enforce" && name === "R" ? [] : base[route]);
        }
      }
    }
    // The ids R needs are still there.
    await setMode("enforce");
    const task = await (await as(R)).get(`/api/issues/${taskId}`);
    expect(task.body).toMatchObject({ id: taskId, projectId, executionWorkspaceId: workspaceId,
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
      assigneeAdapterOverrides: { adapterConfig: { model: "o-model" } } });
    // PAR-14313: the mode pickers still learn that the project allows a mode, and nothing else of its policy.
    const safePolicy = { enabled: true, allowIssueOverride: true, defaultMode: "isolated_workspace" };
    const project = await (await as(R)).get(`/api/projects/${projectId}`);
    expect(project.body.executionWorkspacePolicy).toEqual(safePolicy);
    expect(project.body.workspaceProvider.effectivePolicy).toEqual(safePolicy);
    const list = await (await as(R)).get(`/api/companies/${Y}/projects`);
    expect(list.body.find((row: { id: string }) => row.id === projectId).executionWorkspacePolicy).toEqual(safePolicy);
  }, 300_000);

  it("PAR-13327: R under `enforce` keeps the runtime service and workspace fields he needs, and comment `metadata`", async () => {
    await setMode("enforce");
    const SERVICE_FIELDS = ["serviceName", "status", "port", "url", "healthStatus"];
    const execution = (await (await as(R)).get(`/api/execution-workspaces/${workspaceId}`)).body;
    expect(execution).toMatchObject({ id: workspaceId, name: "R's work" });
    expect(Object.keys(execution)).not.toContain("metadata");
    expect(JSON.stringify(execution)).not.toMatch(/providerRef|pnpm dev|snap-1/);
    expect(execution.runtimeServices).toEqual([expect.objectContaining({ serviceName: "api", status: "running", port: 3200,
      url: "http://127.0.0.1:3200", healthStatus: expect.any(String) })]);
    const listed = (await (await as(R)).get(`/api/projects/${projectId}/workspaces`)).body;
    const project = (await (await as(R)).get(`/api/projects/${projectId}`)).body;
    for (const [where, workspace] of [["list", listed[0]], ["project", project.workspaces[0]], ["primary", project.primaryWorkspace]]) {
      expect(workspace.metadata, where).toEqual({ githubRepositoryId: "gh-1" });
      expect(JSON.stringify(workspace), where).not.toMatch(/providerRef|pnpm dev|"idle"/);
      for (const name of SERVICE_FIELDS) expect(workspace.runtimeServices[0], `${where} ${name}`).toHaveProperty(name);
    }
    // A `metadata` key outside the bound parents still reaches him.
    const comments = (await (await as(R)).get(`/api/issues/${taskId}/comments`)).body;
    expect(comments).toEqual([expect.objectContaining({ body: "note", metadata: COMMENT_METADATA })]);
  }, 120_000);

  it("AC-X1: when the resolver throws, R gets 503 MEMBER_RESTRICTION_UNAVAILABLE and no data", async () => {
    await setMode("enforce");
    resolverFails.on = true;
    // Carried fields answer without a read; without them the middleware asks the resolver.
    unknownFields = true;
    for (const [route, res] of Object.entries(await responses(R))) {
      expect(res.status, route).toBe(503);
      expect(res.body?.code ?? res.body?.details?.code, route).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(hostKeys(res.body), route).toEqual([]);
      expect(JSON.stringify(res.body), route).not.toContain(projectId);
    }
  }, 120_000);

  describe("live socket", () => {
    type Message = { type: string; payload: Record<string, unknown> };
    const workspaceFrame = () => ({ id: workspaceId, metadata: { remoteWorkspace: { snapshotId: "snap-1" } },
      runtimeServices: [{ serviceName: "api", status: "running", port: 3200, command: "pnpm dev", stopPolicy: { type: "idle" } }] });
    // A tool call of his own run: `command` and `metadata` outside the bound parents.
    const toolCall = { name: "shell", command: "ls -la", metadata: { step: 1 } };
    const goalFrame = (issue: Record<string, unknown>) => ({ issueId: taskId, issue: { id: taskId, toolCall, ...issue } });
    async function received(user: string, payload: Record<string, unknown> = goalFrame({
      executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: envId },
      assigneeAdapterOverrides: { adapterConfig: { model: "m", env: { KEY: "v" } } },
      project: { id: projectId, env: STORED_ENV, codebase: { localFolder: "/srv/o" } },
      currentExecutionWorkspace: workspaceFrame(),
    })): Promise<Message[]> {
      const server = createServer();
      const wss = setupLiveEventsWebSocketServer(server, db, {
        deploymentMode: "authenticated",
        resolveCloudActor: async () => ({ userId: user, companyIds: [Y] }),
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${Y}/events/ws`);
      const messages: Message[] = [];
      socket.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
      const warn = vi.spyOn(logger, "warn");
      try {
        await once(socket, "open");
        publishLiveEvent({ companyId: Y, type: "agent.session.goal.changed", payload });
        if (resolverFails.on) {
          await expect.poll(() => warn.mock.calls.filter((call) => call[1] === "live event authorization failed").length).toBe(1);
        } else {
          await expect.poll(() => messages.length).toBe(1);
        }
        return messages;
      } finally {
        warn.mockRestore();
        socket.terminate();
        wss.close();
        server.close();
      }
    }
    const SOCKET_KEYS = ["adapterConfig.env", "currentExecutionWorkspace.metadata", "env", "environmentId", "localFolder",
      "runtimeServices[].command", "runtimeServices[].stopPolicy"];

    it("R under `enforce` gets the task event without a strip-set key; O gets them", async () => {
      await setMode("enforce");
      const [toR] = await received(R);
      expect(toR!.payload).toMatchObject({ issueId: taskId, issue: { id: taskId, project: { id: projectId } } });
      expect(hostKeys(toR)).toEqual([]);
      expect(toR!.payload.issue).toMatchObject({ toolCall,
        currentExecutionWorkspace: { id: workspaceId, runtimeServices: [{ serviceName: "api", status: "running", port: 3200 }] } });
      expect(hostKeys(await received(O))).toEqual(SOCKET_KEYS);
    });

    it("PAR-13327: a bound frame without a strip key adds no restriction read; one with a runtime command adds one", async () => {
      await setMode("enforce");
      const reads = async (payload: Record<string, unknown>) => {
        resolverFails.reads = 0;
        const [toR] = await received(R, payload);
        return { reads: resolverFails.reads, keys: hostKeys(toR) };
      };
      const plain = await reads(goalFrame({}));
      const clean = await reads(goalFrame({ currentExecutionWorkspace: { id: workspaceId, runtimeServices: [{ serviceName: "api" }] },
        workspaces: [{ id: "w", metadata: { githubRepositoryId: "gh-1" } }] }));
      const command = await reads(goalFrame({ currentExecutionWorkspace: { id: workspaceId,
        runtimeServices: [{ serviceName: "api", command: "pnpm dev" }] } }));
      expect(clean).toEqual(plain);
      expect(command).toEqual({ reads: plain.reads + 1, keys: [] });
    });

    it("AC-F8: with the kill switch `off`, and under `report`, R gets the frame unchanged", async () => {
      for (const mode of ["kill", "report"] as Mode[]) {
        await setMode(mode);
        expect(hostKeys(await received(R)), mode).toEqual(SOCKET_KEYS);
      }
    });

    it("AC-X1: when the resolver throws, R gets no frame", async () => {
      await setMode("enforce");
      resolverFails.on = true;
      expect(await received(R)).toEqual([]);
    });
  });
});
