import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, issueComments, issueTreeHolds, issues,
  projectAccessMembers, projectWorkspaces, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { projectRoutes } from "../routes/projects.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  createRouteClassifier,
} from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12731 (C4b-1b): the comment, project and task-tree rows of the route
 * table. Spec PAR-12608 rev 3, 4.6. AC-G3: for every `open` row, R (restricted
 * in Y) asks for O's object through that route and gets "not found" or a list
 * without it; a control call with the kill switch on reaches the object, so
 * the answer is the restriction. Scope callers (section 8): R as owner of X,
 * and an instance admin who is not a member of Y, get today's answer. AC-G1
 * for the closed rows is the classifier's answer; the 403 body is the
 * middleware's (AC-G2). This area has no `run` and no `by-company` rows.
 */

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-comments-projects.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("comment, project and task-tree route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ids = {
  companyId: string; agentId: string; issueId: string; commentId: string; holdId: string;
  projectId: string; workspaceId: string; memberId: string;
};

/** One request per row. `hidden` says R did not get O's object. */
type Case = {
  row: string;
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
  hidden: (res: Res, ids: Ids) => boolean;
};

const notFound = (res: Res) => res.status === 404;
const listedIds = (res: Res) => (Array.isArray(res.body) ? res.body : (res.body?.projects ?? []))
  .map((row: { id: string }) => row.id);

const CASES: Case[] = [
  // Comments (routes/issues.ts).
  { row: "GET /api/issues/:id/recent-comments", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/recent-comments`), hidden: notFound },
  { row: "GET /api/issues/:id/comments", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/comments`), hidden: notFound },
  { row: "POST /api/issues/:id/comments",
    send: (c, { issueId }) => c.post(`/api/issues/${issueId}/comments`).send({ body: "Hello" }), hidden: notFound },
  { row: "GET /api/issues/:id/comments/:commentId",
    send: (c, { issueId, commentId }) => c.get(`/api/issues/${issueId}/comments/${commentId}`), hidden: notFound },
  { row: "DELETE /api/issues/:id/comments/:commentId",
    send: (c, { issueId, commentId }) => c.delete(`/api/issues/${issueId}/comments/${commentId}`), hidden: notFound },
  { row: "GET /api/issues/:id/queued-comments", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/queued-comments`), hidden: notFound },
  // Projects (routes/projects.ts).
  { row: "GET /api/companies/:companyId/projects", send: (c, { companyId }) => c.get(`/api/companies/${companyId}/projects`),
    hidden: (res, { projectId }) => res.status === 200 && !listedIds(res).includes(projectId) },
  { row: "GET /api/projects/:id", send: (c, { projectId }) => c.get(`/api/projects/${projectId}`), hidden: notFound },
  { row: "GET /api/projects/:id/external-object-summary",
    send: (c, { projectId }) => c.get(`/api/projects/${projectId}/external-object-summary`), hidden: notFound },
  { row: "GET /api/projects/:id/access-members",
    send: (c, { projectId }) => c.get(`/api/projects/${projectId}/access-members`), hidden: notFound },
  { row: "POST /api/projects/:id/access-members",
    send: (c, { projectId, agentId }) => c.post(`/api/projects/${projectId}/access-members`).send({ subjectType: "agent", subjectId: agentId }),
    hidden: notFound },
  { row: "DELETE /api/projects/:id/access-members/:memberId",
    send: (c, { projectId, memberId }) => c.delete(`/api/projects/${projectId}/access-members/${memberId}`), hidden: notFound },
  { row: "GET /api/projects/:id/workspaces", send: (c, { projectId }) => c.get(`/api/projects/${projectId}/workspaces`), hidden: notFound },
  // Task tree (routes/issue-tree-control.ts).
  { row: "GET /api/issues/:id/tree-control/state",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/tree-control/state`), hidden: notFound },
];

/** The closed rows this ticket wrote (AC-G1). */
const CLOSED_ROWS = [
  "PATCH /api/issues/:id/queued-comments/:commentId",
  "PUT /api/issues/:id/queued-comments/order",
  "POST /api/issues/:id/queued-comments/interrupt",
  "POST /api/issues/:id/queued-comments/:commentId/steer",
  "DELETE /api/issues/:id/queued-comments/:commentId",
  // Project create and patch are open since PAR-12934 (their test:
  // member-restriction-project-body-allowlist.test.ts). Workspaces stay or
  // become closed there: host `cwd`, commands and repositories.
  "POST /api/projects/:id/workspaces",
  "PATCH /api/projects/:id/workspaces/:workspaceId",
  "DELETE /api/projects/:id/workspaces/:workspaceId",
  "GET /api/companies/:companyId/project-repositories",
  "GET /api/projects/:id/git-authorization",
  "PUT /api/projects/:id/git-authorization",
  "PUT /api/projects/:id/repositories",
  "POST /api/projects/:id/workspaces/:workspaceId/runtime-services/:action",
  "POST /api/projects/:id/workspaces/:workspaceId/runtime-commands/:action",
  "DELETE /api/projects/:id",
  "POST /api/issues/:id/tree-holds",
  "POST /api/issues/:id/tree-holds/:holdId/release",
  // PAR-12934: closed (active runs and agents under the root, PAR-12938).
  "POST /api/issues/:id/tree-control/preview",
  "GET /api/issues/:id/tree-holds",
  "GET /api/issues/:id/tree-holds/:holdId",
];

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE
    .filter((entry) => entry.test === THIS_FILE)
    .map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

it("AC-G1: the closed comment, project and task-tree rows classify as closed for their real paths", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe("closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry!.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("comment, project and task-tree rows of the route table (PAR-12608 4.6, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  let agentY = "";
  let agentX = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  /** Fresh objects per request, so a write that goes through cannot change the next case. */
  const ids = async (companyId: string, agentId: string, owner: string): Promise<Ids> => {
    const [task] = await db.insert(issues).values({
      companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo", createdByUserId: owner, responsibleUserId: owner,
    }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: task!.id, authorUserId: owner, body: "From the owner" }).returning();
    const [hold] = await db.insert(issueTreeHolds).values({
      companyId, rootIssueId: task!.id, mode: "pause", createdByActorType: "user", createdByUserId: owner,
    }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: `Project ${randomUUID().slice(0, 8)}`, privacyOwnerUserId: owner }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({
      companyId, projectId: project!.id, name: "Main", cwd: `/tmp/restriction-${randomUUID().slice(0, 8)}`,
    }).returning();
    const [member] = await db.insert(projectAccessMembers).values({
      companyId, projectId: project!.id, subjectType: "agent", subjectId: agentId,
    }).returning();
    return {
      companyId, agentId, issueId: task!.id, commentId: comment!.id, holdId: hold!.id,
      projectId: project!.id, workspaceId: workspace!.id, memberId: member!.id,
    };
  };
  /** The same request with the kill switch on: today's answer. */
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-comments-projects-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", projectRoutes(db));
    app.use("/api", issueTreeControlRoutes(db));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
    const [a, b] = await db.insert(agents).values([
      { companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "active" },
      { companyId: X, name: "Agent X", role: "engineer", adapterType: "process", status: "active" },
    ]).returning();
    agentY = a!.id;
    agentX = b!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3: R (restricted in Y) asking for O's object gets \"not found\" or a list without it", async () => {
      const send = async () => {
        const target = await ids(Y, agentY, O);
        return { ids: target, res: await entry.send(as(await boardFor(R)), target) };
      };
      const enforced = await send();
      expect(entry.hidden(enforced.res, enforced.ids), JSON.stringify(enforced.res.body)).toBe(true);
      // Control: with the kill switch on the same call reaches O's object, so
      // the answer above is the restriction and not a broken request.
      const open = await today(send);
      expect(entry.hidden(open.res, open.ids), JSON.stringify(open.res.body)).toBe(false);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      // Set-up first, then the caller sets the actor.
      const callAs = async (who: () => Promise<Actor>, target: Promise<Ids>) => {
        const ready = await target;
        return entry.send(as(await who()), ready);
      };
      const ownX = () => callAs(() => boardFor(R), ids(X, agentX, R));
      const ownXNow = await ownX();
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBe((await today(ownX)).status);
      expect(ownXNow.status).not.toBe(404);

      const admin = () => callAs(() => boardFor(ADMIN, true), ids(Y, agentY, O));
      const adminNow = await admin();
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe((await today(admin)).status);
    });
  });
});
