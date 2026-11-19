import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import type { MemberRestrictionMode } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12715 (C2-5, H3 core half): an action, an API route and a tool call each
// hand the plugin `onBehalfOfUserId` (the run's, the key's or the connection's
// person; null for the local board) and `onBehalfOfRestricted` (true only for a
// flagged person in an `enforce` company). A failed read answers 503, no call.

const failReads = vi.hoisted(() => ({ on: false }));
const mockRegistry = vi.hoisted(() => ({ getById: vi.fn(), getByKey: vi.fn() }));

vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...real,
    memberRestrictionResolver: (db: Parameters<typeof real.memberRestrictionResolver>[0]) => {
      const resolve = real.memberRestrictionResolver(db);
      return (personId: string, companyId: string) =>
        failReads.on ? Promise.reject(new Error("restriction read failed")) : resolve(personId, companyId);
    },
  };
});
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const support = await getEmbeddedPostgresTestSupport();

describe("plugin acting person database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("plugins receive the acting person (AC-H3, core side)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let sessionUserId: string | null = null;
  const call = vi.fn();
  const executeTool = vi.fn();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-acting-person-");
    db = createDb(tempDb.connectionString);
    // Warm the route modules here: their cold import takes most of a test's 15 s budget.
    await Promise.all([import("../routes/plugins.js"), import("../middleware/auth.js"), import("../middleware/error-handler.js")]);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "plugin-acting-person");
    call.mockReset().mockImplementation(async (_id: string, method: string) =>
      method === "handleApiRequest" ? { status: 200, body: { ok: true } } : { ok: true });
    executeTool.mockReset().mockResolvedValue({ pluginId: PLUGIN_ID, toolName: "search", result: { content: "ok" } });
    const plugin = {
      id: PLUGIN_ID, pluginKey: "paperclip.acting", version: "1.0.0", status: "ready",
      manifestJson: { id: "paperclip.acting", capabilities: ["api.routes.register"], apiRoutes: [{
        routeKey: "whoami", method: "GET", path: "/whoami", auth: "board-or-agent",
        capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" },
      }] },
    };
    mockRegistry.getById.mockResolvedValue(plugin);
    mockRegistry.getByKey.mockResolvedValue(plugin);
  });

  afterEach(() => {
    failReads.on = false;
    sessionUserId = null;
    vi.unstubAllEnvs();
  });

  async function fixture(mode: MemberRestrictionMode) {
    const [company] = await db.insert(companies).values({
      name: "Acting person", issuePrefix: `H${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const companyId = company!.id;
    const [restricted, unflagged, owner] = ["r", "u", "o"].map((p) => `${p}-${randomUUID()}`) as [string, string, string];
    for (const [id, membershipRole, flag] of [[restricted, "operator", true], [unflagged, "operator", false], [owner, "owner", false]] as const) {
      await db.insert(authUsers).values({ id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      // R has this plugin on his list, so the core plugin gate (C5-1, PAR-12740) lets his call reach it.
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole,
        restricted: flag, restrictedPluginKeys: flag ? ["paperclip.acting"] : [] });
    }
    const [agent] = await db.insert(agents).values({ companyId, name: "Worker", adapterType: "process" }).returning();
    return { companyId, agentId: agent!.id, restricted, unflagged, owner };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function runFor(f: Fixture, personId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "running", responsibleUserId: personId,
    }).returning();
    return run!.id;
  }

  async function runToken(f: Fixture, personId: string) {
    const runId = await runFor(f, personId);
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    return { runId, headers: { authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "process", runId, personId)}` } };
  }

  async function keyFor(f: Fixture, personId: string) {
    const token = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      companyId: f.companyId, agentId: f.agentId, responsibleUserId: personId, name: "long-lived",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    return { authorization: `Bearer ${token}` };
  }

  async function app(options: { local?: boolean; actor?: Record<string, unknown> } = {}) {
    const [{ pluginRoutes }, { actorMiddleware }, { errorHandler }] = await Promise.all([
      import("../routes/plugins.js"), import("../middleware/auth.js"), import("../middleware/error-handler.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use(options.actor
      ? (req, _res, next) => { req.actor = options.actor as typeof req.actor; next(); }
      : actorMiddleware(db, {
        deploymentMode: options.local ? "local_trusted" : "authenticated",
        resolveSession: async () => sessionUserId
          ? { session: { id: `s-${sessionUserId}`, userId: sessionUserId }, user: { id: sessionUserId, name: "S", email: null } } as never
          : null,
      }));
    server.use("/api", pluginRoutes(db, {} as never, undefined, undefined,
      { toolDispatcher: { getTool: () => ({ name: "paperclip.acting:search" }), executeTool, listToolsForAgent: vi.fn() } } as never,
      { workerManager: { call, isRunning: () => true } } as never));
    server.use(errorHandler);
    return server;
  }

  type Entry = "action" | "api" | "tool";
  const ENTRIES: Entry[] = ["action", "api", "tool"];

  /** Calls one entry point; returns the response and what the plugin received as its caller. */
  async function callEntry(entry: Entry, f: Fixture, headers: Record<string, string>, options: Parameters<typeof app>[0] = {}, runId?: string) {
    call.mockClear();
    executeTool.mockClear();
    const server = await app(options);
    if (entry === "action") {
      const res = await request(server).post(`/api/plugins/${PLUGIN_ID}/actions/sync`).set(headers).send({ companyId: f.companyId });
      return { res, caller: call.mock.calls.find(([, method]) => method === "performAction")?.[2]?.actorContext };
    }
    if (entry === "api") {
      const res = await request(server).get("/api/plugins/paperclip.acting/api/whoami").query({ companyId: f.companyId }).set(headers);
      return { res, caller: call.mock.calls.find(([, method]) => method === "handleApiRequest")?.[2]?.actor };
    }
    // A person sent in the body is dropped; core computes it.
    const res = await request(server).post("/api/plugins/tools/execute").set(headers).send({
      tool: "paperclip.acting:search", parameters: {},
      runContext: { agentId: f.agentId, runId: runId ?? await runFor(f, f.owner), companyId: f.companyId, onBehalfOfUserId: "spoofed" },
    });
    return { res, caller: executeTool.mock.calls[0]?.[2] };
  }

  async function expectPerson(
    entry: Entry, f: Fixture, headers: Record<string, string>, onBehalfOfUserId: string | null, onBehalfOfRestricted: boolean,
    options: Parameters<typeof app>[0] = {}, runId?: string,
  ) {
    const { res, caller } = await callEntry(entry, f, headers, options, runId);
    expect(res.status, `${entry}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(caller, entry).toMatchObject({ onBehalfOfUserId, onBehalfOfRestricted });
  }

  it.each(ENTRIES)("%s from a run carries the run's person, marked restricted for R under enforce", async (entry) => {
    const f = await fixture("enforce");
    for (const [person, restricted] of [[f.restricted, true], [f.unflagged, false], [f.owner, false]] as const) {
      const { runId, headers } = await runToken(f, person);
      await expectPerson(entry, f, headers, person, restricted, {}, runId);
    }
  });

  it.each(ENTRIES)("%s with a long-lived agent key carries the key's person", async (entry) => {
    // H5 (PAR-12714): a long-lived key may name only a run of its own agent for its own person.
    const f = await fixture("enforce");
    for (const [person, restricted] of [[f.restricted, true], [f.unflagged, false]] as const) {
      await expectPerson(entry, f, await keyFor(f, person), person, restricted, {}, await runFor(f, person));
    }
  });

  it("tool with a long-lived agent key naming another person's or agent's run is refused (H5)", async () => {
    const f = await fixture("enforce");
    const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    const [otherAgentRun] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: other!.id, invocationSource: "assignment", status: "running", responsibleUserId: f.restricted,
    }).returning();
    for (const runId of [await runFor(f, f.owner), otherAgentRun!.id]) {
      const { res } = await callEntry("tool", f, await keyFor(f, f.restricted), {}, runId);
      expect(res.status).toBe(422);
      expect(res.body.code ?? res.body.details?.code).toBe("agent_key_run_not_owned");
      expect(executeTool).not.toHaveBeenCalled();
    }
  });

  it.each(ENTRIES)("%s through an agent-purpose connection carries its approver", async (entry) => {
    // The connection's actor as C4f builds it (spec 4.6a row 4): the approving person and his membership.
    const f = await fixture("enforce");
    const { boardAuthService } = await import("../services/board-auth.js");
    for (const [person, restricted] of [[f.unflagged, false], [f.restricted, true]] as const) {
      const onBehalfOfMemberships = (await boardAuthService(db).resolveBoardAccess(person)).memberships;
      const actor = { type: "agent", source: "mcp_oauth", agentId: f.agentId, companyId: f.companyId, onBehalfOfUserId: person, onBehalfOfMemberships };
      await expectPerson(entry, f, {}, person, restricted, { actor });
    }
  });

  it.each(["action", "api"] as const)("%s from a signed-in user carries that user", async (entry) => {
    const f = await fixture("enforce");
    sessionUserId = f.restricted;
    await expectPerson(entry, f, {}, f.restricted, true);
    sessionUserId = f.owner;
    await expectPerson(entry, f, {}, f.owner, false);
  });

  it.each(ENTRIES)("%s from the local board carries no person", async (entry) => {
    await expectPerson(entry, await fixture("enforce"), {}, null, false, { local: true });
  });

  it.each([["report", null], ["off", null], ["enforce", "off"]] as const)(
    "R is not marked restricted under %s (kill switch %s)", async (mode, killSwitch) => {
      if (killSwitch) vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", killSwitch);
      const f = await fixture(mode);
      for (const entry of ENTRIES) {
        const { runId, headers } = await runToken(f, f.restricted);
        await expectPerson(entry, f, headers, f.restricted, false, {}, runId);
      }
    });

  it.each(ENTRIES)("%s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and never reaches the plugin when the read fails", async (entry) => {
    const f = await fixture("enforce");
    const { runId, headers } = await runToken(f, f.restricted);
    failReads.on = true;
    const { res } = await callEntry(entry, f, headers, {}, runId);
    expect(res.status).toBe(503);
    expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(call).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
