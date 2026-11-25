import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, agents, authUsers, chatEndpoints, chatGitHubRegistrations, companies, companyMemberships, createDb, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { runnerPrpWebSocketInternals, setupRunnerPrpWebSocketServer } from "../realtime/runner-prp-ws.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { customerSuccessRoutes } from "../routes/customer-success.js";
import { llmRoutes } from "../routes/llms.js";
import { nativeRunMcpRoutes } from "../routes/native-run-mcp.js";
import { githubChatWizardService } from "../services/chat-github-wizard.js";
import { publishLiveEvent } from "../services/live-events.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { MEMBER_RESTRICTION_MOUNT_TABLE } from "../services/member-restriction/route-table.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13211 (C4f-2b): the "to prove" rows of the mount table, spec PAR-12608
 * rev 3, 4.6a, each with a flagged member's identity, and AC-M7 (his live
 * socket opened before the flag). These mounts sit before the actor
 * middleware, so R's identity is what he can send: his session cookie and his
 * board key. Rows 2, 5 and 19 run with no database (`{}`): a refusal there is
 * made without looking up any person. This ticket adds no caller of the
 * resolver, so it carries no kill-switch or failing-read test of its own.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => vi.unstubAllEnvs());

describe("mount rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const R_SESSION = `better-auth.session_token=${randomUUID()}.restricted-member`;
const R_KEY = `Bearer pcp_board_${randomUUID().replace(/-/g, "")}`;
const R_CREDENTIALS = [{ cookie: R_SESSION }, { authorization: R_KEY }, { cookie: R_SESSION, authorization: R_KEY }];
const NO_DB = {} as Db;

function mounted(router: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  return app;
}

describe("4.6a row 2: customer success accepts no member's session or key", () => {
  const app = mounted(express.Router().use("/api/customer-success/v1", customerSuccessRoutes(NO_DB, {} as StorageService)));

  it.each(R_CREDENTIALS)("R's credentials %o are refused on both routes", async (headers) => {
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED", "true");
    const authority = await request(app).get("/api/customer-success/v1/run-authority").set(headers);
    const read = await request(app).post("/api/customer-success/v1/read").set(headers).send({});
    for (const res of [authority, read]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(Object.keys(res.body)).toEqual(["error"]);
    }
  });
});

describe("4.6a row 5: runtime connection intents and native-run MCP take only a run's own token", () => {
  const app = mounted(express.Router().use(runtimeConnectionIntentRoutes(NO_DB), nativeRunMcpRoutes()));
  const row5 = MEMBER_RESTRICTION_MOUNT_TABLE.find((entry) => entry.row === 5)!;
  const bodies: Record<string, unknown> = {
    "/runtime-tools/connections/search": { query: "github" },
    "/runtime-tools/connections/request": { service: "github" },
    "/mcp/runtime-tools": { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };

  it.each(row5.routes!.flatMap((route) => R_CREDENTIALS.map((headers) => ({ ...route, headers }))))(
    "$method $path ($class) refuses R's credentials",
    async ({ method, path: routePath, headers }) => {
      const url = routePath.replace(":runId", randomUUID());
      const verb = method === "ALL" ? "post" : method.toLowerCase() as "get" | "post";
      const res = await request(app)[verb](url).set(headers).send(bodies[routePath] ?? {});
      expect([401, 403], `${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/"(result|tools|token|credentials)"/);
    },
  );
});

describe("4.6a row 9: the llms text routes carry no company data", () => {
  it("R's board actor reads them with no database read and no company in the answer", async () => {
    const companyId = randomUUID();
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: `restricted-${randomUUID()}`, source: "session", companyIds: [companyId] } as Express.Request["actor"];
      next();
    });
    app.use(llmRoutes(NO_DB));
    app.use(errorHandler);
    for (const url of ["/llms/agent-configuration.txt", "/llms/agent-icons.txt", "/llms/agent-configuration/process.txt"]) {
      const res = await request(app).get(url);
      expect(res.status, `${url} ${res.text}`).toBe(200);
      expect(res.type).toBe("text/plain");
      expect(res.text).not.toContain(companyId);
    }
  });
});

describe("4.6a row 19: the runner socket opens with no member's session", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("R's session and key open nothing: the path alone picks a registered run's authority", () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server);
    for (const [url, status] of [
      [`/api/runner/v1/connect/${randomUUID()}`, "404 Not Found"],
      ["/api/runner/v1/connect/not-a-run", "400 Bad Request"],
    ] as const) {
      const socket = new PassThrough();
      const writes: Buffer[] = [];
      socket.on("data", (chunk) => writes.push(Buffer.from(chunk)));
      server.emit("upgrade", { url, headers: { cookie: R_SESSION, authorization: R_KEY, upgrade: "websocket" } }, socket, Buffer.alloc(0));
      expect(Buffer.concat(writes).toString("utf8")).toContain(status);
    }
    server.close();
    // The handler resolves no person: it reads neither cookie nor authorization.
    const source = fs.readFileSync(path.resolve(__dirname, "../realtime/runner-prp-ws.ts"), "utf8");
    expect(source).not.toMatch(/headers\??\.(?:cookie|authorization)|headers\[["'](?:cookie|authorization)|resolveSession|actorMiddleware/i);
  });
});

describe("4.6a row 12: each GitHub callback mount hands the browser actor to the wizard", () => {
  // The wizard skips its session and `connections:configure` checks when no actor
  // comes in, so a mount that drops `req.actor` would let R finish a set-up.
  const source = fs.readFileSync(path.resolve(__dirname, "../app.ts"), "utf8");
  /** The argument text of the first `<callee>(...)` call in `text`, split at top-level commas. */
  const callArgs = (text: string, callee: string) => {
    const start = text.indexOf(`${callee}(`);
    if (start < 0) return null;
    const args: string[] = [];
    let depth = 0, current = "";
    for (const char of text.slice(start + callee.length + 1)) {
      if (depth === 0 && char === ")") return [...args, current.trim()];
      if (depth === 0 && char === ",") { args.push(current.trim()); current = ""; continue; }
      if ("([{".includes(char)) depth += 1;
      if (")]}".includes(char)) depth -= 1;
      current += char;
    }
    return null;
  };

  it.each([
    ["/api/chat-github/manifest/callback", "directCallback"],
    ["/api/chat-github/cloud/callback", "cloudCallback"],
    ["/api/chat-github/identity/callback", "identityCallback"],
  ])("%s passes req.actor to %s", (route, method) => {
    const mounts = source.split(`app.get("${route}"`);
    expect(mounts, `one mount of ${route} in app.ts`).toHaveLength(2);
    const handler = mounts[1]!.slice(0, mounts[1]!.indexOf("\n  });"));
    expect(callArgs(handler, `chatChannels.githubWizard.${method}`)?.at(-1)).toBe("req.actor");
  });
});

(support.supported ? describe : describe.skip)("a flagged member in a company under enforce", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const id: Record<string, string> = {};
  const ORIGIN = "http://127.0.0.1:3199";

  const boardFor = async (userId: string) => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", memberships, companyIds: memberships.map((row) => row.companyId) } as never;
  };
  const flag = (restricted: boolean) => db.update(companyMemberships).set({ restricted })
    .where(and(eq(companyMemberships.companyId, id.Y!), eq(companyMemberships.principalId, R)));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-mount-rows-");
    db = createDb(tempDb.connectionString);
    const [y] = await db.insert(companies).values({
      name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    id.Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    for (const member of [
      { companyId: id.Y, principalId: O, membershipRole: "owner" as const },
      { companyId: id.Y, principalId: R, membershipRole: "operator" as const },
    ]) {
      await db.insert(companyMemberships).values({ ...member, principalType: "user", status: "active", restricted: member.principalId === R });
      // An operator's default grants include `tools:manage_connections`: only the restriction refuses R in row 12.
      await ensureHumanRoleDefaultGrants(db, { ...member, grantedByUserId: null });
    }
    const [agent] = await db.insert(agents).values({ companyId: id.Y, name: "Bot", adapterType: "process", status: "active" }).returning();
    const [mine, others] = await db.insert(issues).values([
      { companyId: id.Y, title: "R's task", status: "todo", createdByUserId: R, responsibleUserId: R },
      { companyId: id.Y, title: "O's task", status: "todo", createdByUserId: O, responsibleUserId: O },
    ]).returning();
    Object.assign(id, { agent: agent!.id, mine: mine!.id, others: others!.id });
    const [application] = await db.insert(toolApplications).values({
      companyId: id.Y, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: id.Y, applicationId: application!.id, name: "GitHub bot", uid: `github-${randomUUID()}`, connectionKind: "managed",
      ownership: "customer", transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true,
    }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId: id.Y, connectionId: connection!.id, provider: "github", publicId: `gh-${randomUUID()}`, assignedAgentId: agent!.id,
    }).returning();
    id.endpoint = endpoint!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("4.6a row 12: the GitHub callbacks refuse a flagged member", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const wizard = () => githubChatWizardService(db, {
      origin: () => ORIGIN, connector: () => null,
      startDirect: async () => { throw new Error("unused"); }, storeApp: async () => undefined, storeCredentials: async () => undefined,
      refreshRepositories: async () => [], resources: async () => [], replaceResources: async () => undefined,
      configure: async () => undefined, finish: async () => undefined,
    });
    /** A pending set-up R started, and the callback for it (the three mounts of row 12). */
    const callbacks = {
      manifest: async (actor: never) => {
        const state = randomUUID();
        await registration({ stateHash: hash(state) });
        return wizard().directCallback(state, "code", actor);
      },
      cloud: async (actor: never) => {
        const cloudId = randomUUID();
        await registration({ stateHash: hash(randomUUID()), handoff: { cloudId, redemptionId: "r", returnState: "s" } });
        return wizard().cloudCallback("s", cloudId, "claim", actor);
      },
      identity: async (actor: never) => {
        const state = randomUUID();
        await registration({ stateHash: hash(randomUUID()), handoff: { cloudId: "", redemptionId: "r", returnState: "s", identityStateHash: hash(state) } });
        return wizard().identityCallback(state, "", actor);
      },
    };
    const registration = (values: Partial<typeof chatGitHubRegistrations.$inferInsert>) => db.insert(chatGitHubRegistrations).values({
      companyId: id.Y!, endpointId: id.endpoint!, userId: R, stateHash: "", trustedOrigin: ORIGIN, status: "pending",
      expiresAt: new Date(Date.now() + 60_000), ...values,
    });
    const refusals = async () => (await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, id.Y!), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION))))
      .filter((row) => (row.details as { target?: string }).target === "connections:configure").length;

    it.each(Object.keys(callbacks) as Array<keyof typeof callbacks>)("%s callback", async (name) => {
      const refused = await callbacks[name](await boardFor(R)).then(() => null,
        (error: { status?: number; message: string; details?: unknown }) => error);
      expect(refused?.status).toBe(403);
      expect(refused?.details).toMatchObject({ reason: "deny_member_restricted" });
      expect(refused?.message).toContain("not available to a restricted member");
      expect(await refusals()).toBeGreaterThan(0);
      // Control: with the kill switch `off` the same return passes the check (it may fail later for want of GitHub).
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const control = await callbacks[name](await boardFor(R)).then(() => null, (error: { message: string }) => error);
      expect(control?.message ?? "").not.toContain("restricted member");
    });
  });

  describe("AC-M7: R's live socket opened before the flag", () => {
    it("gets O's task events until the flag, and none after it; his own task still arrives", async () => {
      await flag(false);
      const server = createServer();
      const wss = setupLiveEventsWebSocketServer(server, db, {
        deploymentMode: "authenticated", resolveSessionFromHeaders: async () => ({ user: { id: R } }) as never,
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${id.Y}/events/ws`);
      const got: Array<{ issueId: string; mark: string }> = [];
      socket.on("message", (bytes) => got.push(JSON.parse(bytes.toString()).payload));
      const send = (issueId: string, mark: string) =>
        publishLiveEvent({ companyId: id.Y!, type: "agent.session.goal.changed", payload: { issueId, mark } });
      const arrived = (mark: string) => expect.poll(() => got.some((payload) => payload.mark === mark)).toBe(true);
      try {
        await once(socket, "open");
        send(id.others!, "before");
        await arrived("before");
        await flag(true);
        send(id.others!, "after");
        // Delivery is in order: once R's own task event arrives, the one before it was decided.
        send(id.mine!, "barrier");
        await arrived("barrier");
        expect(got.map((payload) => payload.mark)).toEqual(["before", "barrier"]);
      } finally {
        socket.terminate();
        wss.close();
        server.close();
        await flag(true);
      }
    });
  });
});
