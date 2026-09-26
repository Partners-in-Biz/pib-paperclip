/**
 * Guided setup: what Accounting still needs for a company before its books
 * can be trusted (kit setup.ts). Served on `GET /setup-status` and pushed to
 * the Setup plugin hourly from the redeliver job.
 *
 * Every probe reads the plugin's own rows or settings and never writes; a
 * probe that fails reports "unknown" instead of failing the whole status.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  isModuleEnabled,
  pluginUiBase,
  publishSetupStatus,
  readConfig,
  settingsItem,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import manifest from "../manifest.js";
import { PLUGIN_ID } from "../namespace.js";
import { bookkeeper } from "./agent.js";
import { loadChart, roleGaps } from "./books.js";
import { errorMessage } from "./common.js";

export const PLUGINS_SETTINGS_HREF = "/company/settings/instance/plugins";

type Probe = Omit<SetupItem, "status"> & { status?: SetupItem["status"] };

function blank(value: unknown): boolean {
  return typeof value !== "string" || !value.trim();
}

/** The installation uuid from `/_plugins/<uuid>/ui/`, or null. */
export function installationId(uiBase: string | null): string | null {
  const match = /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(uiBase ?? "");
  return match ? match[1]! : null;
}

async function settingsHref(ctx: PluginContext): Promise<string> {
  const id = installationId(await pluginUiBase(ctx).catch(() => null));
  return id ? `${PLUGINS_SETTINGS_HREF}/${id}` : PLUGINS_SETTINGS_HREF;
}

/** Run one probe; a thrown error becomes status "unknown". */
async function probe(ctx: PluginContext, companyId: string, base: Probe, check: () => Promise<{ done: boolean; detail?: string; patch?: Partial<SetupItem> }>): Promise<SetupItem> {
  try {
    const { done, detail, patch } = await check();
    const status: SetupItem["status"] = done ? "done" : base.required ? "missing" : "optional";
    return {
      ...base,
      ...patch,
      status,
      detail: done ? patch?.detail ?? undefined : detail ?? base.detail,
      steps: done ? undefined : patch?.steps ?? base.steps,
    };
  } catch (error) {
    ctx.logger.info("Accounting setup check failed", { companyId, key: base.key, error: errorMessage(error) });
    return { ...base, status: "unknown", detail: "This could not be checked just now." };
  }
}

export async function setupStatus(ctx: PluginContext, companyId: string): Promise<SetupStatus> {
  const settingsLink = await settingsHref(ctx);
  const items: SetupItem[] = [];

  // 1. Settings saved once for the company.
  try {
    const saved = await configSaved(ctx, companyId);
    const id = installationId(await pluginUiBase(ctx).catch(() => null));
    const item = settingsItem({
      saved,
      pluginId: id ?? "",
      detail: "Until the Accounting settings are saved once for this company, the scheduled jobs (depreciation, FX, month-end) skip it.",
      agentNext: "Sets up the South African chart of accounts and starts the scheduled jobs.",
    });
    if (!id) item.href = PLUGINS_SETTINGS_HREF;
    items.push(item);
  } catch (error) {
    ctx.logger.info("Accounting setup check failed", { companyId, key: "settings", error: errorMessage(error) });
    items.push({ key: "settings", title: "Save the plugin settings", status: "unknown", required: true, href: settingsLink, hrefLabel: "Open settings" });
  }

  // 2. Company details used on the VAT201 and the accountant pack.
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "company_details",
        title: "Add the legal name, VAT details and year-end",
        required: true,
        detail: "Printed on the VAT201 export and the accountant pack, and used to work out VAT periods.",
        href: settingsLink,
        hrefLabel: "Open settings",
        steps: [
          "Open Settings → Plugins → Accounting.",
          "Fill in the legal name (as registered with CIPC), the VAT number, the VAT category (or none if not VAT-registered) and the financial year-end month.",
          "Click Save Configuration.",
        ],
        agentNext: "Works out the VAT periods and prints these details on the VAT201 and the accountant pack.",
      },
      async () => {
        const raw = await readConfig(ctx, companyId);
        if (Object.keys(raw).length === 0) return { done: false, detail: "Still missing: legal name, VAT number, VAT category and financial year-end month." };
        // VAT category and year-end have defaults (B, February), so a saved form always has them.
        const missing: string[] = [];
        if (blank(raw.legalName)) missing.push("legal name");
        if (raw.vatCategory !== "none" && blank(raw.vatNumber)) missing.push("VAT number");
        const defaults: string[] = [];
        if (blank(raw.vatCategory)) defaults.push("VAT category B");
        if (raw.financialYearEndMonth == null || raw.financialYearEndMonth === "") defaults.push("year-end February");
        const note = defaults.length ? ` Using the defaults: ${defaults.join(", ")}.` : "";
        return {
          done: missing.length === 0,
          detail: `Still missing: ${missing.join(", ")}.${note}`,
          patch: note ? { detail: `Using the defaults: ${defaults.join(", ")}. Check they are right.` } : undefined,
        };
      },
    ),
  );

  // 3. Chart of accounts seeded, and every posting role mapped.
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "chart",
        title: "Set up the chart of accounts",
        required: true,
        detail: "The South African chart, the posting roles and the VAT codes are added the first time Accounting is used for the company.",
        href: "/accounting?tab=chart",
        hrefLabel: "Open Chart & roles",
        steps: ["Click Set up the chart (or open Accounting once).", "Check the accounts under Chart & roles and add any the business needs."],
        agentNext: "Billing and Payroll can post journals to the books.",
        action: { plugin: PLUGIN_ID, key: "accounting.chart", label: "Set up the chart" },
      },
      async () => {
        const book = await db.getBook(ctx.db, companyId);
        if (!book) return { done: false };
        const accounts = await db.listAccounts(ctx.db, companyId);
        return { done: accounts.length > 0, detail: "The book exists but has no accounts yet." };
      },
    ),
  );
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "roles",
        title: "Map every posting role to an account",
        required: true,
        detail: "Postings from Billing and Payroll that use an unmapped role are rejected.",
        href: "/accounting?tab=chart",
        hrefLabel: "Open Chart & roles",
        steps: ["Open Accounting → Chart & roles.", "Pick an active account for each role listed as missing."],
        agentNext: "Postings from Billing and Payroll land on the right accounts.",
        blockedBy: ["chart"],
      },
      async () => {
        const book = await db.getBook(ctx.db, companyId);
        if (!book) return { done: false, detail: "Set up the chart first." };
        const gaps = roleGaps(await loadChart(ctx, companyId));
        return { done: gaps.length === 0, detail: `Not mapped: ${gaps.join(", ")}.` };
      },
    ),
  );

  // 4. At least one bank account.
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "bank_account",
        title: "Add a bank account",
        required: true,
        detail: "Statements are imported and reconciled per bank account.",
        href: "/accounting?tab=bank",
        hrefLabel: "Open Bank",
        steps: ["Open Accounting → Bank.", "Click + Add bank account.", "Give it a name and link it to a Bank account in the chart."],
        agentNext: "The Bookkeeper can import statements and reconcile them.",
        blockedBy: ["chart"],
      },
      async () => {
        const accounts = await db.listBankAccounts(ctx.db, companyId);
        return { done: accounts.some((a) => a.active) };
      },
    ),
  );

  // 5. Opening balances at cut-over.
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "opening_balances",
        title: "Import opening balances at cut-over",
        required: true,
        detail: "Until the opening trial balance is posted, the balance sheet only shows what was posted here.",
        href: "/accounting?tab=cutover",
        hrefLabel: "Open Cut-over",
        steps: [
          "Export the trial balance from the old books at the cut-over date (usually the day before the first month kept here) as a CSV: code, name, debit, credit.",
          "Open Accounting → Cut-over, choose the file and the cut-over date.",
          "Click Check: it must balance, every code must be in the chart, and receivables and payables should match Billing.",
          "Click Post opening balances.",
        ],
        agentNext: "The balance sheet, cash flow and accountant pack start from the right figures.",
        blockedBy: ["chart", "roles"],
      },
      async () => {
        const book = await db.getBook(ctx.db, companyId);
        return { done: Boolean(book?.openingJournalId) };
      },
    ),
  );

  // 6. First statement imported (optional).
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "first_statement",
        title: "Import the first bank statement",
        required: false,
        detail: "CSV, OFX or MT940 from the bank. Statement emails in the mailbox open an issue to import them.",
        href: "/accounting?tab=bank",
        hrefLabel: "Open Bank",
        steps: ["Download a CSV, OFX or MT940 statement from the bank.", "Open Accounting → Bank → Import statement, pick the bank account and the file, and click Import."],
        agentNext: "Suggests a category or an invoice match for each line; the Bookkeeper works through them.",
        blockedBy: ["bank_account"],
      },
      async () => ({ done: (await db.listStatements(ctx.db, companyId)).length > 0 }),
    ),
  );

  // 7. Bookkeeper agent (optional).
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "bookkeeper",
        title: "Hire or link the Bookkeeper",
        required: false,
        detail: "An agent that reconciles the bank and runs the month-end close. A person still approves anything that posts or locks.",
        href: "/accounting",
        hrefLabel: "Open Accounting",
        steps: [
          "Open Accounting → Overview.",
          "Click Open a new hire task (or Link an existing agent).",
          "Approve the hire, then attach the pib-bookkeeping skill if Accounting asks you to.",
        ],
        agentNext: "Gets a \"Reconcile N new bank lines\" issue after each import and a \"Month-end close\" issue each month.",
      },
      async () => {
        const agent = await bookkeeper(ctx, companyId);
        return { done: Boolean(agent), patch: agent ? { detail: `Linked: ${agent.name}.` } : undefined };
      },
    ),
  );

  // 8. Private R2 bucket (optional).
  items.push(
    await probe(
      ctx,
      companyId,
      {
        key: "private_storage",
        title: "Connect private file storage (Cloudflare R2)",
        required: false,
        detail: "Needed for statement files over 1 MB and large accountant packs. Use a private bucket: these are financial documents.",
        href: settingsLink,
        hrefLabel: "Open settings",
        steps: [
          "In Cloudflare R2, create a new bucket. Leave public access off (no public URL, no custom domain).",
          "In the bucket's CORS settings, allow PUT and GET from the Paperclip address.",
          "Create an R2 API token with Object Read & Write on that bucket only.",
          "Open Settings → Plugins → Accounting → Private file storage: fill in the account ID, bucket name, access key ID and the secret access key (as a secret), then Save Configuration.",
        ],
        agentNext: "Large statements upload straight to the bucket and accountant packs are stored there.",
      },
      async () => {
        const raw = await readConfig(ctx, companyId);
        const r2 = (raw.r2 ?? null) as Record<string, unknown> | null;
        const ok = Boolean(r2) && !blank(r2!.accountId) && !blank(r2!.bucket) && !blank(r2!.accessKeyId) && r2!.secretAccessKey != null && r2!.secretAccessKey !== "";
        return { done: ok };
      },
    ),
  );

  // 9. Accountant review (information only).
  items.push({
    key: "accountant_review",
    title: "Ask the accountant to review the chart and VAT codes",
    status: "optional",
    required: false,
    detail: "Worth doing once before the first VAT201: the accountant checks the accounts, the role mapping and which VAT code each kind of income and expense uses.",
    href: "/accounting?tab=chart",
    hrefLabel: "Open Chart & roles",
    steps: ["Share Chart & roles and the VAT tab with the accountant.", "Make any changes they ask for under Chart & roles."],
    agentNext: null,
  });

  return {
    plugin: PLUGIN_ID,
    module: "accounting",
    title: "Accounting",
    version: manifest.version,
    items,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Hourly push to the Setup plugin
// ---------------------------------------------------------------------------

const PUBLISH_EVERY_MS = 60 * 60 * 1000;
const lastPublished = new Map<string, number>();

/** Publish at most once an hour per company; never throws. Returns true when it published. */
export async function publishStatusThrottled(ctx: PluginContext, companyId: string, now = Date.now()): Promise<boolean> {
  const last = lastPublished.get(companyId);
  if (last != null && now - last < PUBLISH_EVERY_MS) return false;
  lastPublished.set(companyId, now);
  try {
    if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) return false;
    await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId));
    return true;
  } catch (error) {
    ctx.logger.info("Accounting setup status publish failed", { companyId, error: errorMessage(error) });
    return false;
  }
}

/** Test hook: forget the publish times. */
export function resetPublishThrottle(): void {
  lastPublished.clear();
}
