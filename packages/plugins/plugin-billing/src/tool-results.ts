/**
 * Small tool results for agents (audit Q8-11).
 *
 * The list tools returned every row in full (a quote is about 1 KB, a proof of payment carries its email
 * snippet and attachment list, an invoice detail is every section at once), with no limit. An agent that
 * only has to find the right invoice paid for all of it in tokens. Now:
 *
 * - lists are compact by default (the fields a decision needs, the client as one `company:<id>` string),
 *   at most 50 rows a call (200 at most), with `offset` and a `more` flag;
 * - `compact: false` gives the full rows (still limited), and the detail tools give everything about one
 *   record by id, so nothing is lost, only not sent unasked;
 * - `invoice-detail` is compact by default (the invoice, its lines, its payments and links, and a count of
 *   everything else); `sections` adds the ones the agent wants.
 *
 * The page's actions are not shaped: only the agent tool results go through here.
 */

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

type Row = Record<string, unknown>;

/** Preferred fields per list tool, in the order they are returned. A field a row does not have is skipped. */
const LIST_FIELDS: Record<string, string[]> = {
  "list-open-invoices": ["id", "number", "client", "customerName", "status", "currency", "totalMinor", "outstandingMinor", "dueAt"],
  "list-quotes": ["id", "number", "client", "customerName", "status", "currency", "totalMinor", "validUntil", "dealId", "convertedInvoiceId"],
  "list-credit-notes": ["id", "number", "invoiceId", "invoiceNumber", "amountMinor", "currency", "status", "createdAt"],
  "list-proofs-of-payment": ["id", "invoiceId", "invoiceNumber", "status", "amountMinor", "reference", "source", "fromName", "receivedAt", "hasFile"],
  "list-bills": ["id", "supplierName", "supplierReference", "status", "currency", "totalMinor", "outstandingMinor", "dueDate", "pendingAction"],
  "list-time-entries": ["id", "description", "client", "customerName", "startedAt", "minutes", "billable", "invoiceId", "running"],
  "list-recurring-invoices": ["id", "templateInvoiceId", "frequency", "nextRunAt", "isActive", "autoSend", "endsAt"],
  "list-payment-links": ["id", "provider", "label", "status", "amountMinor", "currency", "url", "paidAt", "refundedMinor"],
};

const RETAINER_FIELDS = {
  plans: ["id", "name", "priceMinor", "currency", "period", "active"],
  subscriptions: ["id", "client", "customerName", "planId", "description", "priceMinor", "currency", "period", "status", "nextInvoiceAt"],
};

export const LIST_TOOLS = [...Object.keys(LIST_FIELDS), "list-retainers"];

function withClient(row: Row): Row {
  if (typeof row.customerKind === "string" && typeof row.customerRef === "string") {
    const { customerKind, customerRef, ...rest } = row;
    return { client: `${customerKind}:${customerRef}`, ...rest };
  }
  return row;
}

function pick(row: Row, fields: string[]): Row {
  const source = withClient(row);
  const out: Row = {};
  for (const field of fields) if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  return out;
}

export interface ListParams {
  limit?: unknown;
  offset?: unknown;
  compact?: unknown;
}

export function listWindow(params: ListParams): { limit: number; offset: number; compact: boolean } {
  const asked = Number(params.limit ?? LIST_DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(Number.isFinite(asked) ? Math.floor(asked) : LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));
  const start = Number(params.offset ?? 0);
  return { limit, offset: Math.max(0, Number.isFinite(start) ? Math.floor(start) : 0), compact: params.compact !== false };
}

export interface ListResult {
  mode: "compact" | "full";
  total: number;
  count: number;
  offset: number;
  items: Row[];
  more?: boolean;
  next?: string;
}

/** Window and shape one list. */
export function shapeList(tool: string, rows: Row[], params: ListParams, fields = LIST_FIELDS[tool]): ListResult {
  const { limit, offset, compact } = listWindow(params);
  const page = rows.slice(offset, offset + limit);
  const items = compact && fields ? page.map((row) => pick(row, fields)) : page;
  const more = offset + page.length < rows.length;
  return {
    mode: compact ? "compact" : "full",
    total: rows.length,
    count: items.length,
    offset,
    items,
    ...(more ? { more: true, next: `${rows.length - offset - page.length} more. Ask again with offset ${offset + page.length}, or narrow the request (client, status).` } : {}),
  };
}

/** A tool's result after shaping; anything that is not a list tool passes through. */
export function shapeToolResult(tool: string, data: unknown, params: Record<string, unknown>): unknown {
  if (tool === "list-retainers" && data && typeof data === "object") {
    const d = data as { plans?: Row[]; subscriptions?: Row[] };
    return {
      plans: shapeList("list-retainers", d.plans ?? [], params, RETAINER_FIELDS.plans),
      subscriptions: shapeList("list-retainers", d.subscriptions ?? [], params, RETAINER_FIELDS.subscriptions),
    };
  }
  if (LIST_FIELDS[tool] && Array.isArray(data)) return shapeList(tool, data as Row[], params);
  if (tool === "invoice-detail" && data && typeof data === "object") return shapeInvoiceDetail(data as Row, params);
  return data;
}

// ── invoice-detail ───────────────────────────────────────────────────────────

export const DETAIL_SECTIONS = ["groups", "credits", "creditNotes", "pops", "deliveries", "reminders", "followUps", "customerCredit", "recipients", "refunds"] as const;

const INVOICE_FIELDS = ["id", "number", "status", "currency", "client", "customerName", "totalMinor", "paidMinor", "creditedMinor", "writtenOffMinor", "outstandingMinor", "dueAt", "sentAt", "paidAt", "pendingAction", "approvalIssueId", "deliveryStatus", "dealId", "ledgerStatus", "journalNumber", "pendingPops"];
const LINE_FIELDS = ["id", "description", "quantity", "unitAmountMinor", "taxCode", "grossMinor"];
const PAYMENT_FIELDS = ["id", "amountMinor", "allocatedMinor", "method", "reference", "source", "paidAt"];

export function shapeInvoiceDetail(detail: Row, params: Record<string, unknown>): Row {
  if (params.compact === false) return detail;
  const asArray = (key: string): Row[] => (Array.isArray(detail[key]) ? (detail[key] as Row[]) : []);
  const invoice = (detail.invoice ?? {}) as Row;
  const wanted = new Set(Array.isArray(params.sections) ? params.sections.map(String) : []);
  const out: Row = {
    mode: "compact",
    invoice: pick(invoice, INVOICE_FIELDS),
    lines: asArray("lines").map((line) => pick(line, LINE_FIELDS)),
    payments: asArray("payments").map((payment) => pick(payment, PAYMENT_FIELDS)),
    paymentLinks: asArray("paymentLinks").map((link) => pick(link, ["id", "provider", "label", "status", "amountMinor", "url"])),
    recipients: asArray("recipients").map((r) => r.email).filter(Boolean),
    counts: {
      credits: asArray("credits").length,
      creditNotes: asArray("creditNotes").length,
      pops: asArray("pops").length,
      deliveries: asArray("deliveries").length,
      reminders: asArray("reminders").length,
      followUps: asArray("followUps").length,
      refunds: asArray("refunds").length,
    },
  };
  for (const section of DETAIL_SECTIONS) if (wanted.has(section) && detail[section] !== undefined) out[section] = detail[section];
  out.hint = `Compact view. For more pass sections (${DETAIL_SECTIONS.join(", ")}) or compact false for everything.`;
  return out;
}
