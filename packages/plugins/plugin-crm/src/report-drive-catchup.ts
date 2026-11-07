/**
 * Drive catch-up for sent client reports (PAR-8130): the reports sent while the Drive route was broken
 * (20 Oct - 7 Nov 2026) get their copy in the client's "04 Reports" folder.
 *
 * Copy only: the HTML is the stored sent report (`client_reports.html`, never rewritten once sent), the name is the
 * send-time `reportFileName`, and this module never writes to `client_reports`. saveDriveFile skips a file already in
 * the folder with the same name and sha256 and says `duplicate`, so a second run saves nothing new.
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
}

const DEFAULT_DEPS: ReportCatchupDeps = {
  clientName: async (ctx, companyId, client) => (await clientInfo(ctx, companyId, client))?.name ?? null,
  project: (ctx, companyId, client) => resolveProducerSaveProject(ctx, companyId, { kind: "client", clientKind: client.kind, clientRef: client.ref }),
  save: saveDriveFile as unknown as ReportCatchupDeps["save"],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const MAX_REPORTS = 100;
const MAX_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;

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
 * `delayMs` between saves. Read-only on `client_reports`.
 */
export async function reportsDriveCatchup(
  ctx: PluginContext,
  companyId: string,
  params: { from: unknown; to: unknown; dryRun?: boolean; delayMs?: number },
  deps: ReportCatchupDeps = DEFAULT_DEPS,
): Promise<{ dryRun: boolean; counts: Record<string, number>; items: ReportCatchupItem[] }> {
  const { start, end } = reportCatchupRange(params.from, params.to);
  const dryRun = params.dryRun !== false;
  const delayMs = Math.max(0, Math.min(Number(params.delayMs ?? 2000) || 0, 10_000));
  const rows = await ctx.db.query<SentReportRow>(
    `SELECT id, client_kind, client_ref, period, html, sent_at FROM ${table(ctx, "client_reports")}
     WHERE company_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3 ORDER BY sent_at ASC, id ASC LIMIT ${MAX_REPORTS + 1}`,
    [companyId, start.toISOString(), end.toISOString()],
  );
  if (rows.length > MAX_REPORTS) throw new Error(`More than ${MAX_REPORTS} reports in the range; use a shorter range`);

  const items: ReportCatchupItem[] = [];
  let saves = 0;
  for (const row of rows) {
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
  return { dryRun, counts, items };
}
