/**
 * Guided setup: which modules a company uses, and what each plugin still
 * needs before its agents can run on their own.
 *
 * - The Setup plugin (`partnersinbiz.setup`) owns the module choice per
 *   company and emits `modules.updated` (re-emitted hourly). Every PiB plugin
 *   keeps a copy with `registerModuleWatch` and skips jobs for companies that
 *   switched its module off (`isModuleEnabled`). No choice saved = enabled.
 * - Every PiB plugin serves `GET /setup-status?companyId=` (declare it with
 *   `SETUP_STATUS_ROUTE`) returning a `SetupStatus`, and pushes the same
 *   status as `setup.status` from its periodic jobs (`publishSetupStatus`) so
 *   the Setup plugin can build the weekly "Finish setup" issue without
 *   calling other plugins.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS } from "./contracts.js";

export const SETUP_PLUGIN = "partnersinbiz.setup";

export const SETUP_EVENTS = {
  /** Setup → every plugin: `{ companyId, modules: Record<ModuleKey, boolean>, updatedAt }`. */
  modulesUpdated: "modules.updated",
  /** Any plugin → Setup: a `SetupStatus`. */
  status: "setup.status",
} as const;

/** Modules a company can switch on or off, and the plugins behind each. */
export const MODULES = {
  crm: { title: "CRM", plugins: [PIB_PLUGINS.crm], description: "Companies, contacts, deals, sequences. Other modules use it for clients." },
  mailbox: { title: "Mailbox (Gmail)", plugins: [PIB_PLUGINS.mailbox], description: "Connect Gmail: triage, and sending for invoices, payslips, sequences and campaigns." },
  social: { title: "Social media", plugins: [PIB_PLUGINS.social], description: "Accounts, scheduling, inbox, Growth Lab." },
  seo: { title: "SEO", plugins: [PIB_PLUGINS.seo], description: "90-day SEO sprints worked by the SEO agent through the site repo." },
  campaigns: { title: "Email campaigns", plugins: [PIB_PLUGINS.campaigns], description: "Themed email programmes sent through the Mailbox." },
  billing: { title: "Billing", plugins: [PIB_PLUGINS.billing], description: "Invoices, quotes, payments, bills, expenses, retainers." },
  accounting: { title: "Accounting", plugins: [PIB_PLUGINS.accounting], description: "Ledger, bank reconciliation, VAT, reports." },
  payroll: { title: "Payroll", plugins: [PIB_PLUGINS.payroll], description: "ZA payroll, payslips, EMP201/IRP5." },
  partners: { title: "Partners", plugins: [PIB_PLUGINS.partners], description: "Share records with partner companies." },
} as const;
export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];

/** Which module a plugin belongs to. */
export function moduleOfPlugin(pluginKey: string): ModuleKey | null {
  for (const key of MODULE_KEYS) if ((MODULES[key].plugins as readonly string[]).includes(pluginKey)) return key;
  return null;
}

export type SetupItemStatus = "done" | "missing" | "optional" | "blocked" | "unknown";

export interface SetupItem {
  /** Stable key within the plugin, e.g. `settings`, `gmail`, `service_account`. */
  key: string;
  title: string;
  status: SetupItemStatus;
  /** Why it matters / what is wrong, one or two sentences. */
  detail?: string;
  /** Required items count towards progress and the Finish setup issue; optional ones do not. */
  required: boolean;
  /** Where to fix it: a Paperclip path (`/settings/...`, `/social?tab=accounts`) or an https URL. */
  href?: string | null;
  hrefLabel?: string | null;
  /** Exact steps when a person has to do it (shown in guided mode). */
  steps?: string[];
  /** What the agent does once this is done. */
  agentNext?: string | null;
  /** A plugin action the Setup page can run for the person ("Do it for me"). */
  action?: { plugin: string; key: string; params?: Record<string, unknown>; label: string } | null;
  /** Items this one waits on (other keys in the same plugin). */
  blockedBy?: string[];
}

export interface SetupStatus {
  plugin: string;
  module: ModuleKey | null;
  title: string;
  version?: string | null;
  items: SetupItem[];
  checkedAt: string;
}

export function setupProgress(items: SetupItem[]): { done: number; total: number; missing: SetupItem[] } {
  const required = items.filter((i) => i.required);
  return { done: required.filter((i) => i.status === "done").length, total: required.length, missing: required.filter((i) => i.status !== "done") };
}

/** Manifest apiRoutes entry every PiB plugin adds. */
export const SETUP_STATUS_ROUTE = {
  routeKey: "setup-status",
  method: "GET",
  path: "/setup-status",
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
} as const;

/** Standard first item: the plugin's settings were saved for this company. */
export function settingsItem(input: { saved: boolean; pluginId?: string | null; title?: string; detail?: string; agentNext?: string }): SetupItem {
  return {
    key: "settings",
    title: input.title ?? "Save the plugin settings",
    status: input.saved ? "done" : "missing",
    required: true,
    detail: input.saved ? undefined : input.detail ?? "Until the settings are saved once for this company, the plugin's scheduled jobs cannot act for it.",
    href: input.pluginId ? `/company/settings/instance/plugins/${input.pluginId}` : "/company/settings/instance/plugins",
    hrefLabel: "Open settings",
    steps: input.saved ? undefined : ["Open the plugin's settings page.", "Fill in what you have (secrets can come later).", "Click Save Configuration."],
    agentNext: input.agentNext ?? null,
  };
}

// ---------------------------------------------------------------------------
// Module switches (worker side)
// ---------------------------------------------------------------------------

const MODULE_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-setup", stateKey: "modules" });

export interface ModulesPayload {
  companyId: string;
  modules: Partial<Record<ModuleKey, boolean>>;
  updatedAt: string;
}

/** Keep a copy of the company's module switches (call once in setup). */
export function registerModuleWatch(ctx: PluginContext): void {
  ctx.events.on(`plugin.${SETUP_PLUGIN}.${SETUP_EVENTS.modulesUpdated}`, async (event: PluginEvent) => {
    const payload = event.payload as ModulesPayload | undefined;
    const companyId = payload?.companyId ?? event.companyId;
    if (!companyId || !payload?.modules) return;
    try {
      const current = (await ctx.state.get(MODULE_STATE(companyId))) as ModulesPayload | null;
      if (current?.updatedAt && payload.updatedAt && current.updatedAt > payload.updatedAt) return;
      await ctx.state.set(MODULE_STATE(companyId), { companyId, modules: payload.modules, updatedAt: payload.updatedAt ?? new Date().toISOString() });
    } catch (error) {
      ctx.logger.info("Module switch update failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** False only when the company switched this plugin's module off. */
export async function isModuleEnabled(ctx: PluginContext, companyId: string, pluginKey: string): Promise<boolean> {
  const module = moduleOfPlugin(pluginKey);
  if (!module) return true;
  try {
    const current = (await ctx.state.get(MODULE_STATE(companyId))) as ModulesPayload | null;
    return current?.modules?.[module] !== false;
  } catch {
    return true;
  }
}

/** Push this plugin's status to the Setup plugin (call from a periodic job per company). */
export async function publishSetupStatus(ctx: PluginContext, companyId: string, status: SetupStatus): Promise<void> {
  try {
    await ctx.events.emit(SETUP_EVENTS.status, companyId, status as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Setup status emit failed", { error: error instanceof Error ? error.message : String(error) });
  }
}
