import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginEventType } from "@paperclipai/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logActivity, persistActivity, publishActivity, setPluginEventBus } from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createHeartbeatLifecycle } from "../services/heartbeat/run-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
// Chat privacy is a database rule: in CI this suite must run, never skip.
if (!support.supported && process.env.CI) throw new Error(`agent chat plugin event tests cannot run in CI: ${support.reason}`);
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent chat plugin event tests: ${support.reason}`);

// The events the test plugin subscribes to (AC-P17). Cockpit's memory handler listens on
// issue.created, issue.updated and issue.comment.created (plugin-cockpit/src/register.ts);
// the wiki registers its handlers through ctx.events.on for the issue events (plugin-llm-wiki/src/worker.ts).
const ISSUE_EVENTS = ["issue.created", "issue.updated", "issue.comment.created", "issue.document.created", "issue.document.updated"] as const;
const RUN_EVENTS = ["agent.run.finished", "agent.run.failed"] as const;

describePostgres("no plugin event for an agent chat (PAR-12829)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentX: string;
  const userA = "user-a";
  let received: PluginEvent[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-chat-plugin-events-");
    db = createDb(database.connectionString);
    const bus = createPluginEventBus();
    const plugin = bus.forPlugin("test.chat-privacy");
    for (const type of [...ISSUE_EVENTS, ...RUN_EVENTS] as PluginEventType[]) {
      plugin.subscribe(type, async (event) => { received.push(event); });
    }
    setPluginEventBus(bus);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    received = [];
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chat privacy", issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6)}` });
    [{ id: agentX }] = await db.insert(agents).values({ companyId, name: "Agent X", role: "worker", adapterType: "process", adapterConfig: {} }).returning({ id: agents.id });
  });

  const insertTask = async (kind: "chat" | "open" | "private", runner: Db = db) => {
    const [row] = await runner.insert(issues).values({
      companyId, title: `${kind} task`, status: "in_progress", assigneeAgentId: agentX,
      ...(kind === "private" ? { visibility: "private" } : {}),
      ...(kind === "chat" ? { conversationAgentId: agentX, conversationUserId: userA, conversationState: "active" as const } : {}),
    }).returning({ id: issues.id });
    return row.id;
  };

  /** Create, a message of A, a reply of X with a Learned line, a document, an upload, an update. */
  const runConversation = async (issueId: string) => {
    const base = { companyId, entityType: "issue", entityId: issueId };
    const asUser = { ...base, actorType: "user" as const, actorId: userA };
    const asAgent = { ...base, actorType: "agent" as const, actorId: agentX, agentId: agentX };
    await logActivity(db, { ...asUser, action: "issue.created", details: { title: "chat" } });
    await logActivity(db, { ...asUser, action: "issue.comment_added", details: { commentId: randomUUID(), bodySnippet: "my salary is 10" } });
    await logActivity(db, { ...asAgent, action: "issue.comment_added", details: { commentId: randomUUID(), bodySnippet: "**Learned:** A earns 10" } });
    await logActivity(db, { ...asAgent, action: "issue.document_created", details: { key: "notes" } });
    await logActivity(db, { ...asAgent, action: "issue.document_updated", details: { key: "notes" } });
    await logActivity(db, { ...asUser, action: "issue.attachment_added", details: { attachmentId: randomUUID() } });
    await logActivity(db, { ...asAgent, action: "issue.updated", details: { status: "in_review" } });
    // An entry about another entity that names the task through issueId.
    await logActivity(db, { companyId, actorType: "agent", actorId: agentX, agentId: agentX, action: "issue.comment.created",
      entityType: "issue_comment", entityId: randomUUID(), issueId, details: { bodySnippet: "**Learned:** again" } });
  };
  const expected = ["issue.created", "issue.comment.created", "issue.comment.created", "issue.document.created", "issue.document.updated", "issue.updated", "issue.comment.created"];

  it("AC-P17: an open task sends its events as today", async () => {
    const open = await insertTask("open");
    await runConversation(open);
    await vi.waitFor(() => expect(received).toHaveLength(expected.length));
    expect(received.map(e => e.eventType)).toEqual(expected);
    expect(received.filter(e => e.entityType === "issue").every(e => e.entityId === open)).toBe(true);
  });

  it("AC-P17: a private task that is not a chat sends its events as today (Q7 scope)", async () => {
    const privateTask = await insertTask("private");
    await runConversation(privateTask);
    await vi.waitFor(() => expect(received).toHaveLength(expected.length));
    expect(received.map(e => e.eventType)).toEqual(expected);
  });

  it("AC-P17/AC-P18: during A's chat with X no plugin receives an issue event, so no Learned handler runs", async () => {
    const chat = await insertTask("chat");
    const open = await insertTask("open");
    await runConversation(chat);
    // A control event on an open task, published after the chat's: once it arrives, any chat event would have too.
    await logActivity(db, { companyId, actorType: "user", actorId: userA, action: "issue.updated", entityType: "issue", entityId: open, details: {} });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toEqual([expect.objectContaining({ eventType: "issue.updated", entityId: open })]);
    expect(JSON.stringify(received)).not.toContain("Learned");
  });

  it("keeps the activity row and the live publication for a chat; only the plugin event is dropped", async () => {
    const chat = await insertTask("chat");
    const { activity, publication } = await persistActivity(db, { companyId, actorType: "user", actorId: userA,
      action: "issue.comment_added", entityType: "issue", entityId: chat, details: { bodySnippet: "hi" } });
    expect(activity?.id).toBeTruthy();
    expect(publication.payload).toMatchObject({ issueId: chat, action: "issue.comment_added" });
    expect(publication.pluginEvent).toBeNull();
  });

  it("drops the event for a chat created in the same transaction", async () => {
    const publication = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const chat = await insertTask("chat", tx);
      return (await persistActivity(tx, { companyId, actorType: "agent", actorId: agentX, action: "issue.created", entityType: "issue", entityId: chat })).publication;
    });
    expect(publication.pluginEvent).toBeNull();
    publishActivity(publication);
  });

  describe("run events", () => {
    const publishRun = (issueId: string, status: "succeeded" | "failed", error: string | null) =>
      createHeartbeatLifecycle(db, {} as never).publishRunLifecyclePluginEventData({
        companyId, runId: randomUUID(), agentId: agentX, status, invocationSource: "on_demand", triggerDetail: "manual",
        error, errorCode: error ? "adapter_failed" : null, issueId, startedAt: new Date(), finishedAt: new Date(),
      });

    it("AC-P17: a chat's run still sends agent.run.finished and agent.run.failed, with error null", async () => {
      const chat = await insertTask("chat");
      publishRun(chat, "succeeded", null);
      publishRun(chat, "failed", "A said: my salary is 10");
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received.map(e => e.eventType).sort()).toEqual(["agent.run.failed", "agent.run.finished"]);
      for (const event of received) expect(event.payload).toMatchObject({ issueId: chat, error: null });
      expect(received.find(e => e.eventType === "agent.run.failed")?.payload).toMatchObject({ errorCode: "adapter_failed" });
    });

    it("an open task's failed run keeps its error text", async () => {
      const open = await insertTask("open");
      publishRun(open, "failed", "Adapter failed");
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({ eventType: "agent.run.failed", payload: { issueId: open, error: "Adapter failed" } });
    });
  });
});
