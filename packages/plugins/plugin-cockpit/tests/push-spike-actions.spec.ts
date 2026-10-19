import { describe, expect, it, beforeEach, vi, test } from "vitest";
import { subscribe, send, type SpikeActionDeps, type StoredSubscription } from "../src/push/spike-actions.js";
import { PushKeyError } from "../src/push/keys.js";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { VAPID_SUBJECT } from "../src/push/keys.js";
import { createECDH, hkdfSync, createDecipheriv } from "node:crypto";
import { decodeBase64Url } from "../src/push/encrypt.js";

/** Create a fake VAPID keypair for testing. */
function fakeKeyPair() {
  return {
    publicKey: "BDjGpb-qxGO5HfyRz8j5xJNmD3v2_3d_hgx4_J0f5k=",
    privateKey: "sQOCuWKSZ7Y8X6V9_fD7aE9c3e5F0gH2iJ4kL6mN8o=",
  };
}

/** Create a valid p256dh (EC public key) for testing. */
function fakeP256dh(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  return pub.toString("base64url");
}

/** Create a fake 16-byte auth secret. */
function fakeAuth(): string {
  return Buffer.alloc(16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Create a mock endpoint that passes validation. */
function mockEndpoint(variant = 0): string {
  return `https://fcm.googleapis.com/fcm/send/endpoint${variant}`;
}

/** Decrypt payload for testing (uses recipient private key). */
function decryptPayload(
  encrypted: Buffer,
  recipientPrivateKey: Buffer,
  authSecret: Buffer
): string {
  if (encrypted.length < 86) throw new Error("Encrypted payload too short for header");
  const salt = encrypted.subarray(0, 16);
  const rs = encrypted.readUInt32BE(16);
  const idlen = encrypted[20];
  const ephemeralPublicKey = encrypted.subarray(21, 21 + idlen);
  const ciphertextAndTag = encrypted.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(recipientPrivateKey);
  const sharedSecret = Buffer.from(ecdh.computeSecret(ephemeralPublicKey));
  const recipientPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), recipientPublic, ephemeralPublicKey]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, cekInfo, 16));
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, nonceInfo, 12));
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(authTag);
  const framedPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (framedPlaintext[framedPlaintext.length - 1] !== 0x02) throw new Error("Missing frame delimiter");
  return framedPlaintext.subarray(0, framedPlaintext.length - 1).toString("utf-8");
}

/** Create a minimal fake store and deps for testing. */
function createFakeDeps(
  initState: Record<string, unknown> = {},
  postPushOverride?: (endpoint: string, headers: Record<string, string>, body: Buffer) => Promise<{ status: number }>
): { deps: SpikeActionDeps; getState: () => Record<string, unknown> } {
  const state = { ...initState };
  const postPushFn = postPushOverride ?? (async (_endpoint: string, _headers: Record<string, string>, _body: Buffer) => ({ status: 201 }));

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

    it("postPush 404/410 deletes subscription; 401/403 sets needsResubscribe", async () => {
      const keyPair = fakeKeyPair();
      const sub1 = { endpoint: mockEndpoint(1), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D1", createdAt: new Date().toISOString() };
      const sub2 = { endpoint: mockEndpoint(2), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D2", createdAt: new Date().toISOString() };
      const sub3 = { endpoint: mockEndpoint(3), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D3", createdAt: new Date().toISOString() };
      const sub4 = { endpoint: mockEndpoint(4), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D4", createdAt: new Date().toISOString() };

      for (const [subIndex, expectedStatus, expectedError, shouldDelete] of [[0, 404, "not_found", true], [1, 410, "gone", true], [2, 401, "key_mismatch", false], [3, 403, "key_mismatch", false]] as const) {
        const { deps: testDeps, getState: testGetState } = createFakeDeps({
          subs: { user1: [sub1, sub2, sub3, sub4] },
          key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
        });
        let callCount = 0;
        (testDeps.postPush as any) = vi.fn(async () => {
          callCount++;
          return { status: callCount === subIndex + 1 ? expectedStatus : 201 };
        });

        const actor = { type: "user", userId: "user1" };
        const result = await send(testDeps, {}, actor);

        expect(result.devices[subIndex].error).toBe(expectedError);
        const state = testGetState() as any;
        const remaining = (state.subs as any).user1;
        if (shouldDelete) {
          expect(remaining).not.toContainEqual(expect.objectContaining({ endpoint: [mockEndpoint(1), mockEndpoint(2), mockEndpoint(3), mockEndpoint(4)][subIndex] }));
        } else {
          const updated = remaining.find((s: any) => s.endpoint === [mockEndpoint(1), mockEndpoint(2), mockEndpoint(3), mockEndpoint(4)][subIndex]);
          expect(updated.needsResubscribe).toBe(true);
        }
      }
    });

    it("encrypted body decrypts to {title, url}", async () => {
      const keyPair = fakeKeyPair();
      const p256dhStr = fakeP256dh();
      const p256dhBuf = decodeBase64Url(p256dhStr);
      const authStr = fakeAuth();
      const authBuf = decodeBase64Url(authStr);

      const { deps } = createFakeDeps({
        subs: {
          user1: [
            {
              endpoint: mockEndpoint(),
              p256dh: p256dhStr,
              auth: authStr,
              label: "D1",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });

      let capturedBody: Buffer | null = null;
      (deps.postPush as any) = vi.fn(async (_endpoint: string, _headers: any, body: Buffer) => {
        capturedBody = body;
        return { status: 201 };
      });

      const actor = { type: "user", userId: "user1" };
      await send(deps, { url: "/issues/par-123" }, actor);

      expect(capturedBody).not.toBeNull();
      const plaintext = decryptPayload(capturedBody!, p256dhBuf, authBuf);
      const payload = JSON.parse(plaintext);
      expect(payload.title).toBe("Push test");
      expect(payload.url).toBe("/issues/par-123");
    });

    it("send with missing key and existing subscriptions fails key_lost", async () => {
      const { deps, getState } = createFakeDeps({
        subs: { user1: [{ endpoint: mockEndpoint(), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D1", createdAt: new Date().toISOString() }] },
      });
      (deps.keyStore.read as any) = vi.fn(async () => null);

      const actor = { type: "user", userId: "user1" };
      await expect(send(deps, {}, actor)).rejects.toMatchObject({ code: "key_lost" });

      const state = getState();
      expect((state.subs as any).user1).toHaveLength(1);
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

    it("send (410/401) concurrent with subscribe: all three handled correctly", async () => {
      const keyPair = fakeKeyPair();
      const sub1 = { endpoint: mockEndpoint(1), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D1", createdAt: new Date().toISOString() };
      const sub2 = { endpoint: mockEndpoint(2), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D2", createdAt: new Date().toISOString() };
      const { deps, getState } = createFakeDeps({
        subs: { user1: [sub1, sub2] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });

      let sendCallCount = 0;
      (deps.postPush as any) = vi.fn(async () => {
        sendCallCount++;
        return { status: sendCallCount === 1 ? 410 : 401 };
      });

      const actor = { type: "user", userId: "user1" };
      const newSub = { endpoint: mockEndpoint(3), p256dh: fakeP256dh(), auth: fakeAuth(), label: "D3" };

      const [sendResult, subResult] = await Promise.all([
        send(deps, {}, actor),
        subscribe(deps, newSub, actor),
      ]);

      const state = getState();
      expect((state.subs as any).user1).toHaveLength(2);
      const endpoints = (state.subs as any).user1.map((s: any) => s.endpoint);
      expect(endpoints).toContain(mockEndpoint(2));
      expect(endpoints).toContain(mockEndpoint(3));
      const sub2State = (state.subs as any).user1.find((s: any) => s.endpoint === mockEndpoint(2));
      expect(sub2State.needsResubscribe).toBe(true);
      expect(subResult.subscriptions).toBe(2);
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
