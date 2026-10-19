import { describe, expect, it, beforeEach, vi } from "vitest";
import { subscribe, send, type SpikeActionDeps, type StoredSubscription } from "../src/push/spike-actions.js";
import { PushKeyError } from "../src/push/keys.js";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { VAPID_SUBJECT } from "../src/push/keys.js";

/** Create a fake VAPID keypair for testing. */
function fakeKeyPair() {
  return {
    publicKey: "BDjGpb-qxGO5HfyRz8j5xJNmD3v2_3d_hgx4_J0f5k=",
    privateKey: "sQOCuWKSZ7Y8X6V9_fD7aE9c3e5F0gH2iJ4kL6mN8o=",
  };
}

/** Create a fake 65-byte p256dh (EC public key). */
function fakeP256dh(): string {
  const buf = Buffer.alloc(65);
  buf[0] = 0x04;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Create a fake 16-byte auth secret. */
function fakeAuth(): string {
  return Buffer.alloc(16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Create a mock endpoint that passes validation. */
function mockEndpoint(variant = 0): string {
  return `https://fcm.googleapis.com/fcm/send/endpoint${variant}`;
}

/** Create a minimal fake store and deps for testing. */
function createFakeDeps(
  initState: Record<string, unknown> = {},
  postPushOverride?: () => Promise<{ status: number }>
): { deps: SpikeActionDeps; getState: () => Record<string, unknown> } {
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
    },
    getState: () => state,
  };
}

describe("Push spike actions", () => {
  describe("subscribe", () => {
    it("rejects non-allowlisted endpoint", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "user", userId: "user1" };

      await expect(
        subscribe(deps, { endpoint: "https://evil.com/push" }, actor)
      ).rejects.toMatchObject({ code: "endpoint_not_allowed" });
    });

    it("rejects bad p256dh", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "user", userId: "user1" };

      await expect(
        subscribe(deps, { endpoint: mockEndpoint(), p256dh: "invalid!@#", auth: fakeAuth() }, actor)
      ).rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("rejects bad auth", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "user", userId: "user1" };

      await expect(
        subscribe(deps, { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: "tooshort" }, actor)
      ).rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("user A cannot alter user B's subscription", async () => {
      const keyPair = fakeKeyPair();
      const userB = { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "Device B" };
      const { deps, getState } = createFakeDeps({
        subs: { user2: [userB as any] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });

      const actor = { type: "user", userId: "user1" };
      await subscribe(deps, { endpoint: mockEndpoint(1), p256dh: fakeP256dh(), auth: fakeAuth(), label: "Device A" }, actor);

      const state = getState();
      expect((state.subs as any).user1).toHaveLength(1);
      expect((state.subs as any).user2).toHaveLength(1);
    });

    it("returns key_lost when no key and subscriptions exist", async () => {
      const { deps } = createFakeDeps({ subs: { user2: [{ endpoint: mockEndpoint() }] } });
      (deps.keyStore.read as any) = vi.fn(async () => null);

      const actor = { type: "user", userId: "user1" };

      await expect(
        subscribe(deps, { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth() }, actor)
      ).rejects.toMatchObject({ code: "key_lost" });
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

      const actor = { type: "user", userId: "user1" };
      const result = await subscribe(
        deps,
        { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "First" },
        actor
      );

      expect(result.ok).toBe(true);
      expect(result.subscriptions).toBe(1);
      expect(deps.keyStore.write).toHaveBeenCalled();
    });

    it("returns publicKey without endpoint", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({ key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() } });

      const actor = { type: "user", userId: "user1" };
      const result = await subscribe(deps, {}, actor);

      expect(result.ok).toBe(true);
      expect(result.publicKey).toBeTruthy();
      expect(result).not.toHaveProperty("subscriptions");
    });
  });

  describe("send", () => {
    it("rejects if no subscriptions exist", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "user", userId: "user1" };

      await expect(send(deps, {}, actor)).rejects.toMatchObject({ code: "no_subscription" });
    });

    it("user A cannot send to user B's subscriptions", async () => {
      const userB = { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "Device B", createdAt: new Date().toISOString() };
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user2: [userB] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      deps.keyStore.read = vi.fn(async () => (deps.keyStore as any).__returnValue ?? null);

      const actor = { type: "user", userId: "user1" };

      await expect(send(deps, {}, actor)).rejects.toMatchObject({ code: "no_subscription" });
    });

    it("send returns a device entry for each subscription", async () => {
      const sub = { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "Device", createdAt: new Date().toISOString() };
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user1: [sub] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });

      const actor = { type: "user", userId: "user1" };
      const result = await send(deps, {}, actor);

      expect(result).toHaveProperty("devices");
      expect(Array.isArray(result.devices)).toBe(true);
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].label).toBe("Device");
    });

    it("never logs private key, JWT, or auth in errors", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const sub = { endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "Device", createdAt: new Date().toISOString() };
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user1: [sub] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      (deps.postPush as any) = vi.fn(async () => ({ status: 201 }));

      const actor = { type: "user", userId: "user1" };

      try {
        await send(deps, { url: "/test" }, actor);
      } catch (e) {
        const err = e as Error;
        expect(err.message).not.toContain(keyPair.privateKey);
        expect(err.message).not.toContain(sub.auth);
      }

      consoleSpy.mockRestore();
    });

    it("multiple subscriptions are all sent to", async () => {
      const { deps, getState } = createFakeDeps({
        subs: {
          user1: [
            { endpoint: mockEndpoint(1), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D1", createdAt: new Date().toISOString() },
            { endpoint: mockEndpoint(2), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D2", createdAt: new Date().toISOString() },
          ],
        },
        key: { publicKey: fakeKeyPair().publicKey, privateKey: fakeKeyPair().privateKey, createdAt: new Date().toISOString() },
      });

      const actor = { type: "user", userId: "user1" };
      const result = await send(deps, {}, actor);

      expect(result.devices).toHaveLength(2);
      expect(result.devices[0].label).toBe("D1");
      expect(result.devices[1].label).toBe("D2");
    });
  });

  describe("concurrency", () => {
    it("concurrent subscribe calls with same endpoint update once", async () => {
      const keyPair = fakeKeyPair();
      const { deps, getState } = createFakeDeps({
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });

      const actor = { type: "user", userId: "user1" };
      const endpoint = mockEndpoint();
      const p256dh = fakeP256dh();
      const auth = fakeAuth();

      const [r1, r2] = await Promise.all([
        subscribe(deps, { endpoint, p256dh, auth, label: "D1" }, actor),
        subscribe(deps, { endpoint, p256dh, auth, label: "D2" }, actor),
      ]);

      expect((getState().subs as any).user1).toHaveLength(1);
      expect(r1.subscriptions).toBe(1);
      expect(r2.subscriptions).toBe(1);
    });
  });

  describe("non-user actors", () => {
    it("subscribe rejects agents", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "agent" } as any;

      await expect(subscribe(deps, {}, actor)).rejects.toMatchObject({ code: "not_user" });
    });

    it("send rejects agents", async () => {
      const { deps } = createFakeDeps();
      const actor = { type: "agent" } as any;

      await expect(send(deps, {}, actor)).rejects.toMatchObject({ code: "not_user" });
    });
  });
});
