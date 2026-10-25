import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Outbound fetch for the worker. JSON calls go through the host client so its
 * http.outbound policy and audit apply. The host client can only carry string
 * bodies (the SDK sends `String(body)`, so a FormData upload would arrive as
 * "[object FormData]"); the voice-note upload therefore uses Node's own fetch.
 */
export function outboundFetch(ctx: PluginContext, directFetch: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") return directFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return ctx.http.fetch(url, init);
  }) as typeof fetch;
}
