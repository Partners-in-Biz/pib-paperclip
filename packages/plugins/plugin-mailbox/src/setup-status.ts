/**
 * What the Mailbox still needs for a company, for the Setup plugin's
 * checklist (`GET /setup-status` and the hourly `setup.status` event).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  companyRoles,
  isSecretRef,
  moduleOfPlugin,
  pluginUiBase,
  publishSetupStatus,
  settingsItem,
  teamSetupPath,
  valueAtPath,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { gmailRedirectUri, loadMailboxConfig, r2Configured } from "./config.js";
import type { GmailStore } from "./db.js";
import type { AccountRow } from "./gmail/types.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
/** A connected account whose last sync is older than this counts as unhealthy. */
export const SYNC_HEALTHY_MS = 10 * 60_000;
const KNOWN = { scopeKind: "instance" as const, namespace: "mailbox-setup", stateKey: "known-companies" };

type AccountSource = Pick<GmailStore, "listAccounts"> & Partial<Pick<GmailStore, "delegationFor">>;

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

  // 1. Settings: saved, with the three values Gmail needs. Admin work, done once.
  const missing = missingSettings(raw);
  const base = settingsItem({
    saved,
    pluginId: uuid ?? "",
    title: "One-time technical setup (admin)",
    agentNext: "Gmail can be connected and the sync job runs for this company.",
  });
  const settingsDone = saved && missing.length === 0;
  items.push({
    ...base,
    href: settings,
    hrefLabel: "Open settings",
    status: settingsDone ? "done" : "missing",
    detail: settingsDone
      ? undefined
      : `An admin connects Paperclip to Google once, so Gmail can be connected. ${!saved ? "Save the settings once for this company. " : ""}Still needed: ${missing.join(", ")}.`,
    steps: settingsDone
      ? undefined
      : [
          "Open the Mailbox settings (an admin).",
          ...(missing.includes("Public base URL") ? ["**Public base URL**: the web address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online. Google sends people back there after they sign in."] : []),
          ...(missing.includes("Token encryption key") ? ["**Token encryption key**: pick or create a Paperclip secret of 16 or more random characters. Gmail sign-ins are stored locked with it."] : []),
          ...(missing.includes("Google client secret") ? ["**Google OAuth client → Client secret**: pick the Paperclip secret that holds the Google Cloud web app's secret."] : []),
          "Click **Save Configuration**.",
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
    // The Mailbox page starts the Google sign-in at once from this link.
    href: "/mailbox?tab=mailboxes&connect=gmail",
    hrefLabel: gmailStatus === "blocked" ? "Reconnect Gmail" : "Connect Gmail",
    steps: gmailStatus === "done" ? undefined : [
      redirectUri
        ? `In Google Cloud → APIs & Services → Credentials, add this Authorised redirect URI to the Web client: ${redirectUri}`
        : "Open the Mailbox page once to see the redirect URI, then add it in Google Cloud → APIs & Services → Credentials → the Web client → Authorised redirect URIs.",
      "Make sure the Gmail API is enabled for that Google Cloud project.",
      "Click **Connect Gmail** and sign in with the Google account to use.",
      "Google shows an \"unverified app\" warning the first time: click Advanced, then continue.",
    ],
    blockedBy: settingsDone ? undefined : ["settings"],
    agentNext: "Mail is synced and sorted every 2 minutes, and the other modules can send mail.",
  });

  // 3. A default sending account.
  const defaultAccount = connected.find((account) => account.is_default) ?? null;
  items.push({
    key: "default_account",
    title: "Choose the sending account",
    status: defaultAccount ? "done" : "missing",
    required: true,
    detail: defaultAccount
      ? `Mail from the other modules goes out as ${defaultAccount.address}.`
      : "Invoices, reminders and payslips go out from this account unless a module names another address.",
    href: "/mailbox?tab=mailboxes",
    hrefLabel: "Choose sending account",
    steps: defaultAccount ? undefined : ["Open **Mailboxes**.", "Under Gmail, click **Make default** on the account to send from."],
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    action: !defaultAccount && connected.length === 1
      ? { plugin: PLUGIN_ID, key: "mailbox.set-default", params: { accountId: connected[0]!.id }, label: `Send from ${connected[0]!.address}` }
      : null,
    agentNext: null,
  });

  // 4. Smart sorting (optional; the Jev decision service).
  const jev = hasValue(raw, "jev.apiKey") && (raw.jev as { enabled?: unknown } | undefined)?.enabled !== false;
  items.push({
    key: "jev",
    title: "Smart sorting (optional)",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "New mail is sorted by the smart sorting service."
      : "Optional. Sorts new mail more accurately (lead, client, invoice, spam, phishing) and matches it to clients. Without it the Mailbox uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "An admin creates an API key with the smart sorting service (typesafe.ai → API keys).",
      "In the Mailbox settings, find **Smart sorting (Jev by TypeSafe)** and pick or create a Paperclip secret for the API key.",
      "Click **Save Configuration**.",
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
    href: "/mailbox?tab=mailboxes",
    hrefLabel: "Check Gmail sync",
    steps: connected.length === 0 || stale.length === 0 ? undefined : [
      "Open **Mailboxes** and click **Sync** on the account.",
      "If the account shows Reconnect, click it and sign in again.",
      "If it still fails, check that the Mailbox settings are saved and the sync job is on under Settings → Plugins → Mailbox.",
    ],
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    agentNext: null,
  });

  // 6. The Account Manager answers client mail: it needs read and draft access (a one-time grant).
  const manager = (await companyRoles(ctx, companyId))?.team?.["account-manager"]?.agentId ?? null;
  const sender = defaultAccount ?? connected[0] ?? null;
  const grant = manager && sender && store.delegationFor ? await store.delegationFor(sender.id, manager).catch(() => null) : null;
  const delegated = Boolean(grant?.can_read && grant.can_draft);
  items.push({
    key: "delegation",
    title: "Let the Account Manager read and draft mail",
    status: !manager ? "optional" : delegated ? "done" : "missing",
    required: Boolean(manager),
    detail: !manager
      ? "Once an Account Manager is staffed in Setup → Team, give it read and draft access here so it can answer client mail."
      : delegated
        ? `The Account Manager can read and draft on ${sender!.address}. Sending stays with a person unless you allow it.`
        : sender
          ? `Reply issues go to the Account Manager, but it cannot read or draft on ${sender.address} yet.`
          : "Connect Gmail first; then give the Account Manager read and draft access.",
    href: manager ? "/mailbox?tab=mailboxes" : teamSetupPath("account-manager"),
    hrefLabel: manager ? "Open Mailboxes" : "Open Setup → Team",
    steps: manager && !delegated ? ["Open the Mailbox → **Mailboxes**.", "Click **Give an agent access**, pick the mailbox and the Account Manager, and leave sending off.", "Click **Give access**."] : undefined,
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    action: manager && sender && !delegated
      ? { plugin: PLUGIN_ID, key: "mailbox.create-delegation", params: { accountId: sender.id, agentId: manager }, label: "Allow read and draft" }
      : null,
    agentNext: "The Account Manager answers client, lead and support mail from its reply issues.",
  });

  // 7. The Bookkeeper imports bank statements that arrive by mail: it needs read access (no drafting).
  const bookkeeper = (await companyRoles(ctx, companyId))?.team?.bookkeeper?.agentId ?? null;
  const bookGrant = bookkeeper && sender && store.delegationFor ? await store.delegationFor(sender.id, bookkeeper).catch(() => null) : null;
  const bookRead = Boolean(bookGrant?.can_read);
  items.push({
    key: "bookkeeper_delegation",
    title: "Let the Bookkeeper read bank statements",
    status: !bookkeeper ? "optional" : bookRead ? "done" : "missing",
    required: Boolean(bookkeeper),
    detail: !bookkeeper
      ? "Once a Bookkeeper is staffed in Setup → Team, let it read mail here so it can import bank statements that arrive by email."
      : bookRead
        ? `The Bookkeeper can read ${sender!.address} (no drafting or sending) and imports statements that arrive there.`
        : sender
          ? `Bank statements that arrive in ${sender.address} wait for a person until the Bookkeeper may read it.`
          : "Connect Gmail first; then let the Bookkeeper read it.",
    href: bookkeeper ? "/mailbox?tab=mailboxes" : teamSetupPath("bookkeeper"),
    hrefLabel: bookkeeper ? "Open Mailboxes" : "Open Setup → Team",
    steps: bookkeeper && !bookRead ? ["Open the Mailbox → **Mailboxes**.", "Click **Give an agent access**, pick the mailbox that receives bank statements and the Bookkeeper, and leave sending off.", "Click **Give access**."] : undefined,
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    action: bookkeeper && sender && !bookRead
      ? { plugin: PLUGIN_ID, key: "mailbox.create-delegation", params: { accountId: sender.id, agentId: bookkeeper, canDraft: false }, label: "Allow reading statements" }
      : null,
    agentNext: "The Bookkeeper fetches statements with get-attachment and imports them in Accounting.",
  });

  // 8. Private storage for attachments (optional).
  const r2 = r2Configured(raw);
  items.push({
    key: "attachments",
    title: "Private file storage for attachments (optional, admin)",
    status: r2 ? "done" : "optional",
    required: false,
    detail: r2
      ? "Agents get 15-minute links to attachments (PDF statements, proofs of payment)."
      : "Optional. Lets agents open PDF and image attachments, such as bank statements. Text files (CSV, OFX, QIF, TXT) work without it.",
    href: settings,
    hrefLabel: "Open settings",
    steps: r2 ? undefined : [
      "In Cloudflare R2, create a PRIVATE bucket (no public URL) and an API token with read and write on it.",
      "In the Mailbox settings, fill in Private attachment storage: account ID, bucket, access key ID, and pick a Paperclip secret for the secret access key.",
      "Click Save Configuration.",
    ],
    agentNext: "get-attachment returns a download link for any file.",
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
