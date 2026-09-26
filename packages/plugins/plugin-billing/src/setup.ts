/**
 * Guided setup for the Setup plugin: what Billing still needs for a company
 * (`GET /setup-status`, and `setup.status` pushed hourly), plus the module
 * switches (Billing off → no new automatic work; Accounting off → no
 * journals are sent).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  isModuleEnabled,
  LEDGER_EVENTS,
  PIB_PLUGINS,
  pluginUiBase,
  publishSetupStatus,
  settingsItem,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { billingSettings, emailEnabled, ledgerEnabled, r2Configured, type BillingSettings } from "./config.js";
import { asObject, table } from "./db.js";
import manifest from "./manifest.js";
import { PLUGIN_ID } from "./namespace.js";

export const SETTINGS_FALLBACK_HREF = "/company/settings/instance/plugins";

/** Billing is on for this company (no choice saved = on). */
export function billingOn(ctx: PluginContext, companyId: string): Promise<boolean> {
  return isModuleEnabled(ctx, companyId, PLUGIN_ID);
}

/** Accounting is on for this company, so journals may be sent to it. */
export function accountingOn(ctx: PluginContext, companyId: string): Promise<boolean> {
  return isModuleEnabled(ctx, companyId, PIB_PLUGINS.accounting);
}

/** Companies this plugin knows from its own rows (documents, costs, CRM projection, outbox). */
export async function knownCompanyIds(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT company_id FROM ${table(ctx, "invoices")}
      UNION SELECT company_id FROM ${table(ctx, "quotes")}
      UNION SELECT company_id FROM ${table(ctx, "bills")}
      UNION SELECT company_id FROM ${table(ctx, "expenses")}
      UNION SELECT company_id FROM ${table(ctx, "subscriptions")}
      UNION SELECT company_id FROM ${table(ctx, "crm_companies")}
      UNION SELECT company_id FROM ${table(ctx, "crm_contacts")}
      UNION SELECT company_id FROM ${table(ctx, "outbox")}`,
  );
  return [...new Set(rows.map((row) => row.company_id).filter(Boolean))];
}

/** `/company/settings/instance/plugins/<installation uuid>` once the page reported it, else the plugin list. */
export async function settingsLink(ctx: PluginContext): Promise<{ pluginId: string | null; href: string }> {
  const base = await pluginUiBase(ctx);
  const uuid = base ? /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(base)?.[1] ?? null : null;
  return uuid ? { pluginId: uuid, href: `${SETTINGS_FALLBACK_HREF}/${uuid}` } : { pluginId: null, href: SETTINGS_FALLBACK_HREF };
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

async function probe(key: string, title: string, required: boolean, fn: () => Promise<SetupItem>): Promise<SetupItem> {
  try {
    return await fn();
  } catch (error) {
    return { key, title, required, status: "unknown", detail: `Could not check this: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function count(ctx: PluginContext, sql: string, params: unknown[]): Promise<number> {
  const rows = await ctx.db.query<{ n: string | number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

function vatRegistered(settings: BillingSettings): boolean {
  if (settings.defaultTaxCode === "za_out_of_scope") return false;
  if (settings.defaultTaxCode == null && settings.defaultTaxRate != null && Number(settings.defaultTaxRate) <= 0) return false;
  return true;
}

export async function setupStatus(ctx: PluginContext, companyId: string): Promise<SetupStatus> {
  const [saved, settings, link] = await Promise.all([configSaved(ctx, companyId), billingSettings(ctx, companyId), settingsLink(ctx)]);
  const settingsHref = link.href;
  const base = settingsItem({
    saved,
    pluginId: link.pluginId ?? PLUGIN_ID,
    agentNext: "Billing can number, price and send documents for this company.",
  });
  const items: SetupItem[] = [{ ...base, href: settingsHref }];

  items.push(await probe("sender", "Your business details", true, async () => {
    const sender = asObject(settings.sender);
    const needsVat = vatRegistered(settings);
    const missing = [
      !str(sender.name) && "business name",
      !str(sender.address) && "address",
      needsVat && !str(sender.vatNumber) && "VAT number",
    ].filter(Boolean) as string[];
    return {
      key: "sender",
      title: "Your business details",
      required: true,
      status: missing.length ? "missing" : "done",
      detail: missing.length
        ? `Missing: ${missing.join(", ")}. These print on every invoice and quote.${needsVat ? " Not VAT registered? Set the default VAT code to za_out_of_scope." : ""}`
        : undefined,
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: missing.length ? ["Open Billing settings.", "Under Your business (sender), fill in the business name, address and VAT number.", "Click Save Configuration."] : undefined,
      agentNext: "Invoices and quotes print your business details (and are titled Tax invoice when a VAT number is set).",
    };
  }));

  items.push(await probe("eft", "EFT bank details", true, async () => {
    const payment = asObject(settings.payment);
    const missing = [
      !str(payment.bankName) && "bank",
      !str(payment.accountName) && "account name",
      !str(payment.accountNumber) && "account number",
      !str(payment.branchCode) && "branch code",
    ].filter(Boolean) as string[];
    return {
      key: "eft",
      title: "EFT bank details",
      required: true,
      status: missing.length ? "missing" : "done",
      detail: missing.length ? `Missing: ${missing.join(", ")}. Clients need these to pay by EFT.` : undefined,
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: missing.length ? ["Open Billing settings.", "Under EFT payment details, fill in the bank, account name, account number and branch code.", "Click Save Configuration."] : undefined,
      agentNext: "Invoices and reminders show how to pay, with the invoice number as the reference.",
    };
  }));

  items.push(await probe("r2", "Private storage for invoice PDFs", true, async () => {
    const done = r2Configured(settings);
    return {
      key: "r2",
      title: "Private storage for invoice PDFs",
      required: true,
      status: done ? "done" : "missing",
      detail: done ? undefined : "Invoice PDFs, statements, receipts and proofs of payment are kept in a private Cloudflare R2 bucket. Without it, emails go out without attachments and uploads fail.",
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: done ? undefined : [
        "In Cloudflare, open R2 and create a new bucket (for example pib-billing-private). Do not connect a custom domain and leave the public r2.dev URL off.",
        "In the bucket's Settings, add a CORS policy that allows PUT and GET from your Paperclip address (for example https://paperclip.partnersinbiz.online).",
        "In R2, create an API token with Object Read & Write on that bucket only. Copy the access key ID and secret access key.",
        "In Billing settings, fill in Private document storage: account ID, bucket, access key ID and secret access key. Click Save Configuration.",
      ],
      agentNext: "Billing attaches invoice PDFs to emails as links that expire, and stores receipts and proofs of payment.",
    };
  }));

  items.push(await probe("mailbox", "Mailbox for sending invoices", false, async () => {
    if (!emailEnabled(settings)) {
      return {
        key: "mailbox",
        title: "Mailbox for sending invoices",
        required: false,
        status: "optional",
        detail: "Emailing documents is off in Billing settings, so approved invoices are marked sent and you send them yourself.",
        href: settingsHref,
        hrefLabel: "Open settings",
      };
    }
    const mailboxOn = await isModuleEnabled(ctx, companyId, PIB_PLUGINS.mailbox);
    const sent = await count(ctx, `SELECT count(*) AS n FROM ${table(ctx, "deliveries")} WHERE company_id = $1 AND status = 'sent'`, [companyId]);
    return {
      key: "mailbox",
      title: "Mailbox for sending invoices",
      required: false,
      status: sent > 0 ? "done" : "optional",
      detail: sent > 0
        ? undefined
        : mailboxOn
          ? "Approved invoices, quotes, statements and reminders are sent from your Gmail through the Mailbox. Connect Gmail there. Nothing has been sent yet."
          : "The Mailbox is switched off for this company, so Billing cannot email documents. Send them yourself, or turn the Mailbox on in Setup.",
      href: mailboxOn ? "/mailbox" : "/setup",
      hrefLabel: mailboxOn ? "Open Mailbox" : "Open Setup",
      agentNext: "Approved documents are emailed with the PDF, and replies with proof of payment are picked up.",
    };
  }));

  items.push(await probe("ledger", "Post to Accounting", false, async () => {
    const title = "Post to Accounting";
    if (!ledgerEnabled(settings)) {
      return { key: "ledger", title, required: false, status: "optional", detail: "Posting to Accounting is off in Billing settings, so invoices and payments do not reach the books.", href: settingsHref, hrefLabel: "Open settings" };
    }
    if (!(await accountingOn(ctx, companyId))) {
      return { key: "ledger", title, required: false, status: "optional", detail: "Accounting is switched off for this company, so Billing does not send journals.", href: "/setup", hrefLabel: "Open Setup" };
    }
    const rows = await ctx.db.query<{ status: string; n: string | number }>(
      `SELECT status, count(*) AS n FROM ${table(ctx, "outbox")} WHERE company_id = $1 AND event = $2 GROUP BY status`,
      [companyId, LEDGER_EVENTS.postRequested],
    );
    const by = new Map(rows.map((row) => [row.status, Number(row.n)]));
    const posted = by.get("done") ?? 0;
    const failed = by.get("failed") ?? 0;
    const waiting = by.get("pending") ?? 0;
    return {
      key: "ledger",
      title,
      required: false,
      status: posted > 0 && failed === 0 ? "done" : "optional",
      detail: failed > 0
        ? `${failed} journal${failed === 1 ? " was" : "s were"} rejected by Accounting. Open the document and retry once Accounting is set up.`
        : posted > 0
          ? undefined
          : waiting > 0
            ? `${waiting} journal${waiting === 1 ? " is" : "s are"} waiting for Accounting. Install the Accounting plugin and seed its chart of accounts.`
            : "Invoices, payments, credit notes, bills and expenses are posted to the Accounting plugin. Install it and seed its chart of accounts.",
      href: "/accounting",
      hrefLabel: "Open Accounting",
      agentNext: "Every invoice, payment, bill and expense lands in the books as a journal.",
    };
  }));

  items.push(await probe("reminders", "Payment reminders", false, async () => {
    const on = settings.dunning?.enabled === true;
    return {
      key: "reminders",
      title: "Payment reminders",
      required: false,
      status: on ? "done" : "optional",
      detail: on ? undefined : "Off by default. When on, Billing emails a reminder for each stage an invoice is overdue. You can opt clients out on the Billing page.",
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: on ? undefined : ["Open Billing settings.", "Under Payment reminders, switch on Send reminders and check the stages.", "Click Save Configuration."],
      agentNext: "Overdue invoices are chased by email at 07:00 each day.",
    };
  }));

  items.push(await probe("receipts", "Receipt reading (Anthropic key)", false, async () => {
    const on = settings.anthropic?.extractReceipts !== false && Boolean(settings.anthropic?.apiKey);
    return {
      key: "receipts",
      title: "Receipt reading (Anthropic key)",
      required: false,
      status: on ? "done" : "optional",
      detail: on ? undefined : "Optional. With an Anthropic API key, Billing reads the vendor, date, total and VAT from uploaded receipts. Without it, people type them.",
      href: settingsHref,
      hrefLabel: "Open settings",
      steps: on ? undefined : ["Create an API key at console.anthropic.com.", "In Billing settings, under Receipt reading, paste it as a secret.", "Click Save Configuration."],
      agentNext: "Uploaded receipts become draft expenses with the amounts filled in.",
    };
  }));

  items.push(await probe("jev", "Smart categories (Jev key)", false, async () => {
    const on = settings.jev?.enabled !== false && Boolean(settings.jev?.apiKey);
    return {
      key: "jev",
      title: "Smart categories (Jev key)",
      required: false,
      status: on ? "done" : "optional",
      detail: on ? undefined : "Optional. With a Jev key, Billing suggests categories for expenses read from receipts. Without it, fixed rules are used.",
      href: settingsHref,
      hrefLabel: "Open settings",
      agentNext: "New expenses get a suggested category.",
    };
  }));

  items.push(await probe("first_client", "First client in the CRM", false, async () => {
    const n = await count(
      ctx,
      `SELECT (SELECT count(*) FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND deleted = false)
            + (SELECT count(*) FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND deleted = false) AS n`,
      [companyId],
    );
    return {
      key: "first_client",
      title: "First client in the CRM",
      required: false,
      status: n > 0 ? "done" : "optional",
      detail: n > 0 ? undefined : "Invoices are addressed to CRM companies and contacts. Add your first client in the CRM.",
      href: "/crm",
      hrefLabel: "Open CRM",
      agentNext: "Agents can draft invoices and quotes for that client.",
    };
  }));

  return {
    plugin: PLUGIN_ID,
    module: "billing",
    title: "Billing",
    version: manifest.version,
    items,
    checkedAt: new Date().toISOString(),
  };
}

/** Push the status of every known company to the Setup plugin. Never throws. */
export async function publishAllSetupStatus(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanyIds(ctx).catch(() => [] as string[])) {
    try {
      await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Setup status skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
