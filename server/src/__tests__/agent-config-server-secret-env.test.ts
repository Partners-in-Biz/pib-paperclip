// PAR-15260 (G1b): saving a server-secret name in an agent's config env is
// refused (422) for every caller class that may edit the config, through the
// real auth middleware (local board, agent key, run JWT). A plain key in the
// same request is the control: it saves (200). Kill switch
// `PAPERCLIP_AGENT_ENV_ALLOWLIST=off`: accepted as today.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("agent config env refuses server-secret names", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home = "";
  // cursor_cloud: an env agents may edit. On a *_local adapter an agent key is
  // already refused any env edit (403, asserted below).
  const companyId = randomUUID(), agentId = randomUUID(), localAgentId = randomUUID(), userId = randomUUID(), runId = randomUUID();
  const apiKey = randomUUID();

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-secret-env-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-only-jwt-signing-value");
    vi.stubEnv("PAPERCLIP_AGENT_ENV_ALLOWLIST", "");
    database = await startEmbeddedPostgresTestDatabase("agent-config-secret-env-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Secret env", issuePrefix: "SEV" });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", adapterType: "cursor_cloud", adapterConfig: { env: {} } },
      { id: localAgentId, companyId, name: "Local", adapterType: "hermes_local", adapterConfig: { env: {} } },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: agentId, permissionKey: "agents:create" },
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" },
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" },
    ]);
    await db.insert(agentApiKeys).values({ companyId, agentId, name: "Worker", responsibleUserId: userId,
      keyHash: createHash("sha256").update(apiKey).digest("hex") });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  }, 60_000);

  function app(deploymentMode: "local_trusted" | "authenticated") {
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, { deploymentMode, resolveSession: async () => null }));
    server.use("/api", agentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const callers = () => {
    const runJwt = createLocalAgentJwt(agentId, companyId, "cursor_cloud", runId, userId);
    expect(runJwt).toBeTruthy();
    return [
      { name: "local board", server: app("local_trusted"), auth: null },
      { name: "agent key", server: app("authenticated"), auth: apiKey },
      { name: "run JWT", server: app("authenticated"), auth: runJwt! },
    ];
  };

  function patchEnv(caller: ReturnType<typeof callers>[number], env: Record<string, unknown>, target = agentId) {
    const call = request(caller.server).patch(`/api/agents/${target}`).send({ adapterConfig: { env } });
    return caller.auth ? call.set("Authorization", `Bearer ${caller.auth}`) : call;
  }

  async function storedEnvKeys(): Promise<string[]> {
    const [row] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId));
    return Object.keys(((row?.adapterConfig ?? {}) as { env?: Record<string, unknown> }).env ?? {}).sort();
  }

  it.each(["DATABASE_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_QA_USER_PASSWORD"])(
    "%s: 422 for every caller, nothing stored; a plain key saves",
    async (key) => {
      for (const caller of callers()) {
        const refused = await patchEnv(caller, { [key]: { type: "plain", value: "x" }, PLAIN_OK: { type: "plain", value: "1" } });
        expect(refused.status, `${caller.name} ${key}`).toBe(422);
        expect(refused.body.error).toContain(key);
        expect(JSON.stringify(refused.body)).not.toContain("\"x\"");
        expect(await storedEnvKeys()).not.toContain(key);

        const control = await patchEnv(caller, { PLAIN_OK: { type: "plain", value: "1" } });
        expect(control.status, `${caller.name} control`).toBe(200);
      }
    },
    60_000,
  );

  it("local adapter: the board gets 422; an agent key is refused any env edit, as today", async () => {
    const [board, agentKey] = callers();
    const refused = await patchEnv(board!, { DATABASE_URL: { type: "plain", value: "x" } }, localAgentId);
    expect(refused.status).toBe(422);
    const agentEdit = await patchEnv(agentKey!, { DATABASE_URL: { type: "plain", value: "x" } }, localAgentId);
    expect(agentEdit.status).toBe(403);
  }, 60_000);

  it("kill switch off: the board saves the key as today", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_ENV_ALLOWLIST", "off");
    try {
      const saved = await patchEnv(callers()[0]!, { DATABASE_URL: { type: "plain", value: "x" } });
      expect(saved.status).toBe(200);
      expect(await storedEnvKeys()).toContain("DATABASE_URL");
    } finally {
      vi.stubEnv("PAPERCLIP_AGENT_ENV_ALLOWLIST", "");
    }
  }, 60_000);
});
