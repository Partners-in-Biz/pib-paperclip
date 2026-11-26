import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  planningCanvases,
} from "@paperclipai/db";
import { PLANNING_CANVAS_UNFURL_ERROR_CODES as CODES } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { planningCanvasUnfurlRoutes } from "../routes/planning-canvas-unfurl.js";
import { PLANNING_CANVAS_UNFURL_ENV } from "../services/planning-canvas-switches.js";
import type { PlanningCanvasUnfurlFetch } from "../services/planning-canvas-unfurl.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14426 (plan PAR-14389 C.5 "Preview fetch", "Rate limit"; E "D3") through
 * the real router and `actorMiddleware` on embedded Postgres. The network is a
 * seam: these tests prove the route's gates and that the URL comes from the
 * stored node. The outbound guard is proven in planning-canvas-unfurl.test.ts.
 */

const support = await getEmbeddedPostgresTestSupport();
const JWT_SECRET = "planning-canvas-unfurl-routes";

describe("planning canvas unfurl database support", () => {
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas link preview route (PAR-14426)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const OWNER = `owner-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  let Y = "", agentA = "";
  const fetched: string[] = [];
  let hold: Promise<void> | null = null;

  const fetchSeam: PlanningCanvasUnfurlFetch = async (url) => {
    fetched.push(url.toString());
    if (hold) await hold;
    return new Response("<title>Stored &amp; fetched</title>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  async function board(values: Partial<typeof planningCanvases.$inferInsert> = {}) {
    const [row] = await db.insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: "Board", scope: "company", memberAccess: "edit", ...values }).returning();
    return row!;
  }
  const node = (key: string, kind: string, data: Record<string, unknown>) => ({
    op: "add",
    item: { itemType: "node", key, kind, x: 0, y: 0, width: 320, height: 200, zIndex: 1, color: "slate", title: "", content: "", data },
  });
  async function seed(boardId: string, ops: unknown[]) {
    const res = await request(app).post(`/api/companies/${Y}/planning-canvases/${boardId}/ops`).set(session(OWNER)).send({ ops });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  /** A fresh app: its own unfurl router, so its own in-memory limiter. */
  function makeApp() {
    const fresh = express();
    fresh.use(express.json());
    fresh.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId ? ({ session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never) : null;
      },
    }));
    const api = express.Router();
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasUnfurlRoutes(db, { fetch: fetchSeam, log: () => {} }));
    fresh.use("/api", api);
    fresh.use(errorHandler);
    return fresh;
  }
  const unfurl = (headers: Record<string, string>, boardId: string, body: Record<string, unknown>, target = app) =>
    request(target).post(`/api/companies/${Y}/planning-canvases/${boardId}/unfurl`).set(headers).send(body);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
    vi.stubEnv(PLANNING_CANVAS_UNFURL_ENV, "on");
    fetched.length = 0;
    hold = null;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-unfurl-");
    db = createDb(tempDb.connectionString);
    app = makeApp();

    Y = randomUUID();
    await db.insert(companies).values({ id: Y, name: "Unfurl Y", issuePrefix: `U${Y.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    const now = new Date();
    await db.insert(authUsers).values([OWNER, VIEWER].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
    ]);
    const [a] = await db.insert(agents).values({
      companyId: Y, name: "Previewer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    agentA = a!.id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads the URL from the stored node, never from the body", async () => {
    const b = await board();
    await seed(b.id, [node("w1", "weblink", { url: "https://stored.example/page" })]);
    const res = await unfurl(session(OWNER), b.id, { nodeId: "w1" });
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({ title: "Stored & fetched", description: "", siteName: "" });
    expect(fetched).toEqual(["https://stored.example/page"]);

    const forged = await unfurl(session(OWNER), b.id, { nodeId: "w1", url: "https://attacker.example/" });
    expect(forged.status).toBe(400);
    expect(fetched).toHaveLength(1);
  });

  it("switch off answers off and fetches nothing; view access, agents and other nodes are refused", async () => {
    const b = await board();
    await seed(b.id, [node("w1", "weblink", { url: "https://stored.example/" }), node("m1", "markdown", { markdown: "https://stored.example/" })]);

    vi.stubEnv(PLANNING_CANVAS_UNFURL_ENV, "off");
    const off = await unfurl(session(OWNER), b.id, { nodeId: "w1" });
    expect(off.status).toBe(403);
    expect(off.body.details?.code ?? off.body.code).toBe(CODES.disabled);
    vi.stubEnv(PLANNING_CANVAS_UNFURL_ENV, "on");

    expect((await unfurl(session(VIEWER), b.id, { nodeId: "w1" })).status).toBe(403);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: Y, agentId: agentA, status: "running", invocationSource: "assignment", responsibleUserId: OWNER, contextSnapshot: {},
    }).returning();
    const agent = await unfurl({ authorization: `Bearer ${createLocalAgentJwt(agentA, Y, "process", run!.id, OWNER)}` }, b.id, { nodeId: "w1" });
    expect([403, 404]).toContain(agent.status);
    expect((await unfurl(session(OWNER), b.id, { nodeId: "m1" })).status).toBe(404);
    expect((await unfurl(session(OWNER), b.id, { nodeId: "missing" })).status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("limits 30 per person per company per hour across two boards", async () => {
    const limited = makeApp();
    const one = await board(), two = await board();
    await seed(one.id, [node("w1", "weblink", { url: "https://one.example/" })]);
    await seed(two.id, [node("w2", "weblink", { url: "https://two.example/" })]);
    for (let i = 0; i < 30; i += 1) {
      const res = await unfurl(session(OWNER), i % 2 ? two.id : one.id, { nodeId: i % 2 ? "w2" : "w1" }, limited);
      expect(res.status).toBe(200);
    }
    const over = await unfurl(session(OWNER), two.id, { nodeId: "w2" }, limited);
    expect(over.status).toBe(429);
    expect(over.body.details?.code ?? over.body.code).toBe(CODES.rateLimited);
    expect(over.headers["retry-after"]).toBeDefined();
    expect(fetched).toHaveLength(30);
  });

  it("holds at most 2 previews in flight per person", async () => {
    const isolated = makeApp();
    const b = await board();
    await seed(b.id, [node("w1", "weblink", { url: "https://slow.example/" })]);
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const call = () => request(isolated).post(`/api/companies/${Y}/planning-canvases/${b.id}/unfurl`).set(session(OWNER)).send({ nodeId: "w1" });
    const first = call().then((r) => r);
    const second = call().then((r) => r);
    await vi.waitFor(() => expect(fetched).toHaveLength(2));
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.body.details?.code ?? third.body.code).toBe(CODES.busy);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    hold = null;
    expect((await call()).status).toBe(200);
  });
});
