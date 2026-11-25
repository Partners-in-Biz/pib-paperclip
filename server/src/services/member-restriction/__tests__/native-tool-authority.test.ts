import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { PaperclipRunnerToolAuthority } from "../../native-runtime/paperclip-runner-tool-authority.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../admin.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";

/**
 * PAR-12743 (C-sweep-1), base decision consumer: the native tool authority.
 * `execute()` runs `#boundContext`, which decides `issue:read` on the bound
 * task for the person the run works for (`responsibleUserId`), so the base
 * decision's restriction step (`applyMemberRestriction`) reaches every native
 * tool. Pinned with `set_task_title` for a native run that works for R
 * (restricted in an `enforce` company) on O's task R cannot read.
 * PAR-12608 rev 3, 4.2 and 4.3; AC-F8, AC-X1.
 */

const support = await getEmbeddedPostgresTestSupport();
const TITLE = "Original title";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native tool authority restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("native tool authority: set_task_title for a run working for R", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-native-tool-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  /** A fresh company per case: O owns the task, R (flagged) is the run's person. */
  async function fixture(mode: "report" | "enforce" = "enforce") {
    const [company] = await db.insert(companies).values({
      name: "Native tool co", issuePrefix: `N${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const companyId = company!.id;
    const O = `owner-${randomUUID()}`, R = `restricted-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    const [agent] = await db.insert(agents).values({
      companyId, name: "Runner agent", adapterType: "paperclip_runner", adapterConfig: {}, status: "active",
    }).returning();
    const agentId = agent!.id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" },
    ]);
    const [issue] = await db.insert(issues).values({
      companyId, title: TITLE, status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
      createdByUserId: O, responsibleUserId: O,
    }).returning();
    const issueId = issue!.id;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: R,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId: run!.id });
    const rename = () => authority.execute({
      tool: "set_task_title", callId: randomUUID(),
      arguments: { title: "Renamed by the run", onlyIfProvisional: false, idempotencyKey: `rename-${randomUUID()}` },
    });
    const title = async () => (await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)))[0]!.title;
    const titleActivity = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated"),
    ));
    const denials = async () => (await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
    ))).map((row) => row.details as Record<string, unknown>);
    return { companyId, R, issueId, rename, title, titleActivity, denials };
  }

  it("enforce: refused with \"The task is no longer available to this run\"; title unchanged, no title activity", async () => {
    const f = await fixture();
    await expect(f.rename()).rejects.toMatchObject({ status: 403, message: "The task is no longer available to this run" });
    expect(await f.title()).toBe(TITLE);
    expect(await f.titleActivity()).toHaveLength(0);
  });

  it("report: one R-read would-refuse record, and the rename succeeds", async () => {
    const f = await fixture("report");
    await expect(f.rename()).resolves.toMatchObject({ changed: true, title: "Renamed by the run" });
    expect(await f.title()).toBe("Renamed by the run");
    expect(await f.denials()).toEqual([
      expect.objectContaining({ ruleId: "R-read", target: "issue:read", objectId: f.issueId, mode: "report" }),
    ]);
  });

  it("AC-F8: with the variable `off` and the column on `enforce`, today's rename", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await expect(f.rename()).resolves.toMatchObject({ changed: true });
    expect(await f.title()).toBe("Renamed by the run");
    expect(await f.titleActivity()).toHaveLength(1);
    expect(await f.denials()).toHaveLength(0);
  });

  it("AC-X1: when the resolver throws, 503 MEMBER_RESTRICTION_UNAVAILABLE and no title change", async () => {
    const f = await fixture();
    // A malformed stored list makes the resolver throw on R's row.
    await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
      where ${companyMemberships.companyId} = ${f.companyId} and ${companyMemberships.principalId} = ${f.R}`);
    await expect(f.rename()).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    expect(await f.title()).toBe(TITLE);
    expect(await f.titleActivity()).toHaveLength(0);
  });
});
