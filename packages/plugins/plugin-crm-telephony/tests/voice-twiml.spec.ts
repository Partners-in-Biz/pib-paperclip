import { describe, expect, it, vi } from "vitest";
import { twimlForVoiceRequest, handleVoiceTwiml } from "../src/voice-twiml.js";
import { computeTwilioSignature, buildPublicWebhookUrl, parseFormParams } from "../src/twilio-signature.js";
import { PLUGIN_ID } from "../src/namespace.js";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";

const NUMBERS = { za: "+27105550100", us: "+12025550100" };

describe("twimlForVoiceRequest (what a TwiML app would get)", () => {
  it("dials a +27 number from the ZA caller ID", () => {
    const r = twimlForVoiceRequest({ To: "+27821234567" }, NUMBERS, { record: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.callerId).toBe("+27105550100");
      expect(r.twiml).toContain("<Number>+27821234567</Number>");
    }
  });

  it("accepts a national South African number and normalises it", () => {
    const r = twimlForVoiceRequest({ To: "082 123 4567" }, NUMBERS, { record: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.to).toBe("+27821234567");
  });

  it("dials a +1 number from the US caller ID with recording when asked", () => {
    const r = twimlForVoiceRequest({ To: "+12125552000" }, NUMBERS, { record: true, recordingStatusCallbackUrl: "https://p.example.com/rec" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.callerId).toBe("+12025550100");
      expect(r.twiml).toContain('record="record-from-answer-dual"');
    }
  });

  it("refuses a region without a caller ID and an unsupported region", () => {
    expect(twimlForVoiceRequest({ To: "+12125552000" }, { za: NUMBERS.za }, { record: false })).toEqual({ ok: false, reason: "caller_id_not_configured" });
    expect(twimlForVoiceRequest({ To: "+447700900123" }, NUMBERS, { record: false })).toEqual({ ok: false, reason: "unsupported_region" });
    expect(twimlForVoiceRequest({ To: "hello" }, NUMBERS, { record: false })).toEqual({ ok: false, reason: "bad_number" });
    expect(twimlForVoiceRequest({}, NUMBERS, { record: false })).toEqual({ ok: false, reason: "bad_number" });
  });
});

describe("handleVoiceTwiml webhook", () => {
  const COMPANY = "550e8400-e29b-41d4-a716-446655440000";
  const TOKEN = "auth-token-a";

  function ctxWith(secrets: Record<string, string>): { ctx: PluginContext; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const ctx = {
      logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      companies: { list: vi.fn(async () => [{ id: COMPANY, name: "A" }]) },
      secrets: {
        resolve: vi.fn(async (name: string, opts: { companyId: string }) => {
          if (opts.companyId !== COMPANY) throw new Error("no company");
          const v = secrets[name];
          if (!v) throw new Error("not set");
          return v;
        }),
      },
    } as unknown as PluginContext;
    return { ctx, warn };
  }

  function signed(body: string, token = TOKEN): PluginWebhookInput {
    const url = buildPublicWebhookUrl({ baseUrl: "https://paperclip.example.com", pluginId: PLUGIN_ID, endpointKey: "voice-twiml" });
    const signature = computeTwilioSignature(token, url, parseFormParams(body));
    return {
      requestId: "r1",
      endpointKey: "voice-twiml",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "paperclip.example.com", "x-twilio-signature": signature },
      rawBody: body,
      parsedBody: parseFormParams(body),
    };
  }

  it("verifies the signature, computes the TwiML and warns that the host cannot return it", async () => {
    const { ctx, warn } = ctxWith({ TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ZA_NUMBER: NUMBERS.za });
    const outcome = await handleVoiceTwiml(ctx, signed("To=%2B27821234567&From=client%3Auser-1"), PLUGIN_ID);
    expect(outcome).toBe("ok");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot answer Twilio with TwiML"), expect.objectContaining({ to_ok: true }));
  });

  it("rejects a bad signature before touching numbers", async () => {
    const { ctx } = ctxWith({ TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ZA_NUMBER: NUMBERS.za });
    const input = signed("To=%2B27821234567", "other-token");
    expect(await handleVoiceTwiml(ctx, input, PLUGIN_ID)).toBe("bad_signature");
    expect(ctx.secrets.resolve).not.toHaveBeenCalledWith("TWILIO_ZA_NUMBER", expect.anything());
  });

  it("reports a refusal when no caller ID fits the number", async () => {
    const { ctx } = ctxWith({ TWILIO_AUTH_TOKEN: TOKEN });
    expect(await handleVoiceTwiml(ctx, signed("To=%2B27821234567"), PLUGIN_ID)).toBe("refused");
  });

  it("needs a host header", async () => {
    const { ctx } = ctxWith({ TWILIO_AUTH_TOKEN: TOKEN });
    const input = signed("To=%2B27821234567");
    input.headers = { "x-twilio-signature": "x" };
    expect(await handleVoiceTwiml(ctx, input, PLUGIN_ID)).toBe("missing_host");
  });
});
