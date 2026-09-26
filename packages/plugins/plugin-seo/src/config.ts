/**
 * Company config for the SEO plugin. Saving it once for the PiB company is
 * what authorises the scheduled jobs to act on that company (jobs have no
 * invocation scope; the host allows a job's call only for a company with a
 * saved config row). Secrets are secret-refs resolved at call time.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { oauthCallbackUrl, readConfig, secretField, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { AUTOPILOT_MODES, type AutopilotMode } from "./engine/sprint.js";
import { DEFAULT_TIMEZONE, validTimezone } from "./engine/time.js";
import { PLUGIN_ID } from "./namespace.js";

export const DEFAULT_DAILY_HOUR = 6;

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "SEO settings",
  description:
    "Save these settings once for the Partners in Biz company. Saving is what lets the hourly and weekly SEO jobs work for the company. Google OAuth redirect URI to register: shown on the SEO page (<Public base URL>/_plugins/<plugin installation id>/ui/oauth-callback.html).",
  properties: {
    publicBaseUrl: {
      type: "string",
      title: "Public base URL",
      description: "The URL people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online. Required to connect Google Search Console.",
    },
    encryptionKey: secretField(
      "Token encryption key",
      "A secret (16+ characters) used to encrypt stored Google tokens. Changing it means reconnecting Search Console.",
    ),
    timezone: {
      type: "string",
      title: "Timezone",
      description: "Sprint days, the daily run and audit days use this timezone.",
      default: DEFAULT_TIMEZONE,
    },
    dailyHourLocal: {
      type: "integer",
      title: "Daily run hour",
      description: "Local hour (0–23) after which the daily SEO run materialises tasks and pulls data.",
      default: DEFAULT_DAILY_HOUR,
      minimum: 0,
      maximum: 23,
    },
    defaultAutopilotMode: {
      type: "string",
      title: "Default autopilot mode for new sprints",
      description: "off: every task goes to the sprint owner. safe: the SEO agent works its tasks; anything that publishes, sends or changes the live site needs sign-off. full: the agent finishes its tasks without sign-off.",
      enum: [...AUTOPILOT_MODES],
      default: "safe",
    },
    google: {
      type: "object",
      title: "Google OAuth client (Search Console)",
      description: "A Google Cloud OAuth client (Web application) with the Search Console API enabled. Can be the same project as YouTube.",
      properties: {
        clientId: { type: "string", title: "Client ID" },
        clientSecret: secretField("Client secret"),
      },
    },
    pagespeedApiKey: secretField("PageSpeed Insights API key (optional)", "Raises the PageSpeed quota. Without it Google may rate-limit the daily checks."),
    bingApiKey: secretField("Bing Webmaster API key (optional)", "From Bing Webmaster Tools → Settings → API access. Enables inbound link counts."),
  },
};

export interface SeoConfig {
  saved: boolean;
  publicBaseUrl: string | null;
  timezone: string;
  dailyHourLocal: number;
  defaultAutopilotMode: AutopilotMode;
  googleClientId: string | null;
}

export function parseSeoConfig(raw: Record<string, unknown>): SeoConfig {
  const google = (raw.google && typeof raw.google === "object" ? raw.google : {}) as Record<string, unknown>;
  const hour = Number(raw.dailyHourLocal);
  const mode = raw.defaultAutopilotMode;
  const base = typeof raw.publicBaseUrl === "string" && raw.publicBaseUrl.trim() ? raw.publicBaseUrl.trim() : null;
  return {
    saved: Object.keys(raw).length > 0,
    publicBaseUrl: base,
    timezone: validTimezone(raw.timezone) ? String(raw.timezone) : DEFAULT_TIMEZONE,
    dailyHourLocal: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DAILY_HOUR,
    defaultAutopilotMode: AUTOPILOT_MODES.includes(mode as AutopilotMode) ? (mode as AutopilotMode) : "safe",
    googleClientId: typeof google.clientId === "string" && google.clientId.trim() ? google.clientId.trim() : null,
  };
}

export interface LoadedConfig {
  config: SeoConfig;
  secrets: SecretResolver;
}

/** Read config for one company. Always pass the company explicitly (jobs have no scope). */
export async function loadSeoConfig(ctx: PluginContext, companyId: string): Promise<LoadedConfig> {
  const raw = await readConfig(ctx, companyId);
  return { config: parseSeoConfig(raw), secrets: new SecretResolver(ctx, companyId, raw) };
}

/**
 * `<publicBaseUrl>/_plugins/<installation uuid>/ui/oauth-callback.html`. The host
 * serves static plugin files only by installation uuid, which the SEO page
 * reports on load (kit `rememberPluginUiBase`).
 */
export function gscRedirectUri(publicBaseUrl: string, uiBase: string | null): string {
  if (!uiBase) throw new Error("The SEO callback address is not known yet. Open the SEO page once, then try again.");
  return oauthCallbackUrl(publicBaseUrl, uiBase);
}

export function validateSeoConfig(raw: Record<string, unknown>): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw.timezone != null && raw.timezone !== "" && !validTimezone(raw.timezone)) errors.push(`Unknown timezone: ${String(raw.timezone)}`);
  if (raw.dailyHourLocal != null && raw.dailyHourLocal !== "") {
    const hour = Number(raw.dailyHourLocal);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push("Daily run hour must be a whole number from 0 to 23");
  }
  if (typeof raw.publicBaseUrl === "string" && raw.publicBaseUrl.trim()) {
    try {
      const parsed = new URL(raw.publicBaseUrl.trim());
      if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
        errors.push("Public base URL must use https (http only for localhost)");
      }
    } catch {
      errors.push("Public base URL is not a valid URL");
    }
  } else {
    warnings.push("Public base URL is empty: Google Search Console cannot be connected until it is set.");
  }
  if (typeof raw.encryptionKey === "string" && raw.encryptionKey.trim()) {
    warnings.push("Token encryption key is stored as plain text; pick a Paperclip secret instead.");
  }
  const google = (raw.google && typeof raw.google === "object" ? raw.google : {}) as Record<string, unknown>;
  if (google.clientId && !google.clientSecret) warnings.push("Google client secret is missing.");
  return { ok: errors.length === 0, errors, warnings };
}
