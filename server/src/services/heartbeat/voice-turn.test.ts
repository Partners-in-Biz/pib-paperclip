import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { deliverConversationComments } from "../agent-conversations.js";
import { heartbeatService } from "../heartbeat.js";
import { instanceSettingsService } from "../instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { enrichWakeContextSnapshot, mergeCoalescedContextSnapshot } from "./run-preparation.js";
import { VOICE_PLUGIN_KEY } from "./voice-run-setting.js";
import { resolveVoiceTurn, type VoiceTurnRun } from "./voice-turn.js";

/**
 * PAR-15299 (plan PAR-15073 rev 3, 5.1 and 7 "Stage 1"): every way around the four rules gives a normal run;
 * one chat comment wake with `voice` from the chat's own person, plugin enabled and both switches on gives voice.
 *
 * Comments go through the real comment route, wakes through the real outbox (`deliverConversationComments`),
 * the queue's own context enrichment and its merge, and are read back from a stored `heartbeat_runs` row.
 * The wake is captured instead of executed: no agent or provider starts.
 */

type WakeOptions = {
  source?: string;
  triggerDetail?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown>;
};
type Wake = { agentId: string; options: WakeOptions };

/**
 * The comment route and the outbox call the real `heartbeat.wakeup`. Here it records the options they pass and
 * stores the wakeup request (which marks an outbox comment delivered), but starts no run.
 */
const capture = vi.hoisted(() => ({
  wakes: [] as Array<{ agentId: string; options: Record<string, unknown> }>,
  store: null as null | ((agentId: string, options: Record<string, unknown>) => Promise<void>),
}));
vi.mock("../heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async (agentId: string, options: Record<string, unknown>) => {
        capture.wakes.push({ agentId, options: structuredClone(options) });
        await capture.store?.(agentId, options);
        return null;
      },
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe("voice turn database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

const VOICE = { version: 1, voice: { mode: "direct" }, sections: [] } as const;

(support.supported ? describe : describe.skip)("resolveVoiceTurn", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let otherAgentId: string;
  let pluginId: string;
  const OWNER = `owner-${randomUUID()}`;
  const COLLEAGUE = `colleague-${randomUUID()}`;
  const RESTRICTED = `restricted-${randomUUID()}`;
  const wakes = capture.wakes as Wake[];

  type Actor = Record<string, unknown> | undefined;
  const appFor = (actor: Actor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor ?? { type: "none", source: "none" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };
  const board = (userId: string | undefined): Actor => ({ type: "board", source: "session", userId, companyIds: [companyId] });

  async function setVoice(state: { flag: boolean; setting?: string | null; plugin?: "ready" | "absent" | "disabled" }) {
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableVoiceRunProfile: state.flag });
    await db.delete(pluginCompanySettings).where(eq(pluginCompanySettings.companyId, companyId));
    await db.delete(plugins).where(eq(plugins.pluginKey, VOICE_PLUGIN_KEY));
    if (state.plugin === "absent") return;
    const [plugin] = await db.insert(plugins).values({
      pluginKey: VOICE_PLUGIN_KEY, packageName: "@partnersinbiz/plugin-voice", version: "1.0.0", status: "ready",
      manifestJson: { id: VOICE_PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Voice", description: "Voice",
        author: "test", categories: ["ui"], capabilities: [], entrypoints: { worker: "worker.js" } } as never,
    }).returning();
    pluginId = plugin!.id;
    await db.insert(pluginCompanySettings).values({
      pluginId, companyId, enabled: state.plugin !== "disabled",
      settingsJson: state.setting === null ? {} : { voiceRunProfile: state.setting ?? "profile" },
    });
  }
  const allOn = () => setVoice({ flag: true, setting: "profile", plugin: "ready" });

  async function member(userId: string, extra: Partial<typeof companyMemberships.$inferInsert> = {}) {
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true,
      createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator", ...extra });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: userId, membershipRole: "operator", grantedByUserId: null });
  }

  async function openChat(userId: string, agent = agentId): Promise<string> {
    const res = await request(appFor(board(userId))).post(`/api/companies/${companyId}/chats/${agent}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  async function post(actor: Actor, issueId: string, body: Record<string, unknown>) {
    return request(appFor(actor)).post(`/api/issues/${issueId}/comments`)
      .send({ clientRequestId: randomUUID(), ...body });
  }
  /** One chat message through the real route; `typed` sends no metadata. */
  const say = async (userId: string, chatId: string, metadata: unknown = VOICE) => {
    const res = await post(board(userId), chatId,
      { body: "What is on my list today?", ...(metadata === "typed" ? {} : { metadata }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  /** The queue's own enrichment of a captured wake, as `heartbeat.wakeup` stores it on the run. */
  function enriched(wake: Wake): Record<string, unknown> {
    return enrichWakeContextSnapshot({
      contextSnapshot: { ...(wake.options.contextSnapshot ?? {}) },
      reason: wake.options.reason ?? null,
      source: wake.options.source as never,
      triggerDetail: (wake.options.triggerDetail ?? null) as never,
      payload: wake.options.payload ?? null,
    }).contextSnapshot;
  }

  /** Stores a queued run for a context and returns the stored row. */
  async function storeRun(
    wake: Wake,
    contextSnapshot: Record<string, unknown>,
    extra: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ): Promise<VoiceTurnRun> {
    const issueId = typeof contextSnapshot.issueId === "string" ? contextSnapshot.issueId : null;
    const [row] = await db.insert(heartbeatRuns).values({
      companyId, agentId: wake.agentId, status: "queued", invocationSource: wake.options.source ?? "on_demand",
      triggerDetail: wake.options.triggerDetail ?? null, scopeKind: issueId ? "issue" : "company", issueId,
      contextSnapshot, ...extra,
    }).returning();
    return row!;
  }
  const lastWake = () => {
    const wake = wakes.at(-1);
    expect(wake, "a wake was enqueued").toBeDefined();
    return wake!;
  };
  const runOf = async (wake = lastWake(), extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) =>
    storeRun(wake, enriched(wake), extra);
  const reasonOf = async (run: VoiceTurnRun) => {
    const decision = await resolveVoiceTurn(db, run);
    return decision.voice ? "voice" : decision.reason;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-voice-turn-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({
      name: "Voice", issuePrefix: `V${randomUUID().slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    const [agent] = await db.insert(agents).values({ companyId, name: "Leo", role: "engineer", status: "idle",
      adapterType: "process" }).returning();
    const [other] = await db.insert(agents).values({ companyId, name: "Sam", role: "engineer", status: "idle",
      adapterType: "process" }).returning();
    agentId = agent!.id;
    otherAgentId = other!.id;
    capture.store = async (wakeAgentId, options) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId: wakeAgentId,
        source: String(options.source ?? "on_demand"), status: "queued",
        idempotencyKey: (options.idempotencyKey as string | undefined) ?? null,
        payload: (options.payload as Record<string, unknown> | undefined) ?? null });
    };
    await member(OWNER);
    await member(COLLEAGUE);
    await member(RESTRICTED, { restricted: true, restrictedAgentIds: [agentId] });
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });
  beforeEach(async () => {
    wakes.length = 0;
    await allOn();
  });

  it("a chat comment wake with voice from the chat's own person gives voice, twice the same", async () => {
    const chatId = await openChat(OWNER);
    const commentId = await say(OWNER, chatId);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(stored!.metadata).toEqual(VOICE);
    const wake = lastWake();
    expect(wake.agentId).toBe(agentId);
    const run = await runOf(wake);
    const first = await resolveVoiceTurn(db, run);
    expect(first).toEqual({ voice: true, setting: "profile", chatIssueId: chatId, userId: OWNER, commentIds: [commentId] });
    expect(await resolveVoiceTurn(db, run)).toEqual(first);
    await setVoice({ flag: true, setting: "profile_and_warm" });
    expect(await resolveVoiceTurn(db, run)).toMatchObject({ voice: true, setting: "profile_and_warm" });
  });

  it("the chat route keeps only the voice marker and stores no metadata on a typed message", async () => {
    const chatId = await openChat(OWNER);
    const typed = await say(OWNER, chatId, "typed");
    const marked = await say(OWNER, chatId, { version: 1, voice: { mode: "direct" },
      sections: [{ title: "Extra", rows: [{ type: "text", text: "not kept" }] }] });
    const rows = await db.select({ id: issueComments.id, metadata: issueComments.metadata }).from(issueComments)
      .where(eq(issueComments.issueId, chatId));
    expect(rows.find((row) => row.id === typed)?.metadata).toBeNull();
    expect(rows.find((row) => row.id === marked)?.metadata).toEqual(VOICE);
  });

  it("an agent that posts the field is refused by the existing guard, and an agent comment never counts", async () => {
    const chatId = await openChat(OWNER);
    const refused = await post({ type: "agent", source: "agent_jwt", agentId, companyId, runId: randomUUID() }, chatId,
      { body: "Spoken by an agent", metadata: VOICE });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toBe("Only board users may set structured comment presentation or metadata");
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, chatId),
      eq(issueComments.body, "Spoken by an agent")))).toEqual([]);
    // A row no route writes: an agent-authored comment with the field.
    const [row] = await db.insert(issueComments).values({ companyId, issueId: chatId, authorAgentId: agentId,
      authorType: "agent", body: "Spoken by an agent", metadata: VOICE as never }).returning();
    await say(OWNER, chatId);
    const wake = lastWake();
    const run = await storeRun(wake, { ...enriched(wake), wakeCommentIds: [row!.id] });
    expect(await reasonOf(run)).toBe("comment_not_by_chat_person");
  });

  it("a board actor without a user id cannot post, and a comment with no user id never counts", async () => {
    const chatId = await openChat(OWNER);
    const refused = await post(board(undefined), chatId, { body: "No user", metadata: VOICE });
    expect([403, 404]).toContain(refused.status);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, chatId),
      eq(issueComments.body, "No user")))).toEqual([]);
    await say(OWNER, chatId);
    const wake = lastWake();
    const [row] = await db.insert(issueComments).values({ companyId, issueId: chatId, authorType: "user",
      body: "No user", metadata: VOICE as never, clientRequestId: randomUUID() }).returning();
    const run = await storeRun(wake, { ...enriched(wake), wakeCommentIds: [row!.id] });
    expect(await reasonOf(run)).toBe("comment_not_by_chat_person");
  });

  it("a person on a task that is not a chat gives a normal run", async () => {
    const [task] = await db.insert(issues).values({ companyId, title: "Plain task", status: "todo",
      assigneeAgentId: agentId, createdByUserId: OWNER, assigneeUserId: null }).returning();
    const res = await post(board(OWNER), task!.id, { body: "Spoken on a task", metadata: VOICE });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, res.body.id));
    expect(stored!.metadata).toEqual(VOICE);
    // The route wakes the assignee after it answers.
    const wake = await vi.waitFor(() => {
      const found = wakes.find((entry) => entry.options.reason === "issue_commented");
      if (!found) throw new Error("no task comment wake yet");
      return found;
    });
    expect(wake.options.contextSnapshot?.issueId).toBe(task!.id);
    expect(await reasonOf(await runOf(wake))).toBe("not_comment_wake");
    // The same wake as an on-demand one still is not a chat's.
    const onDemand = { ...wake, options: { ...wake.options, source: "on_demand" } };
    expect(await reasonOf(await runOf(onDemand))).toBe("not_chat");
  });

  it("a person on another person's chat is refused, and his comment never counts there", async () => {
    const chatId = await openChat(OWNER);
    const refused = await post(board(COLLEAGUE), chatId, { body: "Not mine", metadata: VOICE });
    expect([403, 404]).toContain(refused.status);
    await say(OWNER, chatId);
    const wake = lastWake();
    const [row] = await db.insert(issueComments).values({ companyId, issueId: chatId, authorUserId: COLLEAGUE,
      authorType: "user", body: "Not mine", metadata: VOICE as never, clientRequestId: randomUUID() }).returning();
    const merged = mergeCoalescedContextSnapshot(enriched(wake), { issueId: chatId, wakeCommentIds: [row!.id] });
    expect(await reasonOf(await storeRun(wake, merged))).toBe("comment_not_by_chat_person");
    // His own voice comment on his own chat, named on the owner's chat run: not that chat's comment.
    const ownChat = await openChat(COLLEAGUE);
    const own = await say(COLLEAGUE, ownChat);
    expect(await reasonOf(await storeRun(wake, { ...enriched(wake), wakeCommentIds: [own] }))).toBe("comment_not_found");
  });

  it("a restricted member gives a normal run once the agent is off his list", async () => {
    expect((await request(appFor(board(RESTRICTED))).post(`/api/companies/${companyId}/chats/${otherAgentId}`)).status)
      .toBe(404);
    const chatId = await openChat(RESTRICTED);
    await say(RESTRICTED, chatId);
    const run = await runOf();
    expect(await reasonOf(run)).toBe("voice");
    await db.update(companyMemberships).set({ restrictedAgentIds: [otherAgentId] })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, RESTRICTED)));
    try {
      expect(await reasonOf(run)).toBe("agent_not_listed");
    } finally {
      await db.update(companyMemberships).set({ restrictedAgentIds: [agentId] })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, RESTRICTED)));
    }
  });

  it.each([
    ["plugin not installed", { flag: true, setting: "profile", plugin: "absent" }, "setting_off"],
    ["plugin disabled for the company", { flag: true, setting: "profile", plugin: "disabled" }, "setting_off"],
    ["flag off", { flag: false, setting: "profile", plugin: "ready" }, "flag_off"],
    ["company setting off", { flag: true, setting: "off", plugin: "ready" }, "setting_off"],
    ["company setting absent", { flag: true, setting: null, plugin: "ready" }, "setting_off"],
  ] as const)("%s gives a normal run", async (_name, state, reason) => {
    const chatId = await openChat(OWNER);
    await setVoice(state);
    await say(OWNER, chatId);
    const run = await runOf();
    expect(await reasonOf(run)).toBe(reason);
    expect(await reasonOf(run)).toBe(reason);
  });

  it.each([
    ["the flag", { flag: false, setting: "profile" }, "flag_off"],
    ["the company setting", { flag: true, setting: "off" }, "setting_off"],
  ] as const)("%s turned off between comment and claim gives a normal run", async (_name, state, reason) => {
    const chatId = await openChat(OWNER);
    await say(OWNER, chatId);
    const run = await runOf();
    expect(await reasonOf(run)).toBe("voice");
    await setVoice(state);
    expect(await reasonOf(run)).toBe(reason);
  });

  it("a voice wake merged with a typed comment gives a normal run", async () => {
    const chatId = await openChat(OWNER);
    const spoken = await say(OWNER, chatId);
    const voiceWake = lastWake();
    const typed = await say(OWNER, chatId, "typed");
    const typedWake = lastWake();
    expect(typedWake).not.toBe(voiceWake);
    const merged = mergeCoalescedContextSnapshot(enriched(voiceWake), enriched(typedWake));
    expect(merged.wakeCommentIds).toEqual([spoken, typed]);
    expect(await reasonOf(await storeRun(voiceWake, merged))).toBe("comment_not_voice");
    // Two spoken turns that merge stay a voice turn.
    await say(OWNER, chatId);
    const twoSpoken = mergeCoalescedContextSnapshot(enriched(voiceWake), enriched(lastWake()));
    expect(await reasonOf(await storeRun(voiceWake, twoSpoken))).toBe("voice");
  });

  it("a comment delivered from the outbox after the switch went off gives a normal run", async () => {
    const chatId = await openChat(OWNER);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    try {
      await say(OWNER, chatId);
      expect(wakes.filter((wake) => wake.options.contextSnapshot?.issueId === chatId)).toEqual([]);
      await setVoice({ flag: true, setting: "off" });
    } finally {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    }
    const [chat] = await db.select().from(issues).where(eq(issues.id, chatId));
    expect(await deliverConversationComments(db, chat!, heartbeatService(db).wakeup)).toBe("delivered");
    const run = await runOf();
    expect(await reasonOf(run)).toBe("setting_off");
    // The same delivered run with the switch back on is a voice turn: the decision is made at claim.
    await allOn();
    expect(await reasonOf(run)).toBe("voice");
  });

  it.each([
    ["retryOfRunId", async (source: VoiceTurnRun) => ({ retryOfRunId: source.id })],
    ["scheduledRetryReason", async () => ({ scheduledRetryReason: "transient_failure" })],
    ["contextSnapshot.executionRetryAccounting", async (source: VoiceTurnRun) => ({
      contextSnapshot: { ...source.contextSnapshot, executionRetryAccounting: { failureRetries: 1 } } })],
    ["systemRecoveryAdoption", async () => ({ resultJson: { systemRecoveryAdoption: { adoptedAt: new Date().toISOString() } } })],
  ] as const)("a retry or recovery run marked by %s gives a normal run", async (_field, mark) => {
    const chatId = await openChat(OWNER);
    await say(OWNER, chatId);
    const wake = lastWake();
    const source = await runOf(wake);
    expect(await reasonOf(source)).toBe("voice");
    const retry = await storeRun(wake, enriched(wake), await mark(source));
    expect(await reasonOf(retry)).toBe("retry_or_recovery");
  });

  it("a malformed field is refused on write and never counts when stored", async () => {
    const chatId = await openChat(OWNER);
    for (const metadata of [
      { version: 1, voice: { mode: "spoken" }, sections: [] },
      { version: 1, voice: "direct", sections: [] },
      { version: 1, voice: { mode: "direct", callId: "x" }, sections: [] },
    ]) {
      const res = await post(board(OWNER), chatId, { body: "Malformed", metadata });
      expect(res.status, JSON.stringify(metadata)).toBe(400);
    }
    await say(OWNER, chatId);
    const wake = lastWake();
    for (const metadata of [
      { version: 1, voice: { mode: "spoken" }, sections: [] },
      { version: 2, voice: { mode: "direct" }, sections: [] },
      { voice: { mode: "direct" } },
      "voice",
    ]) {
      const [row] = await db.insert(issueComments).values({ companyId, issueId: chatId, authorUserId: OWNER,
        authorType: "user", body: "Malformed", metadata: metadata as never, clientRequestId: randomUUID() }).returning();
      const run = await storeRun(wake, { ...enriched(wake), wakeCommentIds: [row!.id] });
      expect(await reasonOf(run), JSON.stringify(metadata)).toBe("comment_not_voice");
    }
  });

  it("other wake kinds and broken rows give a normal run", async () => {
    const chatId = await openChat(OWNER);
    await say(OWNER, chatId);
    const wake = lastWake();
    const context = enriched(wake);
    expect(await reasonOf(await storeRun(wake, context, { invocationSource: "timer" }))).toBe("not_comment_wake");
    expect(await reasonOf(await storeRun(wake, { ...context, wakeReason: "issue_blockers_resolved" }))).toBe("not_comment_wake");
    expect(await reasonOf(await storeRun({ ...wake, agentId: otherAgentId }, context))).toBe("not_chat");
    expect(await reasonOf(await storeRun(wake, { ...context, wakeCommentIds: [], commentId: null, wakeCommentId: null })))
      .toBe("no_comments");
    const missing = await storeRun(wake, { ...context, wakeCommentIds: [randomUUID()] });
    expect(await reasonOf(missing)).toBe("comment_not_found");
    const failing = { ...db, select: () => { throw new Error("database down"); } } as unknown as typeof db;
    expect(await resolveVoiceTurn(failing, await runOf(wake), { readVoiceFlag: async () => true }))
      .toEqual({ voice: false, reason: "read_failed" });
  });
});
