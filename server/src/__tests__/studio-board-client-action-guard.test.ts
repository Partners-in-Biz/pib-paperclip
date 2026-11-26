import { createHash, randomUUID } from "node:crypto";
import express, { Router, type RequestHandler } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14847 (plan PAR-14835 AC7): Studio's two board client keys, `board-client` and `board-client-set`, have no
 * core guard of their own; Studio's worker refuses agents (`person()`, tested in plugin-studio's board-clients.spec.ts).
 * That refusal is only sound if core hands the worker the right actor. This proves it through the real
 * `actorMiddleware` on both plugin action routes: a session user arrives as `actor.type "user"`, an agent key and a
 * run token arrive as `actor.type "agent"`, and a restricted member is stopped by core's restriction guard unless the
 * plugin is on his list, when he arrives flagged `onBehalfOfRestricted` for Studio to refuse.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("studio board client guard database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

const JWT_SECRET = "studio-board-client-action-guard";
const KEYS = ["board-client", "board-client-set"] as const;
const BOARD = "b0a7d000-0000-4000-8000-000000000001";
const PARAMS: Record<(typeof KEYS)[number], Record<string, unknown>> = {
  "board-client": { boardScope: { projectId: null, boardId: BOARD } },
  "board-client-set": { boardScope: { projectId: null, boardId: BOARD }, client: "company:acme", expected: null },
};

function manifest(key: string): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "0.1.73", displayName: "Studio stand-in", description: "board client fixture", author: "Paperclip",
    categories: ["ui"], capabilities: ["ui.action.register"], entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
    ui: { slots: [{ type: "page", id: "page", displayName: "Studio", exportName: "Page", routePath: "studio" }] },
  } as PaperclipPluginManifestV1;
}

type RouteName = "bridge/action" | "actions/:key";
const ROUTES: RouteName[] = ["bridge/action", "actions/:key"];
type ActorSeen = { type: string; userId?: string | null; agentId?: string | null; onBehalfOfRestricted?: boolean };

(support.supported ? describe : describe.skip)("Studio board-client keys: the actor core hands the worker (PAR-14835 AC7)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const STUDIO = `partnersinbiz.studio-${randomUUID().slice(0, 8)}`;
  const id: Record<string, string> = {};
  const token: Record<string, string> = {};

  let allowWorker = false;
  const unexpectedCalls: string[] = [];
  const workerManager = {
    isRunning: vi.fn(() => true),
    call: vi.fn(async (pluginId: string, method: string, input: { key?: string }) => {
      if (!allowWorker) {
        unexpectedCalls.push(`${pluginId} ${method} ${input?.key}`);
        throw new Error("worker called where the test says it is not");
      }
      return { fromWorker: true };
    }),
  };

  let sessionUser: string | null = null;
  let app: express.Express;
  const mount = () => {
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => sessionUser
        ? { session: { id: `session-${sessionUser}`, userId: sessionUser }, user: { id: sessionUser, name: sessionUser, email: null } } as never
        : null,
    }));
    const api = Router();
    api.use(memberRestrictionRouteGuard(db) as RequestHandler);
    api.use(pluginRoutes(db, {} as never, { scheduler: {}, jobStore: {} } as never, { workerManager } as never, undefined, { workerManager } as never));
    server.use("/api", api);
    server.use(errorHandler);
    return server;
  };

  const call = (route: RouteName, key: string, headers: Record<string, string> = {}) => {
    const pluginId = id[STUDIO]!;
    const params = PARAMS[key as (typeof KEYS)[number]];
    const req = route === "bridge/action"
      ? request(app).post(`/api/plugins/${pluginId}/bridge/action`).send({ key, companyId: id.Y, params })
      : request(app).post(`/api/plugins/${pluginId}/actions/${key}`).send({ companyId: id.Y, params });
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  };

  const setList = (pluginKeys: string[]) => db.update(companyMemberships).set({ restrictedPluginKeys: pluginKeys })
    .where(and(eq(companyMemberships.companyId, id.Y!), eq(companyMemberships.principalId, R)));

  const agentKey = async (responsibleUserId: string) => {
    const value = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: id.Y!, agentId: id.agent!, responsibleUserId, name: "test",
      keyHash: createHash("sha256").update(value).digest("hex") });
    return value;
  };
  const run = async (responsibleUserId: string) => {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: id.Y!, agentId: id.agent!, status: "running",
      invocationSource: "on_demand", responsibleUserId }).returning();
    return row!.id;
  };
  const jwt = (runId: string, person: string) => createLocalAgentJwt(id.agent!, id.Y!, "process", runId, person)!;
  const bearer = (value: string) => ({ authorization: ["Bearer", value].join(" ") });

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-studio-board-client-guard-");
    db = createDb(tempDb.connectionString);
    const [y] = await db.insert(companies).values({
      name: "Y", issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    id.Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: id.Y, principalType: "user", principalId: O, membershipRole: "owner", status: "active" },
      { companyId: id.Y, principalType: "user", principalId: R, membershipRole: "admin", status: "active", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: id.Y, name: "Worker", status: "active" }).returning();
    id.agent = agent!.id;
    const [row] = await db.insert(plugins).values({
      pluginKey: STUDIO, packageName: STUDIO, version: "0.1.73", manifestJson: manifest(STUDIO), status: "ready",
    }).returning();
    id[STUDIO] = row!.id;
    token.keyO = await agentKey(O);
    id.runO = await run(O);
    app = mount();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    workerManager.call.mockClear();
    unexpectedCalls.length = 0;
    allowWorker = false;
    sessionUser = null;
    await setList([]);
  });
  afterEach(() => {
    expect(unexpectedCalls, "worker calls where the test says the worker is not called").toEqual([]);
  });

  /** Both keys on both routes; returns the actor the worker received for each call. */
  const actorsFor = async (headers: Record<string, string> = {}) => {
    allowWorker = true;
    const seen: ActorSeen[] = [];
    for (const route of ROUTES) {
      for (const key of KEYS) {
        workerManager.call.mockClear();
        const res = await call(route, key, headers);
        expect(res.status, `${route} ${key}: ${JSON.stringify(res.body)}`).toBe(200);
        const [pluginId, method, input] = workerManager.call.mock.calls[0]! as unknown as [string, string, { key: string; params: Record<string, unknown>; actorContext: ActorSeen }];
        expect(pluginId).toBe(id[STUDIO]);
        expect(method).toBe("performAction");
        expect(input.key).toBe(key);
        expect(input.params).toMatchObject({ companyId: id.Y });
        seen.push(input.actorContext);
      }
    }
    return seen;
  };

  it("a session user arrives as actor.type \"user\" for both keys", async () => {
    sessionUser = O;
    const seen = await actorsFor();
    expect(seen).toHaveLength(4);
    for (const actor of seen) expect(actor).toMatchObject({ type: "user", userId: O, onBehalfOfRestricted: false });
  });

  it("an agent key arrives as actor.type \"agent\" for both keys, so Studio's person() refuses it", async () => {
    const seen = await actorsFor(bearer(token.keyO!));
    for (const actor of seen) expect(actor).toMatchObject({ type: "agent", agentId: id.agent });
    expect(seen.some((actor) => actor.type === "user")).toBe(false);
  });

  it("a run token arrives as actor.type \"agent\" for both keys, with or without the run header", async () => {
    for (const headers of [{ ...bearer(jwt(id.runO!, O)), "x-paperclip-run-id": id.runO! }, bearer(jwt(id.runO!, O))]) {
      const seen = await actorsFor(headers);
      for (const actor of seen) expect(actor).toMatchObject({ type: "agent", agentId: id.agent });
    }
  });

  it("a restricted member, Studio not on his list: core's restriction guard answers 403 MEMBER_RESTRICTED, worker not called", async () => {
    sessionUser = R;
    for (const route of ROUTES) {
      for (const key of KEYS) {
        const res = await call(route, key);
        expect(res.status, `${route} ${key}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTED" });
      }
    }
  });

  it("a restricted member, Studio on his list: he reaches the worker flagged restricted, for Studio to refuse", async () => {
    await setList([STUDIO]);
    sessionUser = R;
    const seen = await actorsFor();
    for (const actor of seen) expect(actor).toMatchObject({ type: "user", userId: R, onBehalfOfRestricted: true });
  });

  it("no credentials: 401, worker not called", async () => {
    for (const route of ROUTES) {
      for (const key of KEYS) expect((await call(route, key)).status, `${route} ${key}`).toBe(401);
    }
  });
});
