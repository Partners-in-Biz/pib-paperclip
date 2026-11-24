import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
