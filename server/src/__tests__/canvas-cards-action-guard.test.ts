import { createHash, randomUUID } from "node:crypto";
import express, { Router, type RequestHandler } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, plugins } from "@paperclipai/db";
import {
  CANVAS_CARDS_ACTION_KEYS,
  CANVAS_CARDS_PERSON_ONLY_CODE,
  type CanvasCardsActionKey,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { canvasCardsGuard } from "../services/plugin-canvas-cards-guard.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14411 (plan PAR-14389 C.1, E paths 2 to 7 and 10): the core guard on the
 * `canvas.cards.*` keys, on both plugin action routes, through the real
 * `actorMiddleware` with a real session, agent keys and run tokens. The
 * stand-in worker fails the test when it is called where E says it is not.
 */

const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Db) => {
      const real = actual.memberRestrictionResolver(db);
      return (personId: string, companyId: string) => {
        if (failRead.on) return Promise.reject(new Error("restriction store down"));
        return real(personId, companyId);
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe("canvas cards guard database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

const JWT_SECRET = "canvas-cards-action-guard";

function manifest(key: string, entityCard: boolean): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "card fixture", author: "Paperclip",
    categories: ["ui"], capabilities: ["ui.action.register"], entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
    ui: { slots: [
      { type: "page", id: "page", displayName: "Page", exportName: "Page", routePath: "cards" },
      ...(entityCard ? [{ type: "canvasNode" as const, id: "card-company", displayName: "Company", exportName: "CompanyCard",
        entityCard: { kind: "company", search: true, related: true } }] : []),
    ] },
  } as PaperclipPluginManifestV1;
}

const PARAMS: Record<CanvasCardsActionKey, (plugin: string) => Record<string, unknown>> = {
  "canvas.cards.resolve": () => ({ items: [{ type: "card-company", id: "c1" }, { type: "card-company", id: "c2" }] }),
  "canvas.cards.search": () => ({ type: "card-company", q: "acme", limit: 5 }),
  "canvas.cards.related": (plugin) => ({ of: { plugin, type: "card-company", id: "c1" }, limit: 10 }),
};
/** E path 3: what core answers a restricted person itself. */
const RESTRICTED_ANSWER: Record<CanvasCardsActionKey, unknown> = {
  "canvas.cards.resolve": { cards: [{ type: "card-company", id: "c1", hidden: true }, { type: "card-company", id: "c2", hidden: true }] },
  "canvas.cards.search": { cards: [] },
  "canvas.cards.related": { groups: [] },
};

type RouteName = "bridge/action" | "actions/:key";
const ROUTES: RouteName[] = ["bridge/action", "actions/:key"];

(support.supported ? describe : describe.skip)("core guard on canvas.cards.* (PAR-14389 C.1)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const CARDS = `partnersinbiz.cards-${randomUUID().slice(0, 8)}`;
  const CLOSED = `partnersinbiz.closed-${randomUUID().slice(0, 8)}`;
  const PLAIN = `partnersinbiz.plain-${randomUUID().slice(0, 8)}`;
  const id: Record<string, string> = {};
  const token: Record<string, string> = {};

  /** The stand-in worker. `allowWorker` is set only where E says the worker is called. */
  let allowWorker = false;
  const unexpectedCalls: string[] = [];
  const workerManager = {
    isRunning: vi.fn(() => true),
    call: vi.fn(async (pluginId: string, method: string, input: { key?: string }) => {
      if (!allowWorker) {
        unexpectedCalls.push(`${pluginId} ${method} ${input?.key}`);
        throw new Error("worker called where E says it is not");
      }
      return { fromWorker: true };
    }),
  };

  let sessionUser: string | null = null;
  const mount = (mode: "authenticated" | "local_trusted") => {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: mode,
      ...(mode === "authenticated" ? { resolveSession: async () => sessionUser
        ? { session: { id: `session-${sessionUser}`, userId: sessionUser }, user: { id: sessionUser, name: sessionUser, email: null } } as never
        : null } : {}),
    }));
    const api = Router();
    api.use(memberRestrictionRouteGuard(db) as RequestHandler);
    api.use(pluginRoutes(db, {} as never, { scheduler: {}, jobStore: {} } as never, { workerManager } as never,
      undefined, { workerManager } as never));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  };
  let app: express.Express;
  let localApp: express.Express;

  const call = (target: express.Express, route: RouteName, pluginKey: string, key: string, params: unknown,
    headers: Record<string, string> = {}) => {
    const pluginId = id[pluginKey]!;
    const req = route === "bridge/action"
      ? request(target).post(`/api/plugins/${pluginId}/bridge/action`).send({ key, companyId: id.Y, params })
      : request(target).post(`/api/plugins/${pluginId}/actions/${key}`).send({ companyId: id.Y, params });
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  };

  const setList = (pluginKeys: string[]) => db.update(companyMemberships).set({ restrictedPluginKeys: pluginKeys })
    .where(and(eq(companyMemberships.companyId, id.Y!), eq(companyMemberships.principalId, R)));
  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, id.Y!));

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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-canvas-cards-guard-");
    db = createDb(tempDb.connectionString);
    const [y] = await db.insert(companies).values({
      name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    id.Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: id.Y, principalType: "user", principalId: O, membershipRole: "owner", status: "active" },
      { companyId: id.Y, principalType: "user", principalId: R, membershipRole: "operator", status: "active", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: id.Y, name: "Worker", status: "active" }).returning();
    id.agent = agent!.id;
    for (const [key, card] of [[CARDS, true], [CLOSED, true], [PLAIN, false]] as const) {
      const [row] = await db.insert(plugins).values({
        pluginKey: key, packageName: key, version: "1.0.0", manifestJson: manifest(key, card), status: "ready",
      }).returning();
      id[key] = row!.id;
    }
    token.keyO = await agentKey(O);
    token.keyR = await agentKey(R);
    id.runO = await run(O);
    id.runO2 = await run(O);
    id.runR = await run(R);
    app = mount("authenticated");
    localApp = mount("local_trusted");
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
    failRead.on = false;
    sessionUser = null;
    await setList([CARDS]);
    await setMode("enforce");
  });
  afterEach(() => {
    expect(unexpectedCalls, "worker calls where E says the worker is not called").toEqual([]);
  });

  /** Every key on both routes, as the given caller. */
  const eachCall = async (
    check: (res: request.Response, what: string, key: CanvasCardsActionKey) => void,
    opts: { target?: express.Express; plugin?: string; headers?: Record<string, string> } = {},
  ) => {
    for (const route of ROUTES) {
      for (const key of CANVAS_CARDS_ACTION_KEYS) {
        const plugin = opts.plugin ?? CARDS;
        const res = await call(opts.target ?? app, route, plugin, key, PARAMS[key](plugin), opts.headers);
        check(res, `${route} ${key}`, key);
      }
    }
  };

  it("control (path 1): the owner's call reaches the worker, company forced, actor a user", async () => {
    sessionUser = O;
    allowWorker = true;
    await eachCall((res, what) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toEqual({ data: { fromWorker: true } });
    });
    expect(workerManager.call).toHaveBeenCalledTimes(6);
    for (const [pluginId, method, input] of workerManager.call.mock.calls) {
      expect(pluginId).toBe(id[CARDS]);
      expect(method).toBe("performAction");
      expect(input).toMatchObject({ params: { companyId: id.Y }, actorContext: { type: "user", userId: O, onBehalfOfRestricted: false } });
    }
  });

  it("path 2: a restricted member, plugin not on his list: core gate 403 MEMBER_RESTRICTED, worker not called", async () => {
    sessionUser = R;
    await eachCall((res, what) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTED" });
    }, { plugin: CLOSED });
  });

  it("path 3: a restricted member, plugin on his list: core answers hidden and empty, worker not called", async () => {
    sessionUser = R;
    await eachCall((res, what, key) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toEqual({ data: RESTRICTED_ANSWER[key] });
    });
  });

  it("path 4 (stated): the company on report, the restricted member's call reaches the worker unflagged", async () => {
    await setMode("report");
    sessionUser = R;
    allowWorker = true;
    await eachCall((res, what) => expect(res.status, what).toBe(200));
    expect(workerManager.call.mock.calls.every(([, , input]) =>
      (input as { actorContext: { onBehalfOfRestricted: boolean } }).actorContext.onBehalfOfRestricted === false)).toBe(true);
  });

  it("path 5: the restriction read throws: 503 MEMBER_RESTRICTION_UNAVAILABLE, worker not called", async () => {
    sessionUser = R;
    failRead.on = true;
    await eachCall((res, what) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(503);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
      expect(res.body).not.toHaveProperty("data");
    });
  });

  const personOnly = (res: request.Response, what: string) => {
    expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body).toMatchObject({ code: CANVAS_CARDS_PERSON_ONLY_CODE });
  };

  it("path 6: agent keys (no run, own run, another run): 403 CANVAS_CARDS_PERSON_ONLY, worker not called", async () => {
    await eachCall(personOnly, { headers: bearer(token.keyO!) });
    await eachCall(personOnly, { headers: { ...bearer(token.keyO!), "x-paperclip-run-id": id.runO! } });
    await eachCall(personOnly, { headers: { ...bearer(token.keyO!), "x-paperclip-run-id": id.runR! } });
    // The key of an agent working for the restricted member, plugin on his list.
    await eachCall(personOnly, { headers: bearer(token.keyR!) });
  });

  it("path 6: run tokens (own run, no run id, a run working for the restricted member): 403, worker not called", async () => {
    await eachCall(personOnly, { headers: { ...bearer(jwt(id.runO!, O)), "x-paperclip-run-id": id.runO! } });
    await eachCall(personOnly, { headers: bearer(jwt(id.runO!, O)) });
    await eachCall(personOnly, { headers: bearer(jwt(id.runR!, R)) });
    await eachCall(personOnly, { headers: { ...bearer(jwt(id.runR!, R)), "x-paperclip-run-id": id.runR! } });
  });

  it("path 6: a run token naming another run is refused before the guard (422), worker not called", async () => {
    await eachCall((res, what) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body).toMatchObject({ code: "agent_jwt_run_id_mismatch" });
    }, { headers: { ...bearer(jwt(id.runO!, O)), "x-paperclip-run-id": id.runO2! } });
  });

  it("path 7: the local board (no person) passes as a user and reaches the worker", async () => {
    allowWorker = true;
    await eachCall((res, what) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toEqual({ data: { fromWorker: true } });
    }, { target: localApp });
    expect(workerManager.call.mock.calls.every(([, , input]) =>
      (input as { actorContext: { type: string; onBehalfOfUserId: string | null } }).actorContext.type === "user")).toBe(true);
  });

  it("path 7: a system actor is refused 403 CANVAS_CARDS_PERSON_ONLY", () => {
    // No HTTP credential yields a system actor (`req.actor.type` is board, agent
    // or none; none is 401 before the guard), so the guard is called directly.
    for (const key of CANVAS_CARDS_ACTION_KEYS) {
      expect(() => canvasCardsGuard({ key, manifest: manifest(CARDS, true), params: PARAMS[key](CARDS),
        actorContext: { type: "system", onBehalfOfRestricted: false } }))
        .toThrow(expect.objectContaining({ status: 403, details: { code: CANVAS_CARDS_PERSON_ONLY_CODE } }));
    }
  });

  it("no credentials: 401, worker not called", async () => {
    await eachCall((res, what) => expect(res.status, what).toBe(401));
  });

  it("path 10: an unknown canvas.cards key and a plugin with no card slot answer 404, worker not called", async () => {
    sessionUser = O;
    for (const route of ROUTES) {
      for (const key of ["canvas.cards.delete", "canvas.cards.", "canvas.cards.resolve.all"]) {
        const res = await call(app, route, CARDS, key, {});
        expect(res.status, `${route} ${key}: ${JSON.stringify(res.body)}`).toBe(404);
      }
      for (const key of CANVAS_CARDS_ACTION_KEYS) {
        const res = await call(app, route, PLAIN, key, PARAMS[key](PLAIN));
        expect(res.status, `${route} ${key} on a slot-less plugin`).toBe(404);
      }
    }
    // The 404 comes before the person rule: an agent learns nothing more.
    const res = await call(app, "actions/:key", PLAIN, "canvas.cards.resolve", {}, bearer(token.keyO!));
    expect(res.status).toBe(404);
  });

  it("path 10: over-cap params answer 400, worker not called", async () => {
    sessionUser = O;
    const items = Array.from({ length: 101 }, (_, i) => ({ type: "card-company", id: `c${i}` }));
    const overCap: Array<[CanvasCardsActionKey, unknown]> = [
      ["canvas.cards.resolve", { items }],
      ["canvas.cards.search", { type: "card-company", q: "acme", limit: 21 }],
      ["canvas.cards.related", { of: { plugin: CARDS, type: "card-company", id: "c1" }, limit: 51 }],
      ["canvas.cards.resolve", undefined],
      ["canvas.cards.search", { q: "acme" }],
    ];
    for (const route of ROUTES) {
      for (const [key, params] of overCap) {
        const res = await call(app, route, CARDS, key, params);
        expect(res.status, `${route} ${key}: ${JSON.stringify(res.body)}`).toBe(400);
      }
    }
    // A restricted member's over-cap call is a 400 too, not a hidden answer.
    sessionUser = R;
    expect((await call(app, "bridge/action", CARDS, "canvas.cards.resolve", { items })).status).toBe(400);
  });

  it("other action keys are untouched by the guard (an agent still reaches the worker)", async () => {
    allowWorker = true;
    for (const route of ROUTES) {
      const res = await call(app, route, PLAIN, "resync", {}, bearer(token.keyO!));
      expect(res.status, `${route}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    expect(workerManager.call).toHaveBeenCalledTimes(2);
  });
});
