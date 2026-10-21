import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { createPreview } from "../src/service/preview.js";
import { captureSnapshot } from "../src/service/snapshots.js";

// Mock driveSave at the kit level
const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn() }));

vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...actual, driveSave: fakeDriveSave };
});

describe("createPreview saves HTML preview to Drive", () => {
  function hostEnv() {
    const sprint = { id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_name: "Acme Ltd", status: "active", start_date: "2026-09-01", template_id: "t", template_version: 2, autopilot_mode: "safe", owner_user_id: "u1", project_id: "p1", root_issue_id: "r1", root_issue_identifier: "PIB-1", agent_id: "a1", site_access: "wordpress", site_id: "s1", change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
    const task = { id: "t1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Pages", title: "Home", description: null, task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template", parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null, started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null };

    const ctx = {
      db: {
        namespace: NAMESPACE,
        async query(sql: string) {
          if (/sprints WHERE id/.test(sql)) return [sprint];
          if (/sprint_tasks WHERE id/.test(sql)) return [task];
          if (/needs_you|previews/.test(sql)) return [];
          return [];
        },
        async execute() {
          return { rowCount: 1 };
        },
      },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      issues: {
        create: vi.fn(async () => ({ id: "rev-1" })),
        createComment: vi.fn(),
        requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
        update: vi.fn(),
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as PluginContext;

    return createEnv(ctx, {
      now: () => new Date("2026-10-21T12:00:00Z"),
      site: vi.fn(async () => ({ status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: "<html><body><h1>Live</h1></body></html>", ms: 1 })) as never,
    });
  }

  const actor: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDriveSave.mockResolvedValue({ status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.google.com/file/d/file-1" });
  });

  it("saves preview HTML with correct subfolder, name pattern, mimeType", async () => {
    const env = hostEnv();
    const result = await createPreview(env, "co-1", actor, { sprintId: "sp-1", pageUrl: "/", title: "Homepage Update", h1: "New heading", bodyHtml: "<p>new text</p>" });

    expect(result).toHaveProperty("previewId");
    expect(result.reviewStatus).toBe("pending");
    await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalled());

    const opts = fakeDriveSave.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.subfolder).toBe("03 Deliverables");
    expect(opts.mimeType).toBe("text/html");
    expect(String(opts.name)).toMatch(/^\d{4}-\d{2}-\d{2} .+ v\d{2}\.html$/);
  });

  it.each([{ status: "failed" as const, reason: "drive_not_bound" }, { status: "no_ack" as const }, { rejected: true }])
  ("preview succeeds even when driveSave fails: $status/$reason/$rejected", async (scenario) => {
    if ("rejected" in scenario) fakeDriveSave.mockRejectedValue(new Error("Network error"));
    else fakeDriveSave.mockResolvedValue(scenario);

    const env = hostEnv();
    const result = await createPreview(env, "co-1", actor, { sprintId: "sp-1", pageUrl: "/", title: "Test Preview", h1: "Test", bodyHtml: "<p>test</p>" });

    expect(result).toHaveProperty("previewId");
    expect(result.reviewStatus).toBe("pending");
    await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalled());
  });
});

describe("captureSnapshot saves JSON audit to Drive", () => {
  function hostEnv() {
    const ctx = {
      db: { namespace: NAMESPACE, async query() { return []; }, async execute() { return { rowCount: 1 }; } },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      issues: { create: vi.fn(async () => ({ id: "iss-1" })), createComment: vi.fn(), requestWakeup: vi.fn(async () => ({ queued: true })) },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as PluginContext;
    return createEnv(ctx, {
      now: () => new Date("2026-10-21T12:00:00Z"),
      site: vi.fn(async () => ({ status: 200, text: "<html></html>", ms: 1 })) as never,
    });
  }

  const sprint = { id: "sp-1", companyId: "co-1", siteUrl: "https://example.com", siteName: "Example", geoEnabled: false, ga4Enabled: false };
  const info = { today: "2026-10-21" };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDriveSave.mockResolvedValue({ status: "saved" as const, requestId: "req-1", driveFileId: "file-1", url: "https://drive.google.com/file/d/file-1" });
  });

  it("saves scheduled snapshot JSON with correct subfolder, name pattern, mimeType", async () => {
    const env = hostEnv();
    const result = await captureSnapshot(env, info as never, sprint as never, { day: 0, kind: "scheduled" });

    expect(result).toHaveProperty("snapshotId");
    expect(result.created).toBe(true);
    await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalled());

    const opts = fakeDriveSave.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.subfolder).toBe("04 Reports");
    expect(opts.mimeType).toBe("application/json");
    expect(String(opts.name)).toMatch(/^\d{4}-\d{2}-\d{2} .+ v\d{2}\.json$/);
  });

  it("manual snapshot does NOT call exportToDrive", async () => {
    const env = hostEnv();
    const result = await captureSnapshot(env, info as never, sprint as never, { day: 0, kind: "manual" });

    expect(result).toHaveProperty("snapshotId");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeDriveSave).not.toHaveBeenCalled();
  });

  it.each([{ status: "failed" as const, reason: "drive_not_bound" }, { status: "no_ack" as const }, { rejected: true }])
  ("scheduled snapshot succeeds when driveSave fails: $status/$reason/$rejected", async (scenario) => {
    if ("rejected" in scenario) fakeDriveSave.mockRejectedValue(new Error("Network timeout"));
    else fakeDriveSave.mockResolvedValue(scenario);

    const env = hostEnv();
    const result = await captureSnapshot(env, info as never, sprint as never, { day: 0, kind: "scheduled" });

    expect(result).toHaveProperty("snapshotId");
    expect(result.created).toBe(true);
    await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalled());
  });
});
