/**
 * Company settings for the Mailbox. Saving them once per company is what lets
 * the Gmail sync job act for that company (jobs have no invocation scope; the
 * host allows a job's call only for a company with a saved config row).
 * Secrets are secret-refs resolved per call with the kit `SecretResolver`.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { jevConfigSchema, oauthCallbackUrl, readConfig, secretField, SecretResolver } from "@partnersinbiz/pib-plugin-kit";

/** Same Google Cloud Web client as SEO and YouTube. */
export const DEFAULT_GOOGLE_CLIENT_ID = "430887310034-6hc826irms25pf22ou7qi22s70gbm79k.apps.googleusercontent.com";
export const DEFAULT_LABEL_PREFIX = "PiB";
export const DEFAULT_SEND_RATE = 20;

/** `autoDelegate` setting: who gets a default delegation on the company's own mailboxes (see delegations.ts). */
export type AutoDelegateMode = "operator" | "operator+roles" | "off";

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Mailbox settings",
  description:
    "Save once for each Paperclip company that uses the Mailbox. Saving lets the Gmail sync job work for the company. The Google redirect URI to register is shown on the Mailbox page.",
  properties: {
    publicBaseUrl: {
      type: "string",
      title: "Public base URL",
      description: "The URL people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online. Needed to connect Gmail.",
    },
    encryptionKey: secretField(
      "Token encryption key",
      "A secret (16+ characters) used to encrypt stored Gmail tokens. Changing it means reconnecting Gmail.",
    ),
    google: {
      type: "object",
      title: "Google OAuth client (Gmail)",
      description: "The Google Cloud Web client used by SEO and YouTube, with the Gmail API enabled.",
      properties: {
        clientId: { type: "string", title: "Client ID", default: DEFAULT_GOOGLE_CLIENT_ID },
        clientSecret: secretField("Client secret"),
      },
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
    labelPrefix: {
      type: "string",
      title: "Gmail label prefix",
      description: "Triage labels are added as <prefix>/<Category>, e.g. PiB/Lead.",
      default: DEFAULT_LABEL_PREFIX,
    },
    fromName: {
      type: "string",
      title: "Sender name",
      description: "Optional name shown next to the Gmail address on mail the plugins send, e.g. Partners in Biz.",
    },
    replyIssues: {
      type: "boolean",
      title: "Open reply issues",
      description: "Mail from a client, a known lead or support that needs a reply opens one issue per thread for the agent who answers it. New leads go to the CRM instead.",
      default: true,
    },
    triageIssueAssignee: {
      type: "string",
      title: "Assign reply issues to",
      description:
        "Optional. An agent id, or user:<id> for a person. Empty: the Account Manager, else the Operator, else the owner.",
    },
    r2: {
      type: "object",
      title: "Private attachment storage (Cloudflare R2)",
      description:
        "A PRIVATE bucket (no public URL) where get-attachment stores a file and hands agents a link that expires in 15 minutes. Text files (CSV, OFX, QIF, TXT) work without it. Do not use the public social media bucket.",
      properties: {
        accountId: { type: "string", title: "Account ID" },
        bucket: { type: "string", title: "Bucket" },
        accessKeyId: { type: "string", title: "Access key ID" },
        secretAccessKey: secretField("Secret access key"),
        prefix: { type: "string", title: "Key prefix", default: "mailbox" },
      },
    },
    sendRatePerMinute: {
      type: "integer",
      title: "Sends per minute",
      description: "Most messages the Mailbox sends per Gmail account per minute. Extra requests wait and are retried.",
      default: DEFAULT_SEND_RATE,
      minimum: 1,
      maximum: 250,
    },
    defaultDelegation: {
      type: "string",
      title: "Default delegation for new agents",
      enum: ["read-draft", "draft-only"],
      default: "read-draft",
    },
    autoDelegate: {
      type: "string",
      title: "Mailbox access given without asking",
      description:
        "Who gets read and draft access (never sending) on the company's own Gmail mailboxes automatically. operator: only the Operator (default). operator+roles: also the Account Manager (read and draft) and the Bookkeeper (read). off: nobody; access is given by hand or by answering an agent's ask. Access a person removes is never given back automatically.",
      enum: ["operator", "operator+roles", "off"],
      default: "operator",
    },
    domainChecks: {
      type: "boolean",
      title: "Check sender domains every day",
      description: "Reads SPF, DKIM, DMARC and MX of every domain the company's mailboxes send from (public DNS) and reports problems on the Cockpit. It never changes DNS.",
      default: true,
    },
    dkimSelectors: {
      type: "string",
      title: "Extra DKIM selectors to look for",
      description: "Comma separated, e.g. mailer1, brevo. The usual ones (google, default, selector1, selector2, resend, k1, s1, s2, mail, dkim, smtp) are always tried.",
    },
    unsubscribe: {
      type: "object",
      title: "One-click unsubscribe (optional)",
      description:
        "With a secret here, marketing mail to a single recipient carries an https one-click unsubscribe link (RFC 8058) next to the mailto one, and the Mailbox's public unsubscribe address accepts it. The reverse proxy must pass the request address on (see the README): the Mailbox checks that every hour and adds its own link only while the check passes. Without it the Mailbox only adds a caller's https link or the mailto form.",
      properties: {
        secret: secretField("Unsubscribe link secret", "A Paperclip secret of 16 or more random characters that signs the unsubscribe links. Changing it invalidates links already sent."),
      },
    },
  },
};

export interface TriageAssignee {
  agentId?: string;
  userId?: string;
}

export interface MailboxConfig {
  /** Who gets a default delegation (see delegations.ts). */
  autoDelegate: AutoDelegateMode;
  /** Run the daily sender domain checks (default on). */
  domainChecks: boolean;
  /** Extra DKIM selectors to look for. */
  dkimSelectors: string[];
  saved: boolean;
  publicBaseUrl: string | null;
  googleClientId: string;
  labelPrefix: string;
  fromName: string | null;
  triageAssignee: TriageAssignee | null;
  /** Open reply issues for mail that needs an answer (default on). */
  replyIssues: boolean;
  sendRatePerMinute: number;
}

export function parseLabelPrefix(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LABEL_PREFIX;
  const cleaned = value.replace(/[\r\n\t]/g, " ").trim().replace(/^\/+|\/+$/g, "").slice(0, 40).trim();
  return cleaned || DEFAULT_LABEL_PREFIX;
}

export function parseTriageAssignee(value: unknown): TriageAssignee | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^user:/i.test(raw)) {
    const id = raw.slice(5).trim();
    return id ? { userId: id } : null;
  }
  const id = raw.replace(/^agent:/i, "").trim();
  return id ? { agentId: id } : null;
}

export function parseAutoDelegate(value: unknown): AutoDelegateMode {
  return value === "off" || value === "operator+roles" ? value : "operator";
}

/** `google, default` → a clean selector list (DNS labels only, at most 10). */
export function parseSelectors(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out = value.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/.test(item));
  return [...new Set(out)].slice(0, 10);
}

export function parseMailboxConfig(raw: Record<string, unknown>): MailboxConfig {
  const google = (raw.google && typeof raw.google === "object" ? raw.google : {}) as Record<string, unknown>;
  const rate = Number(raw.sendRatePerMinute);
  const base = typeof raw.publicBaseUrl === "string" && raw.publicBaseUrl.trim() ? raw.publicBaseUrl.trim() : null;
  const fromName = typeof raw.fromName === "string" && raw.fromName.trim() ? raw.fromName.replace(/[\r\n]/g, " ").trim().slice(0, 120) : null;
  return {
    autoDelegate: parseAutoDelegate(raw.autoDelegate),
    domainChecks: raw.domainChecks !== false,
    dkimSelectors: parseSelectors(raw.dkimSelectors),
    saved: Object.keys(raw).length > 0,
    publicBaseUrl: base,
    googleClientId: typeof google.clientId === "string" && google.clientId.trim() ? google.clientId.trim() : DEFAULT_GOOGLE_CLIENT_ID,
    labelPrefix: parseLabelPrefix(raw.labelPrefix),
    fromName,
    triageAssignee: parseTriageAssignee(raw.triageIssueAssignee),
    replyIssues: raw.replyIssues !== false,
    sendRatePerMinute: Number.isInteger(rate) && rate >= 1 && rate <= 250 ? rate : DEFAULT_SEND_RATE,
  };
}

/** Private R2 for attachments. Null until account id, bucket, key id and secret are set. */
export interface PrivateR2 {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** True when the R2 settings are filled in (the secret may still fail to resolve). */
export function r2Configured(raw: Record<string, unknown>): boolean {
  const r2 = (raw.r2 && typeof raw.r2 === "object" ? raw.r2 : {}) as Record<string, unknown>;
  return Boolean(text(r2.accountId) && text(r2.bucket) && text(r2.accessKeyId) && r2.secretAccessKey);
}

export async function privateR2(loaded: LoadedConfig): Promise<PrivateR2 | null> {
  if (!r2Configured(loaded.raw)) return null;
  const r2 = loaded.raw.r2 as Record<string, unknown>;
  const secretAccessKey = await loaded.secrets.get("r2.secretAccessKey");
  if (!secretAccessKey) return null;
  const prefix = (text(r2.prefix) ?? "mailbox").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9/_-]/g, "-") || "mailbox";
  return { accountId: text(r2.accountId)!, bucket: text(r2.bucket)!, accessKeyId: text(r2.accessKeyId)!, secretAccessKey, prefix };
}

export interface LoadedConfig {
  companyId: string;
  raw: Record<string, unknown>;
  config: MailboxConfig;
  secrets: SecretResolver;
}

/** Always pass the company explicitly (jobs and event handlers have no scope). */
export async function loadMailboxConfig(ctx: PluginContext, companyId: string): Promise<LoadedConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }
  return { companyId, raw, config: parseMailboxConfig(raw), secrets: new SecretResolver(ctx, companyId, raw) };
}

/** `<publicBaseUrl>/_plugins/<installation uuid>/ui/oauth-callback.html`. */
export function gmailRedirectUri(publicBaseUrl: string, uiBase: string | null): string {
  if (!uiBase) throw new Error("The Mailbox callback address is not known yet. Open the Mailbox page once, then try again.");
  return oauthCallbackUrl(publicBaseUrl, uiBase);
}

export function validateMailboxConfig(raw: Record<string, unknown>): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw.publicBaseUrl === "string" && raw.publicBaseUrl.trim()) {
    try {
      const parsed = new URL(raw.publicBaseUrl.trim());
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        errors.push("Public base URL must use https (http only for localhost)");
      }
    } catch {
      errors.push("Public base URL is not a valid URL");
    }
  }
  if (raw.sendRatePerMinute != null && raw.sendRatePerMinute !== "") {
    const rate = Number(raw.sendRatePerMinute);
    if (!Number.isInteger(rate) || rate < 1 || rate > 250) errors.push("Sends per minute must be a whole number from 1 to 250");
  }
  if (typeof raw.encryptionKey === "string" && raw.encryptionKey.trim()) {
    warnings.push("The token encryption key was typed as plain text. Pick a Paperclip secret instead.");
  }
  return { ok: errors.length === 0, errors, warnings };
}
