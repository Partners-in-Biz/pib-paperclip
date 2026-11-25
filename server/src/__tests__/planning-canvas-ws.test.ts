import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  planningCanvasAgentGrants,
  planningCanvases,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { planningCanvasSharingRoutes } from "../routes/planning-canvas-sharing.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import {
  createPlanningCanvasHub,
  PLANNING_CANVAS_WS_CLOSE_REVOKED,
  PLANNING_CANVAS_WS_DENIED,
  PLANNING_CANVAS_WS_MAX_MESSAGES_PER_SECOND,
  type PlanningCanvasHub,
} from "../realtime/planning-canvas-ws.js";
import { logActivity } from "../services/activity-log.js";
import { PLANNING_CANVAS_AGENT_GRANTS_ENV } from "../services/planning-canvas-access.js";
import { publishPlanningCanvasEvent } from "../services/planning-canvas-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13939 (Planning Canvas C11): the board WebSocket of plan PAR-13925
 * section E, on a real HTTP server through the real live-events upgrade
 * dispatch, `authorizeUpgrade`, `actorMiddleware` and canvas routes.
 * Route: /api/companies/:companyId/planning-canvases/:boardId/ws
 */

/** Makes the hub's membership read (the input of every access check) throw. */
const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/actor-memberships.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/actor-memberships.js")>();
  return {
    ...actual,
    loadActorMemberships: (...args: Parameters<typeof actual.loadActorMemberships>) =>
      resolverFails.on ? Promise.reject(new Error("fixture: memberships unreadable")) : actual.loadActorMemberships(...args),
  };
});

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

type Msg = Record<string, unknown> & { type: string };

class Client {
  messages: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as Msg);
      this.wake();
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  of(type: string) {
    return this.messages.filter((m) => m.type === type);
  }

  async until<T>(check: () => T | undefined | null | false, label: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = check();
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(this.messages.map((m) => m.type))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  next(type: string, after = 0) {
    return this.until(() => this.messages.slice(after).find((m) => m.type === type), type);
  }

  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(support.supported ? describe : describe.skip)("planning canvas realtime hub (plan PAR-13925 E)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let server: Server;
  let hub: PlanningCanvasHub;
  let port = 0;
  let clockOffset = 0;
  const open: Client[] = [];

  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const OTHER = `other-${randomUUID()}`;
  let Y = "", X = "", agentY = "", agentKey = "", orphanKey = "";

  const sessionHeaders = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });

  async function makeBoard(values: Partial<typeof planningCanvases.$inferInsert> = {}) {
    const [inserted] = await db
      .insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: `Board ${randomUUID().slice(0, 6)}`, ...values })
      .returning();
    const [row] = await db
      .update(planningCanvases)
      .set({ legacyDataMd5: sql`md5(${planningCanvases.data}::text)` })
      .where(eq(planningCanvases.id, inserted!.id))
      .returning();
    return row!;
  }

  const wsPath = (companyId: string, boardId: string) => `/api/companies/${companyId}/planning-canvases/${boardId}/ws`;

  async function join(companyId: string, boardId: string, headers: Record<string, string>) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath(companyId, boardId)}`, { headers });
    // Listen before `open`: the snapshot can arrive in the same chunk as the 101.
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    open.push(client);
    await client.next("presence.snapshot");
    return client;
  }

  /** The raw bytes the server writes for an upgrade, until it closes the socket. */
  function rawUpgrade(path: string, headers: Record<string, string>) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
      // An accepted upgrade stays open: answer with what arrived so far.
      setTimeout(() => socket.destroy(), 3000).unref();
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
  }

  const node = (key: string, content = "") => ({
    op: "add",
    item: { itemType: "node", key, kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: key, content },
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-ws-");
    db = createDb(tempDb.connectionString);
    const resolveSession = (userId: string | null) =>
      userId ? ({ session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never) : null;
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async (req) => resolveSession(req.header("x-test-session") ?? null) }));
    const api = express.Router();
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasSharingRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);
    server = createServer(app);
    hub = createPlanningCanvasHub(db, { now: () => Date.now() + clockOffset, tickMs: 3_600_000 });
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async (headers) => resolveSession(headers.get("x-test-session")),
      planningCanvasHub: hub,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, OTHER].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "operator" },
      { companyId: X, principalType: "user", principalId: OTHER, status: "active", membershipRole: "owner" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "idle" }).returning();
    agentY = agent!.id;
    agentKey = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      companyId: Y, agentId: agentY, responsibleUserId: OWNER, name: "ws test", keyHash: createHash("sha256").update(agentKey).digest("hex"),
    });
    // A key with no responsible user is refused on REST, so on the socket too.
    orphanKey = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      companyId: Y, agentId: agentY, name: "orphan", keyHash: createHash("sha256").update(orphanKey).digest("hex"),
    });
  }, 120_000);

  afterEach(async () => {
    clockOffset = 0;
    for (const client of open.splice(0)) client.close();
    await db?.update(companyMemberships).set({ status: "active", restricted: false })
      .where(and(eq(companyMemberships.companyId, Y), eq(companyMemberships.principalId, MEMBER)));
  });

  afterAll(async () => {
    hub?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("upgrade denial is byte-equal to an unknown board id", () => {
    it("unknown id, malformed id, cross-company, other company's caller, no caller and resolver `none` all write the same bytes", async () => {
      const personal = await makeBoard();
      const company = await makeBoard({ scope: "company", memberAccess: "edit" });
      const [xBoard] = await db.insert(planningCanvases).values({ companyId: X, userId: OTHER, title: "X board", scope: "company" }).returning();

      const answers = {
        unknown: await rawUpgrade(wsPath(Y, randomUUID()), sessionHeaders(MEMBER)),
        malformed: await rawUpgrade(wsPath(Y, "not-a-uuid"), sessionHeaders(MEMBER)),
        // Y's member names X's board under Y, and under X.
        crossCompanyUnderY: await rawUpgrade(wsPath(Y, xBoard!.id), sessionHeaders(MEMBER)),
        crossCompanyUnderX: await rawUpgrade(wsPath(X, xBoard!.id), sessionHeaders(MEMBER)),
        // X's owner asks for Y's company board.
        otherCompanyCaller: await rawUpgrade(wsPath(Y, company.id), sessionHeaders(OTHER)),
        noCaller: await rawUpgrade(wsPath(Y, company.id), {}),
        agentKeyWithoutPerson: await rawUpgrade(wsPath(Y, company.id), { authorization: `Bearer ${orphanKey}` }),
        // Resolver answers `none`: a member on the owner's personal board.
        denied: await rawUpgrade(wsPath(Y, personal.id), sessionHeaders(MEMBER)),
      };
      for (const [label, bytes] of Object.entries(answers)) {
        expect(bytes, label).toBe(PLANNING_CANVAS_WS_DENIED);
      }
      // The REST unknown-id body is the same text.
      const rest = await request(app).get(`/api/companies/${Y}/planning-canvases/${randomUUID()}`).set(sessionHeaders(MEMBER));
      expect(PLANNING_CANVAS_WS_DENIED.endsWith(`\r\n\r\n${rest.body.error}`)).toBe(true);
      // The owner gets in; the live-events socket path is untouched.
      const owner = await join(Y, personal.id, sessionHeaders(OWNER));
      expect(owner.of("presence.snapshot")[0]).toMatchObject({ level: "admin", peers: [] });
    });
  });

  describe("two clients", () => {
    it("presence fans out to the other socket of the same board only; ops.applied reaches both after REST and agent ops", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const elsewhere = await makeBoard({ scope: "company", memberAccess: "edit" });
      const owner = await join(Y, board.id, sessionHeaders(OWNER));
      const member = await join(Y, board.id, sessionHeaders(MEMBER));
      const bystander = await join(Y, elsewhere.id, sessionHeaders(MEMBER));

      const snapshot = member.of("presence.snapshot")[0]!;
      expect(snapshot.peers).toEqual([expect.objectContaining({ actor: { type: "user", id: OWNER } })]);
      await owner.until(() => owner.of("presence.update").find((m) => (m.actor as { id: string }).id === MEMBER), "member join");

      member.send({ type: "presence", cursor: { x: 10, y: 20 }, selection: ["n1"], viewport: { x: 0, y: 0, zoom: 1 } });
      const update = await owner.until(
        () => owner.of("presence.update").find((m) => (m.cursor as { x: number } | null)?.x === 10),
        "member cursor",
      );
      expect(update).toMatchObject({ actor: { type: "user", id: MEMBER }, selection: ["n1"], clientId: snapshot.clientId });

      const ownerRest = await request(app).post(`/api/companies/${Y}/planning-canvases/${board.id}/ops`)
        .set(sessionHeaders(OWNER)).send({ ops: [node("a")] });
      expect(ownerRest.status, ownerRest.text).toBe(200);
      for (const client of [owner, member]) {
        const applied = await client.next("ops.applied");
        expect(applied).toMatchObject({ revision: ownerRest.body.revision, actor: { type: "user", id: OWNER } });
        expect((applied.items as Array<{ key: string }>).map((i) => i.key)).toEqual(["a"]);
      }

      const agentRest = await request(app).post(`/api/companies/${Y}/planning-canvases/${board.id}/ops`)
        .set({ authorization: `Bearer ${agentKey}` }).send({ ops: [node("b")] });
      expect(agentRest.status, agentRest.text).toBe(200);
      for (const client of [owner, member]) {
        await client.until(() => client.of("ops.applied").find((m) => m.revision === agentRest.body.revision), "agent ops");
        expect(client.of("ops.applied").at(-1)).toMatchObject({ actor: { type: "agent", id: agentY } });
      }

      // An agent socket joins and sees the same fan-out.
      const agent = await join(Y, board.id, { authorization: `Bearer ${agentKey}` });
      expect(agent.of("presence.snapshot")[0]!.peers).toHaveLength(2);

      // Above 32 KB the event is sent as keys only.
      const big = "x".repeat(19_000);
      const bigRest = await request(app).post(`/api/companies/${Y}/planning-canvases/${board.id}/ops`)
        .set(sessionHeaders(OWNER)).send({ ops: [node("big1", big), node("big2", big)] });
      expect(bigRest.status, bigRest.text).toBe(200);
      const truncated = await member.until(() => member.of("ops.applied").find((m) => m.revision === bigRest.body.revision), "truncated");
      expect(truncated).toMatchObject({ truncated: true, keys: ["big1", "big2"] });
      expect(truncated.items).toBeUndefined();

      await sleep(100);
      expect(bystander.messages.filter((m) => m.type !== "presence.snapshot")).toEqual([]);
    });

    it("drops messages above 30 per second per socket and closes on a payload above 16 KB", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const owner = await join(Y, board.id, sessionHeaders(OWNER));
      const member = await join(Y, board.id, sessionHeaders(MEMBER));
      await owner.until(() => owner.of("presence.update").length >= 1, "join");
      const before = owner.of("presence.update").length;
      for (let i = 0; i < 45; i += 1) {
        member.send({ type: "presence", cursor: { x: i, y: 0 }, selection: [], viewport: null });
      }
      member.send({ type: "ping" });
      await sleep(300);
      expect(owner.of("presence.update").length - before).toBe(PLANNING_CANVAS_WS_MAX_MESSAGES_PER_SECOND);
      expect(member.of("pong")).toEqual([]);

      member.send({ type: "presence", cursor: null, selection: ["k".repeat(100)], viewport: null, pad: "p".repeat(17 * 1024) });
      const closed = await member.until(() => member.closed, "close");
      expect(closed.code).toBe(1009);
      await owner.until(() => owner.of("presence.leave").length === 1, "leave");
    });
  });

  describe("revocation", () => {
    const expectRevoked = async (client: Client) => {
      await client.next("access.revoked");
      const closed = await client.until(() => client.closed, "close");
      expect(closed.code).toBe(PLANNING_CANVAS_WS_CLOSE_REVOKED);
    };

    it("(a) canvas events: narrowing a board to personal revokes the member at once; the owner stays", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const owner = await join(Y, board.id, sessionHeaders(OWNER));
      const member = await join(Y, board.id, sessionHeaders(MEMBER));
      const res = await request(app).patch(`/api/companies/${Y}/planning-canvases/${board.id}/sharing`)
        .set(sessionHeaders(OWNER)).send({ scope: "personal" });
      expect(res.status, res.text).toBe(200);
      await expectRevoked(member);
      await owner.until(() => owner.of("presence.leave").length === 1, "leave");
      expect(owner.closed).toBeNull();
      expect(hub.socketCount(board.id)).toBe(1);

      // Deleting the board revokes the owner too.
      expect((await request(app).delete(`/api/companies/${Y}/planning-canvases/${board.id}`).set(sessionHeaders(OWNER))).status).toBe(200);
      await expectRevoked(owner);
      expect(hub.socketCount(board.id)).toBe(0);
    });

    it("(a) grants: a grant revoke and a grant issue reaching done revoke the agent's socket", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const grantSocket = async () => {
        const board = await makeBoard();
        const [issue] = await db.insert(issues)
          .values({ companyId: Y, title: "Grant task", status: "todo", createdByUserId: OWNER, responsibleUserId: OWNER }).returning();
        const [grant] = await db.insert(planningCanvasAgentGrants)
          .values({ companyId: Y, boardId: board.id, agentId: agentY, issueId: issue!.id, grantedByUserId: OWNER, source: "mention" }).returning();
        const client = await join(Y, board.id, { authorization: `Bearer ${agentKey}` });
        return { board, issue: issue!, grant: grant!, client };
      };

      const viaRevoke = await grantSocket();
      const revoked = await request(app).delete(`/api/companies/${Y}/planning-canvases/${viaRevoke.board.id}/agent-grants/${viaRevoke.grant.id}`)
        .set(sessionHeaders(OWNER));
      expect(revoked.status, revoked.text).toBe(200);
      await expectRevoked(viaRevoke.client);

      const viaIssue = await grantSocket();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, viaIssue.issue.id));
      await logActivity(db, {
        companyId: Y, actorType: "user", actorId: OWNER, action: "issue.updated", entityType: "issue",
        entityId: viaIssue.issue.id, details: { status: "done" },
      });
      await expectRevoked(viaIssue.client);
    });

    it("(b) activity.logged company_member.*: a suspended member is revoked at once", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const member = await join(Y, board.id, sessionHeaders(MEMBER));
      const owner = await join(Y, board.id, sessionHeaders(OWNER));
      await db.update(companyMemberships).set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, Y), eq(companyMemberships.principalId, MEMBER)));
      // An unrelated action re-checks nothing.
      await logActivity(db, { companyId: Y, actorType: "user", actorId: OWNER, action: "project.updated", entityType: "project", entityId: randomUUID() });
      await sleep(150);
      expect(member.closed).toBeNull();
      await logActivity(db, {
        companyId: Y, actorType: "user", actorId: OWNER, action: "company_member.updated", entityType: "company_membership", entityId: MEMBER,
      });
      await expectRevoked(member);
      expect(owner.closed).toBeNull();
    });

    it("fails closed: a failed restriction read refuses the upgrade, and a failed re-check leaves the socket without fan-out", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      resolverFails.on = true;
      const refused = await rawUpgrade(wsPath(Y, board.id), sessionHeaders(MEMBER));
      expect(refused.startsWith("HTTP/1.1 500 ")).toBe(true);
      expect(hub.socketCount(board.id)).toBe(0);
      resolverFails.on = false;

      const member = await join(Y, board.id, sessionHeaders(MEMBER));
      resolverFails.on = true;
      clockOffset = 61_000;
      publishPlanningCanvasEvent({ type: "ops.applied", companyId: Y, boardId: board.id, revision: 7, actor: { type: "user", id: OWNER }, items: [], purgedThroughRevision: 0 });
      await sleep(200);
      expect(member.of("ops.applied")).toEqual([]);
      expect(member.of("resync")).toEqual([]);
      expect(member.closed).toBeNull();

      resolverFails.on = false;
      await hub.tick();
      expect(await member.next("resync")).toMatchObject({ revision: board.revision });
    });

    it("(c) the 60 s re-check timer revokes a change no event announces; a stale socket gets no fan-out, then resync", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const owner = await join(Y, board.id, sessionHeaders(OWNER));
      const member = await join(Y, board.id, sessionHeaders(MEMBER));

      // Stale: last check over 60 s ago. The fan-out skips both sockets and re-checks them; they get resync instead.
      clockOffset = 61_000;
      const event = { type: "ops.applied" as const, companyId: Y, boardId: board.id, revision: 99, actor: { type: "user" as const, id: OWNER }, items: [], purgedThroughRevision: 0 };
      publishPlanningCanvasEvent(event);
      for (const client of [owner, member]) {
        const resync = await client.next("resync");
        expect(resync).toMatchObject({ revision: board.revision });
        expect(client.of("ops.applied")).toEqual([]);
      }

      // Restriction mode is enforced and no event is published for the flag: only the timer finds it.
      await db.update(companyMemberships).set({ restricted: true })
        .where(and(eq(companyMemberships.companyId, Y), eq(companyMemberships.principalId, MEMBER)));
      await hub.tick();
      expect(member.closed).toBeNull(); // checked under 45 s ago: not due yet
      await sleep(200); // let the keep-alive pong of the first tick land
      clockOffset += 46_000;
      await hub.tick();
      await member.next("access.revoked");
      await member.until(() => member.closed, "close");
      expect(owner.closed).toBeNull();
    });
  });
});
