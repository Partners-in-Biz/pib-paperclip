import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { outboundFetch } from "../src/outbound.js";

function setup() {
  const hostFetch = vi.fn(async () => new Response("{}"));
  const directFetch = vi.fn(async () => new Response("{}"));
  const ctx = { http: { fetch: hostFetch } } as unknown as PluginContext;
  return { f: outboundFetch(ctx, directFetch as unknown as typeof fetch), hostFetch, directFetch };
}

describe("outboundFetch", () => {
  it("sends JSON calls through the host client", async () => {
    const { f, hostFetch, directFetch } = setup();
    await f(new URL("https://api.x.ai/v1/realtime/client_secrets"), { method: "POST", body: "{}" });
    expect(hostFetch).toHaveBeenCalledWith("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", body: "{}" });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("sends a multipart upload directly, because the host client stringifies bodies", async () => {
    const { f, hostFetch, directFetch } = setup();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2])]), "note.m4a");
    await f("https://api.x.ai/v1/stt", { method: "POST", body: form });
    expect(directFetch).toHaveBeenCalledWith("https://api.x.ai/v1/stt", expect.objectContaining({ body: form }));
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
