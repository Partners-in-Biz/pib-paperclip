/**
 * Building the provider for a company, and remembering whether it works.
 *
 * The provider exists only when the owner switched it on AND saved the API key (`espReadiness`); anything less returns the
 * list of what is missing and never touches the network. Two things are cached for a minute, in memory only:
 * - the API key and the webhook signing secret, because the host lets a plugin resolve 30 secrets a minute per company (a
 *   budget Gmail's token decryption and every other secret share) and the webhook address is public: a flood of unsigned deliveries
 *   must not use the budget up and starve sending. A secret that could NOT be read (a dangling reference, a host error) is
 *   remembered as missing for half a minute, so a flood cannot spend the budget on a secret that is not there either;
 * - the provider object itself, so its request limiter and batcher are shared by every send of the company.
 * A rotated secret is a new reference and is read at once; a changed value behind the same reference is picked up
 * within the minute.
 *
 * What the provider last said about the key is kept in company state (`mailbox-esp/provider-state`) so the Cockpit
 * and Setup can say "Resend refused the API key" without calling Resend.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, valueAtPath } from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, type EspConfig, type LoadedConfig } from "../config.js";
import { errorMessage, type Env } from "../gmail/env.js";
import { EspBatcher, limiterFor } from "./limiter.js";
import { ResendProvider, type HttpFetch } from "./resend.js";
import type { EmailProvider } from "./types.js";

export const SECRET_TTL_MS = 60_000;
/** How long a secret that could not be read is remembered as missing (a fixed reference is a new key and is read at once). */
export const SECRET_MISSING_TTL_MS = 30_000;

const secrets = new Map<string, { value: string | null; expires: number }>();
const providers = new Map<string, { provider: EmailProvider; batcher: EspBatcher | null; expires: number }>();

/** Forgets every remembered secret, provider, limiter and batcher (tests, and a settings change). */
export function forgetEspRuntime(): void {
  secrets.clear();
  providers.clear();
}

export type EspSecretPath = "esp.apiKey" | "esp.webhookSecret";

/** A secret of the `esp` block: a literal needs no host call; a reference is resolved at most once a minute per company. */
export async function espSecret(loaded: Pick<LoadedConfig, "companyId" | "raw" | "secrets">, path: EspSecretPath, nowMs: number): Promise<string | undefined> {
  const raw = valueAtPath(loaded.raw, path);
  if (!isSecretRef(raw)) return loaded.secrets.get(path);
  const key = `${loaded.companyId}|${path}|${JSON.stringify(raw)}`;
  const hit = secrets.get(key);
  if (hit && hit.expires > nowMs) return hit.value ?? undefined;
  let value: string | undefined;
  let failure: unknown = null;
  try {
    value = await loaded.secrets.get(path);
  } catch (error) {
    failure = error;
  }
  for (const [k, v] of secrets) if (v.expires <= nowMs) secrets.delete(k);
  secrets.set(key, value ? { value, expires: nowMs + SECRET_TTL_MS } : { value: null, expires: nowMs + SECRET_MISSING_TTL_MS });
  if (failure) throw failure;
  return value;
}

export type EspProviderResult =
  | { ok: true; provider: EmailProvider; batcher: EspBatcher | null; config: EspConfig }
  | { ok: false; code: "off" | "no_key" | "no_webhook" | "key_unreadable" | "key_invalid"; blockers: string[] };

/**
 * The provider for a company, or why there is none. `forSending` also needs the webhook signing secret: sending without it
 * would miss every bounce and complaint, so it is refused until the secret is saved.
 */
export async function espProviderFor(env: Pick<Env, "ctx" | "now" | "esp">, loaded: LoadedConfig, options: { forSending: boolean }): Promise<EspProviderResult> {
  const config = loaded.config.esp;
  const ready = espReadiness(config);
  if (!config.enabled) return { ok: false, code: "off", blockers: ready.blockers };
  if (!config.hasApiKey) return { ok: false, code: "no_key", blockers: ready.blockers };
  if (options.forSending && !ready.sending) return { ok: false, code: "no_webhook", blockers: ready.blockers };
  const now = env.now();
  const apiKey = await espSecret(loaded, "esp.apiKey", now).catch(() => undefined);
  if (!apiKey) return { ok: false, code: "key_unreadable", blockers: ["The Resend API key secret could not be read. Check the secret exists and the Mailbox may use it."] };
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  const cacheKey = `${loaded.companyId}|${fingerprint}|${config.ratePerSecond}|${config.batch}`;
  const hit = providers.get(cacheKey);
  if (hit && hit.expires > now) return { ok: true, provider: hit.provider, batcher: hit.batcher, config };
  let provider: EmailProvider;
  try {
    const http: HttpFetch = env.esp?.fetch ?? ((url, init) => env.ctx.http.fetch(url, init as RequestInit));
    provider = env.esp?.provider ? env.esp.provider("resend", apiKey) : new ResendProvider({ apiKey, fetch: http, limiter: limiterFor(loaded.companyId, config.ratePerSecond) });
  } catch (error) {
    return { ok: false, code: "key_invalid", blockers: [errorMessage(error)] };
  }
  const batcher = config.batch ? new EspBatcher(provider) : null;
  for (const [k, v] of providers) if (v.expires <= now) providers.delete(k);
  providers.set(cacheKey, { provider, batcher, expires: now + SECRET_TTL_MS });
  return { ok: true, provider, batcher, config };
}

// ---------------------------------------------------------------------------
// What the provider last said
// ---------------------------------------------------------------------------

export interface EspState {
  ok: boolean;
  at: string;
  /** `key_refused`, `quota`, or null when it works. */
  code: "key_refused" | "quota" | null;
  detail: string | null;
}

const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "mailbox-esp", stateKey: "provider-state" });

export async function readEspState(ctx: Pick<PluginContext, "state">, companyId: string): Promise<EspState | null> {
  try {
    const value = (await ctx.state.get(stateKey(companyId))) as Partial<EspState> | null;
    if (!value || typeof value !== "object" || typeof value.ok !== "boolean" || typeof value.at !== "string") return null;
    return { ok: value.ok, at: value.at, code: value.code === "key_refused" || value.code === "quota" ? value.code : null, detail: typeof value.detail === "string" ? value.detail : null };
  } catch {
    return null;
  }
}

/** Records the provider's state when it changed (or an hour has passed), so a busy sender does not write state on every message. Never throws. */
export async function noteEspState(ctx: Pick<PluginContext, "state" | "logger">, companyId: string, next: { code: EspState["code"]; detail?: string | null }, nowMs: number): Promise<void> {
  try {
    const before = await readEspState(ctx, companyId);
    const same = before && before.code === next.code && Date.parse(before.at) > nowMs - 3_600_000;
    if (same) return;
    await ctx.state.set(stateKey(companyId), { ok: next.code === null, at: new Date(nowMs).toISOString(), code: next.code, detail: next.detail?.slice(0, 300) ?? null } satisfies EspState);
  } catch (error) {
    ctx.logger.info("Email provider state not recorded", { error: errorMessage(error) });
  }
}
