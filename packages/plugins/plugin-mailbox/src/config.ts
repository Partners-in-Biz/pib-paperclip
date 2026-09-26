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
    triageIssueAssignee: {
      type: "string",
      title: "Assign reply issues to",
      description:
        "Optional. An agent id, or user:<id> for a person. When set, mail from a lead, client or support that needs a reply opens one issue per thread.",
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
  },
};

export interface TriageAssignee {
  agentId?: string;
  userId?: string;
}

export interface MailboxConfig {
  saved: boolean;
  publicBaseUrl: string | null;
  googleClientId: string;
  labelPrefix: string;
  fromName: string | null;
  triageAssignee: TriageAssignee | null;
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

export function parseMailboxConfig(raw: Record<string, unknown>): MailboxConfig {
  const google = (raw.google && typeof raw.google === "object" ? raw.google : {}) as Record<string, unknown>;
  const rate = Number(raw.sendRatePerMinute);
  const base = typeof raw.publicBaseUrl === "string" && raw.publicBaseUrl.trim() ? raw.publicBaseUrl.trim() : null;
  const fromName = typeof raw.fromName === "string" && raw.fromName.trim() ? raw.fromName.replace(/[\r\n]/g, " ").trim().slice(0, 120) : null;
  return {
    saved: Object.keys(raw).length > 0,
    publicBaseUrl: base,
    googleClientId: typeof google.clientId === "string" && google.clientId.trim() ? google.clientId.trim() : DEFAULT_GOOGLE_CLIENT_ID,
    labelPrefix: parseLabelPrefix(raw.labelPrefix),
    fromName,
    triageAssignee: parseTriageAssignee(raw.triageIssueAssignee),
    sendRatePerMinute: Number.isInteger(rate) && rate >= 1 && rate <= 250 ? rate : DEFAULT_SEND_RATE,
  };
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
