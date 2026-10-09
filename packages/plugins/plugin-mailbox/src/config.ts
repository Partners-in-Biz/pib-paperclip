/**
 * Company settings for the Mailbox. Saving them once per company is what lets
 * the Gmail sync job act for that company (jobs have no invocation scope; the
 * host allows a job's call only for a company with a saved config row).
 * Secrets are secret-refs resolved per call with the kit `SecretResolver`.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, jevConfigSchema, oauthCallbackUrl, readConfig, secretField, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { DEFAULT_STEADY_CAP } from "./esp/warmup.js";

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
    esp: {
      type: "object",
      title: "Email provider (Resend), optional",
      description:
        "A second way to send, beside Gmail: a send-only account for each domain the provider is allowed to send as (a client's own domain, or PiB's). Off until it is switched on here AND the API key is saved. Sending also needs the webhook signing secret, so bounces and complaints are never missed. Gmail stays the default sender; nothing changes for mail that names no provider account.",
      properties: {
        enabled: { type: "boolean", title: "Switch the email provider on", description: "Off by default. With it on, the Mailbox can register sending domains and send from them once their DNS records are in place.", default: false },
        provider: { type: "string", title: "Provider", enum: ["resend", "ses"], default: "resend", description: "resend (default) or ses (Amazon SES). SES needs the keys and the configuration set in the SES block below." },
        apiKey: secretField("Resend API key", "A Paperclip secret holding a Resend API key with full access (it registers domains as well as sending): resend.com, API Keys, Create API Key."),
        webhookSecret: secretField("Resend webhook signing secret", "A Paperclip secret holding the signing secret (whsec_...) of the Resend webhook that points at this Paperclip: resend.com, Webhooks. Without it nothing is sent through the provider."),
        ratePerSecond: { type: "integer", title: "Requests per second", description: "Most requests per second the Mailbox makes to the provider (Resend allows 10 by default, shared by every key of the team).", default: 4, minimum: 1, maximum: 10 },
        steadyDailyCap: { type: "integer", title: "Daily cap once a domain is warmed up", description: "Most recipients one domain is handed to the provider per UTC day after its warm-up (the first 13 days ramp up from 50). A person can give one domain its own cap.", default: DEFAULT_STEADY_CAP, minimum: 1, maximum: 1000000 },
        prefer: { type: "string", title: "Mail the provider takes when no sender is named", enum: ["gmail", "transactional"], default: "gmail", description: "gmail (default): mail that names no sender goes out from the default Gmail account. transactional: invoices, payslips and replies that name no sender go from the company's own provider account when it is ready (marketing always goes from the sender it names, or the client's own domain when the client has one)." },
        defaultFrom: { type: "string", title: "The company's own provider address", description: "The send-only address (on a domain you registered) that transactional mail uses when the setting above is transactional. Empty: the oldest ready company-owned provider account." },
        ses: {
          type: "object",
          title: "Amazon SES (when the provider is ses)",
          description: "The SES account the Mailbox sends through (SESv2). Keys are Paperclip secrets; the IAM user needs ses:SendEmail and ses:GetAccount (and the identity calls for domains).",
          properties: {
            region: { type: "string", title: "AWS region", default: "eu-north-1", description: "The region of the SES account, e.g. eu-north-1." },
            accessKeyId: secretField("AWS access key id", "A Paperclip secret holding the IAM user's access key id."),
            secretAccessKey: secretField("AWS secret access key", "A Paperclip secret holding the IAM user's secret access key."),
            configurationSet: { type: "string", title: "Configuration set", description: "The SES configuration set every send names; it publishes the bounce, complaint and delivery events." },
            snsTopicArn: { type: "string", title: "SNS topic ARN", description: "The SNS topic the configuration set publishes to (arn:aws:sns:<region>:<account>:<name>)." },
          },
        },
        batch: { type: "boolean", title: "Send messages that arrive together in one request", description: "Off by default. Up to 100 messages without attachments go in one provider request. A batch the provider did not answer is never sent again message by message, so a person checks the provider's log for those.", default: false },
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
  /** The email provider block (0.6.0). */
  esp: EspConfig;
}

/** The `esp` settings. A secret's presence is read without resolving it (the host allows 30 secret resolves a minute per company). */
export interface EspConfig {
  enabled: boolean;
  provider: "resend" | "ses";
  /** The provider can be used: Resend, the API key is saved; SES, both access keys are saved. */
  hasCredentials: boolean;
  /** Amazon SES settings (read whatever the provider is, so switching provider keeps them). */
  ses: { region: string; hasAccessKeyId: boolean; hasSecretAccessKey: boolean; configurationSet: string | null; snsTopicArn: string | null };
  hasWebhookSecret: boolean;
  ratePerSecond: number;
  steadyDailyCap: number;
  prefer: "gmail" | "transactional";
  defaultFrom: string | null;
  batch: boolean;
}

export const DEFAULT_ESP_RATE = 4;
export const DEFAULT_SES_REGION = "eu-north-1";
const SES_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

function hasSecret(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : isSecretRef(value) && Boolean(value.secretId);
}

export function parseEspConfig(raw: Record<string, unknown>): EspConfig {
  const esp = (raw.esp && typeof raw.esp === "object" && !Array.isArray(raw.esp) ? raw.esp : {}) as Record<string, unknown>;
  const rate = Number(esp.ratePerSecond);
  const cap = Number(esp.steadyDailyCap);
  const from = typeof esp.defaultFrom === "string" ? esp.defaultFrom.trim().toLowerCase() : "";
  const ses = (esp.ses && typeof esp.ses === "object" && !Array.isArray(esp.ses) ? esp.ses : {}) as Record<string, unknown>;
  const region = typeof ses.region === "string" ? ses.region.trim().toLowerCase() : "";
  const setting = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value.trim()) ? value.trim() : null);
  const provider = esp.provider === "ses" ? "ses" : "resend";
  const sesKeys = { hasAccessKeyId: hasSecret(ses.accessKeyId), hasSecretAccessKey: hasSecret(ses.secretAccessKey) };
  return {
    enabled: esp.enabled === true,
    provider,
    hasCredentials: provider === "ses" ? sesKeys.hasAccessKeyId && sesKeys.hasSecretAccessKey : hasSecret(esp.apiKey),
    ses: { region: SES_REGION.test(region) ? region : DEFAULT_SES_REGION, ...sesKeys, configurationSet: setting(ses.configurationSet, /^[A-Za-z0-9_-]{1,64}$/), snsTopicArn: setting(ses.snsTopicArn, /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/) },
    hasWebhookSecret: hasSecret(esp.webhookSecret),
    ratePerSecond: Number.isInteger(rate) && rate >= 1 && rate <= 10 ? rate : DEFAULT_ESP_RATE,
    steadyDailyCap: Number.isInteger(cap) && cap >= 1 && cap <= 1_000_000 ? cap : DEFAULT_STEADY_CAP,
    prefer: esp.prefer === "transactional" ? "transactional" : "gmail",
    defaultFrom: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) ? from : null,
    batch: esp.batch === true,
  };
}

export interface EspReadiness {
  /** Domains may be registered and checked (switched on, API key saved). */
  domains: boolean;
  /** Mail may be sent (also the webhook signing secret, so no bounce or complaint is missed). */
  sending: boolean;
  /** What is missing, in words, in the order to do it. */
  blockers: string[];
}

/** The address the provider's webhook points at: the host's public webhook route for this plugin. Null until the public base URL is saved. */
export function espWebhookUrl(publicBaseUrl: string | null): string | null {
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/api/plugins/partnersinbiz.mailbox/webhooks/resend` : null;
}

export function espReadiness(config: EspConfig): EspReadiness {
  const blockers: string[] = [];
  if (!config.enabled) blockers.push("The email provider is switched off in the Mailbox settings.");
  if (config.provider === "ses") {
    if (!config.ses.hasAccessKeyId) blockers.push("The AWS access key id is not saved as a Paperclip secret in the Mailbox settings (Email provider, Amazon SES).");
    if (!config.ses.hasSecretAccessKey) blockers.push("The AWS secret access key is not saved as a Paperclip secret in the Mailbox settings (Email provider, Amazon SES).");
    const domains = config.enabled && config.hasCredentials;
    // Without a configuration set SES publishes no events, so bounces and complaints would be missed. (The topic and its confirmation are T1c/T2.)
    if (domains && !config.ses.configurationSet) blockers.push("The SES configuration set is not saved in the Mailbox settings: until it is, nothing is sent through SES, because bounces and complaints would be missed.");
    return { domains, sending: domains && Boolean(config.ses.configurationSet), blockers };
  }
  if (!config.hasCredentials) blockers.push("The Resend API key is not saved as a Paperclip secret in the Mailbox settings.");
  const domains = config.enabled && config.hasCredentials;
  if (domains && !config.hasWebhookSecret) blockers.push("The Resend webhook signing secret is not saved: until it is, nothing is sent through the provider, because bounces and complaints would be missed.");
  return { domains, sending: domains && config.hasWebhookSecret, blockers };
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
    esp: parseEspConfig(raw),
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
  const esp = raw.esp;
  if (esp != null && (typeof esp !== "object" || Array.isArray(esp))) {
    errors.push("The email provider settings are not valid");
  } else if (esp) {
    const block = esp as Record<string, unknown>;
    for (const [key, label] of [["apiKey", "Resend API key"], ["webhookSecret", "Resend webhook signing secret"]] as const) {
      if (typeof block[key] === "string" && String(block[key]).trim()) warnings.push(`The ${label} was typed as plain text. Pick a Paperclip secret instead.`);
    }
    if (block.ratePerSecond != null && block.ratePerSecond !== "") {
      const rate = Number(block.ratePerSecond);
      if (!Number.isInteger(rate) || rate < 1 || rate > 10) errors.push("Requests per second must be a whole number from 1 to 10");
    }
    if (block.steadyDailyCap != null && block.steadyDailyCap !== "") {
      const cap = Number(block.steadyDailyCap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 1_000_000) errors.push("The daily cap must be a whole number from 1 to 1000000");
    }
    const ses = block.ses && typeof block.ses === "object" && !Array.isArray(block.ses) ? (block.ses as Record<string, unknown>) : {};
    for (const [key, label] of [["accessKeyId", "AWS access key id"], ["secretAccessKey", "AWS secret access key"]] as const) {
      if (typeof ses[key] === "string" && String(ses[key]).trim()) warnings.push(`The ${label} was typed as plain text. Pick a Paperclip secret instead.`);
    }
    if (typeof ses.region === "string" && ses.region.trim() && !SES_REGION.test(ses.region.trim().toLowerCase())) errors.push("The AWS region should look like eu-north-1");
    if (block.provider != null && block.provider !== "" && block.provider !== "resend" && block.provider !== "ses") errors.push("The email provider must be resend or ses");
    if (typeof block.defaultFrom === "string" && block.defaultFrom.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(block.defaultFrom.trim())) errors.push("The company's own provider address is not an email address");
  }
  return { ok: errors.length === 0, errors, warnings };
}
