import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("execution blocker recovery-action predicate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-blocker-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `EB${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Blocker Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Blocked work", status: "todo", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  async function insertAction(
    seeded: { companyId: string; agentId: string; issueId: string },
    overrides: Partial<typeof issueRecoveryActions.$inferInsert> = {},
  ) {
    const runId = randomUUID();
    const [row] = await db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      returnOwnerAgentId: seeded.agentId,
      cause: "uncertain_external_action",
      fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      ...overrides,
    }).returning();
    return row!;
  }

  it("still blocks on an active recovery action", async () => {
    const seeded = await seed();
    const action = await insertAction(seeded, { status: "active", outcome: null, evidence: { runId: randomUUID() } });
    const blocker = await getExecutionBlocker(db, seeded.companyId, seeded.issueId);
    expect(blocker?.recoveryActionId).toBe(action.id);
  });

  it("still blocks on an escalated recovery action", async () => {
    const seeded = await seed();
    await insertAction(seeded, { status: "escalated", outcome: null, evidence: { runId: randomUUID() } });
    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).not.toBeNull();
  });

  it("keeps the automatic no-replay hold on a resolved row with outcome blocked", async () => {
    const seeded = await seed();
    const action = await insertAction(seeded);
    const blocker = await getExecutionBlocker(db, seeded.companyId, seeded.issueId);
    expect(blocker?.recoveryActionId).toBe(action.id);
  });

  it("does not block on a resolved row whose outcome was settled with replay still marked blocked", async () => {
    const seeded = await seed();
    for (const outcome of ["restored", "handed_back"] as const) {
      await insertAction(seeded, { outcome });
    }
    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();
  });

  it("keeps the automatic no-replay hold on a resolved row with outcome cancelled", async () => {
    const seeded = await seed();
    const action = await insertAction(seeded, { outcome: "cancelled" });
    const blocker = await getExecutionBlocker(db, seeded.companyId, seeded.issueId);
    expect(blocker?.recoveryActionId).toBe(action.id);
  });

  it("does not block on a cancelled row with replay marked blocked", async () => {
    const seeded = await seed();
    await insertAction(seeded, { status: "cancelled", outcome: "cancelled" });
    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();
  });

  it("keeps an unsafe workspace archive hold even when the resolved outcome is restored", async () => {
    const seeded = await seed();
    const runId = randomUUID();
    const action = await insertAction(seeded, {
      outcome: "restored",
      evidence: { runId, workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } },
    });
    const blocker = await getExecutionBlocker(db, seeded.companyId, seeded.issueId);
    expect(blocker?.recoveryActionId).toBe(action.id);
  });

  it("unblocks once a blocked row is marked cleared", async () => {
    const seeded = await seed();
    const action = await insertAction(seeded);
    await db.update(issueRecoveryActions)
      .set({ evidence: { ...action.evidence, automaticRecovery: { replay: "cleared_manual_reconcile" } } })
      .where(eq(issueRecoveryActions.id, action.id));
    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();
  });
});
