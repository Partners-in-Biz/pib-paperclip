/**
 * Rules and wording for the Mailbox page (no React or UI-kit imports, so node
 * tests can use them): whether Gmail can be connected, whether a draft can be
 * sent and why not, who sent a mail, and recent times.
 */

export interface SettingsLike {
  saved: boolean;
  publicBaseUrl: string | null;
  encryptionKey: boolean;
  googleClientSecret: boolean;
}

/** The one-time technical settings Gmail cannot be connected without, by their name in the settings form. */
export function missingTechnical(settings: SettingsLike | null | undefined): string[] {
  if (!settings) return [];
  return [
    !settings.publicBaseUrl && "Public base URL",
    !settings.encryptionKey && "Token encryption key",
    !settings.googleClientSecret && "Google client secret",
  ].filter((value): value is string => Boolean(value));
}

/** Whether "Connect Gmail" can start the Google sign-in now, and if not, why (one short line). */
export function connectReadiness(settings: SettingsLike | null | undefined): { ready: boolean; reason: string | null } {
  if (!settings) return { ready: false, reason: "Loading the Mailbox settings…" };
  if (!settings.saved || missingTechnical(settings).length > 0) return { ready: false, reason: "An admin first does the one-time technical setup." };
  return { ready: true, reason: null };
}

export interface AccountLike {
  id: string;
  address: string;
  status: string;
  has_credential: boolean;
}

/** Gmail can send from this account (the worker's own test before it sends a draft). */
export function canSendFrom(account: AccountLike | null | undefined): boolean {
  return Boolean(account?.has_credential) && (account?.status === "connected" || account?.status === "needs_reconnect");
}

export interface DraftLike {
  status: string;
  account_id: string;
  to_addrs: Array<{ email: string }> | null;
  cc_addrs?: Array<{ email: string }> | null;
  bcc_addrs?: Array<{ email: string }> | null;
}

export function draftRecipients(draft: DraftLike): string[] {
  return [...(draft.to_addrs ?? []), ...(draft.cc_addrs ?? []), ...(draft.bcc_addrs ?? [])].map((row) => row.email).filter(Boolean);
}

/**
 * Why a draft cannot be sent from the page, or null when it can. Only a draft
 * has a Send button; the reasons match what the worker would refuse or park.
 */
export function sendBlock(draft: DraftLike, accounts: AccountLike[]): string | null {
  if (draft.status !== "draft") return null;
  const account = accounts.find((row) => row.id === draft.account_id) ?? null;
  const reasons: string[] = [];
  if (!canSendFrom(account)) reasons.push(account ? `Connect Gmail for ${account.address} first` : "Connect Gmail first");
  if (draftRecipients(draft).length === 0) reasons.push(reasons.length ? "add a recipient" : "Add a recipient first");
  return reasons.length ? `${reasons.join(", and ")}.` : null;
}

const MODULE_NAMES: Record<string, string> = {
  "partnersinbiz.mailbox": "Mailbox",
  "partnersinbiz.crm": "CRM",
  "partnersinbiz.campaigns": "Campaigns",
  "partnersinbiz.billing": "Billing",
  "partnersinbiz.accounting": "Accounting",
  "partnersinbiz.payroll": "Payroll",
  "partnersinbiz.social": "Social",
  "partnersinbiz.seo": "SEO",
  "partnersinbiz.cockpit": "Cockpit",
  "partnersinbiz.partners": "Partners",
  "partnersinbiz.setup": "Setup",
};

/** A module's name for people: `partnersinbiz.billing` → "Billing". */
export function moduleName(pluginKey: string | null | undefined): string {
  if (!pluginKey) return "Mailbox";
  const known = MODULE_NAMES[pluginKey];
  if (known) return known;
  const last = pluginKey.slice(pluginKey.lastIndexOf(".") + 1).replace(/[-_]+/g, " ");
  return last ? `${last.charAt(0).toUpperCase()}${last.slice(1)}` : "Mailbox";
}

/** Who sent a mail: "Billing · invoice", "Campaigns · campaign step", "Mailbox · draft". */
export function sentBy(request: { sourcePlugin: string; context: { plugin: string; kind: string } | null }): string {
  const kind = (request.context?.kind ?? "mail").replace(/[-_]+/g, " ");
  return `${moduleName(request.context?.plugin ?? request.sourcePlugin)} · ${kind}`;
}

/**
 * "just now", "5 min ago", "3 h ago" for the last day; null otherwise, and
 * the page then shows the date with the UI kit's `formatShortDate` ("28 Sep").
 */
export function recentTime(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.round((now.getTime() - time) / 60_000);
  if (minutes >= 0 && minutes < 1) return "just now";
  if (minutes >= 1 && minutes < 60) return `${minutes} min ago`;
  if (minutes >= 60 && minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return null;
}

/** Page wording for a sender domain's status. */
export function domainStatusLabel(status: string): string {
  return status === "healthy" ? "Healthy" : status === "warn" ? "Needs attention" : status === "bad" ? "Problem" : "Not known yet";
}

/** Pill tone for a sender domain's status (the page's `Pill` tones). */
export function domainTone(status: string): "ok" | "warn" | "bad" | "neutral" {
  return status === "healthy" ? "ok" : status === "warn" ? "warn" : status === "bad" ? "bad" : "neutral";
}

export const MAP_TYPE_NAMES: Record<string, string> = {
  sender_domain: "Mail from the domain",
  sender_address: "Mail from the address",
  recipient_domain: "Mail to the domain",
  recipient_address: "Mail to the address",
};

/** A starting point for a mapping from a mail the Mailbox flagged: its sender's domain. Null when there is no usable sender. */
export function suggestMapping(mail: { from: { email: string } | null }): { matchType: "sender_domain"; pattern: string } | null {
  const domain = mail.from?.email.split("@")[1]?.toLowerCase().trim();
  return domain && domain.includes(".") ? { matchType: "sender_domain", pattern: domain } : null;
}

/** One line for the DKIM, SPF, DMARC and MX results of a stored domain check. */
export function domainFacts(row: { mx: string | null; spf: string | null; dkim: string | null; dmarc: string | null }): string {
  const word = (state: string | null) => (state === null ? "not read" : state === "ok" || state === "enforced" ? "ok" : state === "monitor" ? "monitoring" : state);
  return `MX ${word(row.mx)} · SPF ${word(row.spf)} · DKIM ${word(row.dkim)} · DMARC ${row.dmarc === "none" ? "monitoring (p=none)" : row.dmarc === "quarantine" || row.dmarc === "reject" ? `p=${row.dmarc}` : word(row.dmarc)}`;
}
