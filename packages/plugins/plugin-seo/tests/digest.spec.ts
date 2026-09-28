/**
 * Sprint digests stay short and daily, and a retired (closed) sprint root issue is
 * replaced. Long per-task digests once grew a root issue's thread past what an agent
 * run can be handed (Linux's 128 KB argument limit: spawn E2BIG).
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { DIGEST_MAX, ensureRootIssue } from "../src/service/sprints.js";

type Row = Record<string, unknown>;
const user = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

function sprintRow(extra: Row): Row {
  return {
    id: "sp", company_id: "co-1", name: "Site", site_url: "https://site.co.za", site_name: "Site", client_kind: null, client_ref: null, client_name: null,
    status: "active", start_date: "2026-09-03", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
    project_id: null, root_issue_id: "root-1", root_issue_identifier: "PIB-8", agent_id: null, notes: null, paused_reason: null,
    health: {}, scoreboard: {}, today: {}, current_day: 23, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
    audit_days_done: [], seeded_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
    ...extra,
  };
}

async function boot(rootStatus = "in_progress") {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({
    companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never],
    issues: [{ id: "root-1", companyId: "co-1", identifier: "PIB-8", title: "SEO sprint: Site", status: rootStatus } as never],
  });
  const rows = [sprintRow({})];
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<Row[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.query = async (sql, params = []) => (/\.sprints WHERE id = \$1/.test(sql) ? rows.filter((r) => r.id === params[0]) : []);
  db.execute = async (sql, params = []) => {
    updates.push({ sql, params });
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  return { harness, rows, updates };
}

describe("sprint digest", () => {
  it("refuses a digest longer than the limit and points to the task issue", async () => {
    const { harness } = await boot();
    await expect(harness.performAction("seo.call", { tool: "post-digest", params: { sprintId: "sp", summary: "x".repeat(DIGEST_MAX + 1) } }, user)).rejects.toThrow(/task's own issue/);
  });

  it("posts one short digest a day; the second is skipped", async () => {
    const { harness } = await boot();
    const first = await harness.performAction<Row>("seo.call", { tool: "post-digest", params: { sprintId: "sp", summary: "3 tasks done; sitemap submitted." } }, user);
    expect(first).toMatchObject({ posted: true });
    const second = await harness.performAction<Row>("seo.call", { tool: "post-digest", params: { sprintId: "sp", summary: "More." } }, user);
    expect(second).toMatchObject({ posted: false });
  });
});

describe("sprint root issue", () => {
  it("opens a fresh root issue when the old one was closed", async () => {
    const { harness, rows } = await boot("done");
    const env = { ctx: harness.ctx } as never;
    const info = { companyId: "co-1", today: "2026-09-28" } as never;
    const sprint = { id: "sp", companyId: "co-1", rootIssueId: "root-1", rootIssueIdentifier: "PIB-8", projectId: null, ownerUserId: "user-1", startDate: "2026-09-03", siteName: "Site", siteUrl: "https://site.co.za", name: "Site" } as never;
    const out = await ensureRootIssue(env, info, sprint, null).catch((e: Error) => ({ error: e.message }));
    expect((out as { rootIssueId?: string }).rootIssueId).toBeTruthy();
    expect((out as { rootIssueId?: string }).rootIssueId).not.toBe("root-1");
    void rows; void NAMESPACE;
  });
});
