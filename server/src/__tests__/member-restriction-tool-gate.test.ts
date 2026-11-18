import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  type Db,
} from "@paperclipai/db";
import type { MemberRestrictionMode, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { pluginToolGate } from "../services/member-restriction/tool-gate.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12741 (C5-2): the core plugin gate inside the tool dispatcher, so every
 * path of C11 is gated by the run's person, and connector tools closed for a
 * run that works for a restricted person (PAR-12608 rev 3, 4.8, 4.9 decision 4).
 * AC-K2, AC-T3, AC-T4, AC-M6; the gate and the connector filter are new callers
 * of the resolver: kill-switch and failing-read tests below (AC-F8, AC-X1).
 */

const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Db) => {
      const real = actual.memberRestrictionResolver(db);
      return (personId: string, companyId: string) =>
        failRead.on ? Promise.reject(new Error("restriction store down")) : real(personId, companyId);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe("tool gate database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const CRM = `partnersinbiz.crm-${randomUUID().slice(0, 8)}`;
const WIKI = `paperclip.llm-wiki-${randomUUID().slice(0, 8)}`;
const manifest = (key: string) => ({
  id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "Fixture", author: "Paperclip",
  categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" },
  tools: [{ name: "read", displayName: "Read", description: "Read", parametersSchema: { type: "object" } }],
}) as unknown as PaperclipPluginManifestV1;

(support.supported ? describe : describe.skip)("tool gate (PAR-12608 4.8, 4.9 decision 4)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const call = vi.fn(async () => ({ content: "ok" }));
  const workerManager = { isRunning: () => true, call } as unknown as PluginWorkerManager;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(() => { failRead.on = false; call.mockClear(); vi.unstubAllEnvs(); });

  /** A company in `mode`, a person (flagged or not, CRM on his list) and a running run working for him. */
  async function seed(mode: MemberRestrictionMode, flagged: boolean) {
    const [company] = await db.insert(companies).values({
      name: "Tool gate", issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const companyId = company!.id;
    const person = `p-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: person, name: person, email: `${person}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: person, status: "active", membershipRole: "operator",
      restricted: flagged, restrictedPluginKeys: [CRM],
    });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Worker", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Work", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, invocationSource: "assignment", status: "running",
      contextSnapshot: { issueId: issue!.id }, responsibleUserId: person,
    }).returning();
    await db.insert(toolPolicies).values({ companyId, name: "Allow all", policyType: "allow", selectors: { agentId: agent!.id } });
    const [application] = await db.insert(toolApplications).values({
      companyId, name: "Mail", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Mail", uid: `fixture/${randomUUID()}`, transport: "mcp_remote",
      status: "active", enabled: true, healthStatus: "ok", config: {},
    }).returning();
    await db.insert(toolCatalogEntries).values({
      companyId, applicationId: application!.id, connectionId: connection!.id, name: "send", toolName: "send",
      riskLevel: "read", status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
    });
    const runContext = { companyId, agentId: agent!.id, runId: run!.id, projectId: "" };
    const setFlag = (restricted: boolean) => db.update(companyMemberships).set({ restricted })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, person)));
    const denials = async () => (await db.select({ details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION))))
      .map((row) => (row.details as { target?: string }).target);
    return { companyId, person, runContext, connectionId: connection!.id, setFlag, denials };
  }

  function dispatcher() {
    const d = createPluginToolDispatcher({ workerManager, toolGate: pluginToolGate(db) });
    d.registerPluginTools(CRM, manifest(CRM), randomUUID());
    d.registerPluginTools(WIKI, manifest(WIKI), randomUUID());
    return d;
  }

  const outcome = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  describe("plugin gate in the dispatcher (AC-K2)", () => {
    it("refuses a plugin not on his list for a run working for him, and never reaches the worker", async () => {
      const s = await seed("enforce", true);
      await expect(dispatcher().executeTool(`${WIKI}:read`, {}, s.runContext))
        .rejects.toMatchObject({ status: 403, details: { code: "MEMBER_RESTRICTED" } });
      expect(call).not.toHaveBeenCalled();
      await expect(dispatcher().executeTool(`${CRM}:read`, {}, s.runContext)).resolves.toMatchObject({ result: { content: "ok" } });
      expect(await s.denials()).toEqual([`plugin:${WIKI}:tool:${WIKI}:read`]);
    });

    it("reads the run's person, not one the caller names in the run context", async () => {
      const s = await seed("enforce", true);
      const named = { ...s.runContext, onBehalfOfUserId: `someone-${randomUUID()}`, onBehalfOfRestricted: false };
      await expect(dispatcher().executeTool(`${WIKI}:read`, {}, named)).rejects.toMatchObject({ status: 403 });
    });

    it("lets every call through for an unflagged person, under report (recorded), and under off", async () => {
      for (const [mode, flagged] of [["enforce", false], ["report", true], ["off", true]] as const) {
        const s = await seed(mode, flagged);
        await expect(dispatcher().executeTool(`${WIKI}:read`, {}, s.runContext), `${mode} ${flagged}`).resolves.toBeTruthy();
        expect(await s.denials()).toEqual(mode === "report" ? [`plugin:${WIKI}:tool:${WIKI}:read`] : []);
      }
    });

    it("kill switch `off`: an enforce company behaves as off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const s = await seed("enforce", true);
      await expect(dispatcher().executeTool(`${WIKI}:read`, {}, s.runContext)).resolves.toBeTruthy();
      expect(await s.denials()).toEqual([]);
    });

    it("failing read: 503 MEMBER_RESTRICTION_UNAVAILABLE and the worker is never called", async () => {
      const s = await seed("enforce", true);
      failRead.on = true;
      await expect(dispatcher().executeTool(`${CRM}:read`, {}, s.runContext))
        .rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
      expect(call).not.toHaveBeenCalled();
    });

    it("refuses a run that cannot be found once the company is not off", async () => {
      const s = await seed("enforce", true);
      await expect(dispatcher().executeTool(`${CRM}:read`, {}, { ...s.runContext, runId: randomUUID() }))
        .rejects.toMatchObject({ status: 403, details: { code: "TOOL_RUN_NOT_FOUND" } });
    });

    it("keeps the refusal's status and code through the tool gateway (C11 gateway path)", async () => {
      const s = await seed("enforce", true);
      const gateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher(), toolActionSigningSecret: "tool-gate" });
      const session = await gateway.createSession({ companyId: s.runContext.companyId, agentId: s.runContext.agentId, runId: s.runContext.runId });
      const refused = await outcome(gateway.executeTool({ sessionToken: session.token, tool: `${WIKI}:read`, parameters: {} }));
      expect(refused).toMatchObject({ status: 403, reasonCode: "MEMBER_RESTRICTED" });
      expect(call).not.toHaveBeenCalled();
      // A plugin tool is core's, not a connector: the one on his list still runs for him.
      await expect(gateway.executeTool({ sessionToken: session.token, tool: `${CRM}:read`, parameters: {} }))
        .resolves.toMatchObject({ status: "completed" });
      expect(await s.denials()).toEqual([`plugin:${WIKI}:tool:${WIKI}:read`]);
    });
  });

  describe("connector tools closed for his runs (AC-T3, AC-T4, AC-M6)", () => {
    async function gatewayFor(s: Awaited<ReturnType<typeof seed>>) {
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "tool-gate" });
      const session = await gateway.createSession({ companyId: s.runContext.companyId, agentId: s.runContext.agentId, runId: s.runContext.runId });
      const connectorNames = async () => (await gateway.listToolsForSession(session.token))
        .filter((tool) => tool.connectionId === s.connectionId).map((tool) => tool.name);
      return { gateway, session, connectorNames };
    }

    it("lists connector tools for an unflagged person and none for a restricted one, checked on every call", async () => {
      const s = await seed("enforce", false);
      const g = await gatewayFor(s);
      const [name] = await g.connectorNames();
      expect(name).toBeTruthy();

      await s.setFlag(true);
      expect(await g.connectorNames()).toEqual([]);
      const refused = await outcome(g.gateway.executeTool({ sessionToken: g.session.token, tool: name!, parameters: {} }));
      expect(refused).toMatchObject({ status: 403, reasonCode: "MEMBER_RESTRICTED" });
      expect(await s.denials()).toEqual([`connector:${name}`]);

      await s.setFlag(false);
      expect(await g.connectorNames()).toEqual([name]);
    });

    it("report keeps the list and records a would-refuse; off keeps it silent", async () => {
      for (const mode of ["report", "off"] as const) {
        const s = await seed(mode, true);
        const g = await gatewayFor(s);
        expect((await g.connectorNames()).length, mode).toBe(1);
      }
    });

    it("kill switch `off`: an enforce company keeps connector tools", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const s = await seed("enforce", true);
      expect((await (await gatewayFor(s)).connectorNames()).length).toBe(1);
    });

    it("failing read: listing and a call by name answer 503 MEMBER_RESTRICTION_UNAVAILABLE", async () => {
      const s = await seed("enforce", false);
      const g = await gatewayFor(s);
      const [name] = await g.connectorNames();
      failRead.on = true;
      expect(await outcome(g.gateway.listToolsForSession(g.session.token)))
        .toMatchObject({ status: 503, reasonCode: "MEMBER_RESTRICTION_UNAVAILABLE" });
      expect(await outcome(g.gateway.executeTool({ sessionToken: g.session.token, tool: name!, parameters: {} })))
        .toMatchObject({ status: 503, reasonCode: "MEMBER_RESTRICTION_UNAVAILABLE" });
    });
  });
});
