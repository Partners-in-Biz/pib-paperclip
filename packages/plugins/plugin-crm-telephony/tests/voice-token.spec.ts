import { describe, expect, it } from "vitest";
import { buildVoiceAccessToken } from "../src/voice-token.js";
import { createHmac } from "node:crypto";

// Helper to decode JWT
function decodeJwt(token: string): { header: unknown; payload: unknown } {
  const [headerB64, payloadB64] = token.split(".");
  const header = JSON.parse(Buffer.from(base64urlDecode(headerB64), "binary").toString("utf8"));
  const payload = JSON.parse(Buffer.from(base64urlDecode(payloadB64), "binary").toString("utf8"));
  return { header, payload };
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("binary");
}

// Helper to verify signature independently
function verifySignature(token: string, secret: string): boolean {
  const lastDot = token.lastIndexOf(".");
  const headerPayload = token.slice(0, lastDot);
  const tokenSig = token.slice(lastDot + 1);

  // Compute expected signature
  const hmac = createHmac("sha256", secret);
  hmac.update(headerPayload);
  const digest = hmac.digest();

  // Convert digest to base64url
  const b64 = digest.toString("base64");
  const b64url = b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return b64url === tokenSig;
}

describe("Voice Token", () => {
  const input = {
    accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    apiKeySid: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    apiKeySecret: "fake-secret-key-for-testing",
    twimlAppSid: "APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    identity: "user@example.com",
  };

  it("throws on empty identity", () => {
    expect(() =>
      buildVoiceAccessToken({
        ...input,
        identity: "",
      }),
    ).toThrow("identity cannot be empty");
  });

  it("builds valid JWT with correct header", () => {
    const token = buildVoiceAccessToken(input);
    const { header } = decodeJwt(token);

    expect(header).toEqual({
      typ: "JWT",
      alg: "HS256",
      cty: "twilio-fpa;v=1",
    });
  });

  it("builds payload with required fields", () => {
    const nowSeconds = 1000000;
    const token = buildVoiceAccessToken({
      ...input,
      nowSeconds,
    });
    const { payload } = decodeJwt(token);

    expect(payload).toHaveProperty("jti", `${input.apiKeySid}-${nowSeconds}`);
    expect(payload).toHaveProperty("iss", input.apiKeySid);
    expect(payload).toHaveProperty("sub", input.accountSid);
    expect(payload).toHaveProperty("iat", nowSeconds);
    expect(payload).toHaveProperty("exp", nowSeconds + 3600);
  });

  it("includes voice grants with correct structure", () => {
    const token = buildVoiceAccessToken(input);
    const { payload } = decodeJwt(token);

    expect(payload).toHaveProperty("grants");
    expect((payload as any).grants).toEqual({
      identity: input.identity,
      voice: {
        incoming: { allow: false },
        outgoing: { application_sid: input.twimlAppSid },
      },
    });
  });

  it("sets exp = iat + ttl with default ttl 3600", () => {
    const nowSeconds = 2000000;
    const token = buildVoiceAccessToken({
      ...input,
      nowSeconds,
    });
    const { payload } = decodeJwt(token);

    expect((payload as any).exp - (payload as any).iat).toBe(3600);
  });

  it("clamps ttl to range 1..3600", () => {
    const nowSeconds = 2000000;

    const underMin = buildVoiceAccessToken({
      ...input,
      nowSeconds,
      ttlSeconds: 0,
    });
    const { payload: p1 } = decodeJwt(underMin);
    expect((p1 as any).exp - (p1 as any).iat).toBe(3600);

    const overMax = buildVoiceAccessToken({
      ...input,
      nowSeconds,
      ttlSeconds: 7200,
    });
    const { payload: p2 } = decodeJwt(overMax);
    expect((p2 as any).exp - (p2 as any).iat).toBe(3600);

    const valid = buildVoiceAccessToken({
      ...input,
      nowSeconds,
      ttlSeconds: 1800,
    });
    const { payload: p3 } = decodeJwt(valid);
    expect((p3 as any).exp - (p3 as any).iat).toBe(1800);
  });

  it("signs with HS256 and secret verifies independently", () => {
    const token = buildVoiceAccessToken(input);
    expect(verifySignature(token, input.apiKeySecret)).toBe(true);
  });

  it("produces deterministic output for same inputs and nowSeconds", () => {
    const nowSeconds = 2000000;
    const t1 = buildVoiceAccessToken({
      ...input,
      nowSeconds,
    });
    const t2 = buildVoiceAccessToken({
      ...input,
      nowSeconds,
    });
    expect(t1).toBe(t2);
  });

  it("has three parts separated by periods (valid JWT structure)", () => {
    const token = buildVoiceAccessToken(input);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBeTruthy();
    expect(parts[1]).toBeTruthy();
    expect(parts[2]).toBeTruthy();
  });

  it("uses base64url encoding without padding", () => {
    const token = buildVoiceAccessToken(input);
    expect(token).not.toContain("=");
  });
});
