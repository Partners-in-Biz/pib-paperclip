import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import express, { Router, type RequestHandler } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, environments, executionWorkspaces, issues, plugins,
  projectAccessMembers, projects, projectWorkspaces,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { actorMiddleware } from "../middleware/auth.js";
import { accessRoutes } from "../routes/access.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { costRoutes } from "../routes/costs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueRoutes } from "../routes/issues.js";
import { pluginRoutes } from "../routes/plugins.js";
import { projectRoutes } from "../routes/projects.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12744 (C-sweep-2), AC-F2: with the company on `off` and the member
 * flagged (with both lists set), a recorded set of representative calls as that
 * member returns the same status and body as `development` before stage C.
 * Also one parity cell per strip route of C4i-c (PAR-12951) and per closed
 * tree-control read of C4i-a (PAR-12934): R at `off` gets today's body.
 *
 * BASE was recorded on 8d8cb119a, the commit before the first C change
 * (b787463f6, PAR-12672), with `PAR12744_RECORD=1`. This file runs unchanged
 * there: it imports no stage C module statically, sets the flag only when the
 * column exists, and mounts the route-table middleware only when it exists.
 * Real session loader, real routes, real database.
 */

const support = await getEmbeddedPostgresTestSupport();
const BASE_FILE = new URL("./fixtures/member-restriction-parity-base.json", import.meta.url);
const RECORD = process.env.PAR12744_RECORD === "1";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  const execute = async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "parity" });
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});

describe("parity database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

/** Fixed ids, so the recorded bodies compare after the generated ones are masked. */
const ID = {
  Y: "00000000-0000-4000-8000-00000000a001", agent: "00000000-0000-4000-8000-00000000a002",
  project: "00000000-0000-4000-8000-00000000a003", oTask: "00000000-0000-4000-8000-00000000a004",
  rTask: "00000000-0000-4000-8000-00000000a005", workspace: "00000000-0000-4000-8000-00000000a006",
  projectWorkspace: "00000000-0000-4000-8000-00000000a007", env: "00000000-0000-4000-8000-00000000a008",
  plugin: "00000000-0000-4000-8000-00000000a009", secret: "00000000-0000-4000-8000-00000000a00a",
};
const [O, R] = ["parity-owner", "parity-restricted"];
const NAMES = new Map(Object.entries(ID).map(([name, id]) => [id, `<${name}>`]));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
/** The per-run test home in managed folders. */
const HOME = /[^"]*\/instances\/[^/"]+\//g;
/** Status and body, with generated ids, times and the test home masked. */
const answer = (res: request.Response) => ({
  status: res.status,
  body: JSON.parse(JSON.stringify(res.body ?? null).replace(UUID, (id) => NAMES.get(id.toLowerCase()) ?? "<uuid>")
    .replace(DATE, "<time>").replace(HOME, "<instance>/")),
});

(support.supported ? describe : describe.skip)("AC-F2: a flagged member under `off` gets development's answers (PAR-12744)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let user = R;
  const workerManager = { isRunning: () => true, call: async () => ({ status: 200, body: { ok: true } }) };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-parity-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true,
      createdAt: now, updatedAt: now })));
    await db.insert(companies).values({ id: ID.Y, name: "Parity", issuePrefix: "PTY" });
    await db.insert(companyMemberships).values([
      { companyId: ID.Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: ID.Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(agents).values({ id: ID.agent, companyId: ID.Y, name: "Agent", role: "engineer", adapterType: "process",
      status: "active", adapterConfig: { model: "m", command: "/usr/bin/o", env: { KEY: "v" } },
      runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(environments).values({ id: ID.env, name: "O's box", driver: "ssh", status: "active",
      config: { host: "o.example", username: "o" } });
    const env = { TOKEN: { type: "secret_ref", secretId: ID.secret }, PLAIN: { type: "plain", value: "o" } };
    await db.insert(projects).values({ id: ID.project, companyId: ID.Y, name: "O's project", status: "backlog", env,
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", environmentId: ID.env,
        workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/srv/o", provisionCommand: "make o" } },
    } as typeof projects.$inferInsert);
    await db.insert(projectAccessMembers).values({ companyId: ID.Y, projectId: ID.project, subjectType: "user", subjectId: R });
    await db.insert(projectWorkspaces).values({ id: ID.projectWorkspace, companyId: ID.Y, projectId: ID.project, name: "main",
      isPrimary: true, cwd: "/srv/o/repo", repoUrl: "https://example.test/o.git", setupCommand: "make setup",
    } as typeof projectWorkspaces.$inferInsert);
    const settings = { mode: "isolated_workspace", environmentId: ID.env, workspaceStrategy: { type: "git_worktree",
      worktreeParentDir: "/srv/o", provisionCommand: "make o" } };
    await db.insert(issues).values([
      { id: ID.oTask, companyId: ID.Y, projectId: ID.project, title: "O's open task", status: "todo", issueNumber: 1,
        identifier: "PTY-1", createdByUserId: O, executionWorkspaceSettings: settings },
      { id: ID.rTask, companyId: ID.Y, projectId: ID.project, title: "R's task", status: "todo", issueNumber: 2,
        identifier: "PTY-2", createdByUserId: O, assigneeUserId: R, executionWorkspaceSettings: settings,
        assigneeAdapterOverrides: { adapterConfig: { model: "o-model", env: { KEY: "v" } } } },
    ] as Array<typeof issues.$inferInsert>);
    await db.update(companies).set({ issueCounter: 2 } as Partial<typeof companies.$inferInsert>);
    await db.insert(executionWorkspaces).values({ id: ID.workspace, companyId: ID.Y, projectId: ID.project,
      projectWorkspaceId: ID.projectWorkspace, sourceIssueId: ID.rTask, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "R's work", cwd: "/srv/o/wt/r", config: { provisionCommand: "make o", teardownCommand: "make clean" },
    } as typeof executionWorkspaces.$inferInsert);
    await db.insert(plugins).values({ id: ID.plugin, pluginKey: "parity.plugin", packageName: "parity.plugin", version: "1.0.0",
      status: "ready", manifestJson: { id: "parity.plugin", apiVersion: 1, version: "1.0.0", displayName: "Parity",
        description: "parity", author: "Paperclip", categories: ["automation"], capabilities: [],
        entrypoints: { worker: "dist/worker.js" } } } as typeof plugins.$inferInsert);
    // The flag and both lists, where the columns exist (not on the commit before C).
    const [{ flagged } = { flagged: false }] = (await db.execute(sql`select exists (select 1 from information_schema.columns
      where table_name = 'company_memberships' and column_name = 'restricted') as flagged`)) as unknown as Array<{ flagged: boolean }>;
    if (flagged) {
      await db.execute(sql`update company_memberships set restricted = true,
        restricted_agent_ids = ${JSON.stringify([ID.agent])}::jsonb, restricted_plugin_keys = '["parity.plugin"]'::jsonb
        where principal_id = ${R}`);
    }
    expect(flagged).toBe(!RECORD);

    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => ({
      session: { id: `session-${user}`, userId: user }, user: { id: user, name: user, email: `${user}@example.test` } }) }));
    const api = Router();
    const guard = await import("../services/member-restriction/route-middleware.js").catch(() => null);
    expect(Boolean(guard)).toBe(!RECORD);
    if (guard) api.use(guard.memberRestrictionRouteGuard(db) as RequestHandler);
    api.use("/companies", companyRoutes(db, {} as never));
    api.use(issueRoutes(db, {} as never));
    api.use(issueTreeControlRoutes(db, {}));
    api.use(projectRoutes(db));
    api.use(executionWorkspaceRoutes(db));
    api.use(agentRoutes(db));
    api.use(activityRoutes(db));
    api.use(dashboardRoutes(db));
    api.use(costRoutes(db));
    api.use(sidebarBadgeRoutes(db));
    api.use(pluginRoutes(db, {} as never, { scheduler: {}, jobStore: {} } as never, { workerManager } as never,
      undefined, { workerManager } as never));
    api.use(accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1",
      allowedHostnames: [] }));
    app.use("/api", api);
    app.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  /** The calls, in order: reads first, then writes, the wake last. */
  const CALLS: Array<[string, (r: ReturnType<typeof request>) => request.Test]> = [
    ["task list", (r) => r.get(`/api/companies/${ID.Y}/issues`)],
    ["open task of somebody else", (r) => r.get(`/api/issues/${ID.oTask}`)],
    ["own task (strip: task)", (r) => r.get(`/api/issues/${ID.rTask}`)],
    ["task comments", (r) => r.get(`/api/issues/${ID.oTask}/comments`)],
    ["project (strip)", (r) => r.get(`/api/projects/${ID.project}`)],
    ["project list (strip)", (r) => r.get(`/api/companies/${ID.Y}/projects`)],
    ["project list summary (strip)", (r) => r.get(`/api/companies/${ID.Y}/projects?view=summary`)],
    ["project workspaces (strip)", (r) => r.get(`/api/projects/${ID.project}/workspaces`)],
    ["execution workspace (strip)", (r) => r.get(`/api/execution-workspaces/${ID.workspace}`)],
    ["agent list", (r) => r.get(`/api/companies/${ID.Y}/agents`)],
    ["agent (strip)", (r) => r.get(`/api/agents/${ID.agent}`)],
    ["dashboard", (r) => r.get(`/api/companies/${ID.Y}/dashboard`)],
    ["costs", (r) => r.get(`/api/companies/${ID.Y}/costs/summary`)],
    ["company activity", (r) => r.get(`/api/companies/${ID.Y}/activity`)],
    ["sidebar badges", (r) => r.get(`/api/companies/${ID.Y}/sidebar-badges`)],
    ["company record", (r) => r.get(`/api/companies/${ID.Y}`)],
    ["tree holds (closed C4i-a)", (r) => r.get(`/api/issues/${ID.rTask}/tree-holds`)],
    ["tree-control preview (closed C4i-a)", (r) => r.post(`/api/issues/${ID.rTask}/tree-control/preview`).send({ mode: "pause" })],
    ["project create (strip)", (r) => r.post(`/api/companies/${ID.Y}/projects`).send({ name: "R's project" })],
    ["project patch (strip)", (r) => r.patch(`/api/projects/${ID.project}`).send({ description: "d" })],
    ["task create (strip)", (r) => r.post(`/api/companies/${ID.Y}/issues`).send({ title: "R's new task", projectId: ID.project })],
    ["task patch (strip)", (r) => r.patch(`/api/issues/${ID.rTask}`).send({ description: "d" })],
    ["comment on somebody else's task", (r) => r.post(`/api/issues/${ID.oTask}/comments`).send({ body: "c" })],
    ["invite", (r) => r.post(`/api/companies/${ID.Y}/invites`).send({ allowedJoinTypes: "human", humanRole: "operator" })],
    ["plugin action", (r) => r.post(`/api/plugins/${ID.plugin}/actions/k`).send({ companyId: ID.Y })],
    ["wake", (r) => r.post(`/api/agents/${ID.agent}/wakeup`).send({ reason: "parity" })],
  ];

  it("each call as the flagged member returns development's status and body", async () => {
    const base = RECORD ? {} : JSON.parse(readFileSync(BASE_FILE, "utf8")) as Record<string, ReturnType<typeof answer>>;
    const recorded: Record<string, ReturnType<typeof answer>> = {};
    user = R;
    for (const [name, call] of CALLS) recorded[name] = answer(await call(request(app)));
    // Let the woken run settle before the database closes; the answers are already taken.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    if (RECORD) writeFileSync(BASE_FILE, `${JSON.stringify(recorded, null, 1)}\n`);
    else expect(recorded).toEqual(base);
  }, 120_000);
});
