import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";

const sendWhatsapp = vi.fn();
vi.mock("../src/whatsapp-send.js", () => ({ sendWhatsapp }));

const { toolHandlers } = await import("../src/worker.js");

const ctx = {
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  config: { get: vi.fn(async () => ({})) },
  secrets: { resolve: vi.fn(async (name: string) => (name === "TWILIO_ACCOUNT_SID" ? `AC${"a".repeat(32)}` : name === "TWILIO_WHATSAPP_FROM" ? "whatsapp:+27605550100" : "test-value")) },
  http: { fetch: vi.fn() },
  db: {},
} as unknown as PluginContext;
const run = { companyId: "co-1", agentId: "agent-1" } as ToolRunContext;
const params = { toE164: "+27821234567", body: "Hello" };

describe("whatsapp-send tool handler", () => {
  beforeEach(() => sendWhatsapp.mockReset());

  it("puts failureKind in the error the agent sees", async () => {
    sendWhatsapp.mockResolvedValue({ sent: false, reason: "send_failed", failureKind: "auth" });
    const result = await toolHandlers["whatsapp-send"](ctx, params, run);
    expect(result.error).toBe("Send failed: send_failed (auth)");
    // The sender came from the Numbers list, seeded from the old TWILIO_WHATSAPP_FROM secret.
    expect((sendWhatsapp.mock.calls[0] as unknown[])[0]).toMatchObject({ fromWhatsapp: "+27605550100" });
  });

  it("leaves reasons without a failureKind unchanged", async () => {
    sendWhatsapp.mockResolvedValue({ sent: false, reason: "cap_reached" });
    const result = await toolHandlers["whatsapp-send"](ctx, params, run);
    expect(result.error).toBe("Send failed: cap_reached");
  });
});

describe("whatsapp-send tool handler: sender", () => {
  it("refuses with the settings page named when no WhatsApp number exists", async () => {
    const bare = {
      ...ctx,
      secrets: { resolve: vi.fn(async (name: string) => (name === "TWILIO_ACCOUNT_SID" ? `AC${"a".repeat(32)}` : name === "TWILIO_AUTH_TOKEN" ? "t" : (() => { throw new Error("not set"); })())) },
    } as unknown as PluginContext;
    const result = await toolHandlers["whatsapp-send"](bare, params, run);
    expect(result.error).toBe("No WhatsApp number is set up. Add one under Numbers in Telephony settings.");
  });
});
