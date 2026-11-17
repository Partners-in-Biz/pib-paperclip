import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issueAccessGrants,
  issues,
} from "@paperclipai/db";
import { issueReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12822 (chat privacy CP-2a-1): the chat rule in the list conditions
 * (PAR-12774 plan 4.2, place 1). `issueReadSqlCondition` ANDs the chat rule
 * onto every return but the local board's: AC-P5 (search), AC-P6 (lists, mode
 * `off`), AC-P8 (lists, seeded grant). Chats are seeded directly; CP-2b makes
 * creation private later. One legacy chat stays `open`, as every live chat is
 * today (plan P6), so the rule is proven apart from the private flag.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent chat rule in lists database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat rule in the list conditions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-rule-lists-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const user = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session" });

  /**
   * A (operator, has a chat with X and one with Z), B (operator), O (owner),
   * D (admin), I (owner and instance admin, has his own chat with X); X and Z
   * (chat agents), Y (another agent). `task` is an ordinary open task.
   */
  async function seed() {
    const companyId = randomUUID();
    const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
    const D = `d-${randomUUID()}`, I = `i-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Chat rule", issuePrefix: `L${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values([
      [A, "operator"], [B, "operator"], [O, "owner"], [D, "admin"], [I, "owner"],
    ].map(([principalId, membershipRole]) => ({ companyId, principalType: "user", principalId, status: "active", membershipRole })));
    await db.insert(instanceUserRoles).values({ userId: I, role: "instance_admin" });
    const [X, Y, Z] = await db.insert(agents).values([
      { companyId, name: "Writer", status: "idle", adapterType: "process" },
      { companyId, name: "Editor", status: "idle", adapterType: "process" },
      { companyId, name: "Planner", status: "idle", adapterType: "process" },
    ]).returning();
    const chat = (person: string, title: string, extra: Partial<typeof issues.$inferInsert>, agentId = X!.id): typeof issues.$inferInsert => ({
      id: randomUUID(), companyId, title, status: "in_progress", conversationAgentId: agentId, conversationUserId: person,
      conversationState: "waiting", assigneeAgentId: agentId, ...extra,
    });
    // A legacy chat as in production: open, A is creator and responsible person.
    const legacy = chat(A, "Chat with Writer (legacy)", { visibility: "open", createdByUserId: A, responsibleUserId: A });
    // A private chat that names A only as its person (4.2: "named on the task").
    const privateId = randomUUID();
    const privateChat = { ...chat(A, "Chat with Planner (private)", { visibility: "private", createdByAgentId: Z!.id }, Z!.id), id: privateId, privacyRootIssueId: privateId };
    const adminChat = chat(I, "Chat with Writer (instance admin)", { visibility: "open", createdByUserId: I, responsibleUserId: I });
    await db.insert(issues).values([legacy, privateChat, adminChat]);
    const [task] = await db.insert(issues).values({ companyId, title: "Chat with customers: plan", status: "todo", createdByUserId: O }).returning();
    const ids = { legacy: legacy.id!, private: privateId, admin: adminChat.id!, task: task!.id };
    const all = Object.values(ids);
    const agent = (agentId: string, onBehalfOfUserId?: string): AuthorizationActor =>
      ({ type: "agent", agentId, companyId, source: onBehalfOfUserId ? "agent_jwt" : "agent_key", onBehalfOfUserId });
    /** What the task list returns, by search text and by ids, sorted. */
    const lists = async (actor: AuthorizationActor) => {
      const readCondition = await issueReadSqlCondition(db, actor);
      const svc = issueService(db);
      const sorted = (rows: { id: string }[]) => rows.map(row => row.id).sort();
      return {
        search: sorted(await svc.list(companyId, { readCondition, q: "Chat with" })),
        byIds: sorted(await svc.list(companyId, { readCondition, issueIds: all })),
      };
    };
    const only = (...names: (keyof typeof ids)[]) => { const v = names.map(name => ids[name]).sort(); return { search: v, byIds: v }; };
    return { companyId, A, B, O, D, I, X: X!, Y: Y!, Z: Z!, ids, agent, lists, only };
  }

  it("A reads both his chats, the private one through conversation_user_id alone", async () => {
    const f = await seed();
    expect(await f.lists(user(f.A))).toEqual(f.only("legacy", "private", "task"));
  });

  it("a chat's agent reads only its own chats, on a run for that chat's person or with no person; on a run for B none", async () => {
    const f = await seed();
    expect(await f.lists(f.agent(f.X.id, f.A))).toEqual(f.only("legacy", "task"));
    expect(await f.lists(f.agent(f.Z.id, f.A))).toEqual(f.only("private", "task"));
    expect(await f.lists({ ...f.agent(f.X.id, f.A), authorizingUserId: f.A })).toEqual(f.only("legacy", "task"));
    expect(await f.lists({ ...f.agent(f.X.id, f.A), authorizingUserId: f.B })).toEqual(f.only("task"));
    expect(await f.lists(f.agent(f.X.id))).toEqual(f.only("legacy", "admin", "task"));
    expect(await f.lists(f.agent(f.X.id, f.B))).toEqual(f.only("task"));
  });

  it("AC-P5: Y gets nothing from the task list with search text; a plugin gets no chat", async () => {
    const f = await seed();
    expect(await f.lists(f.agent(f.Y.id))).toEqual(f.only("task"));
    expect(await f.lists(f.agent(f.Y.id, f.A))).toEqual(f.only("task"));
    expect(await f.lists({ type: "none" })).toEqual(f.only("task"));
  });

  it("enforce: B, O, D and I get no chat of A by search text and by ids", async () => {
    const f = await seed();
    for (const person of [f.B, f.O, f.D]) expect(await f.lists(user(person))).toEqual(f.only("task"));
    expect(await f.lists(user(f.I))).toEqual(f.only("admin", "task"));
    expect(await f.lists({ ...user(f.I), isInstanceAdmin: true })).toEqual(f.only("admin", "task"));
  });

  it("AC-P6: with PAPERCLIP_ISSUE_PRIVACY_MODE=off, B, O, D and I get no chat by search text and by ids", async () => {
    const f = await seed();
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    for (const person of [f.B, f.O, f.D]) expect(await f.lists(user(person))).toEqual(f.only("task"));
    expect(await f.lists(user(f.I))).toEqual(f.only("admin", "task"));
    expect(await f.lists({ ...user(f.I), isInstanceAdmin: true })).toEqual(f.only("admin", "task"));
    expect(await f.lists(f.agent(f.Y.id))).toEqual(f.only("task"));
    expect(await f.lists(user(f.A))).toEqual(f.only("legacy", "private", "task"));
  });

  it("AC-P8: a seeded grant on A's chats for B does not put them in B's list, in either mode", async () => {
    const f = await seed();
    await db.insert(issueAccessGrants).values([f.ids.legacy, f.ids.private].map(issueId =>
      ({ issueId, subjectType: "user", subjectId: f.B, source: "explicit" })));
    await db.insert(issueAccessGrants).values({ issueId: f.ids.private, subjectType: "agent", subjectId: f.Y.id, source: "explicit" });
    expect(await f.lists(user(f.B))).toEqual(f.only("task"));
    expect(await f.lists({ ...user(f.B), authorizingUserId: f.B })).toEqual(f.only("task"));
    expect(await f.lists(f.agent(f.Y.id))).toEqual(f.only("task"));
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    expect(await f.lists(user(f.B))).toEqual(f.only("task"));
  });

  it("the local board still gets every row, chats included, in either mode", async () => {
    const f = await seed();
    const local: AuthorizationActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
    const every = f.only("legacy", "private", "admin", "task");
    expect(await f.lists(local)).toEqual(every);
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    expect(await f.lists(local)).toEqual(every);
  });

  it("the instance admin gets every row except other people's chats, private tasks of others included", async () => {
    const f = await seed();
    const [secret] = await db.insert(issues).values({
      companyId: f.companyId, title: "Chat with lawyers", status: "todo", visibility: "private", createdByUserId: f.O,
    }).returning();
    const expected = [f.ids.admin, f.ids.task, secret!.id].sort();
    const svc = issueService(db);
    for (const actor of [user(f.I), { ...user(f.I), isInstanceAdmin: true }]) {
      const readCondition = await issueReadSqlCondition(db, actor);
      expect((await svc.list(f.companyId, { readCondition, q: "Chat with" })).map(row => row.id).sort()).toEqual(expected);
    }
    // B is no instance admin: neither the chats nor O's private task.
    expect(await f.lists(user(f.B))).toEqual(f.only("task"));
  });
});
