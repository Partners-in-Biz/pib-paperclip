import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  summarySlots,
} from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  finalizeSummarySlotsForTerminalIssue,
  finalizeSummarySlotsForTerminalRun,
  settleSummarySlotsForTerminalRun,
} from "../services/summary-slot-finalization.js";
import { summarySlotService } from "../services/summary-slots.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("summary slot finalization and cancel (real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-summary-slot-finalization-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(summarySlots);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let issueCounter = 0;

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function seedGeneration(
    companyId: string,
    opts: { issueStatus?: IssueStatus; slotStatus?: "generating" | "idle" | "failed" } = {},
  ) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    issueCounter += 1;
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId,
        identifier: `GEN-${issueCounter}`,
        issueNumber: issueCounter,
        title: "Summarize project",
        status: opts.issueStatus ?? "in_progress",
      })
      .returning();
    const [slot] = await db
      .insert(summarySlots)
      .values({
        companyId,
        scopeKind: "project",
        scopeId: projectId,
        slotKey: "header",
        status: opts.slotStatus ?? "generating",
        generatingIssueId: issue!.id,
      })
      .returning();
    const selector = { companyId, scopeKind: "project", slotKey: "header", scopeId: projectId };
    return { issue: issue!, slot: slot!, projectId, selector };
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
    });
    return id;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    status: "queued" | "running" | "failed" = "running",
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status,
      contextSnapshot: { issueId },
    });
    return id;
  }

  async function loadSlot(id: string) {
    return db.select().from(summarySlots).where(eq(summarySlots.id, id)).then((rows) => rows[0]!);
  }

  describe("finalizeSummarySlotsForTerminalIssue", () => {
    it("fails a generating slot when its issue is blocked", async () => {
      const companyId = await seedCompany();
      const { issue, slot } = await seedGeneration(companyId, { issueStatus: "blocked" });
      const updated = await finalizeSummarySlotsForTerminalIssue(db, {
        id: issue.id,
        companyId,
        identifier: issue.identifier,
        title: issue.title,
        status: "blocked",
      });
      expect(updated).toEqual([{ id: slot.id }]);
      const after = await loadSlot(slot.id);
      expect(after.status).toBe("failed");
      expect(after.failureReason).toContain("was blocked before writing a summary");
    });

    it("ignores active in_progress issues", async () => {
      const companyId = await seedCompany();
      const { issue, slot } = await seedGeneration(companyId);
      const updated = await finalizeSummarySlotsForTerminalIssue(db, {
        id: issue.id,
        companyId,
        identifier: issue.identifier,
        title: issue.title,
        status: "in_progress",
      });
      expect(updated).toEqual([]);
      expect((await loadSlot(slot.id)).status).toBe("generating");
    });

    it("runs from issueService.update when the issue becomes blocked", async () => {
      const companyId = await seedCompany();
      const { issue, slot } = await seedGeneration(companyId);
      await issueService(db).update(issue.id, { status: "blocked" });
      expect((await loadSlot(slot.id)).status).toBe("failed");
    });
  });

  describe("finalizeSummarySlotsForTerminalRun", () => {
    it("leaves the slot generating while a sibling run waits in scheduled_retry", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const failedRunId = await seedRun(companyId, agentId, issue.id, "failed");
      const retryRunId = await seedRun(companyId, agentId, issue.id, "queued");
      await db.update(heartbeatRuns).set({ status: "scheduled_retry" }).where(eq(heartbeatRuns.id, retryRunId));
      const updated = await finalizeSummarySlotsForTerminalRun(db, {
        id: failedRunId, companyId, status: "failed", contextSnapshot: { issueId: issue.id },
      });
      expect(updated).toEqual([]);
      expect((await loadSlot(slot.id)).status).toBe("generating");
    });

    it("writes a summary_slot.generate_failed activity row for the failed slot", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const runId = await seedRun(companyId, agentId, issue.id, "failed");
      await settleSummarySlotsForTerminalRun(db, {
        id: runId, companyId, status: "failed", contextSnapshot: { issueId: issue.id },
      });
      const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, slot.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "summary_slot.generate_failed", entityType: "summary_slot" });
      expect(rows[0]!.details).toMatchObject({ source: "terminal_run", runId, issueId: issue.id });
    });

    it("fails the generating slot when the run failed and no other run is active", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const runId = await seedRun(companyId, agentId, issue.id, "failed");
      const updated = await finalizeSummarySlotsForTerminalRun(db, {
        id: runId,
        companyId,
        status: "failed",
        contextSnapshot: { issueId: issue.id },
        error: "Provider rate limited",
      });
      expect(updated).toEqual([{ id: slot.id }]);
      expect((await loadSlot(slot.id)).failureReason).toBe(
        "Summary generation run failed before writing a summary (Provider rate limited).",
      );
    });

    it("leaves the slot generating while another queued or running run exists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const failedRunId = await seedRun(companyId, agentId, issue.id, "failed");
      await seedRun(companyId, agentId, issue.id, "queued");
      const updated = await finalizeSummarySlotsForTerminalRun(db, {
        id: failedRunId,
        companyId,
        status: "failed",
        contextSnapshot: { issueId: issue.id },
      });
      expect(updated).toEqual([]);
      expect((await loadSlot(slot.id)).status).toBe("generating");
    });

    it("fails the slot when a run succeeds without writing a summary", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const runId = await seedRun(companyId, agentId, issue.id, "failed");
      await finalizeSummarySlotsForTerminalRun(db, {
        id: runId,
        companyId,
        status: "succeeded",
        issueId: issue.id,
      });
      expect((await loadSlot(slot.id)).status).toBe("failed");
    });

    it("does not touch idle slots or slots of another company", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const idle = await seedGeneration(companyId, { slotStatus: "idle" });
      const foreign = await seedGeneration(otherCompanyId);
      const runId = await seedRun(companyId, agentId, idle.issue.id, "failed");
      await finalizeSummarySlotsForTerminalRun(db, {
        id: runId, companyId, status: "failed", issueId: foreign.issue.id,
      });
      await finalizeSummarySlotsForTerminalRun(db, {
        id: runId, companyId, status: "failed", issueId: idle.issue.id,
      });
      expect((await loadSlot(idle.slot.id)).status).toBe("idle");
      expect((await loadSlot(foreign.slot.id)).status).toBe("generating");
    });

    it("ignores non-terminal runs", async () => {
      const companyId = await seedCompany();
      const { issue, slot } = await seedGeneration(companyId);
      const updated = await finalizeSummarySlotsForTerminalRun(db, {
        id: randomUUID(), companyId, status: "running", issueId: issue.id,
      });
      expect(updated).toEqual([]);
      expect((await loadSlot(slot.id)).status).toBe("generating");
    });
  });

  describe("terminal run trigger (every heartbeat_runs writer)", () => {
    async function writeStatus(runId: string, status: string, extra: Record<string, unknown> = {}) {
      // A bare status UPDATE is what native finalizer, watchdog, recovery,
      // restart recovery, session executor and queue cancels all reduce to.
      await db.update(heartbeatRuns).set({ status, ...extra }).where(eq(heartbeatRuns.id, runId));
    }

    it.each(["failed", "cancelled", "timed_out", "interrupted", "succeeded"])(
      "fails the generating slot when any writer moves the run to %s",
      async (status) => {
        const companyId = await seedCompany();
        const agentId = await seedAgent(companyId);
        const { issue, slot } = await seedGeneration(companyId);
        const runId = await seedRun(companyId, agentId, issue.id, "running");
        await writeStatus(runId, status, { error: "boom" });
        const after = await loadSlot(slot.id);
        expect(after.status).toBe("failed");
        expect(after.failureReason).toMatch(/^Summary generation run /);
        const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, slot.id));
        expect(rows.map((r) => r.action)).toEqual(["summary_slot.generate_failed"]);
        expect(rows[0]!.details).toMatchObject({ source: "terminal_run", runId, runStatus: status });
      },
    );

    it("matches the TypeScript failure reason", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot } = await seedGeneration(companyId);
      const runId = await seedRun(companyId, agentId, issue.id, "running");
      await writeStatus(runId, "failed", { error: "Provider rate limited" });
      expect((await loadSlot(slot.id)).failureReason).toBe(
        "Summary generation run failed before writing a summary (Provider rate limited).",
      );
    });

    it("resolves the issue from native_issue_id and context_snapshot too", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const a = await seedGeneration(companyId);
      const b = await seedGeneration(companyId);
      const nativeRun = await seedRun(companyId, agentId, a.issue.id, "running");
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: {}, nativeIssueId: a.issue.id })
        .where(eq(heartbeatRuns.id, nativeRun));
      const ctxRun = await seedRun(companyId, agentId, b.issue.id, "running");
      await writeStatus(nativeRun, "failed");
      await writeStatus(ctxRun, "cancelled");
      expect((await loadSlot(a.slot.id)).status).toBe("failed");
      expect((await loadSlot(b.slot.id)).status).toBe("failed");
    });

    it("keeps the slot generating while a queued, running or scheduled_retry sibling exists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      for (const siblingStatus of ["queued", "running", "scheduled_retry"]) {
        const { issue, slot } = await seedGeneration(companyId);
        const runId = await seedRun(companyId, agentId, issue.id, "running");
        const siblingId = await seedRun(companyId, agentId, issue.id, "queued");
        await writeStatus(siblingId, siblingStatus);
        await writeStatus(runId, "failed");
        expect((await loadSlot(slot.id)).status).toBe("generating");
        await writeStatus(siblingId, "failed");
        expect((await loadSlot(slot.id)).status).toBe("failed");
      }
    });

    it("ignores non-terminal transitions, idle slots and other companies", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const gen = await seedGeneration(companyId);
      const idle = await seedGeneration(companyId, { slotStatus: "idle" });
      const foreign = await seedGeneration(otherCompanyId);
      const genRun = await seedRun(companyId, agentId, gen.issue.id, "queued");
      await writeStatus(genRun, "running");
      expect((await loadSlot(gen.slot.id)).status).toBe("generating");
      const idleRun = await seedRun(companyId, agentId, idle.issue.id, "running");
      await writeStatus(idleRun, "failed");
      expect((await loadSlot(idle.slot.id)).status).toBe("idle");
      const crossRun = await seedRun(companyId, agentId, foreign.issue.id, "running");
      await writeStatus(crossRun, "failed");
      expect((await loadSlot(foreign.slot.id)).status).toBe("generating");
    });
  });

  describe("summarySlotService.cancel", () => {
    it("cancels the issue, resets the slot to idle, and returns active run ids", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const { issue, slot, selector } = await seedGeneration(companyId);
      const runId = await seedRun(companyId, agentId, issue.id, "running");
      await seedRun(companyId, agentId, issue.id, "failed");

      const result = await summarySlotService(db).cancel(selector);

      expect(result.cancelledIssueId).toBe(issue.id);
      expect(result.activeRunIds).toEqual([runId]);
      expect(result.slot).toMatchObject({ status: "idle", generatingIssueId: null, failureReason: null });
      const issueRow = await db.select().from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]!);
      expect(issueRow.status).toBe("cancelled");
      expect((await loadSlot(slot.id)).status).toBe("idle");
    });

    it("leaves a newer generation alone when generatingIssueId changes between the read and the update", async () => {
      const companyId = await seedCompany();
      const { issue, slot, selector, projectId } = await seedGeneration(companyId);
      const [newer] = await db
        .insert(issues)
        .values({
          companyId, projectId, identifier: "GEN-NEWER", issueNumber: 9999,
          title: "Newer summary", status: "in_progress",
        })
        .returning();
      // Fires inside cancel() once the old issue is cancelled, i.e. after
      // cancel() read the slot and before its final UPDATE: a newer generation
      // takes over the slot.
      await db.execute(sql.raw(`
        create function public.swap_generation() returns trigger language plpgsql as $$
        begin
          update summary_slots set generating_issue_id = '${newer!.id}', status = 'generating'
            where id = '${slot.id}';
          return new;
        end $$;
      `));
      await db.execute(sql.raw(`
        create trigger swap_generation_trg after update of status on issues
          for each row when (new.id = '${issue.id}' and new.status = 'cancelled')
          execute function public.swap_generation();
      `));
      try {
        const result = await summarySlotService(db).cancel(selector);
        expect(result.cancelledIssueId).toBe(issue.id);
        const after = await loadSlot(slot.id);
        expect(after).toMatchObject({ status: "generating", generatingIssueId: newer!.id });
        expect(result.slot).toMatchObject({ status: "generating", generatingIssueId: newer!.id });
      } finally {
        await db.execute(sql.raw("drop trigger if exists swap_generation_trg on issues"));
        await db.execute(sql.raw("drop function if exists public.swap_generation()"));
      }
    });

    it("is a no-op for a slot that is not generating", async () => {
      const companyId = await seedCompany();
      const { slot, selector } = await seedGeneration(companyId, { slotStatus: "idle" });
      const result = await summarySlotService(db).cancel(selector);
      expect(result).toMatchObject({ cancelledIssueId: null, activeRunIds: [] });
      expect(result.slot?.id).toBe(slot.id);
    });

    it("does not collect or cancel runs from another company", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const otherAgentId = await seedAgent(otherCompanyId);
      const { issue, selector } = await seedGeneration(companyId);
      await seedRun(otherCompanyId, otherAgentId, issue.id, "running");
      const result = await summarySlotService(db).cancel(selector);
      expect(result.activeRunIds).toEqual([]);
    });

    it("rejects a selector from another company", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const { selector } = await seedGeneration(companyId);
      await expect(
        summarySlotService(db).cancel({ ...selector, companyId: otherCompanyId }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("summarySlotService.markGenerationFailed", () => {
    it("fails only the slot generating the given issue", async () => {
      const companyId = await seedCompany();
      const { issue, slot, selector } = await seedGeneration(companyId);
      const svc = summarySlotService(db);

      const mismatch = await svc.markGenerationFailed(selector, randomUUID(), "nope");
      expect(mismatch).toBeNull();
      expect((await loadSlot(slot.id)).status).toBe("generating");

      const failed = await svc.markGenerationFailed(selector, issue.id, "Failed to wake Summarizer: boom");
      expect(failed).toMatchObject({ status: "failed", failureReason: "Failed to wake Summarizer: boom" });
      const rows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, slot.id), eq(activityLog.action, "summary_slot.generate_failed")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ source: "mark_generation_failed", issueId: issue.id });
    });

    it("does not touch an already idle slot or another company", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const { issue, slot, selector } = await seedGeneration(companyId, { slotStatus: "idle" });
      const svc = summarySlotService(db);
      expect(await svc.markGenerationFailed(selector, issue.id, "x")).toBeNull();
      expect(await svc.markGenerationFailed({ ...selector, companyId: otherCompanyId }, issue.id, "x")).toBeNull();
      expect((await loadSlot(slot.id)).status).toBe("idle");
    });
  });
});
