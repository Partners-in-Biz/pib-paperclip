/**
 * The `payments` block of Billing settings and what it means: which providers are on, whether each
 * is complete, and how a provider adapter is built from the company's secrets. A provider is on only
 * when its switch is on AND everything it needs is saved AND (PayFast) the host can deliver its
 * notifications. Presence is checked without resolving secrets, because the host allows 30 secret
 * resolves a minute per company and the Billing page reads this on every load.
 */
import { SecretResolver, isSecretRef } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BillingSettings } from "../config.js";
import { PayFastProvider, payfastReadiness, type Readiness } from "./payfast.js";
import { MockProvider } from "./mock.js";
import { StripeProvider } from "./stripe.js";
import { PROVIDER_LABELS, REAL_PROVIDERS, type PaymentProvider, type ProviderKey } from "./types.js";

export interface PaymentSettings {
  /** The public address of this Paperclip (https://paperclip.partnersinbiz.online): the webhook address is built from it. */
  publicBaseUrl?: string;
  /** Chart account that holds provider money until the provider pays it out to the bank (Accounting adds 1020 for it). */
  clearingAccountCode?: string;
  stripe?: { enabled?: boolean; secretKey?: unknown; webhookSecret?: unknown };
  payfast?: { enabled?: boolean; sandbox?: boolean; merchantId?: string; merchantKey?: unknown; passphrase?: unknown; returnUrl?: string; cancelUrl?: string };
  mock?: { enabled?: boolean };
}

export const WEBHOOK_PLUGIN = "partnersinbiz.billing";
export const DEFAULT_CLEARING_ACCOUNT = "1020";

export function paymentSettings(settings: BillingSettings): PaymentSettings {
  const raw = (settings as { payments?: unknown }).payments;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PaymentSettings) : {};
}

export function clearingAccountCode(settings: BillingSettings): string {
  const code = paymentSettings(settings).clearingAccountCode;
  return typeof code === "string" && /^[A-Za-z0-9._-]{1,20}$/.test(code.trim()) ? code.trim() : DEFAULT_CLEARING_ACCOUNT;
}

const has = (value: unknown): boolean => (typeof value === "string" ? value.trim().length > 0 : isSecretRef(value));

function publicBase(settings: BillingSettings): string | null {
  const value = paymentSettings(settings).publicBaseUrl;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : null;
  } catch {
    return null;
  }
}

/** `https://paperclip.example/api/plugins/partnersinbiz.billing/webhooks/stripe`, or null until the public address is saved. */
export function webhookUrl(settings: BillingSettings, key: "stripe" | "payfast"): string | null {
  const base = publicBase(settings);
  return base ? `${base}/api/plugins/${WEBHOOK_PLUGIN}/webhooks/${key}` : null;
}

export interface ProviderState {
  key: ProviderKey;
  label: string;
  /** Links may be made and shown. */
  enabled: boolean;
  /** Switched on in settings (whether or not it is complete). */
  switchedOn: boolean;
  /** What is missing or in the way, in words; null when enabled. */
  blocker: string | null;
  code: Readiness["code"];
}

export function providerState(settings: BillingSettings, key: ProviderKey): ProviderState {
  const p = paymentSettings(settings);
  if (key === "mock") {
    const on = p.mock?.enabled === true;
    return { key, label: PROVIDER_LABELS.mock, enabled: on, switchedOn: on, blocker: on ? null : "Off (it is for tests and the canary journey).", code: on ? "ok" : "off" };
  }
  if (key === "stripe") {
    const s = p.stripe ?? {};
    if (s.enabled !== true) return { key, label: PROVIDER_LABELS.stripe, enabled: false, switchedOn: false, blocker: "Stripe is switched off in Billing settings.", code: "off" };
    const missing = [!has(s.secretKey) && "secret key", !has(s.webhookSecret) && "webhook signing secret"].filter(Boolean);
    if (missing.length) return { key, label: PROVIDER_LABELS.stripe, enabled: false, switchedOn: true, blocker: `Missing: ${missing.join(", ")}.`, code: "missing" };
    return { key, label: PROVIDER_LABELS.stripe, enabled: true, switchedOn: true, blocker: null, code: "ok" };
  }
  const f = p.payfast ?? {};
  const readiness = payfastReadiness({ enabled: f.enabled, merchantId: f.merchantId, merchantKey: has(f.merchantKey), hasPassphrase: has(f.passphrase) }, publicBase(settings));
  return { key, label: PROVIDER_LABELS.payfast, enabled: readiness.ready, switchedOn: f.enabled === true, blocker: readiness.blocker, code: readiness.code };
}

/** Every provider and whether links may come from it, real ones first. */
export function providerStates(settings: BillingSettings): ProviderState[] {
  return [...REAL_PROVIDERS, "mock" as const].map((key) => providerState(settings, key));
}

export function enabledProviderKeys(settings: BillingSettings): ProviderKey[] {
  return providerStates(settings).filter((s) => s.enabled).map((s) => s.key);
}

/** Builds the adapter for one provider from the company's saved secrets, or null when it is not enabled. */
export async function buildProvider(ctx: PluginContext, companyId: string, settings: BillingSettings, key: ProviderKey, resolver?: SecretResolver): Promise<PaymentProvider | null> {
  if (!providerState(settings, key).enabled) return null;
  if (key === "mock") return new MockProvider();
  const secrets = resolver ?? new SecretResolver(ctx, companyId, settings as Record<string, unknown>);
  const p = paymentSettings(settings);
  if (key === "stripe") {
    // Making and withdrawing links needs only the API key. The signing secret is for checking deliveries (`buildVerifier`), so it is
    // not resolved here: that would spend one of the host's 30 secret resolves a minute on every link.
    const secretKey = await secrets.get("payments.stripe.secretKey");
    return secretKey ? new StripeProvider({ secretKey, webhookSecret: "" }) : null;
  }
  const merchantKey = await secrets.get("payments.payfast.merchantKey");
  const passphrase = await secrets.get("payments.payfast.passphrase");
  const notifyUrl = webhookUrl(settings, "payfast");
  const f = p.payfast ?? {};
  if (!merchantKey || !f.merchantId || !notifyUrl) return null;
  return new PayFastProvider({ merchantId: f.merchantId.trim(), merchantKey, passphrase: passphrase ?? null, sandbox: f.sandbox === true, notifyUrl, returnUrl: f.returnUrl?.trim() || null, cancelUrl: f.cancelUrl?.trim() || null });
}

/**
 * The signing secret of a webhook endpoint is resolved from the host at most once a minute per company and secret reference, and kept
 * in memory only that long. The webhook address is public and the host lets a plugin resolve 30 secrets a minute per company: without this
 * a flood of deliveries (even unsigned ones that name a real link) would use the budget up and starve Billing's own secret reads
 * (PDF links, payment links, housekeeping) and every genuine delivery. A rotated secret is a new reference, so it is read at once; a
 * changed value behind the same reference is picked up within the minute (a delivery signed with the old one is retried by the provider).
 */
export const WEBHOOK_SECRET_TTL_MS = 60_000;
const webhookSecrets = new Map<string, { value: string; expires: number }>();

/** Forget every remembered signing secret (tests, and a settings change). */
export function forgetWebhookSecrets(): void {
  webhookSecrets.clear();
}

async function webhookSecretFor(secrets: SecretResolver, companyId: string, configPath: string, raw: unknown, nowMs: number): Promise<string | undefined> {
  // A literal value in settings needs no host call; only a reference is resolved.
  if (!isSecretRef(raw)) return secrets.get(configPath);
  const key = `${companyId}|${configPath}|${JSON.stringify(raw)}`;
  const hit = webhookSecrets.get(key);
  if (hit && hit.expires > nowMs) return hit.value;
  const value = await secrets.get(configPath);
  if (value) {
    for (const [k, v] of webhookSecrets) if (v.expires <= nowMs) webhookSecrets.delete(k);
    webhookSecrets.set(key, { value, expires: nowMs + WEBHOOK_SECRET_TTL_MS });
  }
  return value;
}

/**
 * The adapter that checks a webhook delivery. Unlike `buildProvider` it does not need the provider to be
 * switched on for links: a payment already in flight is still confirmed after the owner switches a
 * provider off, as long as its secrets are saved.
 */
export async function buildVerifier(ctx: PluginContext, companyId: string, settings: BillingSettings, key: "stripe" | "payfast", overrides: { fetchImpl?: typeof fetch; resolveAddresses?: (host: string) => Promise<string[]>; nowMs?: number } = {}): Promise<PaymentProvider | null> {
  const p = paymentSettings(settings);
  const secrets = new SecretResolver(ctx, companyId, settings as Record<string, unknown>);
  if (key === "stripe") {
    const webhookSecret = await webhookSecretFor(secrets, companyId, "payments.stripe.webhookSecret", p.stripe?.webhookSecret, overrides.nowMs ?? Date.now());
    return webhookSecret ? new StripeProvider({ secretKey: "", webhookSecret, ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}) }) : null;
  }
  const merchantKey = await secrets.get("payments.payfast.merchantKey");
  const passphrase = await secrets.get("payments.payfast.passphrase");
  const f = p.payfast ?? {};
  if (!merchantKey || !f.merchantId) return null;
  const { nowMs: _nowMs, ...providerOverrides } = overrides;
  return new PayFastProvider({ merchantId: f.merchantId.trim(), merchantKey, passphrase: passphrase ?? null, sandbox: f.sandbox === true, notifyUrl: webhookUrl(settings, "payfast") ?? "", ...providerOverrides });
}
