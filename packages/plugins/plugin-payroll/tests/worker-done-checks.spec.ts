/**
 * The worker registers the done-checks, and they run under the manifest's
 * capabilities (the EMP201 check reads the issue's comments).
 */
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";

const emptyDb = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };

describe("worker: done-checks", () => {
  it("an agent closing the EMP201 issue early opens it again with what is missing; a person's close stands", async () => {
    const C = "co-w";
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({ companies: [{ id: C, issuePrefix: "PAY", name: "Pay" } as never] });
    await plugin.definition.setup({ ...harness.ctx, db: emptyDb } as unknown as PluginContext);
    const issue = await harness.ctx.issues.create({ companyId: C, title: "EMP201 for September 2026 due by 7 October 2026", originKind: "plugin:partnersinbiz.payroll", originId: "payroll:emp201:2026-09", assigneeAgentId: "agent-books" });

    await harness.ctx.issues.update(issue.id, { status: "done" }, C);
    await harness.emit("issue.updated", {}, { companyId: C, entityId: issue.id, actorType: "agent", actorId: "agent-books" });
    expect((await harness.ctx.issues.get(issue.id, C))!.status).toBe("todo");
    const comments = await harness.ctx.issues.listComments(issue.id, C);
    expect(comments.at(-1)!.body).toContain("The EMP201 for September 2026 is not marked filed.");

    await harness.ctx.issues.update(issue.id, { status: "done" }, C);
    await harness.emit("issue.updated", {}, { companyId: C, entityId: issue.id, actorType: "user", actorId: "u-1" });
    expect((await harness.ctx.issues.get(issue.id, C))!.status).toBe("done");
  });

  it("registers the page actions for marking the EMP201 filed", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    const keys = new Set<string>();
    await plugin.definition.setup({ ...harness.ctx, db: emptyDb, actions: { register: (key: string) => void keys.add(key) } } as unknown as PluginContext);
    for (const key of ["payroll.emp201", "payroll.mark-emp201-filed", "payroll.unmark-emp201-filed"]) expect(keys.has(key), key).toBe(true);
  });
});
