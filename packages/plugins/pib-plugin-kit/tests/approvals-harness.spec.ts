/**
 * The same failure as approvals.spec.ts, but through the SDK's own test
 * harness, so the call really is a registered agent tool run by an agent
 * (tool run context, capability checks, in-memory host) rather than a hand-made
 * ctx. Live evidence: PAR-456..459, opened by `crm:set-sequence-delivery` from an
 * agent run, had no assignee.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_EVENTS, COCKPIT_PLUGIN, openApprovalIssue, registerRoleWatch, unroutedApprovalsCheck } from "../src/index.js";
import { rolesCopy } from "./helpers/fake-ctx.js";

const manifest = {
  id: "partnersinbiz.crm",
  apiVersion: 1,
  version: "0.0.0",
  displayName: "CRM (test)",
  description: "test",
  author: "test",
  categories: ["automation"],
  capabilities: ["events.subscribe", "plugin.state.read", "plugin.state.write", "issues.create", "issues.read", "issues.update", "issues.wakeup", "companies.read", "agents.read", "agent.tools.register"],
  entrypoints: { worker: "worker.js" },
} as unknown as PaperclipPluginManifestV1;

const CO = "b2b8f471-edba-4d05-abce-f15e99a94d9a";
const AGENT = "499f24f9-5f0e-4604-828a-f3f248516a08";
const OWNER = "BjxhmUDCHf1zm0yaWpzTJBCpNVGpy6Ji";
const ROLES_EVENT = `plugin.${COCKPIT_PLUGIN}.${COCKPIT_EVENTS.rolesUpdated}`;

async function boot() {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: CO, name: "Partners in Biz", issuePrefix: "PAR", defaultResponsibleUserId: OWNER } as never] });
  registerRoleWatch(harness.ctx);
  harness.ctx.tools.register("set-sequence-delivery", { displayName: "x", description: "x", parametersSchema: { type: "object" } }, async (_params, run) => {
    const approval = await openApprovalIssue(harness.ctx, {
      companyId: run.companyId,
      title: "Approve email sending: Niche 2 — Wave 1 continuation",
      description: "Approve the sequence.",
      originKind: "plugin:partnersinbiz.crm",
      originId: "crm:sequence-email:7b2a5a21",
      outward: true,
    });
    return { content: approval.assignedTo, data: { id: approval.id, assignedTo: approval.assignedTo } };
  });
  return harness;
}

describe("an approval opened inside an agent tool call", () => {
  it("is assigned to the owner even though the roles copy froze on the first (ownerless) broadcast", async () => {
    const harness = await boot();
    // 2026-09-27: the first broadcast stored, every later one dropped by the old text compare.
    await harness.emit(ROLES_EVENT as never, rolesCopy({ ownerUserId: null, reviewOutward: false, updatedAt: "2026-09-27T06:32:49.178Z", companyId: CO }), { companyId: CO });
    await harness.emit(ROLES_EVENT as never, rolesCopy({ updatedAt: "2026-09-27 18:46:11.052+00", companyId: CO }), { companyId: CO });
    const result = await harness.executeTool<{ data?: { id: string; assignedTo: string } }>("set-sequence-delivery", {}, { companyId: CO, agentId: AGENT, runId: "run-1", projectId: "p-1" });
    expect(result.data?.assignedTo).toBe("reviewer");
    const issue = await harness.ctx.issues.get(result.data!.id, CO);
    expect(issue?.assigneeAgentId).toBe("rev");
  });

  it("still reaches the owner when no roles ever arrived (a company that never saved its team)", async () => {
    const harness = await boot();
    const result = await harness.executeTool<{ data?: { id: string; assignedTo: string } }>("set-sequence-delivery", {}, { companyId: CO, agentId: AGENT, runId: "run-1", projectId: "p-1" });
    expect(result.data?.assignedTo).toBe("person");
    const issue = await harness.ctx.issues.get(result.data!.id, CO);
    expect(issue?.assigneeUserId).toBe(OWNER);
    expect(await unroutedApprovalsCheck(harness.ctx, CO, { now: Date.now() + 2 * 3_600_000 })).toMatchObject({ status: "ok" });
  });
});
