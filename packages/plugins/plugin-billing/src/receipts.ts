/**
 * Receipts: optional reading with Claude (vendor, date, total, VAT,
 * currency) and Jev for the expense category and whether VAT is claimable.
 * Both are optional — with no key the person fills the fields and the
 * built-in rules decide.
 *
 * Claude gets the receipt image or PDF and must answer in a JSON schema
 * (structured outputs). Jev gets only named fields, never the file.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { amountBucket, decide, isYes, shouldAct, type DecisionClientConfig, type JevQuestions } from "@partnersinbiz/pib-plugin-kit";
import { BillingError } from "./domain.js";

export interface ReceiptFields {
  vendor: string | null;
  date: string | null;
  totalMinor: number | null;
  vatMinor: number | null;
  currency: string | null;
}

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vendor", "date", "totalMinor", "vatMinor", "currency"],
  properties: {
    vendor: { anyOf: [{ type: "string" }, { type: "null" }], description: "Business that issued the receipt" },
    date: { anyOf: [{ type: "string", format: "date" }, { type: "null" }], description: "Receipt date, YYYY-MM-DD" },
    totalMinor: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Total paid in minor units (cents), VAT included" },
    vatMinor: { anyOf: [{ type: "integer" }, { type: "null" }], description: "VAT amount in minor units (cents), null when not shown" },
    currency: { anyOf: [{ type: "string" }, { type: "null" }], description: "ISO 4217 code, e.g. ZAR" },
  },
} as const;

const RECEIPT_PROMPT =
  "Read this receipt or supplier invoice. Return the vendor name, the receipt date (YYYY-MM-DD), the total paid and the VAT amount " +
  "as integers in minor units (cents: R 1,234.50 is 123450), and the ISO currency code. Use null for anything that is not on the document. " +
  "South African receipts are usually ZAR with 15% VAT shown separately or as 'incl. VAT'.";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function normaliseReceipt(raw: unknown): ReceiptFields {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  const currency = typeof r.currency === "string" && /^[A-Za-z]{3}$/.test(r.currency.trim()) ? r.currency.trim().toUpperCase() : null;
  const total = int(r.totalMinor);
  let vat = int(r.vatMinor);
  if (vat != null && total != null && vat > total) vat = null;
  return {
    vendor: typeof r.vendor === "string" && r.vendor.trim() ? r.vendor.trim().slice(0, 200) : null,
    date,
    totalMinor: total,
    vatMinor: vat,
    currency,
  };
}

/**
 * Claude Messages API (native fetch; the plugin bundles no SDK). Images go
 * in as `image` blocks, PDFs as `document` blocks; the answer is constrained
 * with `output_config.format` (JSON schema).
 */
export async function extractReceipt(
  config: { apiKey: string; model: string },
  file: { bytes: Uint8Array; mime: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ReceiptFields> {
  const isPdf = file.mime === "application/pdf";
  if (!isPdf && !/^image\/(jpeg|png|gif|webp)$/.test(file.mime)) throw new BillingError("Receipts must be a PDF or an image");
  const source = { type: "base64", media_type: file.mime, data: base64(file.bytes) };
  const body = {
    model: config.model,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: RECEIPT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [isPdf ? { type: "document", source } : { type: "image", source }, { type: "text", text: RECEIPT_PROMPT }],
      },
    ],
  };
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new BillingError(`Receipt reading failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (data.stop_reason === "refusal") throw new BillingError("The receipt could not be read");
  const textBlock = (data.content ?? []).find((block) => block.type === "text" && typeof block.text === "string");
  if (!textBlock?.text) throw new BillingError("The receipt reader returned nothing");
  try {
    return normaliseReceipt(JSON.parse(textBlock.text));
  } catch {
    throw new BillingError("The receipt reader returned an unreadable answer");
  }
}

export interface ExpenseDecision {
  category: string | null;
  categoryConfident: boolean;
  vatClaimable: boolean | null;
  vatConfident: boolean;
  decisionIds: Record<string, string>;
}

/** Minimal state for Jev: named fields only (no file, exact amount bucketed). */
export function expenseState(input: { vendor?: string | null; description: string; amountMinor: number; currency: string; vatMinor?: number | null; senderVatRegistered: boolean }) {
  return {
    vendor: input.vendor ?? null,
    description: input.description.slice(0, 200),
    amount: amountBucket(input.amountMinor),
    currency: input.currency,
    vat_shown_on_receipt: (input.vatMinor ?? 0) > 0,
    we_are_vat_registered: input.senderVatRegistered,
  };
}

export function expenseQuestions(categories: string[]): JevQuestions {
  const criteria: Record<string, string | null> = {};
  for (const category of categories.slice(0, 255)) criteria[category] = null;
  return {
    category: { type: "choice", instructions: "Which bookkeeping expense category fits this business expense best?", criteria },
    vat_claimable: {
      type: "noul",
      instructions: "Can a VAT-registered South African business claim input VAT on this expense (a valid tax invoice with VAT, and not entertainment or a private cost)?",
    },
  };
}

/** Ask Jev; null answers when not configured. Act on category at "update" risk; VAT claimable at "money" risk. */
export async function decideExpense(
  ctx: PluginContext,
  companyId: string,
  config: DecisionClientConfig | null,
  subjectId: string,
  state: ReturnType<typeof expenseState>,
  categories: string[],
  fetchImpl?: typeof fetch,
): Promise<ExpenseDecision> {
  const result = await decide(ctx, companyId, {
    config,
    purpose: "billing.expense",
    subject: { kind: "expense", id: subjectId },
    state,
    questions: expenseQuestions(categories),
    fetchImpl,
  });
  if (!result) return { category: null, categoryConfident: false, vatClaimable: null, vatConfident: false, decisionIds: {} };
  const category = result.answers.category;
  const vat = result.answers.vat_claimable;
  const choice = category && category.type === "choice" && categories.includes(category.choice) ? category.choice : null;
  return {
    category: choice,
    categoryConfident: Boolean(choice) && shouldAct(category, "update"),
    vatClaimable: vat && vat.type === "noul" ? vat.noul >= 0.5 : null,
    vatConfident: Boolean(vat) && shouldAct(vat, "money"),
    decisionIds: result.ids,
  };
}

/** Built-in rule when Jev is off or unsure: claim VAT only when we are registered and the receipt shows VAT. */
export function ruleVatClaimable(input: { vatMinor: number; senderVatRegistered: boolean; category: string }): boolean {
  if (!input.senderVatRegistered || input.vatMinor <= 0) return false;
  return !["meals", "entertainment"].includes(input.category);
}

export { isYes };
