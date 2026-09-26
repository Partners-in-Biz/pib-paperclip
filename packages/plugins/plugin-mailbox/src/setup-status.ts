/**
 * What the Mailbox still needs for a company, for the Setup plugin's
 * checklist (`GET /setup-status` and the hourly `setup.status` event).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  isSecretRef,
  moduleOfPlugin,
  pluginUiBase,
  publishSetupStatus,
  settingsItem,
  valueAtPath,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { gmailRedirectUri, loadMailboxConfig } from "./config.js";
import type { GmailStore } from "./db.js";
import type { AccountRow } from "./gmail/types.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
/** A connected account whose last sync is older than this counts as unhealthy. */
export const SYNC_HEALTHY_MS = 10 * 60_000;
const KNOWN = { scopeKind: "instance" as const, namespace: "mailbox-setup", stateKey: "known-companies" };

type AccountSource = Pick<GmailStore, "listAccounts">;

export async function settingsHref(ctx: PluginContext): Promise<{ href: string; uuid: string | null; uiBase: string | null }> {
  const uiBase = await pluginUiBase(ctx);
  const uuid = uiBase ? /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(uiBase)?.[1] ?? null : null;
  return { href: uuid ? `${SETTINGS_FALLBACK}/${uuid}` : SETTINGS_FALLBACK, uuid, uiBase };
}

function hasValue(raw: Record<string, unknown>, path: string): boolean {
  const value = valueAtPath(raw, path);
  if (isSecretRef(value)) return Boolean(value.secretId);
  return typeof value === "string" && value.trim().length > 0;
}

/** The settings the Mailbox cannot connect Gmail without, by label. */
export function missingSettings(raw: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!hasValue(raw, "publicBaseUrl")) missing.push("Public base URL");
  if (!hasValue(raw, "encryptionKey")) missing.push("Token encryption key");
  if (!hasValue(raw, "google.clientSecret")) missing.push("Google client secret");
  return missing;
}

export async function rememberCompany(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    const known = asList(await ctx.state.get(KNOWN));
    if (known.includes(companyId)) return;
    await ctx.state.set(KNOWN, [...known, companyId]);
  } catch {
    // best effort
  }
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Companies with an account row, plus companies that opened the Mailbox page. */
export async function knownCompanies(ctx: PluginContext): Promise<string[]> {
  const ids: string[] = [];
  try {
    const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${ctx.db.namespace}.accounts`);
    ids.push(...rows.map((row) => row.company_id));
  } catch {
    // no rows yet
  }
  try {
    ids.push(...asList(await ctx.state.get(KNOWN)));
  } catch {
    // ignore
  }
  return [...new Set(ids.filter(Boolean))];
}

function syncAge(account: AccountRow, now: number): number | null {
  if (!account.last_sync_at) return null;
  const at = Date.parse(account.last_sync_at);
  return Number.isNaN(at) ? null : now - at;
}

export async function setupStatus(ctx: PluginContext, companyId: string, store: AccountSource, now = Date.now()): Promise<SetupStatus> {
  const loaded = await loadMailboxConfig(ctx, companyId);
  const raw = loaded.raw;
  const saved = loaded.config.saved;
  const { href: settings, uuid, uiBase } = await settingsHref(ctx);
  const items: SetupItem[] = [];

  // 1. Settings: saved, with the three values Gmail needs.
  const missing = missingSettings(raw);
  const base = settingsItem({
    saved,
    pluginId: uuid ?? "",
    title: "Save the Mailbox settings",
    agentNext: "Gmail can be connected and the sync job runs for this company.",
  });
  const settingsDone = saved && missing.length === 0;
  items.push({
    ...base,
    href: settings,
    status: settingsDone ? "done" : "missing",
    detail: settingsDone
      ? undefined
      : !saved
        ? `Save the settings once for this company. Still needed: ${missing.join(", ")}.`
        : `Still needed: ${missing.join(", ")}.`,
    steps: settingsDone
      ? undefined
      : [
          "Open the Mailbox settings.",
          ...(missing.includes("Public base URL") ? ["Public base URL: the address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online."] : []),
          ...(missing.includes("Token encryption key") ? ["Token encryption key: pick or create a Paperclip secret of 16+ random characters."] : []),
          ...(missing.includes("Google client secret") ? ["Google OAuth client → Client secret: pick the Paperclip secret holding the Google Cloud Web client's secret."] : []),
          "Click Save Configuration.",
        ],
  });

  const accounts = await store.listAccounts(companyId).catch(() => [] as AccountRow[]);
  const connected = accounts.filter((account) => account.status === "connected" && account.token_sealed);
  const reconnect = accounts.filter((account) => account.status === "needs_reconnect");

  // 2. Gmail connected.
  let redirectUri: string | null = null;
  try {
    redirectUri = loaded.config.publicBaseUrl && uiBase ? gmailRedirectUri(loaded.config.publicBaseUrl, uiBase) : null;
  } catch {
    redirectUri = null;
  }
  const gmailStatus = connected.length > 0 ? "done" : reconnect.length > 0 ? "blocked" : "missing";
  items.push({
    key: "gmail",
    title: "Connect Gmail",
    status: gmailStatus,
    required: true,
    detail:
      gmailStatus === "done"
        ? `Connected: ${connected.map((account) => account.address).join(", ")}.`
        : gmailStatus === "blocked"
          ? `Gmail for ${reconnect.map((account) => account.address).join(", ")} must be reconnected.`
          : "Invoices, payslips, sequences and campaigns send through a connected Gmail account.",
    href: "/mailbox",
    hrefLabel: "Open Mailbox",
    steps: gmailStatus === "done" ? undefined : [
      redirectUri
        ? `In Google Cloud → APIs & Services → Credentials, add this Authorised redirect URI to the Web client: ${redirectUri}`
        : "Open the Mailbox page once to see the redirect URI, then add it in Google Cloud → APIs & Services → Credentials → the Web client → Authorised redirect URIs.",
      "Make sure the Gmail API is enabled for that Google Cloud project.",
      "On the Mailbox page, click Connect Gmail and sign in with the Google account to use.",
      "Google shows an \"unverified app\" warning the first time: click Advanced, then continue.",
    ],
    blockedBy: settingsDone ? undefined : ["settings"],
    agentNext: "Mail is synced and triaged every 2 minutes, and other plugins can send mail.",
  });

  // 3. A default sending account.
  const defaultAccount = connected.find((account) => account.is_default) ?? null;
  items.push({
    key: "default_account",
    title: "Pick the default sending account",
    status: defaultAccount ? "done" : "missing",
    required: true,
    detail: defaultAccount
      ? `Mail from other plugins goes out as ${defaultAccount.address}.`
      : "Mail from other plugins goes out from the default account unless a plugin names another address.",
    href: "/mailbox",
    hrefLabel: "Open Mailbox",
    steps: defaultAccount ? undefined : ["Open the Mailbox.", "Under Gmail, click Make default on the account to send from."],
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    action: !defaultAccount && connected.length === 1
      ? { plugin: PLUGIN_ID, key: "mailbox.set-default", params: { accountId: connected[0]!.id }, label: `Send from ${connected[0]!.address}` }
      : null,
    agentNext: null,
  });

  // 4. Jev (optional).
  const jev = hasValue(raw, "jev.apiKey") && (raw.jev as { enabled?: unknown } | undefined)?.enabled !== false;
  items.push({
    key: "jev",
    title: "Add the Jev (TypeSafe) key",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev ? "Inbox triage uses Jev." : "Optional. Used to triage the inbox (lead, client, invoice, spam, phishing). Without it the Mailbox uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "Create an API key at typesafe.ai → API keys.",
      "In the Mailbox settings, pick or create a Paperclip secret for Jev → TypeSafe API key.",
      "Click Save Configuration.",
    ],
    agentNext: "New mail gets a triage label and reply issues open for mail that needs an answer.",
  });

  // 5. Sync healthy.
  const stale = connected.filter((account) => {
    const age = syncAge(account, now);
    return age == null || age > SYNC_HEALTHY_MS;
  });
  const lastError = stale.map((account) => account.last_error).find((error) => Boolean(error)) ?? null;
  items.push({
    key: "sync",
    title: "Gmail sync is running",
    status: connected.length === 0 ? "missing" : stale.length === 0 ? "done" : "blocked",
    required: true,
    detail:
      connected.length === 0
        ? "Starts once Gmail is connected."
        : stale.length === 0
          ? "Every connected account synced in the last 10 minutes."
          : `No sync in the last 10 minutes for ${stale.map((account) => account.address).join(", ")}.${lastError ? ` Last error: ${lastError}` : ""}`,
    href: "/mailbox",
    hrefLabel: "Open Mailbox",
    steps: connected.length === 0 || stale.length === 0 ? undefined : [
      "Open the Mailbox and click Sync on the account.",
      "If the account shows Reconnect, click it and sign in again.",
      "If it still fails, check that the Mailbox settings are saved and the sync job is on under Settings → Plugins → Mailbox.",
    ],
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    agentNext: null,
  });

  return {
    plugin: PLUGIN_ID,
    module: moduleOfPlugin(PLUGIN_ID),
    title: "Mailbox",
    version: PLUGIN_VERSION,
    items,
    checkedAt: new Date(now).toISOString(),
  };
}

/** Hourly: push the status of every company the Mailbox knows with saved settings. */
export async function publishAllSetupStatus(ctx: PluginContext, store: AccountSource): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      const loaded = await loadMailboxConfig(ctx, companyId);
      if (!loaded.config.saved) continue;
      await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId, store));
      published += 1;
    } catch (error) {
      ctx.logger.info("Mailbox setup status skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
