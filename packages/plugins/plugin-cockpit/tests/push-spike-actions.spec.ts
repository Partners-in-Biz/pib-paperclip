import { describe, expect, it, vi } from "vitest";
import { subscribe, type SpikeActionDeps } from "../src/push/spike-actions.js";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { generateVapidKeyPair } from "../src/push/vapid.js";
import { createECDH, randomBytes } from "node:crypto";

const fakeKeyPair = () => generateVapidKeyPair();
const mockEndpoint = (v = 0) => `https://fcm.googleapis.com/fcm/send/endpoint${v}`;

function createRealSubscriptionKeyPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString("base64url");
  const auth = randomBytes(16).toString("base64url");
  return { p256dh, p256dhPrivate: ecdh.getPrivateKey(), auth, authSecret: Buffer.from(auth, "base64url") };
}

function createFakeDeps(initState: Record<string, unknown> = {}, postPushOverride?: (e: string, h: Record<string, string>, b: Buffer) => Promise<{ status: number }>) {
  const state = { ...initState };
  const postPushFn = postPushOverride ?? (async () => ({ status: 201 }));
  return {
    deps: {
      keyStore: {
        read: vi.fn(async () => {
          const key = (state as any).key;
          return key ? { publicKey: key.publicKey, privateKey: key.privateKey, createdAt: key.createdAt } : null;
        }),
        write: vi.fn(async (record) => {
          (state as any).key = record;
        }),
      },
      stateReader: vi.fn(async (key: ScopeKey) => {
        if (key.stateKey === "subs") return (state as any).subs ?? null;
        return null;
      }),
      stateWriter: vi.fn(async (key: ScopeKey, value: unknown) => {
        if (key.stateKey === "subs") (state as any).subs = value;
      }),
      postPush: postPushFn as any,
    } as SpikeActionDeps,
    getState: () => state,
  };
}

describe("Push spike actions", () => {
  const createSub = (variant: number) => {
    const keys = createRealSubscriptionKeyPair();
    return { endpoint: mockEndpoint(variant), p256dh: keys.p256dh, auth: keys.auth, label: `D${variant}`, createdAt: new Date().toISOString() };
  };

  describe("subscribe", () => {
    it("rejects non-allowlisted endpoint", async () => {
      const { deps } = createFakeDeps();
      await expect(subscribe(deps, { endpoint: "https://evil.com/push" }, { type: "user", userId: "user1" }))
        .rejects.toMatchObject({ code: "endpoint_not_allowed" });
    });

    it("rejects bad p256dh", async () => {
      const { deps } = createFakeDeps();
      const { auth } = createRealSubscriptionKeyPair();
      await expect(subscribe(deps, { endpoint: mockEndpoint(), p256dh: "invalid!@#", auth }, { type: "user", userId: "user1" }))
        .rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("rejects bad auth", async () => {
      const { deps } = createFakeDeps();
      const { p256dh } = createRealSubscriptionKeyPair();
      await expect(subscribe(deps, { endpoint: mockEndpoint(), p256dh, auth: "tooshort" }, { type: "user", userId: "user1" }))
        .rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("user A cannot alter user B's subscription", async () => {
      const keyPair = fakeKeyPair();
      const { deps, getState } = createFakeDeps({
        subs: { user2: [createSub(1)] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      const sub = createSub(0);
      await subscribe(deps, { ...sub }, { type: "user", userId: "user1" });
      const state = getState();
      expect((state.subs as any).user1).toHaveLength(1);
      expect((state.subs as any).user2).toHaveLength(1);
    });

    it("returns key_lost when no key and subscriptions exist", async () => {
      const { deps } = createFakeDeps({ subs: { user2: [{ endpoint: mockEndpoint() }] } });
      (deps.keyStore.read as any) = vi.fn(async () => null);
      const keys = createRealSubscriptionKeyPair();
      await expect(subscribe(deps, { endpoint: mockEndpoint(), p256dh: keys.p256dh, auth: keys.auth }, { type: "user", userId: "user1" }))
        .rejects.toMatchObject({ code: "key_lost" });
    });

    it("creates key once on first subscribe", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps();
      (deps.keyStore.read as any) = vi.fn(async () => null);
      (deps.keyStore.write as any) = vi.fn(async () => {
        (deps.keyStore.read as any) = vi.fn(async () => ({
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          createdAt: new Date().toISOString(),
        }));
      });
      const keys = createRealSubscriptionKeyPair();
      const result = await subscribe(deps, { endpoint: mockEndpoint(), p256dh: keys.p256dh, auth: keys.auth, label: "First" }, { type: "user", userId: "user1" });
      expect(result.ok).toBe(true);
      expect(result.subscriptions).toBe(1);
      expect(deps.keyStore.write).toHaveBeenCalled();
    });

    it("returns publicKey without endpoint", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({ key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() } });
      const result = await subscribe(deps, {}, { type: "user", userId: "user1" });
      expect(result.ok).toBe(true);
      expect(result.publicKey).toBeTruthy();
      expect(result).not.toHaveProperty("subscriptions");
    });
  });

  describe("concurrency", () => {
    it("concurrent subscribe calls with same endpoint update once", async () => {
      const keyPair = fakeKeyPair();
      const { deps, getState } = createFakeDeps({
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      const endpoint = mockEndpoint();
      const keys = createRealSubscriptionKeyPair();
      const [r1, r2] = await Promise.all([
        subscribe(deps, { endpoint, p256dh: keys.p256dh, auth: keys.auth, label: "D1" }, { type: "user", userId: "user1" }),
        subscribe(deps, { endpoint, p256dh: keys.p256dh, auth: keys.auth, label: "D2" }, { type: "user", userId: "user1" }),
      ]);
      expect((getState().subs as any).user1).toHaveLength(1);
      expect(r1.subscriptions).toBe(1);
      expect(r2.subscriptions).toBe(1);
    });
  });

  describe("non-user actors", () => {
    it("subscribe rejects agents", async () => {
      const { deps } = createFakeDeps();
      await expect(subscribe(deps, {}, { type: "agent" } as any)).rejects.toMatchObject({ code: "not_user" });
    });
  });
});
