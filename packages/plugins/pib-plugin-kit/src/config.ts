/**
 * Company config and secret-ref resolution.
 *
 * Jobs run without an invocation scope. The host still allows a job's host
 * call when it names a company that has a saved plugin config row, so every
 * helper here takes `companyId` explicitly. Callers must never rely on the
 * host deriving the company.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export type SecretRefValue = { type: "secret_ref"; secretId: string; version?: "latest" | number };

export function isSecretRef(value: unknown): value is SecretRefValue {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "secret_ref";
}

export async function readConfig<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: PluginContext,
  companyId: string,
): Promise<T> {
  const config = await ctx.config.get(companyId);
  return (config && typeof config === "object" ? config : {}) as T;
}

/** True once an operator has saved this plugin's settings for the company. */
export async function configSaved(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    const config = await readConfig(ctx, companyId);
    return Object.keys(config).length > 0;
  } catch {
    return false;
  }
}

export function valueAtPath(config: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = config;
  for (const key of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Resolves config values that may be secret refs. Memoises per instance so a
 * single job run does not exceed the host's resolve rate limit. Create one per
 * run; never persist what it returns.
 */
export class SecretResolver {
  private cache = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly companyId: string,
    private readonly config: Record<string, unknown>,
  ) {}

  /** Resolve the value at `configPath`: a secret ref, a raw string, or nothing. */
  get(configPath: string): Promise<string | undefined> {
    const cached = this.cache.get(configPath);
    if (cached) return cached;
    const run = this.resolve(configPath);
    this.cache.set(configPath, run);
    return run;
  }

  async require(configPath: string, label: string): Promise<string> {
    const value = await this.get(configPath);
    if (!value) throw new Error(`${label} is not set. Add it in the plugin settings.`);
    return value;
  }

  private async resolve(configPath: string): Promise<string | undefined> {
    const raw = valueAtPath(this.config, configPath);
    if (raw == null || raw === "") return undefined;
    if (typeof raw === "string") return raw.trim() || undefined;
    if (isSecretRef(raw)) {
      const value = await this.ctx.secrets.resolve(raw, { companyId: this.companyId, configPath });
      return value?.trim() || undefined;
    }
    return undefined;
  }
}

export async function secretResolverFor(ctx: PluginContext, companyId: string) {
  const config = await readConfig(ctx, companyId);
  return { config, secrets: new SecretResolver(ctx, companyId, config) };
}

/** JSON-schema fragment for a secret field. No `type`, so the picker's object validates. */
export function secretField(title: string, description?: string): Record<string, unknown> {
  return description ? { title, description, format: "secret-ref" } : { title, format: "secret-ref" };
}
