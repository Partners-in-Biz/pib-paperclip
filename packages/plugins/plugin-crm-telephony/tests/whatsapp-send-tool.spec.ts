import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";

const sendWhatsapp = vi.fn();
vi.mock("../src/whatsapp-send.js", () => ({ sendWhatsapp }));

const { toolHandlers } = await import("../src/worker.js");

const ctx = {
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  config: { get: vi.fn(async () => ({})) },
  secrets: { resolve: vi.fn(async (name: string) => (name === "TWILIO_ACCOUNT_SID" ? `AC${"a".repeat(32)}` : "test-value")) },
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
  });

  it("leaves reasons without a failureKind unchanged", async () => {
    sendWhatsapp.mockResolvedValue({ sent: false, reason: "cap_reached" });
    const result = await toolHandlers["whatsapp-send"](ctx, params, run);
    expect(result.error).toBe("Send failed: cap_reached");
  });
});
