import { describe, it, expect, vi } from "vitest";
import { handleCallStatus } from "../src/call-status.js";
import { computeTwilioSignature, parseFormParams } from "../src/twilio-signature.js";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";

const buildSigned = (authToken: string, url: string, rawBody: string) => {
  const params = parseFormParams(rawBody);
  const sig = computeTwilioSignature(authToken, url, params);
  return { headers: { "x-twilio-signature": sig }, rawBody };
};

const mockLogger = { debug: vi.fn(), warn: vi.fn() };

describe("handleCallStatus", () => {
  it("rejects bad signature", async () => {
    const ctx = {
      logger: mockLogger,
      secrets: { resolve: vi.fn().mockResolvedValue("token") },
    } as unknown as PluginContext;

    const input = {
      endpointKey: "call-status",
      headers: { "x-twilio-signature": "bad" },
      rawBody: "CallSid=CA123&CallStatus=completed",
      requestId: "req",
    } as PluginWebhookInput;

    await handleCallStatus(ctx, input, "company1");
    expect(mockLogger.warn).toHaveBeenCalledWith("Call status webhook signature verification failed", expect.any(Object));
  });

  it("rejects missing signature", async () => {
    const ctx = { logger: mockLogger, secrets: { resolve: vi.fn().mockResolvedValue("token") } } as unknown as PluginContext;
    const input = { endpointKey: "call-status", headers: {}, rawBody: "CallSid=CA123", requestId: "req" } as PluginWebhookInput;
    await handleCallStatus(ctx, input, "company1");
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("rejects missing secret", async () => {
    const ctx = { logger: mockLogger, secrets: { resolve: vi.fn().mockRejectedValue(new Error("not found")) } } as unknown as PluginContext;
    const input = { endpointKey: "call-status", headers: { "x-twilio-signature": "sig" }, rawBody: "CallSid=CA123", requestId: "req" } as PluginWebhookInput;
    await handleCallStatus(ctx, input, "company1");
    expect(mockLogger.warn).toHaveBeenCalledWith("Failed to resolve TWILIO_AUTH_TOKEN for call-status webhook");
  });

  it("upserts call record on valid signature", async () => {
    const authToken = "auth-123";
    const url = "https://example.com/webhook";
    const body = "CallSid=CA123&CallStatus=in-progress&CallDuration=45";
    const { headers, rawBody } = buildSigned(authToken, url, body);

    const ctx = {
      logger: mockLogger,
      secrets: { resolve: vi.fn().mockResolvedValue(authToken) },
      db: { execute: vi.fn(async () => ({ rowCount: 1 })) },
    } as unknown as PluginContext;

    await handleCallStatus(ctx, { endpointKey: "call-status", headers, rawBody, requestId: "req" } as PluginWebhookInput, "company1", url);
    expect(ctx.db.execute).toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith("Inserted call status record", expect.any(Object));
  });

  it("handles duplicate delivery idempotently", async () => {
    const authToken = "auth-123";
    const url = "https://example.com/webhook";
    const body = "CallSid=CA123&CallStatus=completed";
    const { headers, rawBody } = buildSigned(authToken, url, body);

    const ctx = {
      logger: mockLogger,
      secrets: { resolve: vi.fn().mockResolvedValue(authToken) },
      db: { execute: vi.fn(async () => ({ rowCount: 0 })) },
    } as unknown as PluginContext;

    await handleCallStatus(ctx, { endpointKey: "call-status", headers, rawBody, requestId: "req" } as PluginWebhookInput, "company1", url);
    expect(mockLogger.debug).toHaveBeenCalledWith("Call status already exists (duplicate delivery)", expect.any(Object));
  });

  it("maps Twilio statuses", async () => {
    for (const status of ["queued", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled"]) {
      const authToken = "auth-123";
      const url = "https://example.com/webhook";
      const body = `CallSid=CA${status}&CallStatus=${status}`;
      const { headers, rawBody } = buildSigned(authToken, url, body);

      const ctx = {
        logger: mockLogger,
        secrets: { resolve: vi.fn().mockResolvedValue(authToken) },
        db: { execute: vi.fn(async () => ({ rowCount: 1 })) },
      } as unknown as PluginContext;

      await handleCallStatus(ctx, { endpointKey: "call-status", headers, rawBody, requestId: "req" } as PluginWebhookInput, "company1", url);
      expect(ctx.db.execute).toHaveBeenCalled();
    }
  });
});
