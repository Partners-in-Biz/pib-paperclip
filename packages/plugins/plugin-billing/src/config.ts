/**
 * Billing settings (one saved row per Paperclip company) and the resolved
 * services built from them: private R2 for financial documents, the
 * Anthropic key for receipt reading, Jev, dunning and numbering.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decisionConfig, readConfig, SecretResolver, TAX_CODES, type DecisionClientConfig, type R2Config, type TaxCode } from "@partnersinbiz/pib-plugin-kit";

export interface DunningStage {
  daysAfterDue: number;
  subject: string;
  body: string;
}

export interface BillingSettings {
  sender?: Record<string, unknown>;
  payment?: Record<string, unknown>;
  defaultCurrency?: string;
  defaultDueDays?: number;
  defaultTaxRate?: number;
  defaultTaxCode?: string;
  pricesIncludeVat?: boolean;
  reportingCurrency?: string;
  invoiceNotes?: string;
  reviewerUserId?: string;
  defaultHourlyRateMinor?: number;
  expenseCategories?: string[];
  numbering?: { mode?: string; digits?: number; fallbackPrefix?: string };
  email?: { enabled?: boolean; from?: string; cc?: string; bcc?: string; signature?: string };
  ledger?: { enabled?: boolean };
  r2?: { accountId?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: unknown; prefix?: string };
  anthropic?: { apiKey?: unknown; model?: string; extractReceipts?: boolean };
  jev?: { apiKey?: unknown; model?: string; enabled?: boolean };
  dunning?: { enabled?: boolean; attachInvoice?: boolean; stages?: DunningStage[] };
}

export const DEFAULT_EXPENSE_CATEGORIES = [
  "software",
  "hosting",
  "advertising",
  "contractors",
  "travel",
  "meals",
  "office",
  "equipment",
  "telecoms",
  "bank_fees",
  "professional_fees",
  "training",
  "other",
];

export const RECEIPT_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

export const DEFAULT_DUNNING_STAGES: DunningStage[] = [
  {
    daysAfterDue: 1,
    subject: "Reminder: invoice {{invoiceNumber}} is due",
    body:
      "Hi {{clientName}},\n\nInvoice {{invoiceNumber}} for {{amount}} was due on {{dueDate}}. " +
      "Please pay by EFT and use {{invoiceNumber}} as the reference. If you have already paid, reply with your proof of payment and ignore this reminder.\n\n" +
      "Thank you,\n{{businessName}}",
  },
  {
    daysAfterDue: 7,
    subject: "Second reminder: invoice {{invoiceNumber}} is {{daysOverdue}} days overdue",
    body:
      "Hi {{clientName}},\n\nInvoice {{invoiceNumber}} still shows {{amount}} outstanding. " +
      "Please settle it by EFT with {{invoiceNumber}} as the reference, and reply with your proof of payment.\n\n" +
      "Thank you,\n{{businessName}}",
  },
  {
    daysAfterDue: 14,
    subject: "Final reminder: invoice {{invoiceNumber}} is overdue",
    body:
      "Hi {{clientName}},\n\nInvoice {{invoiceNumber}} for {{amount}} is {{daysOverdue}} days overdue. " +
      "Please pay it now, or reply to arrange a payment plan.\n\n" +
      "{{businessName}}",
  },
];

export async function billingSettings(ctx: PluginContext, companyId: string): Promise<BillingSettings> {
  try {
    return (await readConfig(ctx, companyId)) as BillingSettings;
  } catch {
    return {};
  }
}

export function isTaxCode(value: unknown): value is TaxCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TAX_CODES, value);
}

/** The VAT code new lines get: the setting, else 15% when a VAT rate is set, else out of scope. */
export function defaultTaxCode(settings: BillingSettings): TaxCode {
  if (isTaxCode(settings.defaultTaxCode)) return settings.defaultTaxCode;
  const rate = Number(settings.defaultTaxRate ?? 15);
  return Number.isFinite(rate) && rate > 0 ? "za_std_15" : "za_out_of_scope";
}

export function reportingCurrency(settings: BillingSettings): string {
  const value = String(settings.reportingCurrency ?? "ZAR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : "ZAR";
}

export function expenseCategories(settings: BillingSettings): string[] {
  const list = Array.isArray(settings.expenseCategories)
    ? settings.expenseCategories.map((item) => String(item).trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean)
    : [];
  const unique = [...new Set(list.length ? list : DEFAULT_EXPENSE_CATEGORIES)];
  if (!unique.includes("other")) unique.push("other");
  return unique.slice(0, 250);
}

export function emailEnabled(settings: BillingSettings): boolean {
  return settings.email?.enabled !== false;
}

export function ledgerEnabled(settings: BillingSettings): boolean {
  return settings.ledger?.enabled !== false;
}

export function dunningStages(settings: BillingSettings): DunningStage[] {
  const raw = Array.isArray(settings.dunning?.stages) && settings.dunning!.stages!.length ? settings.dunning!.stages! : DEFAULT_DUNNING_STAGES;
  return raw
    .map((stage) => ({
      daysAfterDue: Math.max(0, Math.floor(Number(stage.daysAfterDue ?? 0))),
      subject: String(stage.subject ?? "").trim() || "Reminder: invoice {{invoiceNumber}}",
      body: String(stage.body ?? "").trim() || DEFAULT_DUNNING_STAGES[0]!.body,
    }))
    .filter((stage) => Number.isFinite(stage.daysAfterDue))
    .sort((a, b) => a.daysAfterDue - b.daysAfterDue);
}

export function r2Configured(settings: BillingSettings): boolean {
  const r2 = settings.r2 ?? {};
  return Boolean(str(r2.accountId) && str(r2.bucket) && str(r2.accessKeyId) && r2.secretAccessKey);
}

export interface PrivateR2 extends R2Config {
  prefix: string;
}

/** Private bucket for invoices, statements, receipts and POPs. `publicBaseUrl` stays empty: nothing is public. */
export async function privateR2(resolver: SecretResolver, settings: BillingSettings): Promise<PrivateR2 | null> {
  if (!r2Configured(settings)) return null;
  const r2 = settings.r2!;
  const secretAccessKey = await resolver.get("r2.secretAccessKey");
  if (!secretAccessKey) return null;
  const prefix = (str(r2.prefix) ?? "billing").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9/_-]/g, "-") || "billing";
  return {
    accountId: str(r2.accountId)!,
    bucket: str(r2.bucket)!,
    accessKeyId: str(r2.accessKeyId)!,
    secretAccessKey,
    publicBaseUrl: "",
    prefix,
  };
}

export async function anthropicConfig(resolver: SecretResolver, settings: BillingSettings): Promise<{ apiKey: string; model: string } | null> {
  if (settings.anthropic?.extractReceipts === false) return null;
  const apiKey = await resolver.get("anthropic.apiKey");
  if (!apiKey) return null;
  return { apiKey, model: str(settings.anthropic?.model) ?? RECEIPT_MODEL_DEFAULT };
}

export async function jevFor(resolver: SecretResolver, settings: BillingSettings): Promise<DecisionClientConfig | null> {
  try {
    return await decisionConfig(resolver, settings as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Settings + a per-run secret resolver. Never store what the resolver returns. */
export async function loadBilling(ctx: PluginContext, companyId: string) {
  const settings = await billingSettings(ctx, companyId);
  const resolver = new SecretResolver(ctx, companyId, settings as Record<string, unknown>);
  return { settings, resolver };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
