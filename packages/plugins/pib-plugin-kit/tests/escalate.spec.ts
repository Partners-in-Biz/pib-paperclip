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
  });

  describe("(g) disabled flag returns skipped:disabled, no writes", () => {
    it("returns skipped when escalation.enabled is false", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: null, status: "ok" },
        ],
      });

      // Set config to disable escalation
      await fake.ctx.state.set(
        {
          scopeKind: "company",
          scopeId: "co-1",
          namespace: "default",
          stateKey: "config",
        },
        { escalation: { enabled: false } },
      );

      const stuckIssue = await fake.ctx.issues.create({
        companyId: "co-1",
        title: "Stuck",
        assigneeAgentId: "agent1",
        status: "todo",
      });

      const issueCountBefore = fake.issues.length;
      const updateCountBefore = fake.updates.length;

      const result = await escalate(fake.ctx, stuckIssue.id, "blocked", {
        companyId: "co-1",
        now,
      });

      expect(result).toEqual({ skipped: "disabled" });
      expect(fake.issues.length).toBe(issueCountBefore); // no new issue
      expect(fake.updates.length).toBe(updateCountBefore); // no update to stuck issue
    });
  });

  describe("cycle in reportsTo does not hang", () => {
    it("cycle guard prevents infinite loop", async () => {
      const fake = fakeCtx({
        companies: { "co-1": { name: "Test Co", issuePrefix: "TST" } },
        agents: [
          { id: "agent1", reportsTo: "agent2", status: "ok" },
          { id: "agent2", reportsTo: "agent3", status: "ok" },
          { id: "agent3", reportsTo: "agent1", status: "ok" }, // cycle: agent3 -> agent1 -> agent2 -> agent3
        ],
      });

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

      // Should eventually escalate to owner (no other option in cycle)
      // Or skip if all levels are below-start or cap etc. But at minimum should not hang.
      expect(result).toBeDefined();
      expect((result as any).skipped !== undefined || (result as any).created !== undefined).toBe(true);
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
});
