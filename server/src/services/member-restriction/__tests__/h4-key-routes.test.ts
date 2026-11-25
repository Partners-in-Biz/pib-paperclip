import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { errorHandler } from "../../../middleware/error-handler.js";
import { agentRoutes } from "../../../routes/agents.js";
import { loadActorMemberships } from "../actor-memberships.js";
import { memberRestrictionRouteGuard } from "../route-middleware.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";

/**
 * PAR-12743 (C-sweep-1), consumer H4: the agent key routes. They do not call
 * `decide()` (C25); only the route table closes them, through the route
 * middleware (PAR-12608 rev 3, 4.10 H4). R (restricted in an `enforce`
 * company) calls each key route for the agent on his list: refused (AC-H4);
 * with the kill switch `off`, today's answer (AC-F8); with the resolver
 * throwing, 503 `MEMBER_RESTRICTION_UNAVAILABLE`, no key and no data (AC-X1).
 */

const support = await getEmbeddedPostgresTestSupport();
const REFUSED = { error: "Not available for your access level", code: "MEMBER_RESTRICTED" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("H4 key routes database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("H4: agent key routes for R", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Express.Request["actor"];
  const R = `restricted-${randomUUID()}`;
  let companyId = "", agentId = "";
  /** Any key id: the middleware answers before the handler looks the key up. */
  const keyId = randomUUID();

  /** R's session actor; `bare`: his membership without the restriction fields, so the middleware reads them (AC-X3). */
  const asR = async (bare = false) => {
    const loaded = await loadActorMemberships(db, { userId: R, activeOnly: true });
    const memberships = bare ? loaded.map(({ companyId, membershipRole, status }) => ({ companyId, membershipRole, status })) : loaded;
    actor = { type: "board", source: "session", userId: R, memberships, companyIds: memberships.map((m) => m.companyId) } as Express.Request["actor"];
    return request(app);
  };
  const keyRows = () => db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
  /** The three key routes, each sent as R. */
  const calls = async (bare = false) => [
    await (await asR(bare)).get(`/api/agents/${agentId}/keys`),
    await (await asR(bare)).post(`/api/agents/${agentId}/keys`).send({ name: "r-key" }),
    await (await asR(bare)).delete(`/api/agents/${agentId}/keys/${keyId}`),
  ];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-h4-keys-");
    db = createDb(tempDb.connectionString);
    const api = Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use(agentRoutes(db));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", api);
    app.use(errorHandler);

    const [company] = await db.insert(companies).values({
      name: "Keys co", issuePrefix: `H${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    const [agent] = await db.insert(agents).values({
      companyId, name: "Listed", role: "engineer", status: "idle", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }).returning();
    agentId = agent!.id;
    const now = new Date();
    await db.insert(authUsers).values({ id: R, name: R, email: `${R}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator",
      restricted: true, restrictedAgentIds: [agentId],
    });
    // Without the flag R may manage keys: the route table alone closes them (H4).
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: R, permissionKey: "agents:create" });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("AC-H4: each key route is 403 MEMBER_RESTRICTED for R under enforce, and no key is written", async () => {
    for (const res of [...await calls(), ...await calls(true)]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual(REFUSED);
    }
    expect(await keyRows()).toHaveLength(0);
  });

  it("AC-F8: with the variable `off` and the column on `enforce`, R creates, lists and revokes a key as today", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const created = await (await asR()).post(`/api/agents/${agentId}/keys`).send({ name: "r-key" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.responsibleUserId).toBe(R);
    const listed = await (await asR()).get(`/api/agents/${agentId}/keys`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((key: { id: string }) => key.id)).toContain(created.body.id);
    const revoked = await (await asR()).delete(`/api/agents/${agentId}/keys/${created.body.id}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);
  });

  it("AC-X1: when the resolver throws, each key route is 503 MEMBER_RESTRICTION_UNAVAILABLE with no data and no key", async () => {
    const before = (await keyRows()).length;
    // A session that carries the fields answers without a read, so R's membership comes
    // without them (AC-X3) and a malformed stored list makes the resolver throw on his row.
    await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
      where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
    try {
      for (const res of await calls(true)) {
        expect(res.status, JSON.stringify(res.body)).toBe(503);
        expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
        expect(Array.isArray(res.body)).toBe(false);
        expect(res.body).not.toHaveProperty("token");
      }
      expect(await keyRows()).toHaveLength(before);
    } finally {
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
        where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
    }
  });
});
