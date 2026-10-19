import { describe, expect, it, vi } from "vitest";
import { subscribe, send, type SpikeActionDeps } from "../src/push/spike-actions.js";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import { VAPID_SUBJECT } from "../src/push/keys.js";
import { generateVapidKeyPair } from "../src/push/vapid.js";
import { createECDH, hkdfSync, createDecipheriv, randomBytes } from "node:crypto";
import { decodeBase64Url } from "../src/push/encrypt.js";

const fakeKeyPair = () => generateVapidKeyPair();
const mockEndpoint = (v = 0) => `https://fcm.googleapis.com/fcm/send/endpoint${v}`;

function createRealSubscriptionKeyPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString("base64url");
  const auth = randomBytes(16).toString("base64url");
  return { p256dh, p256dhPrivate: ecdh.getPrivateKey(), auth, authSecret: Buffer.from(auth, "base64url") };
}

function decryptPayload(encrypted: Buffer, recipientPrivateKey: Buffer, authSecret: Buffer): string {
  if (encrypted.length < 86) throw new Error("Encrypted payload too short for header");
  const salt = encrypted.subarray(0, 16);
  const idlen = encrypted[20];
  const ephemeralPublicKey = encrypted.subarray(21, 21 + idlen);
  const ciphertextAndTag = encrypted.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(recipientPrivateKey);
  const sharedSecret = Buffer.from(ecdh.computeSecret(ephemeralPublicKey));
  const recipientPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), recipientPublic, ephemeralPublicKey]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(authTag);
  const framedPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (framedPlaintext[framedPlaintext.length - 1] !== 0x02) throw new Error("Missing frame delimiter");
  return framedPlaintext.subarray(0, framedPlaintext.length - 1).toString("utf-8");
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

  describe("send", () => {
    it("rejects if no subscriptions exist", async () => {
      const { deps } = createFakeDeps();
      await expect(send(deps, {}, { type: "user", userId: "user1" })).rejects.toMatchObject({ code: "no_subscription" });
    });

    it("user A cannot send to user B's subscriptions", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user2: [createSub(1)] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      await expect(send(deps, {}, { type: "user", userId: "user1" })).rejects.toMatchObject({ code: "no_subscription" });
    });

    it("send returns a device entry for each subscription", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user1: [createSub(1)] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      const result = await send(deps, {}, { type: "user", userId: "user1" });
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].label).toBe("D1");
    });

    it("never logs private key, JWT, or auth in errors", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const keyPair = fakeKeyPair();
      const sub = createSub(1);
      const { deps } = createFakeDeps({
        subs: { user1: [sub] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      (deps.postPush as any) = vi.fn(async () => ({ status: 201 }));
      try {
        await send(deps, { url: "/test" }, { type: "user", userId: "user1" });
      } catch (e) {
        const err = e as Error;
        expect(err.message).not.toContain(keyPair.privateKey);
        expect(err.message).not.toContain(sub.auth);
      }
      consoleSpy.mockRestore();
    });

    it("multiple subscriptions are all sent to", async () => {
      const keyPair = fakeKeyPair();
      const { deps } = createFakeDeps({
        subs: { user1: [createSub(1), createSub(2)] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      const result = await send(deps, {}, { type: "user", userId: "user1" });
      expect(result.devices).toHaveLength(2);
    });

    it.each<[number, number, string, boolean]>([[0, 404, "not_found", true], [1, 410, "gone", true], [2, 401, "key_mismatch", false], [3, 403, "key_mismatch", false]])
      ("postPush %i: %i -> %s (delete=%s)", async (idx, status, error, shouldDelete) => {
        const keyPair = fakeKeyPair();
        const subs = [createSub(1), createSub(2), createSub(3), createSub(4)];
        const { deps, getState } = createFakeDeps({
          subs: { user1: subs },
          key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
        });
        let callCount = 0;
        (deps.postPush as any) = vi.fn(async () => {
          callCount++;
          return { status: callCount === idx + 1 ? status : 201 };
        });
        const result = await send(deps, {}, { type: "user", userId: "user1" });
        expect(result.devices[idx].error).toBe(error);
        const remaining = (getState().subs as any).user1;
        if (shouldDelete) {
          expect(remaining.map((s: any) => s.endpoint)).not.toContain(mockEndpoint(idx + 1));
        } else {
          const updated = remaining.find((s: any) => s.endpoint === mockEndpoint(idx + 1));
          expect(updated.needsResubscribe).toBe(true);
        }
      });

    it("encrypted body decrypts to {title, url}", async () => {
      const keyPair = fakeKeyPair();
      const subKeys = createRealSubscriptionKeyPair();
      const { deps } = createFakeDeps({
        subs: { user1: [{ endpoint: mockEndpoint(), p256dh: subKeys.p256dh, auth: subKeys.auth, label: "D1", createdAt: new Date().toISOString() }] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      let capturedBody: Buffer | null = null;
      (deps.postPush as any) = vi.fn(async (_e: string, _h: any, body: Buffer) => {
        capturedBody = body;
        return { status: 201 };
      });
      await send(deps, { url: "/issues/par-123" }, { type: "user", userId: "user1" });
      expect(capturedBody).not.toBeNull();
      const plaintext = decryptPayload(capturedBody!, subKeys.p256dhPrivate, subKeys.authSecret);
      const payload = JSON.parse(plaintext);
      expect(payload.title).toBe("Push test");
      expect(payload.url).toBe("/issues/par-123");
    });

    it("send with missing key and existing subscriptions fails key_lost", async () => {
      const { deps, getState } = createFakeDeps({ subs: { user1: [createSub(1)] } });
      (deps.keyStore.read as any) = vi.fn(async () => null);
      await expect(send(deps, {}, { type: "user", userId: "user1" })).rejects.toMatchObject({ code: "key_lost" });
      expect((getState().subs as any).user1).toHaveLength(1);
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

    it("send (410/401) concurrent with subscribe: all three handled correctly", async () => {
      const keyPair = fakeKeyPair();
      const { deps, getState } = createFakeDeps({
        subs: { user1: [createSub(1), createSub(2)] },
        key: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, createdAt: new Date().toISOString() },
      });
      let sendCallCount = 0;
      (deps.postPush as any) = vi.fn(async () => {
        sendCallCount++;
        return { status: sendCallCount === 1 ? 410 : 401 };
      });
      const newSubKeys = createRealSubscriptionKeyPair();
      const [sendResult, subResult] = await Promise.all([
        send(deps, {}, { type: "user", userId: "user1" }),
        subscribe(deps, { endpoint: mockEndpoint(3), p256dh: newSubKeys.p256dh, auth: newSubKeys.auth, label: "D3" }, { type: "user", userId: "user1" }),
      ]);
      const state = getState();
      expect((state.subs as any).user1).toHaveLength(2);
      const endpoints = (state.subs as any).user1.map((s: any) => s.endpoint);
      expect(endpoints).toContain(mockEndpoint(2));
      expect(endpoints).toContain(mockEndpoint(3));
      expect((state.subs as any).user1.find((s: any) => s.endpoint === mockEndpoint(2)).needsResubscribe).toBe(true);
      expect(subResult.subscriptions).toBe(2);
    });
  });

  describe("non-user actors", () => {
    it.each(["subscribe", "send"] as const)("%s rejects agents", async (action) => {
      const { deps } = createFakeDeps();
      const fn = action === "subscribe" ? subscribe : send;
      await expect(fn(deps, {}, { type: "agent" } as any)).rejects.toMatchObject({ code: "not_user" });
    });
  });
});
