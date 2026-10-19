import { describe, expect, it, vi } from "vitest";
import {
  getOrCreateVapidKey,
  getVapidPublicKey,
  PushKeyError,
  publicOnly,
  VAPID_SUBJECT,
  type PushKeyStore,
  type VapidKeyRecord,
} from "../src/push/keys.js";

describe("Push VAPID keys (S4)", () => {
  it("VAPID_SUBJECT is the expected mailto", () => {
    expect(VAPID_SUBJECT).toBe("mailto:cockpit@partnersinbiz.online");
  });

  it("generates a new key on first call when hasSubscriptions=false", async () => {
    let stored: VapidKeyRecord | null = null;
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (record) => {
        stored = record;
      }),
    };

    const key = await getOrCreateVapidKey(store, { hasSubscriptions: () => false });

    expect(key.publicKey).toBeTruthy();
    expect(key.privateKey).toBeTruthy();
    expect(key.publicKey).toMatch(/^[\w\-_]+$/); // base64url
    expect(key.privateKey).toMatch(/^[\w\-_]+$/);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it("returns existing key unchanged on second call", async () => {
    const stored: VapidKeyRecord = {
      publicKey: "AAAA",
      privateKey: "BBBB",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async () => undefined),
    };

    const key = await getOrCreateVapidKey(store, { hasSubscriptions: () => false });

    expect(key).toEqual({ publicKey: "AAAA", privateKey: "BBBB" });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("throws key_lost if key missing and hasSubscriptions=true", async () => {
    const store: PushKeyStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
    };

    await expect(getOrCreateVapidKey(store, { hasSubscriptions: () => true })).rejects.toThrow(PushKeyError);
    await expect(getOrCreateVapidKey(store, { hasSubscriptions: () => true })).rejects.toMatchObject({
      code: "key_lost",
    });
  });

  it("serializes 10 concurrent first calls into one write", async () => {
    let writeCount = 0;
    let stored: VapidKeyRecord | null = null;
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (record) => {
        writeCount++;
        stored = record;
      }),
    };

    const keys = await Promise.all(
      Array.from({ length: 10 }, () => getOrCreateVapidKey(store, { hasSubscriptions: () => false }))
    );

    // All 10 calls should return the same key
    expect(new Set(keys.map((k) => k.publicKey)).size).toBe(1);
    expect(writeCount).toBe(1);
  });

  it("does not poison the chain on write failure; second call succeeds", async () => {
    const store1: PushKeyStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error("write failed");
      }),
    };

    // First call fails on write
    await expect(getOrCreateVapidKey(store1, { hasSubscriptions: () => false })).rejects.toThrow("write failed");

    // Second call should succeed (not poisoned) - uses a different store that doesn't fail
    let stored: VapidKeyRecord | null = null;
    const store2: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (record) => {
        stored = record;
      }),
    };
    const key = await getOrCreateVapidKey(store2, { hasSubscriptions: () => false });
    expect(key.publicKey).toBeTruthy();
    expect(key.privateKey).toBeTruthy();
  });

  it("read-after-write returns the stored value", async () => {
    let stored: VapidKeyRecord | null = null;
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (record) => {
        stored = record;
      }),
    };

    const result = await getOrCreateVapidKey(store, { hasSubscriptions: () => false });

    expect(result.publicKey).toBe(stored!.publicKey);
    expect(result.privateKey).toBe(stored!.privateKey);
  });

  it("read-after-write with another writer winning returns the stored record", async () => {
    let stored: VapidKeyRecord | null = null;
    const store: PushKeyStore = {
      read: vi.fn(async () => {
        // Simulate another worker having written a different key
        if (stored === null) return null;
        return stored;
      }),
      write: vi.fn(async (record) => {
        // On write, replace with a different key (simulating a race)
        stored = {
          publicKey: "WINNER_PUB",
          privateKey: "WINNER_PRIV",
          createdAt: "2026-01-01T00:00:00.000Z",
        };
      }),
    };

    const result = await getOrCreateVapidKey(store, { hasSubscriptions: () => false });

    // Should return the stored (winning) key, not the generated one
    expect(result.publicKey).toBe("WINNER_PUB");
    expect(result.privateKey).toBe("WINNER_PRIV");
  });

  it("getVapidPublicKey returns only the public key", async () => {
    const stored: VapidKeyRecord = {
      publicKey: "PUB123",
      privateKey: "PRIV123",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async () => undefined),
    };

    const pub = await getVapidPublicKey(store);
    expect(pub).toBe("PUB123");
  });

  it("getVapidPublicKey throws key_missing on empty store", async () => {
    const store: PushKeyStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
    };

    await expect(getVapidPublicKey(store)).rejects.toThrow("VAPID key not found");
    await expect(getVapidPublicKey(store)).rejects.toMatchObject({ code: "key_missing" });
  });

  it("publicOnly redacts the private key", () => {
    const record: VapidKeyRecord = {
      publicKey: "PUB",
      privateKey: "SECRET",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const result = publicOnly(record);
    expect(result).toEqual({ publicKey: "PUB", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(result).not.toHaveProperty("privateKey");
  });

  it("serialization handles async hasSubscriptions()", async () => {
    let stored: VapidKeyRecord | null = null;
    const store: PushKeyStore = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (record) => {
        stored = record;
      }),
    };

    const key = await getOrCreateVapidKey(store, {
      hasSubscriptions: async () => false,
    });

    expect(key.publicKey).toBeTruthy();
    expect(key.privateKey).toBeTruthy();
  });
});
