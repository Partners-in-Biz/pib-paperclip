/**
 * Company preferences for Billing: the choices a company owner or admin edits
 * on the Billing page without an instance admin. They are merged over the saved
 * Billing settings at one point (`billingSettings` in config.ts), so every
 * reader of settings sees them. The sender (`sender.*`) and the EFT bank details
 * (`payment.*`) are here too: an id with a dot is a key inside that saved settings object.
 *
 * Defaults are what Billing did before this existed, so a company that never
 * opens the panel (and the saved settings it already has, which are read as the
 * fallback) behaves exactly as before.
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { definePreferences, describePreferences, readPreferences, savePreferences, TAX_CODES, type PreferenceValue, type PreferenceValues } from "@partnersinbiz/pib-plugin-kit";
import { BillingError } from "./domain.js";
import { BANK_PREFERENCE_IDS } from "./preference-ids.js";
import { requiredCompany } from "./util.js";

export const PREFERENCES_LOAD_ACTION = "billing.preferences-load";
export const PREFERENCES_SAVE_ACTION = "billing.preferences-save";

export const BILLING_PREFERENCES = definePreferences({
  id: "billing",
  fields: {
    defaultCurrency: { type: "string", label: "Default currency", help: "Three-letter code, e.g. ZAR.", max: 3, default: "ZAR", legacy: "defaultCurrency" },
    reportingCurrency: { type: "string", label: "Book (reporting) currency", help: "Reports and journals convert foreign invoices to this currency.", max: 3, default: "ZAR", legacy: "reportingCurrency" },
    vatRegistered: { type: "bool", label: "VAT registered", help: "Off when the business does not charge VAT: new lines are out of scope.", default: true, legacy: "vatRegistered" },
    defaultTaxRate: { type: "int", label: "Default VAT rate (%)", min: 0, max: 100, default: 15, legacy: "defaultTaxRate" },
    defaultTaxCode: { type: "enum", label: "Default VAT code for new lines", help: "Empty: follows the VAT rate.", options: ["", ...Object.keys(TAX_CODES)], default: "", legacy: "defaultTaxCode" },
    pricesIncludeVat: { type: "bool", label: "Prices include VAT", help: "Off: VAT is added to line prices. On: line prices already include it.", default: false, legacy: "pricesIncludeVat" },
    defaultDueDays: { type: "int", label: "Days until an invoice is due", help: "0: no due date unless one is set.", min: 0, max: 365, default: 0, legacy: "defaultDueDays" },
    invoiceNotes: { type: "text", label: "Footer notes", help: "Printed at the bottom of invoices (terms, thank-you note).", max: 2000, default: "", legacy: "invoiceNotes" },
    "sender.name": { type: "string", label: "Business name", help: "Printed as the sender on documents and emails. Empty: the company name.", max: 200, default: ({ companyName }) => companyName, legacy: "sender.name" },
    "sender.address": { type: "text", label: "Address", help: "Use new lines for each address line.", max: 500, default: "", legacy: "sender.address" },
    "sender.email": { type: "string", label: "Billing email", max: 200, default: "", legacy: "sender.email" },
    "sender.phone": { type: "string", label: "Phone", max: 50, default: "", legacy: "sender.phone" },
    "sender.vatNumber": { type: "string", label: "VAT number", help: "When set, documents are titled Tax invoice / Tax credit note.", max: 50, default: "", legacy: "sender.vatNumber" },
    "sender.registrationNumber": { type: "string", label: "Company registration number", max: 50, default: "", legacy: "sender.registrationNumber" },
    "payment.bankName": { type: "string", label: "Bank", help: "Customers pay into these details: you confirm before a change is saved.", max: 100, default: "", legacy: "payment.bankName" },
    "payment.accountName": { type: "string", label: "Account holder", max: 200, default: "", legacy: "payment.accountName" },
    "payment.accountNumber": { type: "string", label: "Account number", max: 50, default: "", legacy: "payment.accountNumber" },
    "payment.branchCode": { type: "string", label: "Branch code", max: 50, default: "", legacy: "payment.branchCode" },
    "payment.accountType": { type: "string", label: "Account type", max: 50, default: "", legacy: "payment.accountType" },
    "payment.swift": { type: "string", label: "SWIFT code", max: 50, default: "", legacy: "payment.swift" },
  },
});

const CURRENCY_FIELDS = ["defaultCurrency", "reportingCurrency"] as const;
/** Empty text means "not set": the code that reads settings treats a missing value, not "", as unset. */
const EMPTY_IS_UNSET = new Set(["defaultTaxCode", "invoiceNotes"]);

/**
 * Preferences laid over the saved settings; a preference wins. Only the ids in `explicit` (saved by a person) are
 * laid over: every other setting stays exactly as saved, or unset, so a company that never used the panel behaves as
 * before (the schema defaults are for the form, not for the code that reads settings). Pure.
 */
export function mergePreferences<T extends object>(settings: T, prefs: PreferenceValues, explicit: ReadonlySet<string>): T {
  const out: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const id of explicit) {
    const value = prefs[id];
    if (value === undefined) continue;
    const dot = id.indexOf(".");
    if (dot > 0) {
      // "sender.name" is the key `name` inside the saved `sender` object; its other keys stay as saved. Empty means unset.
      const parentKey = id.slice(0, dot);
      const parent = out[parentKey];
      const nested: Record<string, unknown> = parent && typeof parent === "object" && !Array.isArray(parent) ? { ...(parent as Record<string, unknown>) } : {};
      if (value === "") delete nested[id.slice(dot + 1)];
      else nested[id.slice(dot + 1)] = value;
      out[parentKey] = nested;
    } else if (EMPTY_IS_UNSET.has(id) && value === "") delete out[id];
    else out[id] = value;
  }
  return out as T;
}

/** The ids a person saved. Reads the kit's preferences row (scope below must match `scope()` in the kit's preferences.ts). */
async function explicitIds(ctx: PluginContext, companyId: string): Promise<Set<string>> {
  const row = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "preferences", stateKey: "v1" });
  const values = row && typeof row === "object" ? (row as { values?: unknown }).values : undefined;
  return new Set(values && typeof values === "object" && !Array.isArray(values) ? Object.keys(values).filter((id) => Object.hasOwn(BILLING_PREFERENCES.fields, id)) : []);
}

/** Saved settings with the company's saved preferences on top. A failed preferences read leaves the settings as they are. */
export async function withPreferences<T extends object>(ctx: PluginContext, companyId: string, settings: T): Promise<T> {
  try {
    const explicit = await explicitIds(ctx, companyId);
    if (explicit.size === 0) return settings;
    return mergePreferences(settings, await readPreferences(ctx, companyId, BILLING_PREFERENCES), explicit);
  } catch {
    return settings;
  }
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  return { fields: describePreferences(BILLING_PREFERENCES), values: await readPreferences(ctx, companyId, BILLING_PREFERENCES) };
}

/** Currency codes are checked here: the kit checks length only. Returns the patch with codes upper-cased. */
export function checkedPatch(raw: unknown): Record<string, PreferenceValue | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BillingError("Nothing to save");
  const patch = { ...(raw as Record<string, PreferenceValue | null>) };
  for (const id of CURRENCY_FIELDS) {
    const value = patch[id];
    if (value === undefined || value === null) continue;
    const code = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(code)) throw new BillingError(`${BILLING_PREFERENCES.fields[id]!.label} must be a three-letter currency code`);
    patch[id] = code;
  }
  return patch;
}

/** The bank-detail ids a patch touches. Pure. */
export function bankIdsIn(patch: Record<string, unknown>): string[] {
  return BANK_PREFERENCE_IDS.filter((id) => Object.hasOwn(patch, id));
}

async function save(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  let patch: Record<string, PreferenceValue | null>;
  try {
    patch = checkedPatch(params.patch);
  } catch (error) {
    if (error instanceof BillingError) return { ok: false as const, error: error.message };
    throw error;
  }
  // Money data: the page asks the owner first and sends `confirmed: true`. A save without it is refused and says what would change.
  const bank = bankIdsIn(patch);
  if (bank.length > 0 && params.confirmed !== true) {
    const current = await readPreferences(ctx, companyId, BILLING_PREFERENCES);
    const changes = bank.map((id) => `${BILLING_PREFERENCES.fields[id]!.label} (now ${current[id] === "" || current[id] === undefined ? "empty" : String(current[id])})`);
    return { ok: false as const, needsConfirmation: bank, error: `Confirm the change to the bank details before it is saved: ${changes.join(", ")}` };
  }
  return savePreferences(ctx, context, BILLING_PREFERENCES, patch);
}

export const PREFERENCES_ACTIONS: Record<string, (ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) => Promise<unknown>> = {
  [PREFERENCES_LOAD_ACTION]: (ctx, context) => load(ctx, context),
  [PREFERENCES_SAVE_ACTION]: save,
};
