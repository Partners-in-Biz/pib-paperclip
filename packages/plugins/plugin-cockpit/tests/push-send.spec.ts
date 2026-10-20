import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendPush, type PushPayload } from "../src/push/send.js";
import { MAX_PLAINTEXT_BYTES } from "../src/push/encrypt.js";

describe("sendPush", () => {
  let mockCtx: any;
  let mockPostPush: any;

  const vapidPublicKey = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk0ZjnQaFhcEApkTUpULsqnVEXJsy
4UVPIOoSjrahIS+dTGL0sCtiUtH0JRV0sxUGR+YJ4ZwUUgOBosvLK0tj9g==
-----END PUBLIC KEY-----`;

  const vapidPrivateKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgegQaYaYAma1DxXA1
tYHCSsKnVx7P0JM7umfTC+JraAShRANCAASTRmOdBoWFwQCmRNSlQuyqdURcmzLh
RU8g6hKOtqEhL51MYvSwK2JS0fQlFXSzFQZH5gnhnBRSA4Giy8srS2P2
-----END PRIVATE KEY-----`;

  beforeEach(() => {
    mockPostPush = vi.fn(async () => ({ status: 201 }));

    mockCtx = {
      config: {
        get: vi.fn(async () => ({ pushEnabled: true, vapidSubject: "mailto:test@example.com" })),
      },
      db: {
        execute: vi.fn(async () => ({ rowCount: 1 })),
        query: vi.fn(async () => [{ public_key: vapidPublicKey, private_key: vapidPrivateKey }]),
      },
    };
  });

  describe("disabled when pushEnabled is false", () => {
    it("returns disabled:true with no network calls when pushEnabled=false", async () => {
      mockCtx.config.get = vi.fn(async () => ({ pushEnabled: false }));

      const subs = [
        {
          id: "sub1",
          userId: "user1",
          endpoint: "https://fcm.googleapis.com/push/test",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Test Device",
          state: "ok" as const,
        },
      ];

      const payload: PushPayload = {
        title: "Test",
        body: "Test body",
        url: "/test",
        tag: "test-tag",
        class: "critical",
      };

      const result = await sendPush(mockCtx, "company1", subs, payload, {
        class: "critical",
        deps: { postPush: mockPostPush },
      });

      expect(result.disabled).toBe(true);
      expect(result.devices).toHaveLength(0);
      expect(mockPostPush).not.toHaveBeenCalled();
    });

    it("returns disabled:true when pushEnabled is unset", async () => {
      mockCtx.config.get = vi.fn(async () => ({}));

      const subs = [
        {
          id: "sub1",
          userId: "user1",
          endpoint: "https://fcm.googleapis.com/push/test",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Test Device",
          state: "ok" as const,
        },
      ];

      const payload: PushPayload = {
        title: "Test",
        body: "Test body",
        url: "/test",
        tag: "test-tag",
        class: "critical",
      };

      const result = await sendPush(mockCtx, "company1", subs, payload, {
        class: "critical",
        deps: { postPush: mockPostPush },
      });

      expect(result.disabled).toBe(true);
      expect(mockPostPush).not.toHaveBeenCalled();
    });
  });

  describe("payload validation", () => {
    it("throws when payload exceeds 2 KB", async () => {
      const subs = [
        {
          id: "sub1",
          userId: "user1",
          endpoint: "https://fcm.googleapis.com/push/test",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Test Device",
          state: "ok" as const,
        },
      ];

      const largeBody = "x".repeat(2500);
      const payload: PushPayload = {
        title: "Test",
        body: largeBody,
        url: "/test",
        tag: "test-tag",
        class: "critical",
      };

      await expect(
        sendPush(mockCtx, "company1", subs, payload, {
          class: "critical",
          deps: { postPush: mockPostPush },
        })
      ).rejects.toThrow(/exceeds 2048 bytes/);
    });
  });

  describe("device filtering", () => {
    it("skips muted devices without rate slot", async () => {
      const subs = [
        {
          id: "muted1",
          userId: "user1",
          endpoint: "https://fcm.googleapis.com/push/muted",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Muted Device",
          state: "muted" as const,
        },
      ];

      const payload: PushPayload = {
        title: "Test",
        body: "Test body",
        url: "/test",
        tag: "test-tag",
        class: "needs_you",
      };

      const result = await sendPush(mockCtx, "company1", subs, payload, {
        class: "needs_you",
        deps: { postPush: mockPostPush },
      });

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].outcome).toBe("skipped_muted");
      expect(mockPostPush).not.toHaveBeenCalled();
    });

    it("refuses endpoints not in allow-list without rate slot and calls setSubscriptionState", async () => {
      const mockSetSubscriptionState = vi.fn();
      mockCtx.db.execute = vi.fn(async (query: string) => {
        if (query.includes("UPDATE") && query.includes("state")) {
          mockSetSubscriptionState();
        }
        return { rowCount: 1 };
      });

      const subs = [
        {
          id: "bad1",
          userId: "user1",
          endpoint: "https://bad-host.example.com/push",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Bad Endpoint",
          state: "ok" as const,
        },
      ];

      const payload: PushPayload = {
        title: "Test",
        body: "Test body",
        url: "/test",
        tag: "test-tag",
        class: "needs_you",
      };

      const result = await sendPush(mockCtx, "company1", subs, payload, {
        class: "needs_you",
        deps: { postPush: mockPostPush },
      });

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].outcome).toBe("refused");
      expect(mockPostPush).not.toHaveBeenCalled();
      expect(mockSetSubscriptionState).toHaveBeenCalled();
    });
  });

  describe("rate limiting", () => {
    it("caps when rate limit exceeded for non-critical with appendPushLog", async () => {
      const mockAppendPushLog = vi.fn();
      mockCtx.db.execute = vi.fn(async (query: string) => {
        if (query.includes("INSERT") && query.includes("push_log")) {
          mockAppendPushLog();
        }
        if (query.includes("UPDATE") && query.includes("push_rate")) {
          return { rowCount: 0 }; // Rate limit exceeded
        }
        return { rowCount: 1 };
      });

      const subs = [
        {
          id: "sub1",
          userId: "user1",
          endpoint: "https://fcm.googleapis.com/push/test",
          p256dh: "BOx1XBqKMl8QzAUGhXO8w8f8xpq6OuSI7InhGvV_P_tZHYKKgS6UIL-BUg7qnWwZW7MdV1sCCrmVXI_8bZzVGQ8",
          auth: "m6yd1iqpALXV1f2OEPkPEQ",
          deviceLabel: "Test Device",
          state: "ok" as const,
        },
      ];

      const payload: PushPayload = {
        title: "Test",
        body: "Test body",
        url: "/test",
        tag: "test-tag",
        class: "needs_you",
      };

      const result = await sendPush(mockCtx, "company1", subs, payload, {
        class: "needs_you",
        deps: { postPush: mockPostPush },
      });

      expect(result.capped).toBe(true);
      expect(result.devices).toHaveLength(0);
      expect(mockPostPush).not.toHaveBeenCalled();
      expect(mockAppendPushLog).toHaveBeenCalled();
    });
  });

});
