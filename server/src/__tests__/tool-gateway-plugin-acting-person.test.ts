import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  toolPolicies,
} from "@paperclipai/db";
import type { MemberRestrictionMode } from "@paperclipai/shared";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12715 (C2-5, H3 core half): a plugin tool an agent calls through the tool
// gateway receives the run's person and the restriction mark in its run context.

const failReads = vi.hoisted(() => ({ on: false }));

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

const TOOL = "fixture:read_status";
const support = await getEmbeddedPostgresTestSupport();

describe("tool gateway plugin acting person database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("tool gateway hands plugin tools the acting person (AC-H3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-acting-person-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    failReads.on = false;
    vi.unstubAllEnvs();
  });

  function dispatcher(received: ToolRunContext[]): PluginToolDispatcher {
    return {
      initialize: async () => {},
      teardown: () => {},
      listToolsForAgent: () => [{
        name: TOOL, displayName: "Read status", description: "Fixture.", parametersSchema: { type: "object" }, pluginId: "fixture-plugin",
      }],
      getTool: () => null,
      executeTool: async (_name, _parameters, runContext) => {
        received.push(runContext);
        return { pluginId: "fixture-plugin", toolName: "read_status", result: { content: "ok" } };
      },
      registerPluginTools: () => {},
      unregisterPluginTools: () => {},
      toolCount: () => 1,
      getRegistry: () => {
        throw new Error("not implemented");
      },
    };
  }

  async function callAs(mode: MemberRestrictionMode, flagged: boolean, personless = false) {
    const [company] = await db.insert(companies).values({
      name: "Gateway acting person", issuePrefix: `G${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const person = `p-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: person, name: person, email: `${person}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: person, status: "active", membershipRole: "operator", restricted: flagged,
    });
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, title: "Work", status: "in_progress", assigneeAgentId: agent!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running",
      contextSnapshot: { issueId: issue!.id }, responsibleUserId: personless ? null : person,
    }).returning();
    await db.insert(toolPolicies).values({
      companyId: company!.id, name: "Allow fixture", policyType: "allow", selectors: { toolName: TOOL },
    });
    const received: ToolRunContext[] = [];
    const gateway = createToolGatewayService(db, {
      pluginToolDispatcher: dispatcher(received),
      toolActionSigningSecret: "tool-gateway-acting-person",
    });
    const session = await gateway.createSession({ companyId: company!.id, agentId: agent!.id, runId: run!.id });
    const outcome = await gateway.executeTool({ sessionToken: session.token, tool: TOOL, parameters: {} })
      .then(() => null, (error: unknown) => error);
    return { person, received, outcome };
  }

  it("carries the run's person, marked restricted only for a flagged person under enforce", async () => {
    const r = await callAs("enforce", true);
    expect(r.outcome).toBeNull();
    expect(r.received).toEqual([expect.objectContaining({ onBehalfOfUserId: r.person, onBehalfOfRestricted: true })]);

    for (const [mode, flagged] of [["enforce", false], ["report", true], ["off", true]] as const) {
      const other = await callAs(mode, flagged);
      expect(other.received, `${mode} flagged=${flagged}`)
        .toEqual([expect.objectContaining({ onBehalfOfUserId: other.person, onBehalfOfRestricted: false })]);
    }
  });

  it("carries no person for a run without one", async () => {
    const r = await callAs("enforce", true, true);
    expect(r.received).toEqual([expect.objectContaining({ onBehalfOfUserId: null, onBehalfOfRestricted: false })]);
  });

  it("kill switch `off`: a flagged person under enforce is not marked restricted", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const r = await callAs("enforce", true);
    expect(r.received).toEqual([expect.objectContaining({ onBehalfOfUserId: r.person, onBehalfOfRestricted: false })]);
  });

  it("refuses with 503 MEMBER_RESTRICTION_UNAVAILABLE and never calls the plugin when the read fails", async () => {
    failReads.on = true;
    const r = await callAs("enforce", true);
    expect(r.outcome).toMatchObject({ status: 503, reasonCode: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(r.received).toEqual([]);
  });
});
