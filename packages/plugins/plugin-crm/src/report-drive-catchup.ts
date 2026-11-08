/**
 * Drive catch-up for sent client reports (PAR-8130): the reports sent while the Drive route was broken
 * (20 Oct - 7 Nov 2026) get their copy in the client's "04 Reports" folder.
 *
 * Copy only: the HTML is the stored sent report (`client_reports.html`, never rewritten once sent), the name is the
 * send-time `reportFileName`, and this module never writes to `client_reports`. saveDriveFile skips a file already in
 * the folder with the same name and sha256 and says `duplicate`, so a second run saves nothing new.
 *
 * Batches (PAR-8121): one save takes about 10 s and the host's action RPC gives up after 30 s, so a call saves at most
 * `limit` reports (and stops early once it has used its time budget), then returns `nextAfterId`; the next call passes
 * it as `afterId` and carries on from there. Only one saving call runs per company at a time, because a call that timed
 * out at the RPC keeps working in the worker.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientInfo } from "./care-clients.js";
import { table } from "./db.js";
import { resolveProducerSaveProject } from "./drive/tools.js";
import { saveDriveFile } from "./drive/save.js";
import { reportFileName, REPORTS_SUBFOLDER } from "./report-copy.js";

interface SentReportRow {
  id: string;
  client_kind: "company" | "contact";
  client_ref: string;
  period: string;
  html: string | null;
  sent_at: string | Date;
}

export interface ReportCatchupItem {
  reportId: string;
  period: string;
  client: string;
  sentAt: string;
  name?: string;
  result: "would_save" | "saved" | "skipped" | "failed";
  folder?: string;
  reason?: string;
  duplicate?: boolean;
  driveFileId?: string;
}

export interface ReportCatchupDeps {
  clientName: (ctx: PluginContext, companyId: string, client: { kind: "company" | "contact"; id: string }) => Promise<string | null>;
  project: (ctx: PluginContext, companyId: string, client: { kind: string; ref: string }) => Promise<string | null>;
  save: (ctx: PluginContext, viewer: Parameters<typeof saveDriveFile>[1], input: Parameters<typeof saveDriveFile>[2]) => Promise<{ status: string; driveFileId?: string; subfolder?: string | null; duplicate?: boolean }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_DEPS: ReportCatchupDeps = {
  clientName: async (ctx, companyId, client) => (await clientInfo(ctx, companyId, client))?.name ?? null,
  project: (ctx, companyId, client) => resolveProducerSaveProject(ctx, companyId, { kind: "client", clientKind: client.kind, clientRef: client.ref }),
  save: saveDriveFile as unknown as ReportCatchupDeps["save"],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const MAX_REPORTS = 100;
const MAX_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 10;
/** No new save starts after this; the action RPC times out at 30 s and one save takes about 10 s. */
const TIME_BUDGET_MS = 15_000;
const running = new Set<string>();

export function catchupLimit(value: unknown): number {
  const n = Math.floor(Number(value ?? DEFAULT_LIMIT));
  return Number.isFinite(n) ? Math.max(1, Math.min(n, MAX_LIMIT)) : DEFAULT_LIMIT;
}

/** `from`/`to` are YYYY-MM-DD (UTC), both days included. */
export function reportCatchupRange(from: unknown, to: unknown): { start: Date; end: Date } {
  const parse = (value: unknown, key: string) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`${key} must be a date (YYYY-MM-DD)`);
    }
    return new Date(`${value}T00:00:00Z`);
  };
  const start = parse(from, "from");
  const end = new Date(parse(to, "to").getTime() + DAY_MS);
  if (end <= start) throw new Error("to must be on or after from");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new Error(`The range is limited to ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

/**
 * Lists (dryRun) or saves the reports with status `sent` (dry runs excluded) sent in the range, one at a time with
 * `delayMs` between saves. Read-only on `client_reports`. A saving call starts after `afterId` and stops after `limit`
 * saves or its time budget; `done: false` with `nextAfterId` means call again with `afterId: nextAfterId`.
 */
export async function reportsDriveCatchup(
  ctx: PluginContext,
  companyId: string,
  params: { from: unknown; to: unknown; dryRun?: boolean; delayMs?: number; limit?: unknown; afterId?: unknown },
  deps: ReportCatchupDeps = DEFAULT_DEPS,
): Promise<{ dryRun: boolean; counts: Record<string, number>; items: ReportCatchupItem[]; done: boolean; nextAfterId: string | null; remaining: number }> {
  const { start, end } = reportCatchupRange(params.from, params.to);
  const dryRun = params.dryRun !== false;
  if (params.afterId != null && typeof params.afterId !== "string") throw new Error("afterId must be a report id");
  if (dryRun) return run(ctx, companyId, params, deps, start, end, dryRun);
  if (running.has(companyId)) throw new Error("A report catch-up is already running for this company; wait a minute and call again with the last nextAfterId");
  running.add(companyId);
  try {
    return await run(ctx, companyId, params, deps, start, end, dryRun);
  } finally {
    running.delete(companyId);
  }
}

async function run(
  ctx: PluginContext,
  companyId: string,
  params: { delayMs?: number; limit?: unknown; afterId?: unknown },
  deps: ReportCatchupDeps,
  start: Date,
  end: Date,
  dryRun: boolean,
): Promise<{ dryRun: boolean; counts: Record<string, number>; items: ReportCatchupItem[]; done: boolean; nextAfterId: string | null; remaining: number }> {
  const limit = catchupLimit(params.limit);
  const afterId = typeof params.afterId === "string" ? params.afterId : null;
  const delayMs = Math.max(0, Math.min(Number(params.delayMs ?? 2000) || 0, 10_000));
  const rows = await ctx.db.query<SentReportRow>(
    `SELECT id, client_kind, client_ref, period, html, sent_at FROM ${table(ctx, "client_reports")}
     WHERE company_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3 ORDER BY sent_at ASC, id ASC LIMIT ${MAX_REPORTS + 1}`,
    [companyId, start.toISOString(), end.toISOString()],
  );
  if (rows.length > MAX_REPORTS) throw new Error(`More than ${MAX_REPORTS} reports in the range; use a shorter range`);
  let index = 0;
  if (afterId) {
    index = rows.findIndex((row) => row.id === afterId) + 1;
    if (index === 0) throw new Error("afterId is not a sent report in this range");
  }

  const items: ReportCatchupItem[] = [];
  const startedAt = deps.now();
  let saves = 0;
  let lastId = afterId;
  let stopped = false;
  for (; index < rows.length; index++) {
    if (!dryRun && (saves >= limit || (saves > 0 && deps.now() - startedAt > TIME_BUDGET_MS))) { stopped = true; break; }
    const row = rows[index];
    lastId = row.id;
    const item: ReportCatchupItem = {
      reportId: row.id,
      period: row.period,
      client: `${row.client_kind}:${row.client_ref}`,
      sentAt: new Date(row.sent_at).toISOString(),
      result: "skipped",
    };
    items.push(item);
    if (!row.html) { item.reason = "no_stored_html"; continue; }
    const name = await deps.clientName(ctx, companyId, { kind: row.client_kind, id: row.client_ref });
    if (!name) { item.reason = "no_client"; continue; }
    const projectId = await deps.project(ctx, companyId, { kind: row.client_kind, ref: row.client_ref });
    if (!projectId) { item.reason = "no_project"; continue; }
    // The send-time save used seq 1 (report.ts onSent).
    item.name = reportFileName(name, row.period, 1);
    item.folder = REPORTS_SUBFOLDER;
    if (dryRun) { item.result = "would_save"; continue; }

    if (saves++ > 0 && delayMs) await deps.sleep(delayMs);
    try {
      const bytes = Buffer.from(row.html, "utf8");
      const result = await deps.save(ctx, { companyId, userId: null, agentId: null, role: null }, {
        companyId,
        projectId,
        fileKind: "client",
        name: item.name,
        mimeType: "text/html",
        contentBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        subfolder: REPORTS_SUBFOLDER,
      });
      if (result.status === "saved") {
        item.result = "saved";
        item.duplicate = result.duplicate === true;
        item.driveFileId = result.driveFileId;
        if (result.subfolder) item.folder = result.subfolder;
      } else {
        item.result = "failed";
        item.reason = result.status;
      }
    } catch (error) {
      item.result = "failed";
      item.reason = error instanceof Error ? error.message : String(error);
    }
  }
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.result === "skipped" ? `skipped:${item.reason}` : item.result === "saved" && item.duplicate ? "duplicate" : item.result;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { dryRun, counts, items, done: !stopped, nextAfterId: stopped ? lastId : null, remaining: rows.length - index };
}
