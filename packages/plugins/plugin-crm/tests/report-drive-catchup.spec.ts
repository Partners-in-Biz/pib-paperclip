import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reportsDriveCatchup, type ReportCatchupDeps } from "../src/report-drive-catchup.js";

const rows = [
  { id: "r1", client_kind: "company", client_ref: "c1", period: "2026-10", html: "<p>Lumen October</p>", sent_at: "2026-11-01T08:00:00Z" },
  { id: "r2", client_kind: "company", client_ref: "gone", period: "2026-10", html: "<p>x</p>", sent_at: "2026-11-01T08:05:00Z" },
  { id: "r3", client_kind: "contact", client_ref: "p1", period: "2026-10", html: "<p>Ann</p>", sent_at: "2026-11-02T08:00:00Z" },
  { id: "r4", client_kind: "company", client_ref: "c9", period: "2026-10", html: "<p>no project</p>", sent_at: "2026-11-03T08:00:00Z" },
];

function setup() {
  const execute = vi.fn();
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    expect(params[0]).toBe("co1");
    expect(sql).toContain("status = 'sent'");
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    return rows;
  });
  const ctx = { db: { namespace: "plugin_crm_test", query, execute }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as PluginContext;
  const drive = new Map<string, string>(); // folder/name -> sha256, like saveDriveFile's dedupe
  const save = vi.fn(async (_ctx: unknown, _viewer: unknown, input: { projectId: string; subfolder?: string | null; name: string; sha256?: string; contentBase64?: string }) => {
    const key = `${input.projectId}/${input.subfolder}/${input.name}`;
    const duplicate = drive.get(key) === input.sha256;
    drive.set(key, input.sha256!);
    return { status: "saved", driveFileId: `f-${key}`, subfolder: "Deliverables", duplicate: duplicate || undefined };
  });
  const names: Record<string, string> = { c1: "Lumen Labs (Pty) Ltd", p1: "Ann Smith", c9: "Nine" };
  const deps: ReportCatchupDeps = {
    clientName: vi.fn(async (_c, _co, client) => names[client.id] ?? null),
    project: vi.fn(async (_c, _co, client) => (client.ref === "c9" ? null : `proj-${client.ref}`)),
    save: save as unknown as ReportCatchupDeps["save"],
    sleep: vi.fn(async () => undefined),
    now: () => 0,
  };
  return { ctx, execute, save, deps };
}

describe("crm.reports-drive-catchup", () => {
  it("dry run lists every sent report and saves nothing", async () => {
    const { ctx, execute, save, deps } = setup();
    const out = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07" }, deps);
    expect(out.dryRun).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(out.items.map((i) => [i.reportId, i.result, i.reason ?? i.name])).toEqual([
      ["r1", "would_save", "2026-10-01 Lumen Labs Pty Ltd v01.html"],
      ["r2", "skipped", "no_client"],
      ["r3", "would_save", "2026-10-01 Ann Smith v01.html"],
      ["r4", "skipped", "no_project"],
    ]);
  });

  it("saves the stored HTML to the client's 04 Reports, paced; a rerun is all duplicates", async () => {
    const { ctx, execute, save, deps } = setup();
    const first = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 10 }, deps);
    expect(save).toHaveBeenCalledTimes(2);
    const input = save.mock.calls[0][2];
    expect(input).toMatchObject({ companyId: "co1", projectId: "proj-c1", fileKind: "client", mimeType: "text/html", subfolder: "04 Reports", name: "2026-10-01 Lumen Labs Pty Ltd v01.html" });
    expect(Buffer.from(input.contentBase64!, "base64").toString("utf8")).toBe("<p>Lumen October</p>");
    expect(input.sha256).toBe(createHash("sha256").update("<p>Lumen October</p>").digest("hex"));
    expect(save.mock.calls[0][1]).toEqual({ companyId: "co1", userId: null, agentId: null, role: null });
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(first.counts).toEqual({ saved: 2, "skipped:no_client": 1, "skipped:no_project": 1 });

    const second = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 10 }, deps);
    expect(second.counts).toEqual({ duplicate: 2, "skipped:no_client": 1, "skipped:no_project": 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("works in batches: limit saves per call, then nextAfterId carries on (PAR-8121)", async () => {
    const { ctx, save, deps } = setup();
    const first = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1 }, deps);
    expect(first.items.map((i) => [i.reportId, i.result])).toEqual([["r1", "saved"]]);
    expect(first).toMatchObject({ done: false, nextAfterId: "r1", remaining: 3 });
    const second = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1, afterId: "r1" }, deps);
    expect(second.items.map((i) => [i.reportId, i.result])).toEqual([["r2", "skipped"], ["r3", "saved"]]);
    expect(second).toMatchObject({ done: false, nextAfterId: "r3", remaining: 1 });
    const third = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1, afterId: "r3" }, deps);
    expect(third).toMatchObject({ done: true, nextAfterId: null, remaining: 0, counts: { "skipped:no_project": 1 } });
    expect(save).toHaveBeenCalledTimes(2);
    await expect(reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, afterId: "nope" }, deps)).rejects.toThrow(/afterId/);
  });

  it("stops starting saves once the time budget is used", async () => {
    const { ctx, deps } = setup();
    let t = 0;
    deps.now = () => t;
    const inner = deps.save;
    deps.save = vi.fn(async (...args: Parameters<ReportCatchupDeps["save"]>) => {
      t += 16_000;
      return inner(...args);
    });
    const out = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 10 }, deps);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ done: false, nextAfterId: "r1" });
  });

  it("refuses a second saving call while one runs; dry runs are not blocked", async () => {
    const { ctx, deps } = setup();
    let release!: () => void;
    deps.save = vi.fn(() => new Promise<{ status: string }>((resolve) => { release = () => resolve({ status: "saved" }); })) as unknown as ReportCatchupDeps["save"];
    const first = reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1 }, deps);
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalled());
    await expect(reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps)).rejects.toThrow(/already running/);
    await expect(reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07" }, deps)).resolves.toMatchObject({ dryRun: true });
    release();
    await expect(first).resolves.toMatchObject({ done: false, nextAfterId: "r1" });
  });

  it("reports a failed save with its status", async () => {
    const { ctx, deps } = setup();
    deps.save = vi.fn(async () => ({ status: "drive_not_bound" }));
    const out = await reportsDriveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps);
    expect(out.items[0]).toMatchObject({ result: "failed", reason: "drive_not_bound" });
  });
});
