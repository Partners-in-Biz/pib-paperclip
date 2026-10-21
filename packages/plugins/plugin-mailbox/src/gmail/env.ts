import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GmailStore } from "../db.js";
import type { DnsResolver } from "../dns.js";
import type { HttpFetch } from "../esp/resend.js";
import type { EmailProvider, EspCredentials, EspProviderKey } from "../esp/types.js";
import type { FetchLike } from "./api.js";

/** The email provider's seams: tests pass a mock provider (and a fake fetch); production builds Resend over the host's guarded fetch. */
export interface EspEnv {
  /** HTTP for the provider API; the host's `ctx.http.fetch` when absent. */
  fetch?: HttpFetch;
  /** Builds the provider from the saved credentials (`{ apiKey }` for Resend, `{ region, accessKeyId, secretAccessKey }` for SES); the real adapter when absent. */
  provider?: (key: EspProviderKey, credentials: EspCredentials) => EmailProvider;
}

/** Everything the Gmail logic needs; tests swap the store and fetch. */
export interface Env {
  ctx: PluginContext;
  store: GmailStore;
  /** Google, Gmail and attachment downloads. */
  fetch: FetchLike;
  /** Passed to the kit's Jev client (defaults to global fetch). */
  jevFetch?: typeof fetch;
  now: () => number;
  /** Access tokens by account id for this worker process. */
  tokenCache: Map<string, { token: string; expiresAt: number }>;
  /** DNS over HTTPS for the sender domain checks; the public resolvers through the host's guarded fetch when absent (tests pass a fake). */
  dns?: DnsResolver;
  /** The email provider's seams (see `EspEnv`). */
  esp?: EspEnv;
}

export function createEnv(ctx: PluginContext, store: GmailStore, overrides: Partial<Omit<Env, "ctx" | "store">> = {}): Env {
  return {
    ctx,
    store,
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    jevFetch: overrides.jevFetch,
    now: overrides.now ?? (() => Date.now()),
    tokenCache: overrides.tokenCache ?? new Map(),
    dns: overrides.dns,
    esp: overrides.esp,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
