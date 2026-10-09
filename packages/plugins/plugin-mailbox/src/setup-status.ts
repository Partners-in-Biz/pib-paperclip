/**
 * What the Mailbox still needs for a company, for the Setup plugin's
 * checklist (`GET /setup-status` and the hourly `setup.status` event).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  companyRoles,
  isSecretRef,
  knownCompanyIds,
  moduleOfPlugin,
  pluginUiBase,
  publishSetupStatus,
  settingsItem,
  teamSetupPath,
  valueAtPath,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, espWebhookUrl, gmailRedirectUri, loadMailboxConfig, r2Configured } from "./config.js";
import type { GmailStore } from "./db.js";
import { dnsInstructions, requiredRecords } from "./esp/domains.js";
import { readEspState } from "./esp/runtime.js";
import type { AccountRow } from "./gmail/types.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { proofIsFresh, readProxyProof } from "./unsubscribe.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
/** A connected account whose last sync is older than this counts as unhealthy. */
export const SYNC_HEALTHY_MS = 10 * 60_000;
const KNOWN = { scopeKind: "instance" as const, namespace: "mailbox-setup", stateKey: "known-companies" };

type AccountSource = Pick<GmailStore, "listAccounts"> & Partial<Pick<GmailStore, "delegationFor" | "hasDelegationRemoval" | "listDomainChecks" | "listEspDomains">>;

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
  // Every company any kit entry point (skills, bootstrap, tools) has served.
  ids.push(...(await knownCompanyIds(ctx)));
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
  const roles = await companyRoles(ctx, companyId);
  const manager = roles?.team?.["account-manager"]?.agentId ?? null;
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
  const bookkeeper = roles?.team?.bookkeeper?.agentId ?? null;
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

  // 8. The Operator reviews mail across the company (and asked for access five times when nothing gave it): it gets read and draft by default.
  const operator = roles?.operatorAgentId ?? null;
  const opGrant = operator && sender && store.delegationFor ? await store.delegationFor(sender.id, operator).catch(() => null) : null;
  const opRemoved = operator && sender && store.hasDelegationRemoval ? await store.hasDelegationRemoval(sender.id, operator).catch(() => false) : false;
  const opDelegated = Boolean(opGrant?.can_read && opGrant.can_draft);
  const autoMode = loaded.config.autoDelegate;
  items.push({
    key: "operator_delegation",
    title: "Let the Operator read and draft mail",
    status: !operator ? "optional" : opDelegated ? "done" : opRemoved ? "optional" : "missing",
    required: Boolean(operator) && !opRemoved,
    detail: !operator
      ? "Once an Operator is staffed in Setup → Team it gets read and draft access (never sending) on the company's own mailboxes by itself."
      : opDelegated
        ? `The Operator can read and draft on ${sender!.address}${opGrant?.can_send ? " and send" : ", never send"}.`
        : opRemoved
          ? "You removed the Operator's access, so it stays off until you give it again."
          : !sender
            ? "Connect Gmail first; the Operator then gets read and draft access by itself."
            : autoMode === "off"
              ? `Automatic access is switched off in the Mailbox settings, so the Operator cannot read or draft on ${sender.address} until you allow it.`
              : `The Operator gets read and draft access on ${sender.address} within a few minutes; click to do it now.`,
    href: operator ? "/mailbox?tab=mailboxes" : teamSetupPath("operator"),
    hrefLabel: operator ? "Open Mailboxes" : "Open Setup → Team",
    blockedBy: connected.length > 0 ? undefined : ["gmail"],
    action: operator && sender && !opDelegated && !opRemoved
      ? { plugin: PLUGIN_ID, key: "mailbox.create-delegation", params: { accountId: sender.id, agentId: operator }, label: "Allow read and draft" }
      : null,
    agentNext: "The Operator reads the inbox in its daily review and drafts replies; sending stays with a person.",
  });

  // 9. Mail authentication of the domains the company sends from (SPF, DKIM, DMARC): checked daily; fixes are DNS records someone adds once.
  const domainRows = store.listDomainChecks ? await store.listDomainChecks(companyId).catch(() => []) : [];
  const domainProblems = domainRows.filter((row) => row.status === "bad" || row.status === "warn");
  const worstDomain = domainRows.find((row) => row.status === "bad") ?? domainProblems[0] ?? null;
  const worstReport = (worstDomain?.result ?? {}) as { problems?: Array<{ severity: string; message: string; fix: string }> };
  const worstProblem = worstReport.problems?.find((problem) => problem.severity !== "info") ?? null;
  items.push({
    key: "sender_domain",
    title: "Sender domain mail authentication (SPF, DKIM, DMARC)",
    status: domainRows.length === 0 ? "optional" : domainProblems.length === 0 ? "done" : "missing",
    required: false,
    detail: domainRows.length === 0
      ? "Checked every day for each domain a mailbox sends from. Until a mailbox is connected there is nothing to check."
      : domainProblems.length === 0
        ? `${domainRows.map((row) => row.domain).join(", ")}: SPF, DKIM and DMARC are in place.`
        : `${domainProblems.map((row) => `${row.domain} (${row.status})`).join(", ")}. ${worstProblem?.message ?? ""}`.trim(),
    href: "/mailbox?tab=mailboxes",
    hrefLabel: "Open sender domains",
    steps: domainProblems.length === 0 ? undefined : [
      "A person who controls the domain's DNS adds the records. The Operator or Account Manager can list exactly which with the check-sender-domain tool.",
      worstProblem?.fix ?? "Open Mailboxes → Sender domains for the records to add.",
      "DNS changes can take a few hours to show; the daily check, or Check now on the Mailboxes tab, confirms them.",
    ],
    agentNext: "Campaigns send from a domain only when it is healthy; the Cockpit shows each domain's status.",
  });

  // 10. One-click unsubscribe links (optional). "Done" only while the Mailbox has proved that the reverse proxy passes the request
  // address on: without that rule a one-click unsubscribe is acknowledged by the host and recorded by nobody.
  const unsubSet = hasValue(raw, "unsubscribe.secret") && Boolean(loaded.config.publicBaseUrl);
  const proof = unsubSet ? await readProxyProof(ctx, companyId) : null;
  const unsubLive = unsubSet && proofIsFresh(proof, now);
  const proxyStep = "First, ask whoever runs the server to add the reverse proxy rule from the Mailbox README (it passes the request address of /webhooks/unsubscribe on to the plugin). Without it a one-click unsubscribe would do nothing, so the Mailbox keeps the link off until it has checked this.";
  items.push({
    key: "unsubscribe",
    title: "One-click unsubscribe links (optional, admin)",
    status: unsubLive ? "done" : "optional",
    required: false,
    detail: unsubLive
      ? `Marketing mail to one recipient carries an https unsubscribe link next to the mailto one. The Mailbox checks every hour that the reverse proxy still passes the request address on (last passed ${proof!.at.slice(0, 16).replace("T", " ")} UTC).`
      : unsubSet
        ? `Not active yet: ${proof && !proof.ok ? proof.detail ?? "the last check failed." : proof?.ok ? "the last passed check is more than 6 hours old." : "the Mailbox has not checked the reverse proxy yet (it does so every hour)."} Marketing mail carries the mailto unsubscribe only, which works.`
        : "Optional. Gmail and Yahoo show an Unsubscribe button for mail with a one-click link; without it recipients reply \"unsubscribe\" instead, which also works.",
    href: settings,
    hrefLabel: "Open settings",
    steps: unsubLive ? undefined : [
      proxyStep,
      ...(unsubSet ? [] : ["In the Mailbox settings, find One-click unsubscribe and pick or create a Paperclip secret of 16 or more random characters, then click Save Configuration."]),
      "The Mailbox then tests the rule itself every hour (or press Check now). The https link goes into marketing mail only after that test passes.",
    ],
    action: unsubSet && !unsubLive ? { plugin: PLUGIN_ID, key: "mailbox.check-unsubscribe-proxy", label: "Check now" } : null,
    agentNext: "Marketing mail carries List-Unsubscribe-Post, and a click suppresses the address for that sender.",
  });

  // 11. Private storage for attachments (optional).
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

  // 12-14. The email provider (Resend), optional: a second, send-only way to send as a client's own domain. Three one-time owner steps, each with its deep link.
  items.push(...(await emailProviderItems(ctx, companyId, loaded, store, settings, settingsDone)));

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

/**
 * The email provider's three setup items. All optional: Gmail keeps working without them. The owner does each once; what the
 * agent does afterwards is in each item's `agentNext`.
 * - **Account and key**: a Resend account, a full-access API key saved as a Paperclip secret, and the switch in the Mailbox settings.
 * - **Webhook**: the endpoint in Resend and its signing secret saved as a Paperclip secret. Without it nothing is sent through the
 *   provider, because bounces and complaints would be missed.
 * - **A sending domain**: registered by an agent (add-sending-domain) or a person; its DNS records are added by whoever controls the
 *   DNS (the owner, or the client or their web host). The item lists the exact records while a domain waits.
 */
async function emailProviderItems(ctx: PluginContext, companyId: string, loaded: Awaited<ReturnType<typeof loadMailboxConfig>>, store: AccountSource, settings: string, settingsDone: boolean): Promise<SetupItem[]> {
  const esp = loaded.config.esp;
  const readiness = espReadiness(esp);
  const webhookUrl = espWebhookUrl(loaded.config.publicBaseUrl, loaded.config.esp.provider);
  const state = await readEspState(ctx, companyId);
  const refused = Boolean(state && !state.ok);
  const domains = store.listEspDomains ? await store.listEspDomains(companyId).catch(() => []) : [];
  const verified = domains.filter((row) => row.status === "verified");
  const waiting = domains.filter((row) => row.status !== "verified");
  const items: SetupItem[] = [];

  const accountDone = readiness.domains && !refused;
  items.push({
    key: "esp_account",
    title: "Email provider: a Resend account and API key (optional, owner)",
    status: accountDone ? "done" : refused ? "blocked" : "optional",
    required: false,
    detail: refused
      ? `Resend ${state!.code === "quota" ? "says the sending quota is used up" : "refused the Mailbox's API key"}${state!.detail ? ` (${state!.detail})` : ""}. Mail through the provider waits and is tried again; Gmail is not affected.`
      : accountDone
        ? "The provider is switched on and its API key is saved. Agents can register a client's sending domain."
        : !esp.enabled && esp.hasCredentials
          ? "The API key is saved but the provider is switched off in the Mailbox settings."
          : "Optional. Lets the Mailbox send as a client's own verified domain through Resend, with bounce and complaint handling, instead of only from one Gmail account. Gmail stays the default.",
    href: settings,
    hrefLabel: "Open settings",
    steps: accountDone
      ? undefined
      : [
        ...(esp.hasCredentials ? [] : [
          "Create a Resend account at https://resend.com/signup (or sign in at https://resend.com/login).",
          "Open https://resend.com/api-keys, click Create API Key, choose Full access (the Mailbox adds domains as well as sending), and copy the key once.",
          "In Paperclip, create a secret for it (Settings, Secrets), then open the Mailbox settings, find Email provider, and pick that secret under Resend API key.",
        ]),
        "In the same section tick Switch the email provider on, then click Save Configuration.",
        ...(refused ? ["If Resend refused the key, create a new one and pick the new secret: the old one is revoked or restricted to sending only."] : []),
      ],
    blockedBy: settingsDone ? undefined : ["settings"],
    agentNext: "An agent registers a client's sending domain with add-sending-domain and gets the exact DNS records to hand over.",
  });

  const webhookDone = readiness.domains && esp.hasWebhookSecret;
  items.push({
    key: "esp_webhook",
    title: "Email provider: the webhook for bounces and complaints (optional, owner)",
    status: webhookDone ? "done" : readiness.domains ? "missing" : "optional",
    required: false,
    detail: webhookDone
      ? "Resend's delivery events are verified with the saved signing secret: hard bounces and complaints go on the do-not-email list, soft bounces back off, and each domain's bounce and complaint rate is watched."
      : readiness.domains
        ? "Until this is set, nothing is sent through the provider (a bounce or complaint would be missed). It takes two minutes."
        : "Comes after the account and API key.",
    href: settings,
    hrefLabel: "Open settings",
    steps: webhookDone
      ? undefined
      : [
        `At https://resend.com/webhooks click Add Webhook and set the Endpoint URL to ${webhookUrl ?? "<your Paperclip public address>/api/plugins/partnersinbiz.mailbox/webhooks/resend (save the Public base URL in the Mailbox settings first)"}.`,
        "Tick these events: email.delivered, email.bounced, email.complained, email.delivery_delayed, email.failed, email.opened, email.clicked, email.suppressed, domain.updated. Click Add.",
        "Open the webhook and copy its Signing Secret (it starts with whsec_). In Paperclip create a secret for it.",
        "In the Mailbox settings, Email provider, pick that secret under Resend webhook signing secret and click Save Configuration.",
      ],
    blockedBy: readiness.domains ? undefined : ["esp_account"],
    agentNext: "Bounces and complaints become do-not-email entries, delivery results show in mail-status, and a domain whose hard bounce rate reaches 2% or complaint rate 0.1% (7 days) is held back for marketing.",
  });

  const first = waiting[0] ?? null;
  const instructions = first ? dnsInstructions({ ...first, records: requiredRecords(first.records).filter((record) => record.status !== "verified") }) : null;
  items.push({
    key: "esp_domain",
    title: "Email provider: a sending domain (a client's own, or ours)",
    status: verified.length > 0 && waiting.length === 0 ? "done" : first ? (readiness.domains ? "missing" : "blocked") : "optional",
    required: false,
    detail: first
      ? `${waiting.map((row) => `${row.domain} (${row.status === "failed" ? "failed: its records are wrong" : "waiting for DNS records"})`).join(", ")}.${verified.length ? ` Ready: ${verified.map((row) => row.domain).join(", ")}.` : ""}`
      : verified.length > 0
        ? `Ready: ${verified.map((row) => row.domain).join(", ")}. Mail can go out as ${verified.length === 1 ? "it" : "them"}; each domain's daily cap ramps up over its first 13 days.`
        : "Optional. An agent registers a client's domain (a subdomain such as updates.client.co.za is best); the DNS records then go to whoever controls the domain.",
    href: "/mailbox?tab=mailboxes",
    hrefLabel: "Open sending domains",
    steps: first && instructions ? [`For ${first.domain}: ${instructions.whoAddsIt}`, ...instructions.steps, "The Mailbox asks Resend to verify every hour, so nothing more is needed once the records are in; Check now on the Mailboxes tab does it at once."] : undefined,
    blockedBy: readiness.sending ? undefined : ["esp_account", "esp_webhook"],
    agentNext: "Once the provider has verified the domain its send-only account becomes ready, the daily domain check watches it, and Campaigns and the other plugins can send as the client.",
  });

  // A domain whose bounce or complaint rate is over the limit has its marketing held back. Only a person can lift it sooner than the 7-day window
  // does, so it is shown here where the owner looks, with the one place to do it.
  const held = domains.filter((row) => Array.isArray((row.reputation as { problems?: unknown[] } | null)?.problems) && ((row.reputation as { problems: unknown[] }).problems.length > 0));
  if (held.length > 0) {
    items.push({
      key: "esp_hold",
      title: `Email provider: marketing is held for ${held.map((row) => row.domain).join(", ")}`,
      status: "missing",
      required: false,
      detail: `Marketing from ${held.length === 1 ? "this domain is" : "these domains are"} held back because its hard bounce rate reached 2% or its complaint rate 0.1% over the last 7 days. Transactional mail (invoices, signing emails) still goes. The hold clears by itself as the bad days leave the window; once the cause is fixed a person can lift it sooner. Only a person can, with a reason, and it is recorded: an agent cannot.`,
      href: "/mailbox?tab=mailboxes",
      hrefLabel: "Open sending domains",
      steps: [
        "Find out why: where the list came from (hard bounces) or who did not expect the mail (complaints). The domain's card on the Mailboxes tab shows the numbers.",
        "Fix the cause: remove the dead addresses, tighten the audience, make the unsubscribe link easy to see.",
        "On the Mailboxes tab, Email provider, open the domain and click Lift the hold, and write what was fixed.",
      ],
      agentNext: "Campaigns can launch from the domain again, and only bounces and complaints from now on are counted.",
    });
  }
  return items;
}
