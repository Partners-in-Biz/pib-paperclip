/**
 * One way to read a Telephony credential.
 *
 * The Paperclip host resolves a secret only through a binding: the owner picks
 * a company secret on the plugin's Configuration page (Plugins → CRM Telephony →
 * Configuration), the host stores `{ type: "secret_ref", secretId }` at that
 * config path and a binding for it. A bare secret name passed to
 * `ctx.secrets.resolve` is refused ("invalid secret ref"), so every Twilio,
 * Deepgram and Anthropic credential in this plugin is read from
 * `config.secrets.<NAME>` first. The bare-name call stays as a fallback for a
 * host that may accept it; it never throws.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import type { TelephonySecretName } from "./secret-names.js";

export const SECRETS_CONFIG_KEY = "secrets";

/** The config path the owner's pick lands on, and the binding's configPath. */
export function secretConfigPath(name: TelephonySecretName | string): string {
  return `${SECRETS_CONFIG_KEY}.${name}`;
}

/** The credential's value, or null when it is not configured or cannot be read. Never throws, never logs the value. */
export async function resolveTelephonySecret(
  ctx: PluginContext,
  companyId: string,
  name: TelephonySecretName | string,
): Promise<string | null> {
  let config: Record<string, unknown> = {};
  try {
    config = await readConfig(ctx, companyId);
  } catch {
    config = {};
  }
  try {
    const picked = await new SecretResolver(ctx, companyId, config).get(secretConfigPath(name));
    if (picked) return picked;
  } catch {
    // a broken or revoked binding reads as "not configured"
  }
  try {
    const value = await ctx.secrets.resolve(name, { companyId });
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The same credential, or an Error naming the secret (never its value). */
export async function requireTelephonySecret(
  ctx: PluginContext,
  companyId: string,
  name: TelephonySecretName | string,
): Promise<string> {
  const value = await resolveTelephonySecret(ctx, companyId, name);
  if (!value) throw new Error(`${name} not set`);
  return value;
}
