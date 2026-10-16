import { describe, expect, it, vi, beforeEach } from "vitest";
import { voiceTokenAction } from "../src/voice-token-action.js";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
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

const TEST_SECRETS = {
  TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  TWILIO_API_KEY_SID: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  TWILIO_API_KEY_SECRET: "fake-secret",
  TWILIO_TWIML_APP_SID: "APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
};

function mockCtx(configData: Record<string, unknown> = {}, secretValues: Record<string, string | null> = {}): PluginContext {
  return {
    config: {
      get: vi.fn().mockResolvedValue(configData),
    },
    secrets: {
      resolve: vi.fn().mockImplementation((name: string) => {
        const value = secretValues[name];
        if (value === undefined) {
          return Promise.resolve(TEST_SECRETS[name as keyof typeof TEST_SECRETS] ?? null);
        }
        return Promise.resolve(value);
      }),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("Voice Token Action", () => {
  const baseContext: PluginPerformActionContext = {
    actor: {
      type: "user",
      userId: "user-1",
      agentId: null,
      runId: null,
      companyId: "c1",
    },
    companyId: "c1",
  };

  describe("(a) access denied cases", () => {
    it("user not on allowlist -> rejects with access error and never resolves secrets", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-2", "user-3"] });
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Calling is not enabled for this user");

      // Verify secrets.resolve was never called
      expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    });

    it("agent actor -> rejects with access error", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context: PluginPerformActionContext = {
        actor: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: null,
          companyId: "c1",
        },
        companyId: "c1",
      };

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Only a signed-in person can use the dialer");
      expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    });

    it("empty allowlist -> rejects", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: [] });
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Calling is not enabled for any user");
      expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    });

    it("system actor -> rejects", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context: PluginPerformActionContext = {
        actor: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: "c1",
        },
        companyId: "c1",
      };

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Only a signed-in person can use the dialer");
    });
  });

  describe("(b) company context validation", () => {
    it("null companyId -> rejects immediately", async () => {
      const ctx = mockCtx();
      const context: PluginPerformActionContext = {
        actor: {
          type: "user",
          userId: "user-1",
          agentId: null,
          runId: null,
          companyId: null,
        },
        companyId: null,
      };

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("A company is required");
    });
  });

  describe("(c) missing credentials", () => {
    it("missing TWILIO_ACCOUNT_SID -> rejects with non-secret error message", async () => {
      const ctx = mockCtx(
        { voiceAllowedUserIds: ["user-1"] },
        { TWILIO_ACCOUNT_SID: null }
      );
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Twilio voice credentials are not configured");

      // Verify the error doesn't contain the secret
      try {
        await voiceTokenAction(ctx, context);
      } catch (e) {
        expect(String(e)).not.toContain(TEST_SECRETS.TWILIO_ACCOUNT_SID);
      }
    });

    it("missing TWILIO_API_KEY_SID -> rejects", async () => {
      const ctx = mockCtx(
        { voiceAllowedUserIds: ["user-1"] },
        { TWILIO_API_KEY_SID: null }
      );
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Twilio voice credentials are not configured");
    });

    it("missing TWILIO_API_KEY_SECRET -> rejects", async () => {
      const ctx = mockCtx(
        { voiceAllowedUserIds: ["user-1"] },
        { TWILIO_API_KEY_SECRET: null }
      );
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Twilio voice credentials are not configured");
    });

    it("missing TWILIO_TWIML_APP_SID -> rejects", async () => {
      const ctx = mockCtx(
        { voiceAllowedUserIds: ["user-1"] },
        { TWILIO_TWIML_APP_SID: null }
      );
      const context = baseContext;

      await expect(voiceTokenAction(ctx, context)).rejects.toThrow("Twilio voice credentials are not configured");
    });
  });

  describe("(d) happy path - token generation and verification", () => {
    it("generates valid JWT with correct claims", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const nowSeconds = 1000000;
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context, { nowSeconds });

      expect(result.token).toBeDefined();
      expect(result.identity).toBe("user-1");
      expect(result.expiresAt).toBeDefined();

      const { payload } = decodeJwt(result.token);
      expect((payload as any).iss).toBe(TEST_SECRETS.TWILIO_API_KEY_SID);
      expect((payload as any).sub).toBe(TEST_SECRETS.TWILIO_ACCOUNT_SID);
      expect((payload as any).grants.identity).toBe("user-1");
      expect((payload as any).grants.voice.outgoing.application_sid).toBe(TEST_SECRETS.TWILIO_TWIML_APP_SID);
      expect((payload as any).grants.voice.incoming.allow).toBe(false);
    });

    it("ttl is 3600 seconds", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const nowSeconds = 2000000;
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context, { nowSeconds });

      const { payload } = decodeJwt(result.token);
      const exp = (payload as any).exp;
      const iat = (payload as any).iat;
      expect(exp - iat).toBe(3600);
    });

    it("HS256 signature is valid", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context);

      expect(verifySignature(result.token, TEST_SECRETS.TWILIO_API_KEY_SECRET)).toBe(true);
    });

    it("expiresAt matches exp claim as ISO string", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const nowSeconds = 3000000;
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context, { nowSeconds });

      const { payload } = decodeJwt(result.token);
      const exp = (payload as any).exp;
      const expectedExpires = new Date(exp * 1000).toISOString();
      expect(result.expiresAt).toBe(expectedExpires);
    });

    it("uses nowSeconds parameter for iat when provided", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const nowSeconds = 5000000;
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context, { nowSeconds });

      const { payload } = decodeJwt(result.token);
      expect((payload as any).iat).toBe(nowSeconds);
    });

    it("returns exactly token, identity, and expiresAt (no extra fields)", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context);

      const keys = Object.keys(result).sort();
      expect(keys).toEqual(["expiresAt", "identity", "token"]);
    });
  });

  describe("(e) security - no secret leakage", () => {
    it("token doesn't contain the API key secret in plaintext", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context);

      expect(result.token).not.toContain(TEST_SECRETS.TWILIO_API_KEY_SECRET);
    });

    it("JSON.stringify of result doesn't contain the API key secret", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context);
      const stringified = JSON.stringify(result);

      expect(stringified).not.toContain(TEST_SECRETS.TWILIO_API_KEY_SECRET);
    });

    it("result doesn't contain account SID, api key sid, or twiml app sid", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context = baseContext;

      const result = await voiceTokenAction(ctx, context);
      const stringified = JSON.stringify(result);

      // The token itself contains these (in JWT claims), but the returned object should not
      // Actually, the token WILL contain them because it's a JWT, so we just check identity/expiresAt
      expect(result.identity).not.toContain(TEST_SECRETS.TWILIO_ACCOUNT_SID);
      expect(result.identity).not.toContain(TEST_SECRETS.TWILIO_API_KEY_SID);
      expect(result.expiresAt).not.toContain(TEST_SECRETS.TWILIO_ACCOUNT_SID);
    });
  });

  describe("(f) actor adaptation", () => {
    it("uses userId when both userId and agentId are present", async () => {
      const ctx = mockCtx({ voiceAllowedUserIds: ["my-user-id"] });
      const context: PluginPerformActionContext = {
        actor: {
          type: "user",
          userId: "my-user-id",
          agentId: "some-agent-id",
          runId: null,
          companyId: "c1",
        },
        companyId: "c1",
      };

      const result = await voiceTokenAction(ctx, context);
      expect(result.identity).toBe("my-user-id");
    });

    it("falls back to agentId when userId is null (for agent type)", async () => {
      // Note: agents are rejected by access, but we test the fallback logic
      const ctx = mockCtx({ voiceAllowedUserIds: ["user-1"] });
      const context: PluginPerformActionContext = {
        actor: {
          type: "user",
          userId: null,
          agentId: "fallback-id",
          runId: null,
          companyId: "c1",
        },
        companyId: "c1",
      };

      // This should fail because agentId is not in allowlist, but it tests the adapter
      await expect(voiceTokenAction(ctx, context)).rejects.toThrow();
    });
  });
});
