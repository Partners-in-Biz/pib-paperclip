/**
 * Social plugin settings: JSON schema for the host settings form and a
 * loader that resolves secrets lazily.
 *
 * Every call passes `companyId` explicitly (jobs have no invocation scope).
 * Secrets are resolved through the kit SecretResolver, which memoises per
 * instance and passes the dot `configPath` the host needs. Create one handle
 * per job run or request; the host allows 30 resolves per minute per company.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { pluginUiBase,
  buildKeyring,
  requirePublicBaseUrl,
  SecretResolver,
  secretField,
  TokenKeyError,
  type R2Config,
  type TokenKeyring,
} from "@partnersinbiz/pib-plugin-kit";
import {
  ALL_PLATFORMS,
  NEEDS_APP_CREDENTIALS,
  PLATFORM_LABELS,
  bridgeRedirectUri,
  type SocialPlatform,
} from "./platforms.js";

export const DEFAULT_TIMEZONE = "Africa/Johannesburg";
export const DEFAULT_GRAPH_VERSION = "v21.0";
export const DEFAULT_BLUESKY_PDS = "https://bsky.social";

const CLIENT_ID_LABEL: Partial<Record<SocialPlatform, string>> = {
  facebook: "Meta app ID",
  instagram: "Instagram app ID (Instagram API with Instagram Login)",
  threads: "Threads app ID",
  linkedin: "Client ID",
  x: "OAuth 2.0 client ID",
  tiktok: "Client key",
  youtube: "Google OAuth client ID",
  pinterest: "App ID",
  reddit: "Client ID (web app)",
  dribbble: "Client ID",
};

const PLATFORM_HINT: Partial<Record<SocialPlatform, string>> = {
  facebook: "Facebook Login. Connecting lists every Page you manage plus the Instagram business accounts linked to them.",
  instagram: "Optional. Instagram business accounts linked to a Page can also be connected through Facebook.",
  threads: "Threads API app (use case: Access the Threads API).",
  linkedin: "Products: Sign In with LinkedIn (OpenID Connect) and Share on LinkedIn. Company pages also need the Community Management API.",
  x: "User authentication settings: OAuth 2.0, type Web App (confidential client).",
  tiktok: "Products: Login Kit and Content Posting API. Verify the R2 media domain for PULL_FROM_URL.",
  youtube: "Google Cloud OAuth client (Web application) with the YouTube Data API v3 enabled.",
  pinterest: "Pinterest developer app with pins:write and boards:read.",
  reddit: "Create a 'web app' at reddit.com/prefs/apps.",
  dribbble: "Dribbble application. Upload scope needs Dribbble approval.",
};

const DEFAULT_API_VERSION: Partial<Record<SocialPlatform, string>> = {
  facebook: DEFAULT_GRAPH_VERSION,
  instagram: DEFAULT_GRAPH_VERSION,
  threads: "v1.0",
};

function platformSchema(platform: SocialPlatform): JsonSchema {
  if (platform === "bluesky") {
    return {
      type: "object",
      title: PLATFORM_LABELS[platform],
      description: "Bluesky connects with a handle and an app password from the Social page. No app is needed.",
      properties: {
        defaultPdsUrl: {
          type: "string",
          title: "Default PDS URL",
          description: `Personal data server used when none is entered on connect. Default ${DEFAULT_BLUESKY_PDS}.`,
        },
      },
    };
  }
  if (platform === "mastodon") {
    return {
      type: "object",
      title: PLATFORM_LABELS[platform],
      description: "Mastodon registers an app on each instance automatically the first time you connect. No app is needed.",
      properties: {
        defaultInstance: {
          type: "string",
          title: "Default instance URL",
          description: "Prefilled on connect, e.g. https://mastodon.social.",
        },
      },
    };
  }
  const properties: Record<string, JsonSchema> = {
    clientId: { type: "string", title: CLIENT_ID_LABEL[platform] ?? "Client ID" },
    clientSecret: secretField("Client secret", "Stored as a Paperclip secret.") as JsonSchema,
    apiVersion: {
      type: "string",
      title: "API version",
      description:
        platform === "linkedin"
          ? "LinkedIn-Version header (YYYYMM). Leave empty to use a recent version automatically."
          : DEFAULT_API_VERSION[platform]
            ? `Default ${DEFAULT_API_VERSION[platform]}.`
            : "Not used by this platform.",
    },
    scopes: {
      type: "string",
      title: "Scopes override",
      description: "Leave empty for the defaults. Space- or comma-separated.",
    },
  };
  return {
    type: "object",
    title: PLATFORM_LABELS[platform],
    description: PLATFORM_HINT[platform],
    properties,
  };
}

export function buildInstanceConfigSchema(): JsonSchema {
  const platforms: Record<string, JsonSchema> = {};
  for (const platform of ALL_PLATFORMS) platforms[platform] = platformSchema(platform);
  return {
    type: "object",
    title: "Social",
    description:
      "Save these settings once for the company. The OAuth redirect URI to register with every provider is shown on the Social page: " +
      "<publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html (the id changes only if the plugin is reinstalled). " +
      "Client secrets and the encryption key are Paperclip secrets. Account tokens are encrypted at rest.",
    required: ["publicBaseUrl"],
    properties: {
      publicBaseUrl: {
        type: "string",
        title: "Public base URL",
        description: "The address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online. http is only allowed for localhost.",
      },
      encryptionKey: secretField(
        "Token encryption key",
        "A long random value (at least 16 characters). Changing it without keeping the old one below makes every account reconnect.",
      ) as JsonSchema,
      encryptionKeyVersion: {
        type: "integer",
        title: "Encryption key version",
        description: "Increase when you rotate the key.",
        default: 1,
        minimum: 1,
      },
      previousEncryptionKey: secretField(
        "Previous encryption key",
        "Only while rotating: the old key, so stored tokens still open. They are re-sealed with the new key on refresh.",
      ) as JsonSchema,
      previousEncryptionKeyVersion: {
        type: "integer",
        title: "Previous key version",
        minimum: 1,
      },
      timezone: {
        type: "string",
        title: "Timezone",
        description: `Used for the calendar and the weekly routine. Default ${DEFAULT_TIMEZONE}.`,
        default: DEFAULT_TIMEZONE,
      },
      linkedinOrgPages: {
        type: "boolean",
        title: "LinkedIn company pages",
        description: "Turn on once the LinkedIn Community Management API is approved for the app.",
        default: false,
      },
      allowAgentReplies: {
        type: "boolean",
        title: "Agents may send inbox replies",
        description: "Off: an agent's reply is saved as a suggestion that a person sends. On: agent replies publish immediately.",
        default: false,
      },
      platforms: {
        type: "object",
        title: "Platforms",
        properties: platforms,
      },
      r2: {
        type: "object",
        title: "Cloudflare R2 media",
        description: "Uploads go straight to the bucket with a presigned PUT. Platforms read media from the public domain.",
        properties: {
          accountId: { type: "string", title: "Account ID" },
          bucket: { type: "string", title: "Bucket" },
          accessKeyId: { type: "string", title: "Access key ID" },
          secretAccessKey: secretField("Secret access key") as JsonSchema,
          publicMediaBaseUrl: {
            type: "string",
            title: "Public media URL",
            description: "Public domain of the bucket, e.g. https://media.partnersinbiz.online.",
          },
        },
      },
    },
  };
}

export interface PlatformStatus {
  platform: SocialPlatform;
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  apiVersion: string | null;
  scopes: string[] | null;
  missing: string[];
}

export interface ProviderApp {
  platform: SocialPlatform;
  clientId: string;
  clientSecret?: string;
  apiVersion?: string;
  scopes?: string[];
}

export interface SocialConfig {
  companyId: string;
  raw: Record<string, unknown>;
  saved: boolean;
  publicBaseUrl: string | null;
  publicBaseUrlError: string | null;
  timezone: string;
  linkedinOrgPages: boolean;
  allowAgentReplies: boolean;
  blueskyDefaultPds: string;
  mastodonDefaultInstance: string | null;
  r2Configured: boolean;
  encryptionKeyConfigured: boolean;
  /** The bridge redirect URI. Throws when publicBaseUrl is missing or invalid. */
  redirectUri(): string;
  platform(platform: SocialPlatform): PlatformStatus;
  /** Resolve app credentials, including the client secret. Throws when not configured. */
  app(platform: SocialPlatform): Promise<ProviderApp>;
  keyring(): Promise<TokenKeyring>;
  r2(): Promise<R2Config>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "object";
}

function int(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function splitScopes(value: string | null): string[] | null {
  if (!value) return null;
  const scopes = value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return scopes.length ? scopes : null;
}

export function socialConfigFrom(ctx: PluginContext, companyId: string, raw: Record<string, unknown>, uiBase: string | null = null): SocialConfig {
  const secrets = new SecretResolver(ctx, companyId, raw);
  let publicBaseUrl: string | null = null;
  let publicBaseUrlError: string | null = null;
  try {
    publicBaseUrl = requirePublicBaseUrl(raw.publicBaseUrl);
  } catch (error) {
    publicBaseUrlError = error instanceof Error ? error.message : String(error);
  }
  const platforms = obj(raw.platforms);
  const r2Raw = obj(raw.r2);
  const r2Configured = Boolean(
    str(r2Raw.accountId) && str(r2Raw.bucket) && str(r2Raw.accessKeyId) && hasValue(r2Raw.secretAccessKey) && str(r2Raw.publicMediaBaseUrl),
  );
  let keyringPromise: Promise<TokenKeyring> | null = null;

  const platformStatus = (platform: SocialPlatform): PlatformStatus => {
    const p = obj(platforms[platform]);
    const clientId = str(p.clientId);
    const hasSecret = hasValue(p.clientSecret);
    const missing: string[] = [];
    if (NEEDS_APP_CREDENTIALS[platform]) {
      if (!clientId) missing.push(`platforms.${platform}.clientId`);
      if (!hasSecret) missing.push(`platforms.${platform}.clientSecret`);
    }
    return {
      platform,
      configured: missing.length === 0,
      clientId,
      hasSecret,
      apiVersion: str(p.apiVersion) ?? DEFAULT_API_VERSION[platform] ?? null,
      scopes: splitScopes(str(p.scopes)),
      missing,
    };
  };

  return {
    companyId,
    raw,
    saved: Object.keys(raw).length > 0,
    publicBaseUrl,
    publicBaseUrlError,
    timezone: str(raw.timezone) ?? DEFAULT_TIMEZONE,
    linkedinOrgPages: raw.linkedinOrgPages === true,
    allowAgentReplies: raw.allowAgentReplies === true,
    blueskyDefaultPds: str(obj(platforms.bluesky).defaultPdsUrl) ?? DEFAULT_BLUESKY_PDS,
    mastodonDefaultInstance: str(obj(platforms.mastodon).defaultInstance),
    r2Configured,
    encryptionKeyConfigured: hasValue(raw.encryptionKey),
    redirectUri() {
      if (!publicBaseUrl) throw new Error(publicBaseUrlError ?? "Public base URL is not set in the Social plugin settings.");
      if (!uiBase) throw new Error("The Social callback address is not known yet. Open the Social page once, then try again.");
      return bridgeRedirectUri(publicBaseUrl, uiBase);
    },
    platform: platformStatus,
    async app(platform) {
      const status = platformStatus(platform);
      if (!NEEDS_APP_CREDENTIALS[platform]) {
        return { platform, clientId: "", apiVersion: status.apiVersion ?? undefined };
      }
      if (!status.configured) {
        throw new Error(`${PLATFORM_LABELS[platform]} is not configured. Add ${status.missing.join(" and ")} in the Social plugin settings.`);
      }
      const clientSecret = await secrets.require(`platforms.${platform}.clientSecret`, `${PLATFORM_LABELS[platform]} client secret`);
      return {
        platform,
        clientId: status.clientId!,
        clientSecret,
        apiVersion: status.apiVersion ?? undefined,
        scopes: status.scopes ?? undefined,
      };
    },
    keyring() {
      if (!keyringPromise) {
        keyringPromise = (async () => {
          const secret = await secrets.get("encryptionKey");
          if (!secret) {
            throw new TokenKeyError("The token encryption key is not set. Add it in the Social plugin settings before connecting accounts.");
          }
          const version = int(raw.encryptionKeyVersion, 1);
          const previous: Array<{ version: number; secret: string }> = [];
          if (hasValue(raw.previousEncryptionKey)) {
            const prevSecret = await secrets.get("previousEncryptionKey");
            const prevVersion = int(raw.previousEncryptionKeyVersion, Math.max(1, version - 1));
            if (prevSecret && prevVersion !== version) previous.push({ version: prevVersion, secret: prevSecret });
          }
          return buildKeyring({ purpose: "social", companyId, secret, version, previous });
        })();
        keyringPromise.catch(() => {
          keyringPromise = null;
        });
      }
      return keyringPromise;
    },
    async r2() {
      if (!r2Configured) {
        throw new Error("Cloudflare R2 is not configured. Fill in the R2 section of the Social plugin settings.");
      }
      const secretAccessKey = await secrets.require("r2.secretAccessKey", "R2 secret access key");
      const publicMediaBaseUrl = str(r2Raw.publicMediaBaseUrl)!.replace(/\/+$/, "");
      if (!/^https:\/\//i.test(publicMediaBaseUrl)) throw new Error("R2 public media URL must start with https://");
      return {
        accountId: str(r2Raw.accountId)!,
        bucket: str(r2Raw.bucket)!,
        accessKeyId: str(r2Raw.accessKeyId)!,
        secretAccessKey,
        publicBaseUrl: publicMediaBaseUrl,
      };
    },
  };
}

/** Load company config. Always pass the company id, including inside jobs. */
export async function loadSocialConfig(ctx: PluginContext, companyId: string): Promise<SocialConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const value = await ctx.config.get(companyId);
    raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch (error) {
    ctx.logger.info("Social config could not be read", { companyId, error: error instanceof Error ? error.message : String(error) });
    raw = {};
  }
  return socialConfigFrom(ctx, companyId, raw, await pluginUiBase(ctx));
}

/** Public R2 host of the configured media domain (used to trust media URLs). */
export function r2PublicHost(config: SocialConfig): string | null {
  const url = str(obj(config.raw.r2).publicMediaBaseUrl);
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
