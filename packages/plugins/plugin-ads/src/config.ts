/**
 * Plugin settings: the JSON schema for the host's settings form and a loader that resolves secrets lazily.
 *
 * Every call passes `companyId` explicitly (jobs have no invocation scope). Secrets are resolved through the kit `SecretResolver`
 * (memoised per instance: the host allows 30 resolves a minute per company), so create one per job run or request.
 *
 * A platform is OFF until its switch is on AND everything it needs is saved (`platformState`). Writes are off twice over: the
 * company-wide `writes.enabled` here, and a per-scope switch on the Ads page; both must be on, and every change still needs an approval.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import {
  buildKeyring,
  isSecretRef,
  oauthCallbackUrl,
  pluginUiBase,
  requirePublicBaseUrl,
  SecretResolver,
  secretField,
  TokenKeyError,
  type TokenKeyring,
} from "@partnersinbiz/pib-plugin-kit";
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from "./alerts.js";
import { DEFAULT_GOOGLE_VERSION } from "./providers/google.js";
import { DEFAULT_META_VERSION } from "./providers/meta.js";
import type { ProviderApp } from "./providers/types.js";
import { AD_PLATFORMS, PLATFORM_LABELS, type AdPlatform } from "./platforms.js";

export const DEFAULT_TIMEZONE = "Africa/Johannesburg";

export function buildInstanceConfigSchema(): JsonSchema {
  return {
    type: "object",
    title: "Paid ads",
    description:
      "Save these settings once for each company that runs ads. Every platform starts OFF: nothing is read from Meta or Google until you switch it on and its keys are saved. " +
      "The OAuth redirect URI to register with Meta and Google is shown on the Ads page: <publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html. " +
      "App secrets, tokens and the encryption key are Paperclip secrets. Connection tokens are encrypted at rest.",
    required: ["publicBaseUrl"],
    properties: {
      publicBaseUrl: {
        type: "string",
        title: "Public base URL",
        description: "The address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online. http is only allowed for localhost.",
      },
      encryptionKey: secretField("Token encryption key", "A long random value (at least 16 characters). Changing it without keeping the old one below makes every connection sign in again.") as JsonSchema,
      encryptionKeyVersion: { type: "integer", title: "Encryption key version", description: "Increase when you rotate the key.", default: 1, minimum: 1 },
      previousEncryptionKey: secretField("Previous encryption key", "Only while rotating: the old key, so stored tokens still open.") as JsonSchema,
      previousEncryptionKeyVersion: { type: "integer", title: "Previous key version", minimum: 1 },
      timezone: { type: "string", title: "Timezone", description: `Defines "today" and the month for budgets. Default ${DEFAULT_TIMEZONE}.`, default: DEFAULT_TIMEZONE },
      writes: {
        type: "object",
        title: "Changing ads",
        description: "Everything here is read-only until you switch changes on. Even then each scope has its own switch (off by default) and every change needs a recorded approval.",
        properties: {
          enabled: { type: "boolean", title: "Allow changes to ads at all", description: "Master switch. Off: no campaign is created, paused, resumed or re-budgeted by this plugin, whatever else is switched on.", default: false },
        },
      },
      alerts: {
        type: "object",
        title: "Alert thresholds",
        description: "When an anomaly is raised. The defaults suit most accounts.",
        properties: {
          spikeFactor: { type: "number", title: "Spend spike: times the usual daily spend", default: DEFAULT_ALERT_CONFIG.spikeFactor, minimum: 1.2 },
          spikeMinMinor: { type: "integer", title: "Spend spike: smallest day that counts (minor units, e.g. cents)", default: DEFAULT_ALERT_CONFIG.spikeMinMinor, minimum: 0 },
          cpaTolerance: { type: "number", title: "Cost per result: how far over the target before it is raised (0.25 is 25%)", default: DEFAULT_ALERT_CONFIG.cpaTolerance, minimum: 0 },
        },
      },
      platforms: {
        type: "object",
        title: "Platforms",
        properties: {
          meta: {
            type: "object",
            title: PLATFORM_LABELS.meta,
            description:
              "A Meta developer app with the Marketing API product. Reading needs ads_read; changing things needs ads_management. Your own ad account works with standard access; other businesses' accounts need advanced access (App Review). " +
              "Or skip the sign-in: paste a system-user token (Business Settings, System users) below.",
            properties: {
              enabled: { type: "boolean", title: "Switch Meta on", default: false },
              appId: { type: "string", title: "Meta app ID" },
              appSecret: secretField("Meta app secret") as JsonSchema,
              systemUserToken: secretField("System-user token (optional)", "Instead of signing in: a long-lived token for a system user that has the ad accounts assigned.") as JsonSchema,
              requestWrite: { type: "boolean", title: "The connection may change ads (asks for ads_management)", description: "Off: read-only. Leave off until you want agents to propose changes that a person approves.", default: false },
              apiVersion: { type: "string", title: "Graph API version", description: `Default ${DEFAULT_META_VERSION}.` },
            },
          },
          google: {
            type: "object",
            title: PLATFORM_LABELS.google,
            description:
              "A Google Cloud OAuth client (Web application) in a project with the Google Ads API enabled. Since 2026-09-09 API access levels belong to that Cloud project (apply for Basic access in the Cloud console's Google Ads API page); developer tokens are no longer issued.",
            properties: {
              enabled: { type: "boolean", title: "Switch Google Ads on", default: false },
              clientId: { type: "string", title: "OAuth client ID" },
              clientSecret: secretField("OAuth client secret") as JsonSchema,
              developerToken: secretField("Developer token (legacy, optional)", "No longer needed. If you still have one it is sent and ignored until Google rejects it.") as JsonSchema,
              requestWrite: { type: "boolean", title: "The connection may change ads", description: "Google's sign-in has one permission that reads and changes ads, so this switch is ours: off, the connection is read-only here. Leave off until you want agents to propose changes that a person approves.", default: false },
              apiVersion: { type: "string", title: "Google Ads API version", description: `Default ${DEFAULT_GOOGLE_VERSION}. Google retires versions about a year after release.` },
            },
          },
          mock: {
            type: "object",
            title: "Test platform",
            description: "For rehearsals and the canary journey only. Serves made-up numbers; never contacts an ad platform.",
            properties: { enabled: { type: "boolean", title: "Switch the test platform on", default: false } },
          },
        },
      },
    },
  };
}

export interface PlatformState {
  platform: AdPlatform | "mock";
  /** The platform may be used (switched on and complete). */
  enabled: boolean;
  switchedOn: boolean;
  /** The app credentials for signing in are saved. */
  signIn: boolean;
  /** A system-user token is saved (Meta). */
  token: boolean;
  /** What is missing or in the way, in words; null when enabled. */
  blocker: string | null;
  requestWrite: boolean;
  apiVersion: string | null;
}

export interface AdsConfig {
  companyId: string;
  raw: Record<string, unknown>;
  saved: boolean;
  publicBaseUrl: string | null;
  publicBaseUrlError: string | null;
  timezone: string;
  /** Company-wide master switch for changing ads. */
  writesEnabled: boolean;
  alerts: AlertConfig;
  encryptionKeyConfigured: boolean;
  /** The bridge redirect URI. Throws when the base URL or the page's own address is not known yet. */
  redirectUri(): string;
  platform(platform: AdPlatform | "mock"): PlatformState;
  /** App credentials with the secret resolved. Throws when the platform is not usable. */
  app(platform: AdPlatform): Promise<ProviderApp>;
  /** The saved system-user token (Meta), or undefined. */
  systemToken(platform: AdPlatform): Promise<string | undefined>;
  keyring(): Promise<TokenKeyring>;
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const has = (value: unknown): boolean => (typeof value === "string" ? value.trim().length > 0 : isSecretRef(value));
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const int = (value: unknown, fallback: number): number => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback);

export function platformStateOf(raw: Record<string, unknown>, platform: AdPlatform | "mock"): PlatformState {
  const p = obj(obj(raw.platforms)[platform]);
  const switchedOn = p.enabled === true;
  const label = platform === "mock" ? "The test platform" : PLATFORM_LABELS[platform];
  const base = { platform, switchedOn, requestWrite: p.requestWrite === true, apiVersion: text(p.apiVersion) };
  if (platform === "mock") return { ...base, enabled: switchedOn, signIn: false, token: false, blocker: switchedOn ? null : "Off (it is for rehearsals only).", apiVersion: null };
  const signIn = platform === "meta" ? Boolean(text(p.appId)) && has(p.appSecret) : Boolean(text(p.clientId)) && has(p.clientSecret);
  const token = platform === "meta" && has(p.systemUserToken);
  if (!switchedOn) return { ...base, enabled: false, signIn, token, blocker: `${label} is switched off in the plugin settings.` };
  if (signIn || token) return { ...base, enabled: true, signIn, token, blocker: null };
  const missing = platform === "meta" ? "a Meta app ID and secret (to sign in), or a system-user token" : "the OAuth client ID and secret";
  return { ...base, enabled: false, signIn, token, blocker: `${label} is switched on but is missing ${missing}.` };
}

export function adsConfigFrom(ctx: PluginContext, companyId: string, raw: Record<string, unknown>, uiBase: string | null = null): AdsConfig {
  const secrets = new SecretResolver(ctx, companyId, raw);
  let publicBaseUrl: string | null = null;
  let publicBaseUrlError: string | null = null;
  try {
    publicBaseUrl = requirePublicBaseUrl(raw.publicBaseUrl);
  } catch (error) {
    publicBaseUrlError = error instanceof Error ? error.message : String(error);
  }
  const alertRaw = obj(raw.alerts);
  let keyringPromise: Promise<TokenKeyring> | null = null;
  return {
    companyId,
    raw,
    saved: Object.keys(raw).length > 0,
    publicBaseUrl,
    publicBaseUrlError,
    timezone: text(raw.timezone) ?? DEFAULT_TIMEZONE,
    writesEnabled: obj(raw.writes).enabled === true,
    alerts: {
      ...DEFAULT_ALERT_CONFIG,
      spikeFactor: Math.max(1.2, num(alertRaw.spikeFactor, DEFAULT_ALERT_CONFIG.spikeFactor)),
      spikeMinMinor: Math.max(0, Math.round(num(alertRaw.spikeMinMinor, DEFAULT_ALERT_CONFIG.spikeMinMinor))),
      cpaTolerance: Math.max(0, num(alertRaw.cpaTolerance, DEFAULT_ALERT_CONFIG.cpaTolerance)),
    },
    encryptionKeyConfigured: has(raw.encryptionKey),
    redirectUri() {
      if (!publicBaseUrl) throw new Error(publicBaseUrlError ?? "Public base URL is not set in the Paid ads plugin settings.");
      if (!uiBase) throw new Error("The Ads callback address is not known yet. Open the Ads page once, then try again.");
      return oauthCallbackUrl(publicBaseUrl, uiBase);
    },
    platform: (platform) => platformStateOf(raw, platform),
    async app(platform) {
      const state = platformStateOf(raw, platform);
      if (!state.enabled) throw new Error(state.blocker ?? `${PLATFORM_LABELS[platform]} is not switched on.`);
      const p = obj(obj(raw.platforms)[platform]);
      const clientId = platform === "meta" ? text(p.appId) : text(p.clientId);
      const secretPath = platform === "meta" ? "platforms.meta.appSecret" : "platforms.google.clientSecret";
      const clientSecret = clientId && has(p[platform === "meta" ? "appSecret" : "clientSecret"]) ? await secrets.get(secretPath) : undefined;
      const developerToken = platform === "google" && has(p.developerToken) ? await secrets.get("platforms.google.developerToken") : undefined;
      return {
        platform,
        clientId: clientId ?? "",
        clientSecret: clientSecret ?? "",
        ...(state.apiVersion ? { apiVersion: state.apiVersion } : {}),
        ...(developerToken ? { developerToken } : {}),
        requestWrite: state.requestWrite,
      };
    },
    systemToken: (platform) => (platform === "meta" ? secrets.get("platforms.meta.systemUserToken") : Promise.resolve(undefined)),
    keyring() {
      if (!keyringPromise) {
        keyringPromise = (async () => {
          const secret = await secrets.get("encryptionKey");
          if (!secret) throw new TokenKeyError("The token encryption key is not set. Add it in the Paid ads plugin settings before connecting an ad platform.");
          const version = int(raw.encryptionKeyVersion, 1);
          const previous: Array<{ version: number; secret: string }> = [];
          if (has(raw.previousEncryptionKey)) {
            const prevSecret = await secrets.get("previousEncryptionKey");
            const prevVersion = int(raw.previousEncryptionKeyVersion, Math.max(1, version - 1));
            if (prevSecret && prevVersion !== version) previous.push({ version: prevVersion, secret: prevSecret });
          }
          return buildKeyring({ purpose: "ads", companyId, secret, version, previous });
        })();
        keyringPromise.catch(() => {
          keyringPromise = null;
        });
      }
      return keyringPromise;
    },
  };
}

/** Load company config. Always pass the company id, including inside jobs. */
export async function loadAdsConfig(ctx: PluginContext, companyId: string): Promise<AdsConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const value = await ctx.config.get(companyId);
    raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch (error) {
    ctx.logger.info("Ads config could not be read", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  return adsConfigFrom(ctx, companyId, raw, await pluginUiBase(ctx));
}

export function enabledPlatforms(config: AdsConfig): Array<AdPlatform | "mock"> {
  return ([...AD_PLATFORMS, "mock"] as const).filter((p) => config.platform(p).enabled);
}
