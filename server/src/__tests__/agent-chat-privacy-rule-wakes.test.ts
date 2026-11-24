import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12900 (chat privacy CP-2a-2b, breakdown F12, rule PAR-12618): every wake
 * of a chat's agent on its chat gives the run the chat's person
 * (`heartbeat_runs.responsible_user_id` = `issues.conversation_user_id`). The
 * chat's own `responsible_user_id` is set to the owner O on purpose, so a run
 * that fell back to the task's person, a parent, the company default or a
 * comment author other than A would fail. One case per wake site.
 */

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Chat wake test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();

describe("agent chat wakes database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat wakes give the run the chat's person (F12)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-rule-wakes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  /** A has the chat with X; B is another operator; O owns the company and is its default person. */
  async function seed(chat: Partial<typeof issues.$inferInsert> = {}) {
    const companyId = randomUUID(), X = randomUUID(), chatId = randomUUID();
    const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Chat wakes",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: O });
    await db.insert(authUsers).values([A, B, O].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([[A, "operator"], [B, "operator"], [O, "owner"]].map(([principalId, membershipRole]) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole })));
    await db.insert(agents).values({ id: X, companyId, name: "Writer", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: chatId, companyId, title: "Chat with Writer", status: "in_progress",
      assigneeAgentId: X, conversationAgentId: X, conversationUserId: A, conversationState: "active",
      createdByUserId: A, responsibleUserId: O, ...chat });
    const message = async (authorUserId: string) => (await db.insert(issueComments).values({ companyId, issueId: chatId,
      authorUserId, body: `Message from ${authorUserId}`, clientRequestId: randomUUID() }).returning())[0]!;
    return { companyId, X, chatId, A, B, O, message };
  }

  /** Every run of the company, after the queue settles, works for `person`. */
  async function expectEveryRunFor(companyId: string, person: string) {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map(run => run.responsibleUserId)).toEqual(runs.map(() => person));
    return runs;
  }

  it("chat comment route: A's message wakes X for A, not the task's person O", async () => {
    const f = await seed();
    await f.message(f.A);
    // The route's chat branch (routes/issues.ts) calls exactly this after saving.
    expect(await deliverConversationComments(db, { id: f.chatId, companyId: f.companyId, conversationAgentId: f.X }, heartbeat.wakeup)).toBe("delivered");
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("conversation re-delivery: a message another person authored still runs for the chat's person", async () => {
    const f = await seed();
    // A legacy or seeded message by B on A's chat; the route refuses B today.
    await f.message(f.B);
    expect(await deliverConversationComments(db, { id: f.chatId, companyId: f.companyId, conversationAgentId: f.X }, heartbeat.wakeup)).toBe("delivered");
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("recovery: the stranded-chat sweep re-delivers an undelivered message for the chat's person", async () => {
    const f = await seed();
    await f.message(f.B);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("manual run: the chat's person starting X runs for A; another person is refused", async () => {
    const f = await seed();
    await expect(heartbeat.wakeup(f.X, { causingActor: "system", manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      payload: { issueId: f.chatId }, requestedByActorType: "user", requestedByActorId: f.B })).rejects.toThrow("conversation owner");
    const run = await heartbeat.wakeup(f.X, { causingActor: "system", manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      payload: { issueId: f.chatId }, requestedByActorType: "user", requestedByActorId: f.A });
    expect(run?.responsibleUserId).toBe(f.A);
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("system wake without a message: runs for the chat's person, not the task's person O", async () => {
    const f = await seed();
    const run = await heartbeat.wakeup(f.X, { causingActor: "system", source: "automation", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: f.chatId }, requestedByActorType: "system", requestedByActorId: null,
      contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "issue_assigned" } });
    expect(run).not.toBeNull();
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("system wake on a chat with no task person: the chat's person, not the company default O", async () => {
    const f = await seed({ responsibleUserId: null });
    const run = await heartbeat.wakeup(f.X, { causingActor: "system", source: "automation", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: f.chatId }, requestedByActorType: "system", requestedByActorId: null,
      contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "issue_assigned" } });
    expect(run).not.toBeNull();
    const [stored] = await expectEveryRunFor(f.companyId, f.A);
    expect(stored!.contextSnapshot?.executionIdentityCause).toBeUndefined();
  });

  it("wake naming another person in its context: still the chat's person", async () => {
    const f = await seed();
    const run = await heartbeat.wakeup(f.X, { causingActor: "system", source: "automation", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: f.chatId }, requestedByActorType: "user", requestedByActorId: f.B,
      contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "issue_assigned", responsibleUserId: f.B } });
    expect(run).not.toBeNull();
    await expectEveryRunFor(f.companyId, f.A);
  });

  it("retry: a retry of a run that worked for B runs for the chat's person", async () => {
    const f = await seed();
    const [origin] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.X, status: "failed",
      finishedAt: new Date(), invocationSource: "automation", triggerDetail: "system", responsibleUserId: f.B,
      contextSnapshot: { issueId: f.chatId } }).returning();
    const run = await heartbeat.wakeup(f.X, { causingActor: "system", source: "automation", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: f.chatId }, requestedByActorType: "system", requestedByActorId: null,
      contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "issue_assigned", retryOfRunId: origin!.id } });
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const retries = runs.filter(row => row.id !== origin!.id);
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.map(row => row.responsibleUserId)).toEqual(retries.map(() => f.A));
  });

  it("deferred promotion: a message held behind a running turn is promoted for the chat's person", async () => {
    const f = await seed();
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementationOnce(async () => { await blocked; return execute(); });
    await f.message(f.A);
    await deliverConversationComments(db, { id: f.chatId, companyId: f.companyId, conversationAgentId: f.X }, heartbeat.wakeup);
    try {
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalled(), { timeout: 5_000 });
      await f.message(f.B);
      await deliverConversationComments(db, { id: f.chatId, companyId: f.companyId, conversationAgentId: f.X }, heartbeat.wakeup);
    } finally {
      finish();
    }
    await expectEveryRunFor(f.companyId, f.A);
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
