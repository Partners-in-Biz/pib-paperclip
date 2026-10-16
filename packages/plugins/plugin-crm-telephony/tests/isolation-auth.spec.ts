import { describe, expect, it, vi } from "vitest";
import { voiceTokenAction } from "../src/voice-token-action.js";
import { resolveVerifiedCompany } from "../src/company-resolve.js";
import { secretStatus } from "../src/settings.js";
import { telephonyToolHandler } from "../src/worker.js";
import { createMockContext, createSecretsRecorder } from "./helpers/test-utils.js";
import type { PluginContext, PluginPerformActionContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { createHmac } from "node:crypto";

const A = "company-a";
const B = "company-b";
const SA = { TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TWILIO_API_KEY_SID: "SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TWILIO_API_KEY_SECRET: "secret-a", TWILIO_TWIML_APP_SID: "APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TWILIO_AUTH_TOKEN: "auth-token-a" };
const SB = { TWILIO_ACCOUNT_SID: "ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TWILIO_API_KEY_SID: "SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TWILIO_API_KEY_SECRET: "secret-b", TWILIO_TWIML_APP_SID: "APbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TWILIO_AUTH_TOKEN: "auth-token-b" };

function decodeJwt(token: string) {
  const [, pay] = token.split(".");
  return JSON.parse(Buffer.from(pay.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - pay.length % 4) % 4), "base64").toString("utf8"));
}

describe("Isolation: Auth & Secrets", () => {
  describe("voiceTokenAction: company isolation", () => {
    it.each([
      { co: A, want: SA },
      { co: B, want: SB },
    ])("$co gets token with own secrets only", async ({ co, want }) => {
      const ctx = {
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        companies: { list: vi.fn(async () => [{ id: A }, { id: B }]), get: vi.fn() },
        config: { get: vi.fn(async () => ({ voiceAllowedUserIds: ["u1"] })) },
        secrets: {
          resolve: vi.fn(async (n: string, opts: any) => {
            const s = opts.companyId === A ? SA : SB;
            return s[n as keyof typeof SA] ?? null;
          }),
        },
      } as unknown as PluginContext;

      const result = await voiceTokenAction(ctx, {
        actor: { type: "user", userId: "u1", agentId: null, runId: null, companyId: co },
        companyId: co,
      } as PluginPerformActionContext);

      const payload = decodeJwt(result.token);
      expect(payload.sub).toBe(want.TWILIO_ACCOUNT_SID);
      expect(payload.iss).toBe(want.TWILIO_API_KEY_SID);
    });

    it("missing secret fails closed without resolve for other company", async () => {
      const calls: any[] = [];
      const ctx = {
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        companies: { list: vi.fn(async () => [{ id: A }, { id: B }]), get: vi.fn() },
        config: { get: vi.fn(async () => ({ voiceAllowedUserIds: ["u1"] })) },
        secrets: {
          resolve: vi.fn(async (n: string, opts: any) => {
            calls.push({ n, co: opts.companyId });
            if (opts.companyId === A && n === "TWILIO_ACCOUNT_SID") return null;
            const s = opts.companyId === A ? SA : SB;
            return s[n as keyof typeof SA] ?? null;
          }),
        },
      } as unknown as PluginContext;

      await expect(voiceTokenAction(ctx, {
        actor: { type: "user", userId: "u1", agentId: null, runId: null, companyId: A },
        companyId: A,
      } as PluginPerformActionContext)).rejects.toThrow("credentials are not configured");

      expect(calls.every((c) => c.co === A)).toBe(true);
    });
  });

  describe("resolveVerifiedCompany: signature verification", () => {
    it.each([
      { secret: SA.TWILIO_AUTH_TOKEN, expect: A },
      { secret: SB.TWILIO_AUTH_TOKEN, expect: B },
    ])("signature with $expect token resolves $expect", async ({ secret, expect: exp }) => {
      const ctx = createMockContext([A, B], {
        [A]: SA.TWILIO_AUTH_TOKEN,
        [B]: SB.TWILIO_AUTH_TOKEN,
      }) as unknown as PluginContext;

      const h = { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" };
      const url = "https://example.com/webhook";
      const body = "test=data";

      const hmac = createHmac("sha256", secret);
      hmac.update(url + body);
      const sig = Buffer.from(hmac.digest()).toString("base64");

      const result = await resolveVerifiedCompany(ctx, { ...h, "x-twilio-signature": sig }, body, url);

      if (result && "companyId" in result) expect(result.companyId).toBe(exp);
    });

    it("missing secret skipped, other company verifies", async () => {
      const ctx = createMockContext([A, B], {
        [A]: SA.TWILIO_AUTH_TOKEN,
        [B]: SB.TWILIO_AUTH_TOKEN,
      }) as unknown as PluginContext;

      (ctx.secrets.resolve as any).mockImplementation((n: string, opts: any) => {
        if (opts.companyId === A) return Promise.reject(new Error("No token"));
        return Promise.resolve(SB.TWILIO_AUTH_TOKEN);
      });

      const h = { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" };
      const url = "https://example.com/webhook";
      const body = "test=data";

      const hmac = createHmac("sha256", SB.TWILIO_AUTH_TOKEN);
      hmac.update(url + body);
      const sig = Buffer.from(hmac.digest()).toString("base64");

      const result = await resolveVerifiedCompany(ctx, { ...h, "x-twilio-signature": sig }, body, url);

      if (result && "companyId" in result) expect(result.companyId).toBe(B);
    });

    it.each([[A, B], [B, A]])("order $0,$1 independent", async ([first, second]) => {
      const ctx = createMockContext([first, second], {
        [A]: SA.TWILIO_AUTH_TOKEN,
        [B]: SB.TWILIO_AUTH_TOKEN,
      }) as unknown as PluginContext;

      const h = { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" };
      const url = "https://example.com/webhook";
      const body = "test=data";

      const hmac = createHmac("sha256", SA.TWILIO_AUTH_TOKEN);
      hmac.update(url + body);
      const sig = Buffer.from(hmac.digest()).toString("base64");

      const result = await resolveVerifiedCompany(ctx, { ...h, "x-twilio-signature": sig }, body, url);

      if (result && "companyId" in result) expect(result.companyId).toBe(A);
    });

    it("third-party token rejected", async () => {
      const ctx = createMockContext([A, B], { [A]: SA.TWILIO_AUTH_TOKEN, [B]: SB.TWILIO_AUTH_TOKEN }) as unknown as PluginContext;

      const h = { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" };
      const url = "https://example.com/webhook";
      const body = "test=data";

      const hmac = createHmac("sha256", "third-party-secret");
      hmac.update(url + body);
      const sig = Buffer.from(hmac.digest()).toString("base64");

      const result = await resolveVerifiedCompany(ctx, { ...h, "x-twilio-signature": sig }, body, url);

      expect(result).toEqual({ error: "bad_signature" });
    });
  });

  describe("telephonyToolHandler: run.companyId isolation", () => {
    it("uses run.companyId, ignores params.companyId", async () => {
      const rec = createSecretsRecorder();
      const ctx = {
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        companies: { list: vi.fn(async () => [{ id: A }, { id: B }]), get: vi.fn() },
        config: {
          get: vi.fn(async (co: string) => ({
            callerIds: co === A ? ["+27821111111"] : ["+27829999999"],
            voiceAllowedUserIds: [co === A ? "user-a" : "user-b"],
          })),
        },
        secrets: {
          resolve: vi.fn(async (n: string, opts: any) => {
            rec.record(n, opts.companyId);
            const s = opts.companyId === A ? SA : SB;
            return s[n as keyof typeof SA] ?? null;
          }),
        },
      } as unknown as PluginContext;

      const result = await telephonyToolHandler(ctx, { companyId: B }, { companyId: A } as ToolRunContext);

      expect(result.data.settings.callerIds).toEqual(["+27821111111"]);
      expect(result.data.settings.voiceAllowedUserIds).toEqual(["user-a"]);
      expect(rec.resolved.every((r) => r.companyId === A)).toBe(true);
    });
  });

  describe("secretStatus: per-company resolution", () => {
    it.each([A, B])("resolves only for $A", async (co) => {
      const rec = createSecretsRecorder();
      const ctx = createMockContext([A, B], {
        [A]: SA.TWILIO_AUTH_TOKEN,
        [B]: SB.TWILIO_AUTH_TOKEN,
      }) as unknown as PluginContext;

      (ctx.secrets.resolve as any).mockImplementation((n: string, opts: any) => {
        rec.record(n, opts.companyId);
        return opts.companyId === A ? Promise.resolve(SA.TWILIO_AUTH_TOKEN) : Promise.resolve(SB.TWILIO_AUTH_TOKEN);
      });

      const status = await secretStatus(ctx, co, ["TWILIO_AUTH_TOKEN"]);

      expect(status.TWILIO_AUTH_TOKEN).toBe("set");
      expect(rec.resolved).toEqual([{ secretName: "TWILIO_AUTH_TOKEN", companyId: co }]);
    });
  });
});
