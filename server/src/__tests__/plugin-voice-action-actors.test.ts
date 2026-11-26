import { createHash, randomUUID } from "node:crypto";
import express, { Router, type RequestHandler } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * PAR-14826 (rule PAR-14395): the real `/api/plugins/:id/actions/:key` route for the plugin-voice `speak`
 * action, as a session user, an agent key and a run token. The stand-in worker records the actor the
 * worker would receive. plugin-voice's own tests prove the worker refuses `agent`; together they prove the
 * refusal end to end. `get-my-voice-mode` (PAR-14827) is in the same table.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("plugin-voice action actors database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

const JWT_SECRET = "plugin-voice-action-actors";
const VOICE_KEYS = ["speak", "get-my-voice-mode"] as const;

function manifest(key: string): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "1.0.0", displayName: "Voice", description: "voice fixture", author: "Paperclip",
    categories: ["ui"], capabilities: ["ui.action.register"], entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
    ui: { slots: [{ type: "page", id: "page", displayName: "Page", exportName: "Page", routePath: "voice" }] },
  } as PaperclipPluginManifestV1;
}

(support.supported ? describe : describe.skip)("plugin-voice action actors (PAR-14826)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const PERSON = `person-${randomUUID()}`;
  const VOICE = `partnersinbiz.voice-${randomUUID().slice(0, 8)}`;
  const id: Record<string, string> = {};
  let sessionUser: string | null = null;

  const workerManager = {
    isRunning: vi.fn(() => true),
    call: vi.fn(async () => ({ fromWorker: true })),
  };

  let app: express.Express;
  const call = (key: string, headers: Record<string, string> = {}) => {
    const req = request(app).post(`/api/plugins/${id.plugin}/actions/${key}`)
      .send({ companyId: id.company, params: { agentId: id.agent, text: "Hello.", provider: "grok" } });
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  };
  const bearer = (value: string) => ({ authorization: ["Bearer", value].join(" ") });
  const lastActor = () => {
    const [, method, input] = workerManager.call.mock.calls.at(-1) as unknown as [string, string, { key: string; actorContext: Record<string, unknown> }];
    return { method, key: input.key, actor: input.actorContext };
  };

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-voice-action-actors-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Y", issuePrefix: `V${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    id.company = company!.id;
    const now = new Date();
    await db.insert(authUsers).values({ id: PERSON, name: PERSON, email: `${PERSON}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: id.company, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: id.company, name: "Ren", status: "active" }).returning();
    id.agent = agent!.id;
    const [plugin] = await db.insert(plugins).values({
      pluginKey: VOICE, packageName: VOICE, version: "1.0.0", manifestJson: manifest(VOICE), status: "ready",
    }).returning();
    id.plugin = plugin!.id;
    const keyValue = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: id.company, agentId: id.agent, responsibleUserId: PERSON, name: "test",
      keyHash: createHash("sha256").update(keyValue).digest("hex") });
    id.agentKey = keyValue;
    const [run] = await db.insert(heartbeatRuns).values({ companyId: id.company, agentId: id.agent, status: "running",
      invocationSource: "on_demand", responsibleUserId: PERSON }).returning();
    id.run = run!.id;

    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => sessionUser
        ? { session: { id: `session-${sessionUser}`, userId: sessionUser }, user: { id: sessionUser, name: sessionUser, email: null } } as never
        : null,
    }));
    const api = Router();
    api.use(memberRestrictionRouteGuard(db) as RequestHandler);
    api.use(pluginRoutes(db, {} as never, { scheduler: {}, jobStore: {} } as never, { workerManager } as never,
      undefined, { workerManager } as never));
    app.use("/api", api);
    app.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    workerManager.call.mockClear();
    sessionUser = null;
  });

  for (const key of VOICE_KEYS) {
    it(`${key}: a session user reaches the worker as type user with his userId`, async () => {
      sessionUser = PERSON;
      const res = await call(key);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const { method, key: workerKey, actor } = lastActor();
      expect(method).toBe("performAction");
      expect(workerKey).toBe(key);
      expect(actor).toMatchObject({ type: "user", userId: PERSON, agentId: null, companyId: id.company });
    });

    it(`${key}: an agent key reaches the worker as type agent with no userId`, async () => {
      const res = await call(key, bearer(id.agentKey!));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(lastActor().actor).toMatchObject({ type: "agent", userId: null, agentId: id.agent });
    });

    it(`${key}: a run token reaches the worker as type agent with the run id and no userId`, async () => {
      const token = createLocalAgentJwt(id.agent!, id.company!, "process", id.run!, PERSON)!;
      const res = await call(key, { ...bearer(token), "x-paperclip-run-id": id.run! });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(lastActor().actor).toMatchObject({ type: "agent", userId: null, agentId: id.agent, runId: id.run });
    });

    it(`${key}: no credentials never reach the worker`, async () => {
      const res = await call(key);
      expect(res.status).toBe(401);
      expect(workerManager.call).not.toHaveBeenCalled();
    });
  }
});
