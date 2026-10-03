/**
 * The worker hands every issue event to the page-group sync first: a group issue that closes marks its group done, and
 * is not treated as a task issue by the other handlers.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const GROUP: Row = {
  id: "chunk-2", company_id: "co-1", sprint_id: "sp-1", task_id: "t-1", parent_issue_id: "issue-1", seq: 2, total: 3, label: "pages 21-40",
  urls: ["https://acme.co.za/a", "https://acme.co.za/b"], status: "open", issue_id: "grp-2", issue_identifier: "PIB-202", opened_at: "2026-10-03T07:00:00Z", done_at: null,
};

async function boot(issueStatus: string) {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({
    companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never],
    issues: [{ id: "grp-2", companyId: "co-1", identifier: "PIB-202", title: "Group 2 of 3", status: issueStatus } as never],
  });
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const queries: string[] = [];
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<Row[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.query = async (sql, params = []) => {
    validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
    validateParams(sql, params);
    queries.push(sql);
    if (/\.task_chunks WHERE company_id = \$1 AND issue_id = \$2/.test(sql)) return params[1] === "grp-2" ? [GROUP] : [];
    return [];
  };
  db.execute = async (sql, params = []) => {
    validateRuntimeExecute(sql, NAMESPACE);
    validateParams(sql, params);
    executes.push({ sql, params });
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  return { harness, executes, queries };
}

describe("issue events for page groups", () => {
  it("marks a group done when its issue closes", async () => {
    const { harness, executes } = await boot("done");
    await harness.emit("issue.updated", {}, { entityId: "grp-2", companyId: "co-1" });
    const update = executes.find((e) => /UPDATE plugin_seo_8099f8879a\.task_chunks SET/.test(e.sql));
    expect(update).toBeDefined();
    expect(update!.params).toContain("done");
    expect(update!.params).toContain("chunk-2");
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("leaves a group open while its issue is still being worked", async () => {
    const { harness, executes } = await boot("in_progress");
    await harness.emit("issue.updated", {}, { entityId: "grp-2", companyId: "co-1" });
    expect(executes.filter((e) => /UPDATE plugin_seo_8099f8879a\.task_chunks/.test(e.sql))).toHaveLength(0);
  });

  it("does not hand a group's issue on to the task-issue handlers", async () => {
    const { harness, queries } = await boot("done");
    await harness.emit("issue.updated", {}, { entityId: "grp-2", companyId: "co-1" });
    // The task-issue sync looks tasks up by their issue; a group issue is not one.
    expect(queries.some((q) => /\.sprint_tasks WHERE issue_id = \$1/.test(q))).toBe(false);
  });

  it("passes an issue that is no group on to the task-issue handlers", async () => {
    const { harness, queries } = await boot("done");
    await harness.emit("issue.updated", {}, { entityId: "other-issue", companyId: "co-1" });
    expect(queries.some((q) => /\.task_chunks WHERE company_id = \$1 AND issue_id = \$2/.test(q))).toBe(true);
    expect(queries.some((q) => /\.sprint_tasks WHERE issue_id = \$1/.test(q))).toBe(true);
  });
});
