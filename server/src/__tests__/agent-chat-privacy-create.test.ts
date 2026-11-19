import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issueAccessGrants, issues, projects } from "@paperclipai/db";
import { sendAgentChatMessage } from "../services/agent-chat-messages.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { CHAT_ALWAYS_PRIVATE, issueService } from "../services/issues.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

/**
 * PAR-12823 (chat privacy CP-2b, PAR-12774 plan 4.1). A chat is created
 * private, as its own privacy root, with no project and no grant, through
 * both creators (the chat route and the proactive message). Nobody can open
 * it again: `visibility` on a chat is refused in the service and the update
 * route, and a grant on a chat is refused (plan Q4). Each refusal is 422
 * "A chat is always private".
 */

describe("agent chat privacy create database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("a chat is created private and cannot be opened", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  /** A (the fixture's person) and his chat with X, opened once through the chat route as the UI does. */
  let f: Fixture;
  let cookie: string;
  let chat: { id: string };
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true });
    // One sign-in for the file: the auth handler rate-limits repeated sign-ins.
    f = await fixture();
    cookie = await server.humanSession(f.responsibleUserId!);
    const response = await call("POST", `/companies/${f.companyId}/chats/${f.agentId}`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    chat = await response.json() as { id: string };
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const fixture = () => server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true });
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const message = { body: "Three PRs need your review.", idempotencyKey: "chat-privacy-create" };
  const row = async (id: string) => (await server.db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const grantsOn = (id: string) => server.db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, id));
  const personalProjects = (of: Fixture) => server.db.select().from(projects).where(eq(projects.companyId, of.companyId))
    .then(rows => rows.filter(project => project.personalOwnerUserId));
  const call = (method: string, path: string, body: unknown) => fetch(`${server.apiUrl}/api${path}`, {
    method, headers: { Cookie: cookie, Origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const expectPrivateChat = async (of: Fixture, id: string) => {
    expect(await row(id)).toMatchObject({
      id, visibility: "private", privacyRootIssueId: id, projectId: null,
      conversationAgentId: of.agentId, conversationUserId: of.responsibleUserId,
    });
    expect(await grantsOn(id)).toEqual([]);
    expect(await personalProjects(of)).toEqual([]);
  };

  it("AC-P1: a chat opened through the chat route is private, its own privacy root, with no project and no grant", async () => {
    await expectPrivateChat(f, chat.id);
  });

  it("AC-P1: the proactive-message path creates the same private chat", async () => {
    const g = await fixture();
    const receipt = (await sendAgentChatMessage(server.db, g, message))!;
    await expectPrivateChat(g, receipt.conversationId);
  });

  it("a chat is private even when its creator asks for open, and an ordinary private task still goes to the personal project", async () => {
    const h = await fixture();
    const svc = issueService(server.db);
    const created = await svc.create(h.companyId, {
      title: "Chat with API eval agent", assigneeAgentId: h.agentId, visibility: "open",
      conversationAgentId: h.agentId, conversationUserId: h.responsibleUserId, conversationState: "waiting",
      status: "in_review", createdByUserId: h.responsibleUserId,
    });
    await expectPrivateChat(h, created.id);
    const task = await svc.create(h.companyId, {
      title: "Private note", visibility: "private", status: "todo", createdByUserId: h.responsibleUserId,
    });
    expect(await row(task.id)).toMatchObject({ visibility: "private", privacyRootIssueId: task.id });
    expect((await row(task.id)).projectId).toBe((await personalProjects(h))[0]!.id);
  });

  it("AC-P8: the service refuses visibility open on a chat with 422 and leaves it private", async () => {
    await expect(issueService(server.db).update(chat.id, { visibility: "open" }))
      .rejects.toMatchObject({ status: 422, message: CHAT_ALWAYS_PRIVATE });
    await expectPrivateChat(f, chat.id);
  });

  it("AC-P8: the update route refuses any visibility in the body for a chat with 422", async () => {
    for (const visibility of ["open", "private"]) {
      const response = await call("PATCH", `/issues/${chat.id}`, { visibility });
      expect(response.status, await response.clone().text()).toBe(422);
      expect(await response.json()).toMatchObject({ error: CHAT_ALWAYS_PRIVATE });
    }
    await expectPrivateChat(f, chat.id);
    const titled = await call("PATCH", `/issues/${chat.id}`, { title: "Chat with my planner" });
    expect(titled.status, await titled.clone().text()).toBe(200);
  });

  it("AC-P8: a grant on a chat is refused with 422 and writes no grant", async () => {
    const response = await call("POST", `/issues/${chat.id}/access-grants`, { subjectType: "agent", subjectId: f.agentId });
    expect(response.status, await response.clone().text()).toBe(422);
    expect(await response.json()).toMatchObject({ error: CHAT_ALWAYS_PRIVATE });
    await expectPrivateChat(f, chat.id);
  });

  // Last: it gives A a personal private project.
  it("a grant on an ordinary private task still works for its owner", async () => {
    const task = await issueService(server.db).create(f.companyId, {
      title: "Private plan", visibility: "private", status: "todo", createdByUserId: f.responsibleUserId,
      responsibleUserId: f.responsibleUserId,
    });
    const response = await call("POST", `/issues/${task.id}/access-grants`, { subjectType: "agent", subjectId: f.agentId });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await grantsOn(task.id)).toHaveLength(1);
  });
});
