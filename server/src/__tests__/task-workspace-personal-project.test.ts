import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  issueAccessGrants, issues, projectAccessMembers, projects, projectWorkspaces,
} from "@paperclipai/db";
import { accessService } from "../services/access.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { assertTaskWorkspaceExecutionAccess } from "../services/task-workspace-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14639: a run on a private task parked in its owner's personal private
 * project. The agent holds a grant on the task, never membership of the
 * project. Run setup may use that project only for a run that works for the
 * owner; every other case keeps the project privacy denial.
 */

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("run setup on a task in a personal private project (PAR-14639)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const OWNER = `owner-${randomUUID()}`;
  const OTHER = `other-${randomUUID()}`;
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-workspace-personal-project-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Personal project runs", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    const now = new Date();
    await db.insert(authUsers).values([OWNER, OTHER].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([OWNER, OTHER].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: "operator" })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Helper", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, permissions: {} }).returning();
    agentId = agent!.id;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
  });

  /** A private task with no project: the create path parks it in the owner's personal private project. */
  async function personalTask() {
    const task = await issueService(db).create(companyId, {
      title: "Private work", status: "todo", priority: "medium", visibility: "private",
      createdByUserId: OWNER, assigneeAgentId: agentId,
    } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId!));
    expect(project).toMatchObject({ personalOwnerUserId: OWNER, visibility: "private" });
    return task;
  }

  const agentActor = (extra: Partial<AuthorizationActor> = {}): AuthorizationActor =>
    ({ type: "agent", source: "agent_key", agentId, companyId, ...extra }) as AuthorizationActor;

  it("a run for the owner starts; the agent stays outside the project and its grant is per task", async () => {
    const task = await personalTask();
    await expect(assertTaskWorkspaceExecutionAccess(db, agentActor({ onBehalfOfUserId: OWNER }), companyId, { issueId: task.id }))
      .resolves.toBeDefined();
    const members = await db.select().from(projectAccessMembers).where(eq(projectAccessMembers.projectId, task.projectId!));
    expect(members.map((m) => `${m.subjectType}:${m.subjectId}`)).toEqual([`user:${OWNER}`]);
    const grants = await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id));
    expect(grants.map((g) => `${g.subjectType}:${g.subjectId}`)).toContain(`agent:${agentId}`);
    // The agent alone, and another person, still cannot read the project.
    const access = accessService(db);
    const resource = { type: "project" as const, companyId, projectId: task.projectId! };
    expect((await access.decide({ actor: agentActor({ onBehalfOfUserId: OWNER }), action: "project:read", resource })).allowed).toBe(false);
    expect((await access.decide({ actor: { type: "board", userId: OTHER, source: "session", ignoreInstanceAdmin: true }, action: "project:read", resource })).allowed).toBe(false);
  });

  it.each([
    ["no person", {}, "Project is private and the actor is not an access member."],
    // Another person cannot read the task itself, so the refusal comes first from the task.
    ["another person", { onBehalfOfUserId: OTHER }, ""],
    ["the owner, authorized by another person", { onBehalfOfUserId: OWNER, authorizingUserId: OTHER }, ""],
  ] as const)("a run for %s is refused", async (_label, extra, message) => {
    const task = await personalTask();
    await expect(assertTaskWorkspaceExecutionAccess(db, agentActor(extra), companyId, { issueId: task.id })).rejects.toThrow(message);
  });

  // Another person who can read the task (live explicit grant) passes the task check, so only
  // the personal-owner and authorizer conditions of the exemption keep the project closed.
  it.each([
    ["another person", { onBehalfOfUserId: OTHER }],
    ["the owner, authorized by that person", { onBehalfOfUserId: OWNER, authorizingUserId: OTHER }],
  ] as const)("a run for %s who holds a read grant on the task is still refused", async (_label, extra) => {
    const task = await personalTask();
    await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "user", subjectId: OTHER, source: "explicit", grantedByUserId: OWNER });
    const access = accessService(db);
    const resource = { type: "issue" as const, companyId, issueId: task.id };
    expect((await access.decide({ actor: agentActor(extra), action: "issue:read", resource })).allowed).toBe(true);
    await expect(assertTaskWorkspaceExecutionAccess(db, agentActor(extra), companyId, { issueId: task.id }))
      .rejects.toThrow("Project is private and the actor is not an access member.");
  });

  it("the owner no longer a member: refused", async () => {
    const task = await personalTask();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, OWNER));
    try {
      await expect(assertTaskWorkspaceExecutionAccess(db, agentActor({ onBehalfOfUserId: OWNER }), companyId, { issueId: task.id }))
        .rejects.toThrow();
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, OWNER));
    }
  });

  it("a workspace source inside the personal project still needs project access", async () => {
    const task = await personalTask();
    const [source] = await db.insert(projectWorkspaces).values({ companyId, projectId: task.projectId!,
      name: "Owner's repository", cwd: "/tmp/personal-project-source" }).returning();
    await db.update(issues).set({ projectWorkspaceId: source!.id }).where(eq(issues.id, task.id));
    await expect(assertTaskWorkspaceExecutionAccess(db, agentActor({ onBehalfOfUserId: OWNER }), companyId, { issueId: task.id }))
      .rejects.toThrow("Project is private and the actor is not an access member.");
  });

  it("a shared private project (not personal) is unchanged: a granted agent that is not a member is refused", async () => {
    const [shared] = await db.insert(projects).values({ companyId, name: "Shared private", visibility: "private", privacyOwnerUserId: OWNER }).returning();
    await db.insert(projectAccessMembers).values({ companyId, projectId: shared!.id, subjectType: "user", subjectId: OWNER });
    const task = await issueService(db).create(companyId, {
      title: "Shared private work", status: "todo", priority: "medium", projectId: shared!.id,
      createdByUserId: OWNER, assigneeAgentId: agentId,
    } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
    await expect(assertTaskWorkspaceExecutionAccess(db, agentActor({ onBehalfOfUserId: OWNER }), companyId, { issueId: task.id }))
      .rejects.toThrow("Project is private and the actor is not an access member.");
  });
});
