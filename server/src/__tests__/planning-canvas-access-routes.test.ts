import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  planningCanvasAgentGrants,
  planningCanvases,
  planningCanvasItems,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import type { PlanningCanvasAccessLevel } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { planningCanvasSharingRoutes } from "../routes/planning-canvas-sharing.js";
import { planningCanvasCommentRoutes } from "../routes/planning-canvas-comments.js";
import { planningCanvasBlueprintRoutes } from "../routes/planning-canvas-blueprints.js";
import { planningCanvasLinkRoutes } from "../routes/planning-canvas-links.js";
import { authorizationService } from "../services/authorization.js";
import { planningCanvasService } from "../services/planning-canvases.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE } from "../services/member-restriction/route-table.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import {
  PLANNING_CANVAS_AGENT_GRANTS_ENV,
  planningCanvasAccess,
  planningCanvasAgentGrantsOn,
  writePlanningCanvasAgentGrant,
} from "../services/planning-canvas-access.js";
import {
  PLANNING_CANVAS_KNOWN_READERS,
  sweepPlanningCanvasReaders,
  sweepPlanningCanvasRoutes,
} from "../../../scripts/planning-canvas-route-sweep.mjs";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13932 (Planning Canvas C3): the section D access matrix of plan
 * PAR-13925, on the real routes through the real `actorMiddleware` and the
 * member-restriction route guard, for session users, agent_jwt runs and
 * agent_key keys; agent grants behind `PLANNING_CANVAS_AGENT_GRANTS`; byte-equal
 * denials for every canvas route; sharing per Q15 and Q16; 503 on a failed
 * restriction read. Routes (member-restriction table rows, `open`):
 *   /api/companies/:companyId/planning-canvases
 *   /api/companies/:companyId/planning-canvases/:boardId
 *   /api/companies/:companyId/planning-canvases/:boardId/ops
 *   /api/companies/:companyId/planning-canvases/:boardId/archive
 *   /api/companies/:companyId/planning-canvases/:boardId/restore
 *   /api/companies/:companyId/planning-canvases/:boardId/sharing
 *   /api/companies/:companyId/planning-canvases/:boardId/agent-grants
 *   /api/companies/:companyId/planning-canvases/:boardId/agent-grants/:grantId
 *   /api/companies/:companyId/planning-canvases/:boardId/comments
 *   /api/companies/:companyId/planning-canvases/:boardId/comments/:commentId
 *   /api/companies/:companyId/planning-canvases/:boardId/comments/:commentId/resolve
 *   /api/companies/:companyId/planning-canvases/:boardId/refs
 *   /api/companies/:companyId/planning-canvases/:boardId/query
 *   /api/companies/:companyId/planning-canvases/:boardId/handoff
 *   /api/companies/:companyId/planning-canvases/from-blueprint
 */

const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => (resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId)),
  };
});

const support = await getEmbeddedPostgresTestSupport();

const JWT_SECRET = "planning-canvas-access-routes";
// Every test signs and verifies run tokens with this secret; `unstubAllEnvs` below removes it.
beforeEach(() => {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("planning canvas access database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

describe("planning canvas sweep (plan D)", () => {
  it("every canvas handler calls a guard, and every handler has a member-restriction row naming this file", () => {
    const rows = sweepPlanningCanvasRoutes();
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(row.guards.includes("planningCanvasForRequest") || row.guards.includes("planningCanvasCompany"), `${row.method} ${row.path}`).toBe(true);
      const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => item.method === row.method && item.path === row.path);
      expect(entry, `${row.method} ${row.path}`).toMatchObject({ class: "open", test: "server/src/__tests__/planning-canvas-access-routes.test.ts" });
    }
    expect(new Set(rows.map((row) => `${row.method} ${row.path}`))).toEqual(new Set(DENIAL_ROUTES.map((route) => `${route.method} ${route.path}`)));
  });

  it("no code outside the canvas modules, the schema and the migrations reads the canvas tables", () => {
    const readers = sweepPlanningCanvasReaders();
    expect(readers.unknown).toEqual([]);
    expect(readers.known).toEqual(expect.arrayContaining(["server/src/services/planning-canvas-access.ts", "server/src/routes/planning-canvases.ts"]));
    expect(PLANNING_CANVAS_KNOWN_READERS.length).toBeGreaterThan(0);
  });
});

type Ctx = { companyId: string; boardId: string; grantId: string };
type DenialRoute = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; url: (ctx: Ctx) => string; body?: unknown };
const base = (ctx: Ctx) => `/api/companies/${ctx.companyId}/planning-canvases`;
const board = (ctx: Ctx) => `${base(ctx)}/${ctx.boardId}`;
const P = "/api/companies/:companyId/planning-canvases";
const opBody = { ops: [{ op: "add", item: { itemType: "node", key: "n1", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "x", content: "" } }] };
/** Every canvas route. The sweep test proves this list equals the handlers. */
const DENIAL_ROUTES: DenialRoute[] = [
  { method: "GET", path: P, url: base },
  { method: "POST", path: P, url: base, body: { title: "Board" } },
  { method: "GET", path: `${P}/:boardId`, url: board },
  { method: "PATCH", path: `${P}/:boardId`, url: board, body: { title: "Renamed" } },
  { method: "DELETE", path: `${P}/:boardId`, url: board },
  { method: "POST", path: `${P}/:boardId/ops`, url: (ctx) => `${board(ctx)}/ops`, body: opBody },
  { method: "POST", path: `${P}/:boardId/archive`, url: (ctx) => `${board(ctx)}/archive` },
  { method: "POST", path: `${P}/:boardId/restore`, url: (ctx) => `${board(ctx)}/restore` },
  { method: "PATCH", path: `${P}/:boardId/sharing`, url: (ctx) => `${board(ctx)}/sharing`, body: { scope: "company", memberAccess: "edit" } },
  { method: "GET", path: `${P}/:boardId/agent-grants`, url: (ctx) => `${board(ctx)}/agent-grants` },
  { method: "DELETE", path: `${P}/:boardId/agent-grants/:grantId`, url: (ctx) => `${board(ctx)}/agent-grants/${ctx.grantId}` },
  // C6 (PAR-13935). `grantId` doubles as the second path id.
  { method: "GET", path: `${P}/:boardId/comments`, url: (ctx) => `${board(ctx)}/comments` },
  { method: "POST", path: `${P}/:boardId/comments`, url: (ctx) => `${board(ctx)}/comments`, body: { body: "Hi" } },
  { method: "PATCH", path: `${P}/:boardId/comments/:commentId`, url: (ctx) => `${board(ctx)}/comments/${ctx.grantId}`, body: { body: "Hi" } },
  { method: "DELETE", path: `${P}/:boardId/comments/:commentId`, url: (ctx) => `${board(ctx)}/comments/${ctx.grantId}` },
  { method: "POST", path: `${P}/:boardId/comments/:commentId/resolve`, url: (ctx) => `${board(ctx)}/comments/${ctx.grantId}/resolve`, body: { resolved: true } },
  // C8 (PAR-13937).
  { method: "GET", path: `${P}/:boardId/refs`, url: (ctx) => `${board(ctx)}/refs` },
  { method: "POST", path: `${P}/:boardId/query`, url: (ctx) => `${board(ctx)}/query`, body: { kind: "issues", filter: {}, limit: 10 } },
  { method: "POST", path: `${P}/:boardId/handoff`, url: (ctx) => `${board(ctx)}/handoff`, body: { keys: ["n1"], mode: "single", idempotencyKey: "k" } },
  // C14 (PAR-13941).
  { method: "POST", path: `${P}/from-blueprint`, url: (ctx) => `${base(ctx)}/from-blueprint`, body: { blueprintId: "retro", idempotencyKey: "k" } },
];

(support.supported ? describe : describe.skip)("planning canvas access through the real middleware (plan PAR-13925 D)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;

  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  const RESTRICTED = `restricted-${randomUUID()}`;
  const ADMIN = `admin-${randomUUID()}`;
  const IADMIN = `instance-admin-${randomUUID()}`;
  const OTHER = `other-${randomUUID()}`;
  let Y = "", X = "", agentY = "", agentX = "", projectP = "", projectQ = "";

  type Caller = { name: string; headers: () => Promise<Record<string, string>> };
  const session = (userId: string) => async () => ({ "x-test-session": userId, origin: "http://localhost" });
  const jwt = (agentId: () => string, companyId: () => string, person: string | null) => async () => ({
    authorization: `Bearer ${createLocalAgentJwt(agentId(), companyId(), "process", randomUUID(), person)}`,
  });
  const key = (person: string) => async () => {
    const token = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      companyId: Y, agentId: agentY, responsibleUserId: person, name: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    return { authorization: `Bearer ${token}` };
  };
  const boardKey = (userId: string) => async () => {
    const token = `pcp_${randomUUID()}`;
    await db.insert(boardApiKeys).values({ userId, name: "test", keyHash: createHash("sha256").update(token).digest("hex") });
    return { authorization: `Bearer ${token}` };
  };

  const C = {
    owner: { name: "session owner", headers: session(OWNER) },
    member: { name: "session member", headers: session(MEMBER) },
    viewer: { name: "session viewer", headers: session(VIEWER) },
    restricted: { name: "session restricted member", headers: session(RESTRICTED) },
    admin: { name: "session company admin", headers: session(ADMIN) },
    iadmin: { name: "session instance admin, not a member", headers: session(IADMIN) },
    other: { name: "session member of another company", headers: session(OTHER) },
    jwtNoPerson: { name: "agent_jwt run with no person", headers: jwt(() => agentY, () => Y, null) },
    jwtRestricted: { name: "agent_jwt run for the restricted member", headers: jwt(() => agentY, () => Y, RESTRICTED) },
    jwtOwner: { name: "agent_jwt run for the owner", headers: jwt(() => agentY, () => Y, OWNER) },
    keyMember: { name: "agent_key for the member", headers: key(MEMBER) },
    keyRestricted: { name: "agent_key for the restricted member", headers: key(RESTRICTED) },
    jwtOtherCompany: { name: "agent_jwt of another company", headers: jwt(() => agentX, () => X, null) },
  } satisfies Record<string, Caller>;

  async function send(caller: Caller, method: DenialRoute["method"], url: string, body?: unknown) {
    const req = request(app)[method.toLowerCase() as "get"](url).set(await caller.headers());
    return body === undefined ? req : req.send(body as object);
  }

  async function makeBoard(values: Partial<typeof planningCanvases.$inferInsert> & { companyId?: string }) {
    const [inserted] = await db
      .insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: `Board ${randomUUID().slice(0, 6)}`, ...values })
      .returning();
    // Mark the default blob as synced, so reads do not run the catch-up.
    const [row] = await db
      .update(planningCanvases)
      .set({ legacyDataMd5: sql`md5(${planningCanvases.data}::text)` })
      .where(eq(planningCanvases.id, inserted!.id))
      .returning();
    return row!;
  }

  async function makeIssue(status = "todo") {
    const [row] = await db
      .insert(issues)
      .values({ companyId: Y, title: `Task ${randomUUID().slice(0, 6)}`, status, createdByUserId: OWNER, responsibleUserId: OWNER })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-access-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId
          ? ({ session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never)
          : null;
      },
    }));
    const api = express.Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasSharingRoutes(db));
    api.use(planningCanvasCommentRoutes(db));
    api.use(planningCanvasLinkRoutes(db));
    api.use(planningCanvasBlueprintRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, VIEWER, RESTRICTED, ADMIN, IADMIN, OTHER].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(instanceUserRoles).values({ userId: IADMIN, role: "instance_admin" });
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
      { companyId: Y, principalType: "user", principalId: RESTRICTED, status: "active", membershipRole: "operator", restricted: true },
      { companyId: Y, principalType: "user", principalId: ADMIN, status: "active", membershipRole: "admin" },
      { companyId: X, principalType: "user", principalId: OTHER, status: "active", membershipRole: "owner" },
    ]);
    const [a, b] = await db.insert(agents).values([
      { companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "idle" },
      { companyId: X, name: "Agent X", role: "engineer", adapterType: "process", status: "idle" },
    ]).returning();
    agentY = a!.id;
    agentX = b!.id;
    // P: an open project the restricted member is listed on. Q: a private project of the owner.
    const [p, q] = await db.insert(projects).values([
      { companyId: Y, name: "Open project", privacyOwnerUserId: OWNER },
      { companyId: Y, name: "Private project", privacyOwnerUserId: OWNER, visibility: "private" },
    ]).returning();
    projectP = p!.id;
    projectQ = q!.id;
    await db.insert(projectAccessMembers).values([
      { companyId: Y, projectId: projectP, subjectType: "user", subjectId: RESTRICTED },
      { companyId: Y, projectId: projectQ, subjectType: "user", subjectId: OWNER },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  /** The level the caller has, read through the real GET; `none` must be the unknown-id answer, byte for byte. */
  async function levelOf(caller: Caller, row: { id: string; companyId: string }): Promise<PlanningCanvasAccessLevel> {
    const res = await send(caller, "GET", `/api/companies/${row.companyId}/planning-canvases/${row.id}`);
    if (res.status === 404) {
      const unknown = await send(caller, "GET", `/api/companies/${row.companyId}/planning-canvases/${randomUUID()}`);
      expect(res.text).toBe(unknown.text);
      expect(res.text).toBe(JSON.stringify({ error: "Planning canvas board not found" }));
      return "none";
    }
    expect(res.status, res.text).toBe(200);
    return res.body.access;
  }

  describe("section D matrix (grants switch off, the default)", () => {
    type Board = "personal" | "company" | "project" | "projectless" | "ownerless";
    const MATRIX: Record<keyof typeof C, Record<Board, PlanningCanvasAccessLevel>> = {
      owner:           { personal: "admin", company: "admin",   project: "admin", projectless: "admin", ownerless: "view" },
      member:          { personal: "none",  company: "comment", project: "edit",  projectless: "none",  ownerless: "view" },
      viewer:          { personal: "none",  company: "view",    project: "view",  projectless: "none",  ownerless: "view" },
      restricted:      { personal: "none",  company: "none",    project: "edit",  projectless: "none",  ownerless: "none" },
      admin:           { personal: "none",  company: "admin",   project: "admin", projectless: "admin", ownerless: "admin" },
      iadmin:          { personal: "none",  company: "none",    project: "none",  projectless: "none",  ownerless: "none" },
      other:           { personal: "none",  company: "none",    project: "none",  projectless: "none",  ownerless: "none" },
      jwtNoPerson:     { personal: "none",  company: "edit",    project: "edit",  projectless: "none",  ownerless: "edit" },
      jwtRestricted:   { personal: "none",  company: "none",    project: "edit",  projectless: "none",  ownerless: "none" },
      jwtOwner:        { personal: "none",  company: "edit",    project: "edit",  projectless: "none",  ownerless: "view" },
      keyMember:       { personal: "none",  company: "comment", project: "edit",  projectless: "none",  ownerless: "view" },
      keyRestricted:   { personal: "none",  company: "none",    project: "edit",  projectless: "none",  ownerless: "none" },
      jwtOtherCompany: { personal: "none",  company: "none",    project: "none",  projectless: "none",  ownerless: "none" },
    };
    const boards = {} as Record<Board, typeof planningCanvases.$inferSelect>;

    beforeAll(async () => {
      boards.personal = await makeBoard({});
      boards.company = await makeBoard({ scope: "company", memberAccess: "comment" });
      boards.project = await makeBoard({ scope: "project", projectId: projectP, memberAccess: "edit" });
      boards.projectless = await makeBoard({ scope: "project", projectId: null, memberAccess: "edit" });
      boards.ownerless = await makeBoard({ userId: null, scope: "company", memberAccess: "view", createdByAgentId: agentY });
    });

    describe.each(Object.keys(MATRIX) as Array<keyof typeof C>)("%s", (who) => {
      it.each(["personal", "company", "project", "projectless", "ownerless"] as Board[])("on a %s board", async (kind) => {
        const caller = C[who];
        expect(await levelOf(caller, boards[kind])).toBe(MATRIX[who][kind]);
        // The list shows exactly the boards the caller can open, with the same level.
        const list = await send(caller, "GET", `/api/companies/${boards[kind].companyId}/planning-canvases`);
        if (list.status === 404) {
          expect(MATRIX[who][kind]).toBe("none");
          return;
        }
        expect(list.status, list.text).toBe(200);
        const entry = (list.body as Array<{ id: string; access: string }>).find((item) => item.id === boards[kind].id);
        expect(entry?.access ?? "none").toBe(MATRIX[who][kind]);
      });
    });

    it("a private project board: the member who cannot read the project gets the unknown-id answer; the admin's level follows project:read", async () => {
      const row = await makeBoard({ scope: "project", projectId: projectQ, memberAccess: "edit" });
      expect(await levelOf(C.member, row)).toBe("none");
      expect(await levelOf(C.owner, row)).toBe("admin");
      const adminReads = (await authorizationService(db).decide({
        actor: { type: "board", userId: ADMIN, source: "session", companyIds: [Y],
          memberships: [{ companyId: Y, status: "active", membershipRole: "admin", restricted: false, restrictionMode: "enforce" }] },
        action: "project:read", resource: { type: "project", companyId: Y, projectId: projectQ },
      })).allowed;
      expect(await levelOf(C.admin, row)).toBe(adminReads ? "admin" : "none");
    });

    it("the level gates actions: view cannot apply ops (403), edit cannot archive (403), an agent applies ops", async () => {
      const row = await makeBoard({ scope: "company", memberAccess: "edit" });
      const viewerOps = await send(C.viewer, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/ops`, opBody);
      expect(viewerOps.status).toBe(403);
      expect(viewerOps.body.details?.code ?? viewerOps.body.code).toBe("PLANNING_CANVAS_ACCESS_TOO_LOW");
      const memberArchive = await send(C.member, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/archive`);
      expect(memberArchive.status).toBe(403);
      const agentOps = await send(C.jwtNoPerson, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/ops`, opBody);
      expect(agentOps.status, agentOps.text).toBe(200);
      expect(agentOps.body.results).toEqual([expect.objectContaining({ status: "applied", key: "n1" })]);
      const [item] = await db.select().from(planningCanvasItems).where(eq(planningCanvasItems.boardId, row.id));
      expect(item?.updatedByAgentId).toBe(agentY);
      const md = await send(C.member, "GET", `/api/companies/${Y}/planning-canvases/${row.id}?format=markdown`);
      expect(md.status).toBe(200);
      expect(md.headers["content-type"]).toContain("text/markdown");
      expect(md.headers["x-planning-canvas-revision"]).toBe("1");
    });
  });

  describe("agent grants (Q6, Q14)", () => {
    async function grantedBoard(status = "todo") {
      const row = await makeBoard({});
      const issue = await makeIssue(status);
      const [grant] = await db.insert(planningCanvasAgentGrants).values({
        companyId: Y, boardId: row.id, agentId: agentY, issueId: issue.id, grantedByUserId: OWNER, source: "mention",
      }).returning();
      return { row, issue, grant: grant! };
    }

    it("switch off (default): a live grant opens nothing; switch on: edit for the agent, never the owner's admin", async () => {
      const { row } = await grantedBoard();
      expect(await levelOf(C.jwtNoPerson, row)).toBe("none");
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      expect(await levelOf(C.jwtNoPerson, row)).toBe("edit");
      expect(await levelOf(C.jwtOwner, row)).toBe("edit");
      expect(await levelOf(C.keyMember, row)).toBe("edit");
      // An agent run for a restricted member gets nothing, grant or not.
      expect(await levelOf(C.jwtRestricted, row)).toBe("none");
      expect(await levelOf(C.keyRestricted, row)).toBe("none");
      const list = await send(C.jwtNoPerson, "GET", `/api/companies/${Y}/planning-canvases?scope=personal`);
      expect(list.body.map((item: { id: string }) => item.id)).toContain(row.id);
    });

    it("an agent without a grant gets the unknown-id answer with the switch on", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      expect(await levelOf(C.jwtNoPerson, await makeBoard({}))).toBe("none");
    });

    it.each(["done", "cancelled"])("the grant lapses when its issue is %s", async (status) => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const { row, issue } = await grantedBoard();
      expect(await levelOf(C.jwtNoPerson, row)).toBe("edit");
      await db.update(issues).set({ status }).where(eq(issues.id, issue.id));
      expect(await levelOf(C.jwtNoPerson, row)).toBe("none");
    });

    it("reading the switch throws: no grant access, and the personal board answers the unknown-id 404", async () => {
      const { row } = await grantedBoard();
      const original = process.env;
      process.env = new Proxy({ ...original, [PLANNING_CANVAS_AGENT_GRANTS_ENV]: "on" }, {
        get(target, prop) {
          if (prop === PLANNING_CANVAS_AGENT_GRANTS_ENV) throw new Error("fixture: env unreadable");
          return Reflect.get(target, prop);
        },
      });
      try {
        expect(planningCanvasAgentGrantsOn()).toBe(false);
        expect(await levelOf(C.jwtNoPerson, row)).toBe("none");
      } finally {
        process.env = original;
      }
    });

    it("GET and DELETE agent-grants: owner lists and revokes; revoked grants open nothing; others get 404 or 403", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const { row, grant } = await grantedBoard();
      const url = `/api/companies/${Y}/planning-canvases/${row.id}/agent-grants`;
      const listed = await send(C.owner, "GET", url);
      expect(listed.status, listed.text).toBe(200);
      expect(listed.body).toEqual({ enabled: true, grants: [expect.objectContaining({ id: grant.id, agentId: agentY, active: true })] });
      // The company admin has no access to someone's personal board (privacy).
      expect((await send(C.admin, "GET", url)).status).toBe(404);
      const revoked = await send(C.owner, "DELETE", `${url}/${grant.id}`);
      expect(revoked.status, revoked.text).toBe(200);
      expect(revoked.body.revokedAt).toEqual(expect.any(String));
      expect(await levelOf(C.jwtNoPerson, row)).toBe("none");
      expect((await send(C.owner, "GET", url)).body.grants[0].active).toBe(false);
      expect((await send(C.owner, "DELETE", `${url}/${randomUUID()}`)).status).toBe(404);
      const [logged] = await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, row.id), eq(activityLog.action, "planning_canvas.agent_grant_revoked")));
      expect(logged).toBeTruthy();
    });

    it("no route accepts a grant in its body: sharing refuses unknown fields and writes no grant", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const row = await makeBoard({});
      const res = await send(C.owner, "PATCH", `/api/companies/${Y}/planning-canvases/${row.id}/sharing`,
        { scope: "personal", agentGrants: [{ agentId: agentY }] });
      expect(res.status).toBe(400);
      // Create ignores unknown fields: the board is made, no grant is.
      const create = await send(C.owner, "POST", `/api/companies/${Y}/planning-canvases`,
        { title: "B", agentId: agentY, agentGrants: [{ agentId: agentY }] });
      expect(create.status).toBe(201);
      for (const boardId of [row.id, create.body.id]) {
        expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, boardId))).toEqual([]);
      }
    });

    it("the grant writer writes only for the board owner as a session user, on a personal board, with the switch on", async () => {
      const row = await makeBoard({});
      const issue = await makeIssue();
      const write = (actor: Parameters<typeof writePlanningCanvasAgentGrant>[1]["actor"], target = row) =>
        writePlanningCanvasAgentGrant(db, { actor, board: target, agentId: agentY, issueId: issue.id, source: "mention" });
      const ownerSession = { type: "board" as const, source: "session" as const, userId: OWNER };
      expect(await write(ownerSession)).toBeNull(); // switch off
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      expect(await write({ type: "board", source: "board_key", userId: OWNER })).toBeNull();
      expect(await write({ type: "board", source: "session", userId: MEMBER })).toBeNull();
      expect(await write({ type: "agent", source: "agent_jwt", agentId: agentY, companyId: Y, onBehalfOfUserId: OWNER })).toBeNull();
      expect(await write(ownerSession, await makeBoard({ scope: "company", memberAccess: "edit" }))).toBeNull();
      const original = process.env;
      process.env = new Proxy({ ...original }, {
        get(target, prop) {
          if (prop === PLANNING_CANVAS_AGENT_GRANTS_ENV) throw new Error("fixture: env unreadable");
          return Reflect.get(target, prop);
        },
      });
      try {
        expect(await write(ownerSession)).toBeNull();
      } finally {
        process.env = original;
      }
      expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, row.id))).toEqual([]);
      const written = await write(ownerSession);
      expect(written).toMatchObject({ boardId: row.id, agentId: agentY, issueId: issue.id, grantedByUserId: OWNER, revokedAt: null });
      expect(await levelOf(C.jwtNoPerson, row)).toBe("edit");
    });
  });

  describe("denials are byte-equal to the unknown-id and cross-company answers, on every route", () => {
    describe.each(DENIAL_ROUTES)("$method $path", (route) => {
      it("unknown id, other company's board, and a board the caller cannot open answer the same bytes", async () => {
        const ownersBoard = await makeBoard({});
        const xBoard = await makeBoard({ companyId: X, userId: OTHER });
        const isCollection = !route.path.includes(":boardId");
        const answers: Array<{ label: string; res: request.Response }> = [];
        const at = async (label: string, caller: Caller, ctx: Ctx) =>
          answers.push({ label, res: await send(caller, route.method, route.url(ctx), route.body) });
        if (isCollection) {
          await at("unknown company", C.member, { companyId: randomUUID(), boardId: "", grantId: "" });
          await at("other company", C.member, { companyId: X, boardId: "", grantId: "" });
          await at("instance admin, not a member", C.iadmin, { companyId: Y, boardId: "", grantId: "" });
          await at("agent of another company", C.jwtOtherCompany, { companyId: Y, boardId: "", grantId: "" });
        } else {
          const grantId = randomUUID();
          await at("unknown id", C.member, { companyId: Y, boardId: randomUUID(), grantId });
          await at("malformed id", C.member, { companyId: Y, boardId: "not-a-uuid", grantId });
          await at("other company's board under its company", C.member, { companyId: X, boardId: xBoard.id, grantId });
          await at("other company's board under my company", C.member, { companyId: Y, boardId: xBoard.id, grantId });
          await at("denied: member on the owner's personal board", C.member, { companyId: Y, boardId: ownersBoard.id, grantId });
          await at("denied: company admin on the owner's personal board", C.admin, { companyId: Y, boardId: ownersBoard.id, grantId });
          await at("denied: agent without a grant", C.jwtNoPerson, { companyId: Y, boardId: ownersBoard.id, grantId });
          await at("denied: agent of another company", C.jwtOtherCompany, { companyId: Y, boardId: ownersBoard.id, grantId });
        }
        const first = answers[0]!.res;
        expect(first.status).toBe(404);
        expect(first.text).toBe(JSON.stringify({ error: "Planning canvas board not found" }));
        for (const { label, res } of answers) {
          expect({ label, status: res.status, body: res.text, type: res.headers["content-type"], cache: res.headers["cache-control"] })
            .toEqual({ label, status: first.status, body: first.text, type: first.headers["content-type"], cache: first.headers["cache-control"] });
        }
        // Nothing was written to the boards the callers could not open.
        const [after] = await db.select().from(planningCanvases).where(eq(planningCanvases.id, ownersBoard.id));
        expect(after).toMatchObject({ title: ownersBoard.title, scope: "personal", archivedAt: null, revision: ownersBoard.revision });
      });
    });
  });

  describe("restriction read failure (D, fails closed)", () => {
    it.each([
      ["the restricted member's session", "restricted"],
      ["an agent run for the restricted member", "jwtRestricted"],
    ] as const)("%s: ops on a project board answer 503 MEMBER_RESTRICTION_UNAVAILABLE and write nothing", async (_label, who) => {
      const row = await makeBoard({ scope: "project", projectId: projectP, memberAccess: "edit" });
      const caller = C[who];
      const headers = await caller.headers();
      resolverFails.on = true;
      const res = await request(app).post(`/api/companies/${Y}/planning-canvases/${row.id}/ops`).set(headers).send(opBody);
      expect(res.status, res.text).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      resolverFails.on = false;
      expect(await db.select().from(planningCanvasItems).where(eq(planningCanvasItems.boardId, row.id))).toEqual([]);
      const [after] = await db.select().from(planningCanvases).where(eq(planningCanvases.id, row.id));
      expect(after!.revision).toBe(row.revision);
    });

    it("the resolver itself fails closed: a membership without restriction fields reads, and a failed read throws 503 (never a level)", async () => {
      const row = await makeBoard({ scope: "company", memberAccess: "edit" });
      resolverFails.on = true;
      const handBuilt = {
        type: "board" as const, source: "session" as const, userId: MEMBER, companyIds: [Y],
        memberships: [{ companyId: Y, status: "active" as const, membershipRole: "operator" as const }],
      };
      await expect(planningCanvasAccess(db, handBuilt as never, row)).rejects.toMatchObject({ status: 503 });
      const agentForHim = {
        type: "agent" as const, source: "agent_key" as const, agentId: agentY, companyId: Y, onBehalfOfUserId: MEMBER,
        onBehalfOfMemberships: handBuilt.memberships,
      };
      await expect(planningCanvasAccess(db, agentForHim as never, row)).rejects.toMatchObject({ status: 503 });
      // A known "not restricted" membership needs no read, so the answer stands.
      const res = await send(C.member, "GET", `/api/companies/${Y}/planning-canvases/${row.id}`);
      expect(res.status).toBe(200);
    });
  });

  describe("sharing (Q15, Q16)", () => {
    const sharing = (row: { id: string }) => `/api/companies/${Y}/planning-canvases/${row.id}/sharing`;

    it("widening needs memberAccess, is owner only, and logs activity", async () => {
      const row = await makeBoard({});
      expect((await send(C.owner, "PATCH", sharing(row), { scope: "company" })).status).toBe(400);
      const widened = await send(C.owner, "PATCH", sharing(row), { scope: "company", memberAccess: "edit" });
      expect(widened.status, widened.text).toBe(200);
      expect(widened.body).toMatchObject({ scope: "company", memberAccess: "edit", projectId: null });
      expect(await levelOf(C.member, row)).toBe("edit");
      const [logged] = await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, row.id), eq(activityLog.action, "planning_canvas.sharing_updated")));
      expect(logged?.details).toMatchObject({ widened: true, after: { scope: "company", memberAccess: "edit" } });
    });

    it("a company admin narrows and archives but cannot widen someone's board; an editor cannot narrow", async () => {
      const row = await makeBoard({ scope: "company", memberAccess: "comment" });
      const raise = await send(C.admin, "PATCH", sharing(row), { scope: "company", memberAccess: "edit" });
      expect(raise.status).toBe(403);
      expect(raise.body.details?.code ?? raise.body.code).toBe("PLANNING_CANVAS_OWNER_ONLY");
      const toProject = await send(C.admin, "PATCH", sharing(row), { scope: "project", projectId: projectP, memberAccess: "view" });
      expect(toProject.status).toBe(403);
      expect((await send(C.member, "PATCH", sharing(row), { scope: "company", memberAccess: "view" })).status).toBe(403);
      expect((await send(C.jwtNoPerson, "PATCH", sharing(row), { scope: "company", memberAccess: "view" })).status).toBe(403);
      const lower = await send(C.admin, "PATCH", sharing(row), { scope: "company", memberAccess: "view" });
      expect(lower.status, lower.text).toBe(200);
      expect(await levelOf(C.member, row)).toBe("view");
      const personal = await send(C.admin, "PATCH", sharing(row), { scope: "personal" });
      expect(personal.status, personal.text).toBe(200);
      expect(await levelOf(C.member, row)).toBe("none");
      expect(await levelOf(C.admin, row)).toBe("none");
      expect(await levelOf(C.owner, row)).toBe("admin");
    });

    it("a sharing decision made on stale sharing does not land (409), so a concurrent change cannot turn a narrow into a widen", async () => {
      const row = await makeBoard({ scope: "company", memberAccess: "edit" });
      // The owner narrows to view after the admin's request read the board at edit.
      await db.update(planningCanvases).set({ memberAccess: "view" }).where(eq(planningCanvases.id, row.id));
      await expect(planningCanvasService(db).setSharing(row, { scope: "company", projectId: null, memberAccess: "comment" }))
        .rejects.toMatchObject({ status: 409 });
      const [after] = await db.select().from(planningCanvases).where(eq(planningCanvases.id, row.id));
      expect(after!.memberAccess).toBe("view");
    });

    it("an ownerless board is administered by company admins: they widen it; it cannot become personal", async () => {
      const row = await makeBoard({ userId: null, scope: "company", memberAccess: "view" });
      const raise = await send(C.admin, "PATCH", sharing(row), { scope: "company", memberAccess: "edit" });
      expect(raise.status, raise.text).toBe(200);
      expect((await send(C.admin, "PATCH", sharing(row), { scope: "personal" })).status).toBe(422);
      expect((await send(C.member, "PATCH", sharing(row), { scope: "company", memberAccess: "view" })).status).toBe(403);
    });

    it("a project board whose project was deleted: admins re-home it; an unknown or unreadable project is 422", async () => {
      const row = await makeBoard({ scope: "project", projectId: null, memberAccess: "edit" });
      expect((await send(C.admin, "PATCH", sharing(row), { scope: "project", projectId: randomUUID(), memberAccess: "edit" })).status).toBe(422);
      const rehome = await send(C.admin, "PATCH", sharing(row), { scope: "project", projectId: projectP, memberAccess: "edit" });
      expect(rehome.status, rehome.text).toBe(200);
      expect(await levelOf(C.member, row)).toBe("edit");
      const mine = await makeBoard({});
      const unreadable = await send(C.member, "PATCH", sharing(await makeBoard({ userId: MEMBER })), { scope: "project", projectId: projectQ, memberAccess: "edit" });
      expect(unreadable.status).toBe(422);
      expect(mine.scope).toBe("personal");
    });

    it("archive makes a board read-only and moves it to the archived list; restore brings it back; delete needs archive first", async () => {
      const row = await makeBoard({ scope: "company", memberAccess: "edit" });
      const del = await send(C.admin, "DELETE", `/api/companies/${Y}/planning-canvases/${row.id}`);
      expect(del.status).toBe(409);
      expect((await send(C.admin, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/archive`)).status).toBe(200);
      expect((await send(C.member, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/ops`, opBody)).status).toBe(409);
      const active = await send(C.member, "GET", `/api/companies/${Y}/planning-canvases`);
      expect(active.body.map((item: { id: string }) => item.id)).not.toContain(row.id);
      const archived = await send(C.member, "GET", `/api/companies/${Y}/planning-canvases?archived=true`);
      expect(archived.body.map((item: { id: string }) => item.id)).toContain(row.id);
      expect((await send(C.owner, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/restore`)).status).toBe(200);
      expect((await send(C.member, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/ops`, opBody)).status).toBe(200);
      await send(C.admin, "POST", `/api/companies/${Y}/planning-canvases/${row.id}/archive`);
      expect((await send(C.admin, "DELETE", `/api/companies/${Y}/planning-canvases/${row.id}`)).status).toBe(200);
      expect(await db.select().from(planningCanvases).where(eq(planningCanvases.id, row.id))).toEqual([]);
    });

    it("people create personal boards; a viewer and an agent cannot; the owner deletes his personal board directly", async () => {
      const created = await send(C.member, "POST", `/api/companies/${Y}/planning-canvases`, { title: "Mine" });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ userId: MEMBER, scope: "personal", access: "admin" });
      expect((await send(C.viewer, "POST", `/api/companies/${Y}/planning-canvases`, { title: "No" })).status).toBe(403);
      expect((await send(C.jwtNoPerson, "POST", `/api/companies/${Y}/planning-canvases`, { title: "No" })).status).toBe(403);
      const viaKey = await send({ name: "board key", headers: boardKey(MEMBER) }, "GET", `/api/companies/${Y}/planning-canvases/${created.body.id}`);
      expect(viaKey.status).toBe(200);
      expect((await send(C.member, "DELETE", `/api/companies/${Y}/planning-canvases/${created.body.id}`)).status).toBe(200);
    });

    it("list filters by scope and project", async () => {
      const row = await makeBoard({ scope: "project", projectId: projectP, memberAccess: "view" });
      const byProject = await send(C.member, "GET", `/api/companies/${Y}/planning-canvases?scope=project&projectId=${projectP}`);
      expect(byProject.status).toBe(200);
      const ids = byProject.body.map((item: { id: string; scope: string; projectId: string }) => {
        expect(item).toMatchObject({ scope: "project", projectId: projectP });
        return item.id;
      });
      expect(ids).toContain(row.id);
      expect((await send(C.member, "GET", `/api/companies/${Y}/planning-canvases?scope=nope`)).status).toBe(400);
    });
  });
});
