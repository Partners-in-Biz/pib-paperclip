import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { cleanFlowReports, FLOW_STAGES, FLOWS, flowStagesFor } from "../src/flows.js";
import { DONE_CHECK_MAX_REOPENS, runDoneCheck, type DoneCheckRule } from "../src/done-checks.js";
import { PIB_PLUGINS } from "../src/contracts.js";
import { TEAM_ROLES } from "../src/team.js";
import { MODULES } from "../src/setup.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

describe("company graph", () => {
  it("has unique stage keys, known modules, plugins and roles", () => {
    const keys = FLOWS.flatMap((f) => f.stages.map((s) => s.key));
    expect(new Set(keys).size).toBe(keys.length);
    const roles = new Set(TEAM_ROLES.map((r) => r.key));
    for (const flow of FLOWS) {
      expect(flow.stages.length).toBeGreaterThan(0);
      for (const stage of flow.stages) {
        expect(MODULES[stage.module]).toBeTruthy();
        expect(Object.values(PIB_PLUGINS)).toContain(stage.plugin);
        if (stage.role) expect(roles.has(stage.role)).toBe(true);
        if (stage.waitingOn === "agent") expect(stage.role).not.toBeNull();
        expect(stage.href.startsWith("/")).toBe(true);
      }
    }
    expect(FLOW_STAGES["quote.approval"]!.flow).toBe("lead-to-cash");
  });

  it("keeps only a plugin's own stages with sane numbers", () => {
    expect(flowStagesFor(PIB_PLUGINS.billing).map((s) => s.key)).toContain("invoice.open");
    const out = cleanFlowReports(PIB_PLUGINS.billing, [
      { stage: "invoice.open", count: 3.4, stuck: 9 },
      { stage: "lead.in", count: 2 },
      { stage: "nope", count: 1 },
    ]);
    expect(out).toEqual([{ stage: "invoice.open", count: 3, stuck: 3 }]);
  });
});

function simpleFakeCtx(issue: Record<string, unknown> | null) {
  const state = new Map<string, unknown>();
  const updates: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  const wakes: string[] = [];
  const ctx = {
    manifest: { id: "partnersinbiz.billing" },
    issues: {
      get: vi.fn(async () => issue),
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => void updates.push(patch)),
      createComment: vi.fn(async (_id: string, body: string) => void comments.push(body)),
      requestWakeup: vi.fn(async (id: string) => void wakes.push(id)),
    },
    state: {
      get: vi.fn(async (k: { stateKey: string }) => state.get(k.stateKey) ?? null),
      set: vi.fn(async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v)),
    },
    logger: { info: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, updates, comments, wakes };
}

describe("done checks", () => {
  const issue = { id: "i1", title: "Drafts to send", status: "done", originKind: "plugin:partnersinbiz.billing", originId: "billing:drafts-to-send:2026-09-28", assigneeAgentId: "am", createdAt: "2026-09-28T00:00:00Z" };
  const rule = (done: boolean): DoneCheckRule => ({ originPrefix: "billing:drafts-to-send", label: "Drafts to send", check: async () => (done ? { done } : { done, missing: ["2 drafts still have no send request"] }) });
  const event = { entityId: "i1", companyId: "c1", actorType: "agent" as const };

  it("ignores people, other statuses and other plugins' issues", async () => {
    expect(await runDoneCheck(simpleFakeCtx(issue).ctx, [rule(false)], { ...event, actorType: "user" })).toBe("skipped");
    expect(await runDoneCheck(simpleFakeCtx({ ...issue, status: "todo" }).ctx, [rule(false)], event)).toBe("skipped");
    expect(await runDoneCheck(simpleFakeCtx({ ...issue, originId: "crm:x" }).ctx, [rule(false)], event)).toBe("skipped");
    // Same origin id, opened by another plugin (or by hand): not ours to check.
    expect(await runDoneCheck(simpleFakeCtx({ ...issue, originKind: "plugin:partnersinbiz.crm" }).ctx, [rule(false)], event)).toBe("skipped");
    expect(await runDoneCheck(simpleFakeCtx({ ...issue, originKind: "manual" }).ctx, [rule(false)], event)).toBe("skipped");
    expect(await runDoneCheck(simpleFakeCtx({ ...issue, originKind: "plugin:partnersinbiz.billing:ops" }).ctx, [rule(true)], event)).toBe("passed");
  });

  it("passes finished work", async () => {
    expect(await runDoneCheck(simpleFakeCtx(issue).ctx, [rule(true)], event)).toBe("passed");
  });

  it("reopens unfinished work with what is missing and wakes the agent", async () => {
    const f = simpleFakeCtx(issue);
    expect(await runDoneCheck(f.ctx, [rule(false)], event)).toBe("reopened");
    expect(f.updates[0]).toEqual({ status: "todo" });
    expect(f.comments[0]).toContain("2 drafts still have no send request");
    expect(f.wakes).toEqual(["i1"]);
  });

  it("escalates after the last allowed early close when escalation is enabled", async () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const fake = fakeCtx({
      manifestId: "partnersinbiz.billing",
      companies: { c1: { name: "Test Co", issuePrefix: "TST" } },
      agents: [
        { id: "am", reportsTo: "manager", status: "ok" },
        { id: "manager", reportsTo: null, status: "ok" },
      ],
    });

    // Create the issue with proper setup
    const testIssue = { id: "i1", title: "Drafts to send", status: "done", originKind: "plugin:partnersinbiz.billing", originId: "billing:drafts-to-send:2026-09-28", assigneeAgentId: "am", createdAt: "2026-09-28T00:00:00Z", companyId: "c1" };
    fake.issues.push(testIssue as any);

    // Reopen twice (and reset status to done between calls)
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      expect(await runDoneCheck(fake.ctx, [rule(false)], event)).toBe("reopened");
      testIssue.status = "done"; // Reset for next iteration
    }

    // Third time should escalate
    const result = await runDoneCheck(fake.ctx, [rule(false)], event);
    expect(result).toBe("escalated");

    // Check that an Unblock issue was created
    const unblockIssue = fake.issues.find((i) => (i as any).originId?.startsWith("escalate:"));
    expect(unblockIssue).toBeDefined();
    expect((unblockIssue as any).assigneeAgentId).toBe("manager");

    // Check the comment mentions escalation
    expect(fake.comments.length).toBeGreaterThan(0);
    const lastCommentObj = fake.comments[fake.comments.length - 1];
    expect(lastCommentObj.body).toContain("Still not done");
    expect(lastCommentObj.body).toContain("Unblock");
  });

  it("falls back to Operator routing when escalation is disabled", async () => {
    const fake = fakeCtx({
      manifestId: "partnersinbiz.billing",
      companies: { c1: { name: "Test Co", issuePrefix: "TST", defaultResponsibleUserId: "owner-user" } },
      agents: [
        { id: "am", reportsTo: null, status: "ok" },
        { id: "op", status: "ok" },
      ],
      config: {
        c1: { escalation: { enabled: false } },
      },
    });

    const testIssue = { id: "i1", title: "Drafts to send", status: "done", originKind: "plugin:partnersinbiz.billing", originId: "billing:drafts-to-send:2026-09-28", assigneeAgentId: "am", createdAt: "2026-09-28T00:00:00Z", companyId: "c1" };
    fake.issues.push(testIssue as any);

    // Reopen twice (and reset status to done between calls)
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      expect(await runDoneCheck(fake.ctx, [rule(false)], event)).toBe("reopened");
      testIssue.status = "done"; // Reset for next iteration
    }

    // Third time should fall back to operator routing when escalation is disabled
    const result = await runDoneCheck(fake.ctx, [rule(false)], event);
    expect(result).toBe("escalated");

    // Check that no Unblock issue was created
    const unblockIssue = fake.issues.find((i) => (i as any).originId?.startsWith("escalate:"));
    expect(unblockIssue).toBeUndefined();

    // Check the comment mentions handing to operator
    expect(fake.comments.length).toBeGreaterThan(0);
    const lastCommentObj = fake.comments[fake.comments.length - 1];
    expect(lastCommentObj.body).toContain("Still not done");
    expect(lastCommentObj.body).toContain("Handing");
  });

  it("creates only one Unblock issue on multiple early closes", async () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const fake = fakeCtx({
      manifestId: "partnersinbiz.billing",
      companies: { c1: { name: "Test Co", issuePrefix: "TST" } },
      agents: [
        { id: "am", reportsTo: "manager", status: "ok" },
        { id: "manager", reportsTo: null, status: "ok" },
      ],
    });

    const testIssue = { id: "i1", title: "Drafts to send", status: "done", originKind: "plugin:partnersinbiz.billing", originId: "billing:drafts-to-send:2026-09-28", assigneeAgentId: "am", createdAt: "2026-09-28T00:00:00Z", companyId: "c1" };
    fake.issues.push(testIssue as any);

    // Reopen to threshold (and reset status to done between calls)
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      expect(await runDoneCheck(fake.ctx, [rule(false)], event)).toBe("reopened");
      testIssue.status = "done"; // Reset for next iteration
    }

    // Third early close creates Unblock
    expect(await runDoneCheck(fake.ctx, [rule(false)], event)).toBe("escalated");
    const unblockIssuesAfter3 = fake.issues.filter((i) => (i as any).originId?.startsWith("escalate:"));
    expect(unblockIssuesAfter3).toHaveLength(1);

    // Fourth early close should not create another Unblock (dedupe)
    // Reset the issue to "done" status
    testIssue.status = "done";

    expect(await runDoneCheck(fake.ctx, [rule(false)], event)).toBe("escalated");
    const unblockIssuesAfter4 = fake.issues.filter((i) => (i as any).originId?.startsWith("escalate:"));
    expect(unblockIssuesAfter4).toHaveLength(1);
  });
});
