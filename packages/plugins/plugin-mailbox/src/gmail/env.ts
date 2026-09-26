import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GmailStore } from "../db.js";
import type { FetchLike } from "./api.js";

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
}

export function createEnv(ctx: PluginContext, store: GmailStore, overrides: Partial<Omit<Env, "ctx" | "store">> = {}): Env {
  return {
    ctx,
    store,
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    jevFetch: overrides.jevFetch,
    now: overrides.now ?? (() => Date.now()),
    tokenCache: overrides.tokenCache ?? new Map(),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
