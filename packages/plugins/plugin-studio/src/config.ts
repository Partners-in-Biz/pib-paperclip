/**
 * Studio settings. The bucket is the company's private one (shared with Mailbox and Billing, each in its own folder),
 * and the Higgsfield key is a secret reference. Monthly caps are not settings here: they live in `credit_limits`, are
 * set on the Studio page by a company owner and apply to the next generation.
 */
import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { SecretResolver, secretField } from "@partnersinbiz/pib-plugin-kit";
import { StudioError } from "./errors.js";
import type { PrivateBucket } from "./storage.js";

export function instanceConfigSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      r2: {
        type: "object",
        title: "Private storage (Cloudflare R2)",
        properties: {
          accountId: { type: "string", title: "Account ID" },
          bucket: { type: "string", title: "Private bucket", description: "Not a public one: drafts and client work live here." },
          accessKeyId: { type: "string", title: "Access key ID" },
          secretAccessKey: secretField("Secret access key"),
        },
      },
      higgsfield: {
        type: "object",
        title: "Higgsfield",
        properties: { apiKey: secretField("API key", "platform.higgsfield.ai key, as <key-id>:<key-secret>.") },
      },
      xai: {
        type: "object",
        title: "xAI speech to text",
        properties: { apiKey: secretField("API key", "console.x.ai key for auto-captions (grok-voice-transcribe). The Voice plugin's key works here too.") },
      },
    },
  };
}

async function read(ctx: PluginContext, companyId: string): Promise<Record<string, unknown>> {
  return ((await ctx.config.get(companyId)) ?? {}) as Record<string, unknown>;
}

/** One handle per job run or request: the host limits secret resolves per minute, and this remembers them. */
export class StudioConfig {
  private raw: Promise<Record<string, unknown>>;
  private secrets: Promise<SecretResolver>;

  constructor(ctx: PluginContext, companyId: string) {
    this.raw = read(ctx, companyId);
    this.secrets = this.raw.then((raw) => new SecretResolver(ctx, companyId, raw));
  }

  async bucket(): Promise<PrivateBucket> {
    const r2 = ((await this.raw).r2 ?? {}) as Record<string, unknown>;
    const field = (name: string) => (typeof r2[name] === "string" ? (r2[name] as string).trim() : "");
    const secretAccessKey = await (await this.secrets).get("r2.secretAccessKey");
    if (!field("accountId") || !field("bucket") || !field("accessKeyId") || !secretAccessKey) {
      throw new StudioError("Studio's private storage is not set up in this company's plugin settings.", "not_configured");
    }
    return { accountId: field("accountId"), bucket: field("bucket"), accessKeyId: field("accessKeyId"), secretAccessKey };
  }

  async higgsfieldKey(): Promise<string> {
    const key = await (await this.secrets).get("higgsfield.apiKey");
    if (!key) throw new StudioError("Studio's Higgsfield key is not set up in this company's plugin settings.", "not_configured");
    return key;
  }

  async xaiKey(): Promise<string> {
    const key = await (await this.secrets).get("xai.apiKey");
    if (!key) throw new StudioError("Auto-captions need an xAI key in Studio's plugin settings.", "not_configured");
    return key;
  }
}
