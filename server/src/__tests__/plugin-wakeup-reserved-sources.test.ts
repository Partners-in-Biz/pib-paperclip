// PAR-9770: a plugin wakeup may not claim a server-reserved wake source. The
// execution-stage cap exemption trusts contextSnapshot.source
// "issue.execution_stage"; plugin issues.requestWakeup and batch wakeups copy a
// caller-supplied contextSource, so they must refuse the reserved sources.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  environmentLeases,
  environments,
  executionWorkspaces,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { buildHostServices } from "../services/plugin-host-services.ts";
import { readTicketRunsPerHourCap, SERVER_RESERVED_WAKE_SOURCES } from "../services/issue-wake-guards.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Reserved wake source test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const eventBusStub = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as any;

describeEmbeddedPostgres("plugin wakeups and server-reserved wake sources (PAR-9770)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-reserved-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    for (let attempt = 0; ; attempt += 1) {
      try {
        for (const table of [environmentLeases, issueRelations, issueComments, issues, heartbeatRunEvents,
          activityLog, costEvents, heartbeatRuns, agentWakeupRequests, agentRuntimeState, agents, environments,
          executionWorkspaces, companySkills, companyMemberships, companies]) {
          await db.delete(table);
        }
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // An open issue whose ticket already has the hourly cap of runs.
  async function seedAtCap() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user",
      email: "reserved-wake@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "At cap", status: "todo",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    for (let i = 0; i < readTicketRunsPerHourCap(); i += 1) {
      const at = new Date(Date.now() - (10 + i) * 60_000);
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment",
        status: "succeeded", responsibleUserId: "responsible-user", createdAt: at, startedAt: at, finishedAt: at,
        contextSnapshot: { issueId } });
    }
    return { companyId, agentId, issueId };
  }

  async function runCount(agentId: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length;
  }

  async function wakeRows(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
  }

  function pluginServices() {
    return buildHostServices(db, randomUUID(), "paperclip.reserved-wake-test", eventBusStub);
  }

  const reservedCases = [...SERVER_RESERVED_WAKE_SOURCES].flatMap((contextSource) =>
    (["requestWakeup", "requestWakeups"] as const).map((path) => [path, contextSource] as const));

  it("reserves exactly the execution-stage and review-verdict sources", () => {
    expect([...SERVER_RESERVED_WAKE_SOURCES].sort())
      .toEqual(["issue.comment.review_verdict", "issue.execution_stage"]);
  });

  // Criteria 1, 2, 3: both plugin paths, both reserved sources, issue at cap.
  it.each(reservedCases)("rejects plugin %s with contextSource %s at cap, and starts no run",
    async (path, contextSource) => {
      const ids = await seedAtCap();
      const before = await runCount(ids.agentId);
      const services = pluginServices();
      const reason = contextSource === "issue.execution_stage" ? "execution_review_requested" : "issue_review_verdict";
      const call = path === "requestWakeup"
        ? services.issues.requestWakeup({ issueId: ids.issueId, companyId: ids.companyId, reason, contextSource })
        : services.issues.requestWakeups({ issueIds: [ids.issueId], companyId: ids.companyId, reason, contextSource });
      await expect(call).rejects.toMatchObject({ status: 400 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await wakeRows(ids.agentId)).toHaveLength(0);
      expect(await runCount(ids.agentId)).toBe(before);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    });

  // Criterion 4: any other source behaves as before (at cap: cap-skipped, no run).
  it.each(["requestWakeup", "requestWakeups"] as const)(
    "keeps the normal cap for plugin %s with an unreserved source",
    async (path) => {
      const ids = await seedAtCap();
      const before = await runCount(ids.agentId);
      const services = pluginServices();
      const params = { companyId: ids.companyId, reason: "execution_review_requested", contextSource: "plugin.custom" };
      const result = path === "requestWakeup"
        ? await services.issues.requestWakeup({ issueId: ids.issueId, ...params })
        : (await services.issues.requestWakeups({ issueIds: [ids.issueId], ...params }))[0]!;
      expect(result).toMatchObject({ queued: false, runId: null });
      expect((await wakeRows(ids.agentId)).at(-1)).toMatchObject({ status: "skipped", reason: "issue_run_cap" });
      expect(await runCount(ids.agentId)).toBe(before);
    });

  // Criterion 5: the issues route's own execution-stage handoff keeps the exemption.
  it("still exempts a real execution-stage handoff from the cap", async () => {
    const ids = await seedAtCap();
    const transitioningActorId = randomUUID();
    // The exact request routes/issues.ts builds for a review handoff.
    const run = await heartbeat.wakeup(ids.agentId, {
      source: "assignment", triggerDetail: "system", reason: "execution_review_requested",
      payload: { issueId: ids.issueId, mutation: "update", executionStage: { wakeRole: "reviewer" } },
      requestedByActorType: "agent", requestedByActorId: transitioningActorId,
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId, wakeReason: "execution_review_requested",
        source: "issue.execution_stage", executionStage: { wakeRole: "reviewer" } },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(row?.status).toBe("succeeded");
    }, { timeout: 15_000 });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });
});
