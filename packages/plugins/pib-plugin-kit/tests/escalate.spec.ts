import { describe, expect, it } from "vitest";
import { escalate, type EscalateOptions, type EscalateResult } from "../src/escalate.js";
import { fakeCtx, stateKeyOf } from "./helpers/fake-ctx.js";

describe("escalate", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const today = now.toISOString().split("T")[0];

  describe("(a) paused manager skipped, goes to next manager in chain", () => {
    it("skips paused manager, escalates to next", async () => {
      // Issue assigned to agent1, agent1 reports to agent2 (paused), agent2 reports to agent3 (ok)
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: "agent3", status: "paused" }, // paused, should be skipped
          { id: "agent3", reportsTo: null, status: "ok" },
          { id: "owner-user", status: null },
        ],
      });

      // Create the stuck issue
      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked for 24h", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true, level: 1 }));
      // Level 1 should be agent3 (agent2 is paused and skipped)
      const created = fake.issues.find((i) => (i as any).originId);
      expect(created).toBeDefined();
      expect((created as any).assigneeAgentId).toBe("agent3");
    });
  });

  describe("(b) second call returns existing Unblock id, creates nothing new", () => {
    it("dedupe on second call for same level", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // First escalate
      const result1 = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result1).toEqual(expect.objectContaining({ created: true }));
      const issueCount1 = fake.issues.length;

      // Second escalate with same issue
      const result2 = await escalate(fake.ctx, stuckIssue.id, "still blocked", {
        companyId: "co-1",
        now,
      });

      // Should return the existing issue id
      expect(result2).toEqual({ id: (result1 as any).id, level: (result1 as any).level, created: false });
      // No new issue created
      expect(fake.issues.length).toBe(issueCount1);
    });
  });

  describe("(c) 21st escalation of day refused, 20 succeed", () => {
    it("allows 20 escalations, refuses 21st", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      // Pre-seed day counter to 19
      await fake.ctx.state.set(
        {
          scopeKind: "company",
          scopeId: "co-1",
          namespace: "pib-escalations",
          stateKey: `count:${today}`,
        },
        19,
      );

      const issue1 = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck 1",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // 20th should succeed
      const result20 = await escalate(fake.ctx, issue1.id, "blocked", {
        companyId: "co-1",
        now,
      });
      expect(result20).toEqual(expect.objectContaining({ created: true }));

      // Create issue 2 for 21st attempt
      const issue2 = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck 2",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // 21st should be capped (but need different originId, so we need to trigger the cap on same issue at different level or a new issue)
      // Actually, the cap is per-company per-day, so the 21st escalation call should fail
      const result21 = await escalate(fake.ctx, issue2.id, "blocked", {
        companyId: "co-1",
        now,
      });
      expect(result21).toEqual(expect.objectContaining({ skipped: "cap" }));
    });
  });

  describe("(d) head's manager absent, routes to owner with user assignee, no wakeup", () => {
    it("escalates to owner when chain ends", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST", defaultResponsibleUserId: "owner-user" } },
        agents: [
          { id: "agent1", reportsTo: null, status: "ok" }, // no manager above agent1
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // Set owner in roles
      await fake.ctx.state.set(
        {
          scopeKind: "company" as const,
          scopeId: "co-1",
          namespace: "pib-cockpit",
          stateKey: "roles",
        },
        {
          companyId: "co-1",
          operatorAgentId: null,
          reviewerAgentId: null,
          ownerUserId: "owner-user",
          reviewOutward: false,
          updatedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
      );

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true }));
      // Should be assigned to owner user, not an agent
      const created = fake.issues.find((i) => i.id !== stuckIssue.id);
      expect((created as any).assigneeUserId).toBe("owner-user");
      expect((created as any).assigneeAgentId).toBeNull();

      // Check that no wakeup was requested for the owner assignment
      expect(fake.wakeups).toEqual([]); // Owner doesn't get woken
    });
  });

  describe("(e) stuck issue marked blocked with old blockers kept + new one", () => {
    it("preserves existing blockers and adds new one", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
        blockers: { "issue-1": ["blocker-old-1", "blocker-old-2"] }, // existing blockers on first created issue
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true }));

      // Check the update to the stuck issue
      const update = fake.updates.find((u) => u.id === stuckIssue.id);
      expect(update).toBeDefined();
      expect(update!.patch.status).toBe("blocked");
      const blockedByIds = (update!.patch as any).blockedByIssueIds;
      expect(blockedByIds).toContain("blocker-old-1");
      expect(blockedByIds).toContain("blocker-old-2");
      expect(blockedByIds).toContain((result as any).id); // new unblock
    });
  });

  describe("(f) secrets in reason/comments redacted in created issue", () => {
    it("redacts credentials from description", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked, secret: sk-live-abc123xyztest123", {
        companyId: "co-1",
        errorCode: "sk_test_def456uvwlong1234567890",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true }));
      const created = fake.issues.find((i) => i.id !== stuckIssue.id);
      const desc = (created as any).description;
      expect(desc).not.toMatch(/sk-live-abc123xyztest123/);
      expect(desc).not.toMatch(/sk_test_def456uvwlong1234567890/);
      expect(desc).toContain("[redacted]");
    });

    it("redacts secrets in comments", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // Add comments with authorAgentId for filtering
      fake.comments.push({ issueId: stuckIssue.id, body: "Issue started with token=abc123SECRETVALUE1234567890", authorAgentId: "agent1" });
      fake.comments.push({ issueId: stuckIssue.id, body: "Still blocked, using Bearer abcdefghijklmnop1234", authorAgentId: "agent1" });

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true }));
      const created = fake.issues.find((i) => i.id !== stuckIssue.id);
      const desc = (created as any).description;
      expect(desc).not.toMatch(/abc123SECRETVALUE1234567890/);
      expect(desc).not.toMatch(/abcdefghijklmnop1234/);
      expect(desc).toContain("[redacted]");
    });
  });

  describe("(g) disabled flag returns skipped:disabled, no writes", () => {
    it("returns skipped when escalation.enabled is false, no issues created or updated", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
        config: {
          "co-1": { escalation: { enabled: false } },
        },
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const issueCountBefore = fake.issues.length;
      const updateCountBefore = fake.updates.length;
      const stateKeysWritten = Array.from(fake.state.entries()).map(([k]) => k);

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual({ skipped: "disabled" });
      expect(fake.issues.length).toBe(issueCountBefore); // no new issue
      expect(fake.updates.length).toBe(updateCountBefore); // no update to stuck issue
      // No escalation state written
      const newStateKeys = Array.from(fake.state.entries()).map(([k]) => k).filter((k) => !stateKeysWritten.includes(k));
      expect(newStateKeys).toHaveLength(0);
    });

    it("fails open (escalation proceeds) when config read throws", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // Mock config.get to throw
      const originalConfigGet = fake.ctx.config.get;
      (fake.ctx.config.get as any) = async () => {
        throw new Error("Config service unavailable");
      };

      // Even though config.get throws, escalate should proceed (fail open)
      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual(expect.objectContaining({ created: true }));
    });
  });

  describe("cycle in reportsTo does not hang", () => {
    it("cycle guard prevents infinite loop and escalates correctly", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: "agent3", status: "ok" },
          { id: "agent3", reportsTo: "agent1", status: "ok" }, // cycle: agent3 -> agent1 -> agent2 -> agent3
        ],
      });

      // Set owner in roles
      await fake.ctx.state.set(
        {
          scopeKind: "company" as const,
          scopeId: "co-1",
          namespace: "pib-cockpit",
          stateKey: "roles",
        },
        {
          companyId: "co-1",
          operatorAgentId: null,
          reviewerAgentId: null,
          ownerUserId: "owner-user",
          reviewOutward: false,
          updatedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
      );

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // Should not hang, should just follow the chain until cycle is detected or depth limit
      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      // Should escalate and create an issue (will be assigned to agent2 at level 1, since agent1->agent2->agent3->agent1 has cycle after depth 3)
      expect(result).toEqual(expect.objectContaining({ created: true }));
      const created = fake.issues.find((i) => i.id !== stuckIssue.id);
      expect(created).toBeDefined();
      // Should be assigned to one of the agents in the cycle (likely agent2 as level 1)
      expect((created as any).assigneeAgentId).toBe("agent2");
    });
  });

  describe("returns no-issue when issue not found", () => {
    it("returns skipped:no-issue for missing issue", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [{ id: "agent1", reportsTo: null, status: "ok" }],
      });

      const result = await escalate(fake.ctx, "missing-issue", "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual({ skipped: "no-issue" });
    });
  });

  describe("returns no-owner when ownerUserFor returns no user", () => {
    it("returns skipped:no-owner when escalating to owner with no user found", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST", defaultResponsibleUserId: null } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      // Don't set owner in roles
      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
        startLevel: "owner",
      });

      expect(result).toEqual({ skipped: "no-owner" });
    });
  });

  describe("(h) orphan unblock: state recorded immediately, issues.update fails don't orphan", () => {
    it("records state after createWorkIssue, so retry on same issue returns same Unblock id", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      // Intercept issues.update to fail on first call
      let updateCallCount = 0;
      const originalUpdate = fake.ctx.issues.update.bind(fake.ctx.issues) as (id: string, patch: Record<string, unknown>, companyId?: string) => Promise<any>;
      (fake.ctx.issues.update as any) = async (id: string, patch: Record<string, unknown>, companyId?: string) => {
        updateCallCount += 1;
        if (updateCallCount === 1 && id === stuckIssue.id) {
          throw new Error("Update failed");
        }
        return originalUpdate(id, patch, companyId);
      };

      // First escalate: should create unblock issue and record state, but fail on update
      let level1 = 0;
      try {
        await escalate(fake.ctx, stuckIssue.id, "blocked", {
          companyId: "co-1",
          now,
        });
      } catch {
        // Expected to throw on issues.update
      }

      // The unblock issue should have been created
      const unblockIssues = fake.issues.filter((i) => i.originKind === "plugin:pib-escalation");
      expect(unblockIssues).toHaveLength(1);
      const unblockId = unblockIssues[0].id;

      // State should have been recorded (the dedupe record)
      const escalationState = await fake.ctx.state.get({
        scopeKind: "company",
        scopeId: "co-1",
        namespace: "pib-escalations",
        stateKey: `escalations:${stuckIssue.id}`,
      });
      expect(escalationState).toBeDefined();
      expect((escalationState as any[])[0].issueId).toBe(unblockId);
      level1 = (escalationState as any[])[0].level;

      // Second escalate: should return the same Unblock id (dedupe) and not create a new one
      const result2 = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result2).toEqual({ id: unblockId, level: level1, created: false });
      // Still only one unblock issue
      expect(fake.issues.filter((i) => i.originKind === "plugin:pib-escalation")).toHaveLength(1);
    });
  });
});
