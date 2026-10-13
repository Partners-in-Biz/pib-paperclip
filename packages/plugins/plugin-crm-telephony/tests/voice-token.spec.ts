import { describe, expect, it } from "vitest";
import { buildVoiceAccessToken } from "../src/voice-token.js";
import { createHmac } from "node:crypto";

function decodeJwt(token: string) {
  const [headerB64, payloadB64] = token.split(".");
  const decode = (s: string) => JSON.parse(Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4), "base64"
  ).toString("utf8"));
  return { header: decode(headerB64), payload: decode(payloadB64) };
}

function verifySignature(token: string, secret: string): boolean {
  const lastDot = token.lastIndexOf(".");
  const headerPayload = token.slice(0, lastDot);
  const givenSig = token.slice(lastDot + 1);
  const hmac = createHmac("sha256", secret);
  hmac.update(headerPayload);
  const expected = hmac.digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return expected === givenSig;
}

describe("Voice Token", () => {
  const input = {
    accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    apiKeySid: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    apiKeySecret: "fake-secret",
    twimlAppSid: "APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    identity: "user@example.com",
  };

  it("throws on empty identity", () => {
    expect(() => buildVoiceAccessToken({ ...input, identity: "" })).toThrow();
  });

  it("builds HS256 JWT with correct claims", () => {
    const nowSeconds = 1000000;
    const token = buildVoiceAccessToken({ ...input, nowSeconds });
    const { header, payload } = decodeJwt(token);
    expect((header as any).alg).toBe("HS256");
    expect((payload as any).iss).toBe(input.apiKeySid);
    expect((payload as any).sub).toBe(input.accountSid);
    expect((payload as any).grants.voice.outgoing.application_sid).toBe(input.twimlAppSid);
  });

  it.each([[0, 3600], [7200, 3600], [1800, 1800]])("clamps ttl %i to %i", (ttl, expect_delta) => {
    const nowSeconds = 2000000;
    const token = buildVoiceAccessToken({ ...input, nowSeconds, ttlSeconds: ttl });
    const { payload } = decodeJwt(token);
    expect((payload as any).exp - (payload as any).iat).toBe(expect_delta);
  });

  it("signs with HS256 verifiable by secret", () => {
    const token = buildVoiceAccessToken(input);
    expect(verifySignature(token, input.apiKeySecret)).toBe(true);
  });

  it("produces 3 base64url-encoded parts without padding", () => {
    const token = buildVoiceAccessToken(input);
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toContain("=");
  });
});
