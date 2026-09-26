/**
 * Payroll settings: the JSON schema for the host settings form and a loader
 * that resolves secrets lazily (kit SecretResolver, one per request or job
 * run). Every call passes `companyId` explicitly because jobs have no scope.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, SecretResolver, secretField, TokenKeyError, type TokenKeyring } from "@partnersinbiz/pib-plugin-kit";
import { payrollKeyring } from "./pii.js";

export type SdlMode = "auto" | "registered" | "exempt";

export const DEFAULT_PAYSLIP_SUBJECT = "Your payslip for {{period}}";
export const DEFAULT_PAYSLIP_BODY = `Hi {{firstName}},

Your payslip from {{employer}} for {{period}} (paid on {{payDate}}) is attached.

Please keep it for your records. Reply to this email if anything looks wrong.`;

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Payroll settings",
  description:
    "Save these once for each company that runs payroll. The encryption key protects ID numbers, tax numbers and bank details; keep it safe, because sealed details cannot be read without it.",
  properties: {
    employer: {
      type: "object",
      title: "Employer",
      properties: {
        legalName: { type: "string", title: "Legal name" },
        tradingName: { type: "string", title: "Trading name" },
        address: { type: "string", title: "Address (shown on payslips)" },
        payeReference: { type: "string", title: "PAYE reference number", description: "10 digits starting with 7." },
        uifReference: { type: "string", title: "UIF reference number", description: "Starts with U." },
        sdlReference: { type: "string", title: "SDL reference number", description: "Starts with L. Leave empty if exempt." },
        contactEmail: { type: "string", title: "Payroll contact email" },
      },
    },
    encryptionKey: secretField("Encryption key", "At least 16 characters. Seals ID, tax and bank details. Stored as a Paperclip secret.") as JsonSchema,
    previousEncryptionKey: secretField("Previous encryption key", "Only while rotating the key.") as JsonSchema,
    encryptionKeyVersion: { type: "integer", title: "Encryption key version", default: 1 },
    r2: {
      type: "object",
      title: "Private document storage (Cloudflare R2)",
      description: "A private bucket for payslips, bank files and statutory exports. Do not use the public media bucket.",
      properties: {
        accountId: { type: "string", title: "Account ID" },
        bucket: { type: "string", title: "Bucket (private)" },
        accessKeyId: { type: "string", title: "Access key ID" },
        secretAccessKey: secretField("Secret access key") as JsonSchema,
        prefix: { type: "string", title: "Key prefix", default: "payroll" },
      },
    },
    payslipEmail: {
      type: "object",
      title: "Payslip email",
      properties: {
        from: { type: "string", title: "Send from (Mailbox address)", description: "Leave empty to use the company's default Mailbox account." },
        subject: { type: "string", title: "Subject", default: DEFAULT_PAYSLIP_SUBJECT },
        body: { type: "string", title: "Message", default: DEFAULT_PAYSLIP_BODY, description: "Placeholders: {{firstName}}, {{employer}}, {{period}}, {{payDate}}." },
        sendOnLock: { type: "boolean", title: "Email payslips when a run is locked", default: false },
      },
    },
    defaultPayDay: { type: "integer", title: "Default pay day of the month", default: 25, minimum: 1, maximum: 31 },
    approval: {
      type: "object",
      title: "Approval",
      description: "Every pay run is approved by a board user who did not prepare it.",
      properties: {
        defaultApproverUserId: { type: "string", title: "Default approver (user ID)" },
        leaveApproverUserId: { type: "string", title: "Leave approver (user ID)", description: "Leave requests go to this person. Defaults to the pay run approver." },
      },
    },
    sdlMode: {
      type: "string",
      title: "Skills development levy",
      enum: ["auto", "registered", "exempt"],
      default: "auto",
      description: "auto: charge SDL only when yearly payroll is expected to pass R500 000. registered: always charge. exempt: never charge.",
    },
    etiRegistered: { type: "boolean", title: "Registered for the Employment Tax Incentive", default: false },
  },
};

export interface EmployerDetails {
  legalName: string;
  tradingName: string;
  address: string;
  payeReference: string;
  uifReference: string;
  sdlReference: string;
  contactEmail: string;
}

export interface PayrollConfig {
  companyId: string;
  saved: boolean;
  employer: EmployerDetails;
  encryptionKeyConfigured: boolean;
  r2Configured: boolean;
  payslipEmail: { from: string | null; subject: string; body: string; sendOnLock: boolean };
  defaultPayDay: number;
  defaultApproverUserId: string | null;
  leaveApproverUserId: string | null;
  sdlMode: SdlMode;
  etiRegistered: boolean;
  keyring(): Promise<TokenKeyring>;
  r2(): Promise<PrivateR2Config>;
}

export interface PrivateR2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasValue(value: unknown): boolean {
  return (typeof value === "string" && value.trim() !== "") || (!!value && typeof value === "object");
}

export function payrollConfigFrom(ctx: PluginContext, companyId: string, raw: Record<string, unknown>): PayrollConfig {
  const secrets = new SecretResolver(ctx, companyId, raw);
  const employer = obj(raw.employer);
  const r2 = obj(raw.r2);
  const email = obj(raw.payslipEmail);
  const approval = obj(raw.approval);
  const r2Configured = Boolean(str(r2.accountId) && str(r2.bucket) && str(r2.accessKeyId) && hasValue(r2.secretAccessKey));
  const sdlMode = raw.sdlMode === "registered" || raw.sdlMode === "exempt" ? raw.sdlMode : "auto";
  const payDay = typeof raw.defaultPayDay === "number" && raw.defaultPayDay >= 1 && raw.defaultPayDay <= 31 ? Math.round(raw.defaultPayDay) : 25;
  let keyringPromise: Promise<TokenKeyring> | null = null;
  return {
    companyId,
    saved: Object.keys(raw).length > 0,
    employer: {
      legalName: str(employer.legalName) ?? "",
      tradingName: str(employer.tradingName) ?? "",
      address: str(employer.address) ?? "",
      payeReference: str(employer.payeReference) ?? "",
      uifReference: str(employer.uifReference) ?? "",
      sdlReference: str(employer.sdlReference) ?? "",
      contactEmail: str(employer.contactEmail) ?? "",
    },
    encryptionKeyConfigured: hasValue(raw.encryptionKey),
    r2Configured,
    payslipEmail: {
      from: str(email.from),
      subject: str(email.subject) ?? DEFAULT_PAYSLIP_SUBJECT,
      body: str(email.body) ?? DEFAULT_PAYSLIP_BODY,
      sendOnLock: email.sendOnLock === true,
    },
    defaultPayDay: payDay,
    defaultApproverUserId: str(approval.defaultApproverUserId),
    leaveApproverUserId: str(approval.leaveApproverUserId) ?? str(approval.defaultApproverUserId),
    sdlMode,
    etiRegistered: raw.etiRegistered === true,
    keyring() {
      if (!keyringPromise) {
        keyringPromise = (async () => {
          const secret = await secrets.get("encryptionKey");
          if (!secret) throw new TokenKeyError("The payroll encryption key is not set. Add it in the Payroll settings before adding personal details.");
          const version = typeof raw.encryptionKeyVersion === "number" && raw.encryptionKeyVersion > 0 ? Math.round(raw.encryptionKeyVersion) : 1;
          let previous: { version: number; secret: string } | null = null;
          if (hasValue(raw.previousEncryptionKey)) {
            const prev = await secrets.get("previousEncryptionKey");
            if (prev && version > 1) previous = { version: version - 1, secret: prev };
          }
          return payrollKeyring(companyId, secret, previous, version);
        })();
        keyringPromise.catch(() => {
          keyringPromise = null;
        });
      }
      return keyringPromise;
    },
    async r2() {
      if (!r2Configured) throw new Error("Private storage is not set up. Fill in the R2 section of the Payroll settings (use a private bucket).");
      const secretAccessKey = await secrets.require("r2.secretAccessKey", "R2 secret access key");
      return {
        accountId: str(r2.accountId)!,
        bucket: str(r2.bucket)!,
        accessKeyId: str(r2.accessKeyId)!,
        secretAccessKey,
        prefix: (str(r2.prefix) ?? "payroll").replace(/^\/+|\/+$/g, ""),
      };
    },
  };
}

export async function loadPayrollConfig(ctx: PluginContext, companyId: string): Promise<PayrollConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }
  return payrollConfigFrom(ctx, companyId, raw);
}

/** Fills {{placeholders}}; unknown ones are left empty. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
}
