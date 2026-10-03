import type { Env } from "../../src/gmail/env.js";
import { handleUnsubscribeWebhook, probeUnsubscribeProxy } from "../../src/unsubscribe.js";
import { CO } from "./memory.js";

export interface SelfCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

/**
 * Stands in for the host's guarded `ctx.http.fetch` AND everything between it and
 * the plugin on the way back: the reverse proxy and the host's webhook route.
 * The host hands a webhook its headers and body, never the URL; a proxy with the
 * rule adds `X-Original-Uri`. `proxy: false` is the live box today (no rule).
 */
export function fakeSelfFetch(env: Pick<Env, "ctx" | "store" | "now">, options: { proxy?: boolean; status?: number; fail?: string } = {}): SelfCall[] {
  const calls: SelfCall[] = [];
  (env.ctx as unknown as { http: unknown }).http = {
    async fetch(url: string, init?: SelfCall["init"]) {
      calls.push({ url, init });
      if (options.fail) throw new Error(options.fail);
      const target = new URL(url);
      const status = options.status ?? 200;
      if (status < 400) {
        const headers: Record<string, string> = { "content-type": init?.headers?.["content-type"] ?? "", host: target.host };
        if (options.proxy !== false) headers["x-original-uri"] = target.pathname + target.search;
        await handleUnsubscribeWebhook(env, { endpointKey: "unsubscribe", headers, rawBody: String(init?.body ?? ""), parsedBody: {}, requestId: "req-probe" });
      }
      return { ok: status < 400, status, text: async () => "" };
    },
  };
  return calls;
}

/** Opens the gate the way production does: a probe through a working proxy. */
export async function openGate(env: Pick<Env, "ctx" | "store" | "now">): Promise<void> {
  fakeSelfFetch(env, { proxy: true });
  const proof = await probeUnsubscribeProxy(env, CO);
  if (!proof?.ok) throw new Error("the test proxy did not open the gate");
}

/** Writes an open gate straight into state, for the cases where the Mailbox must still make no link for another reason (no secret, several recipients). */
export async function forceGate(env: Pick<Env, "ctx" | "now">): Promise<void> {
  await env.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "mailbox-unsubscribe", stateKey: "proxy-proof" }, { ok: true, at: new Date(env.now()).toISOString(), detail: null, probe: "forced" });
}
