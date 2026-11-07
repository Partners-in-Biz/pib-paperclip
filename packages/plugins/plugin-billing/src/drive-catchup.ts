/**
 * Drive catch-up (PAR-8130): copy the invoice and quote PDFs that went out while the Drive route was broken
 * (20 Oct - 7 Nov 2026) to each client's "03 Deliverables" folder.
 *
 * Copy only: the bytes are the stored sent PDF in private R2 (`pdf_key`), never a re-render, and this module never
 * writes to a Billing table. The name uses the send date, so it matches what the send-time save would have made, and
 * the CRM skips a file already in the folder with the same name and sha256: a second run saves nothing new.
 */
import { driveSave } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { loadBilling, privateR2, type PrivateR2 } from "./config.js";
import { table } from "./db.js";
import { BillingError } from "./domain.js";
import { invoiceNumberLabel } from "./invoice-number.js";
import { DELIVERABLES_SUBFOLDER, sentCopyName } from "./sent-copy.js";
import { assertOwnKey, getObject } from "./storage.js";

type DocType = "invoice" | "quote";

interface SentRow {
  id: string;
  number: string | null;
  status: string;
  customer_kind: string | null;
  customer_ref: string | null;
  sent_at: string | Date;
  pdf_key: string | null;
  mail_seq: number | string | null;
}

export interface CatchupItem {
  type: DocType;
  number: string;
  client: string | null;
  status: string;
  sentAt: string;
  name?: string;
  result: "would_save" | "saved" | "skipped" | "failed" | "no_ack";
  folder?: string;
  reason?: string;
  url?: string;
}

export interface CatchupDeps {
  r2: (ctx: PluginContext, companyId: string) => Promise<PrivateR2 | null>;
  readPdf: (r2: PrivateR2, key: string) => Promise<Uint8Array>;
  save: typeof driveSave;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: CatchupDeps = {
  r2: async (ctx, companyId) => {
    const { settings, resolver } = await loadBilling(ctx, companyId);
    return privateR2(resolver, settings).catch(() => null);
  },
  readPdf: async (r2, key) => (await getObject(r2, key)).bytes,
  save: driveSave,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const MAX_DOCS = 100;
const MAX_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;

/** `from`/`to` are YYYY-MM-DD (UTC), both days included. */
export function catchupRange(from: unknown, to: unknown): { start: Date; end: Date } {
  const parse = (value: unknown, key: string) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BillingError(`${key} must be a date (YYYY-MM-DD)`);
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new BillingError(`${key} must be a date (YYYY-MM-DD)`);
    return date;
  };
  const start = parse(from, "from");
  const end = new Date(parse(to, "to").getTime() + DAY_MS);
  if (end <= start) throw new BillingError("to must be on or after from");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new BillingError(`The range is limited to ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

const isPdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

async function sentDocs(ctx: PluginContext, companyId: string, type: DocType, start: Date, end: Date): Promise<SentRow[]> {
  return ctx.db.query<SentRow>(
    `SELECT id, number, status, customer_kind, customer_ref, sent_at, pdf_key, mail_seq FROM ${table(ctx, type === "invoice" ? "invoices" : "quotes")}
     WHERE company_id = $1 AND status <> 'draft' AND sent_at >= $2 AND sent_at < $3 ORDER BY sent_at ASC, id ASC LIMIT ${MAX_DOCS + 1}`,
    [companyId, start.toISOString(), end.toISOString()],
  );
}

/**
 * Lists (dryRun) or saves the sent invoices and quotes in the range, one at a time with `delayMs` between saves.
 * Read-only on Billing: only SELECTs, an R2 read and the CRM's Drive save route.
 */
export async function driveCatchup(
  ctx: PluginContext,
  companyId: string,
  params: { from: unknown; to: unknown; dryRun?: boolean; delayMs?: number },
  deps: CatchupDeps = DEFAULT_DEPS,
): Promise<{ dryRun: boolean; from: string; to: string; counts: Record<string, number>; items: CatchupItem[] }> {
  const { start, end } = catchupRange(params.from, params.to);
  const dryRun = params.dryRun !== false;
  const delayMs = Math.max(0, Math.min(Number(params.delayMs ?? 2000) || 0, 10_000));
  const rows = [
    ...(await sentDocs(ctx, companyId, "invoice", start, end)).map((row) => ({ type: "invoice" as const, row })),
    ...(await sentDocs(ctx, companyId, "quote", start, end)).map((row) => ({ type: "quote" as const, row })),
  ];
  if (rows.length > MAX_DOCS) throw new BillingError(`More than ${MAX_DOCS} documents in the range; use a shorter range`);

  const r2 = rows.some(({ row }) => row.pdf_key) ? await deps.r2(ctx, companyId) : null;
  const items: CatchupItem[] = [];
  let saves = 0;
  for (const { type, row } of rows) {
    const sentAt = new Date(row.sent_at);
    const number = invoiceNumberLabel(row.number);
    const client = row.customer_kind && row.customer_ref ? `${row.customer_kind}:${row.customer_ref}` : null;
    const item: CatchupItem = { type, number, client, status: row.status, sentAt: sentAt.toISOString(), result: "skipped" };
    items.push(item);
    if (!row.pdf_key) { item.reason = "no_stored_pdf"; continue; }
    if (!client) { item.reason = "no_client"; continue; }
    if (!r2) { item.reason = "storage_not_configured"; continue; }
    try {
      assertOwnKey(r2, companyId, row.pdf_key, type);
    } catch {
      item.reason = "foreign_pdf_key";
      continue;
    }
    // retrySend overwrites pdf_key with the last render sent; mail_seq is that send's number.
    item.name = sentCopyName(type, number, sentAt, Math.max(1, Number(row.mail_seq ?? 0) || 0));
    item.folder = DELIVERABLES_SUBFOLDER;
    if (dryRun) { item.result = "would_save"; continue; }

    if (saves++ > 0 && delayMs) await deps.sleep(delayMs);
    try {
      const bytes = await deps.readPdf(r2, row.pdf_key);
      if (!isPdf(bytes)) { item.result = "failed"; item.reason = "stored_file_not_pdf"; continue; }
      const result = await deps.save(ctx, {
        companyId,
        kind: "client",
        name: item.name,
        mimeType: "application/pdf",
        bytes,
        subfolder: DELIVERABLES_SUBFOLDER,
        client: { kind: row.customer_kind!, ref: row.customer_ref! },
      });
      item.result = result.status;
      if (result.status === "saved") item.url = result.url;
      if (result.status === "failed") item.reason = result.reason;
    } catch (error) {
      item.result = "failed";
      item.reason = error instanceof Error ? error.message : String(error);
    }
  }
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.result === "skipped" ? `skipped:${item.reason}` : item.result;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { dryRun, from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10), counts, items };
}
