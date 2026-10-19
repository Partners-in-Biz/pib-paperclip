import { describe, it, expect } from "vitest";
import { createECDH, hkdfSync, createDecipheriv } from "node:crypto";
import {
  encryptPayload,
  decodeBase64Url,
  MAX_PLAINTEXT_BYTES,
} from "../src/push/encrypt.js";

// Decrypt helper for testing: uses recipient private key to recover plaintext
function decryptPayload(
  encrypted: Buffer,
  recipientPrivateKey: Buffer,
  authSecret: Buffer
): string {
  if (encrypted.length < 86) {
    throw new Error("Encrypted payload too short for header");
  }

  // Parse header
  const salt = encrypted.subarray(0, 16);
  const rs = encrypted.readUInt32BE(16);
  const idlen = encrypted[20];
  const ephemeralPublicKey = encrypted.subarray(21, 21 + idlen);
  const ciphertextAndTag = encrypted.subarray(21 + idlen);

  // ECDH: compute shared secret with recipient private key
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(recipientPrivateKey);
  const sharedSecret = Buffer.from(ecdh.computeSecret(ephemeralPublicKey));

  // Derive keys same as sender
  const recipientPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    recipientPublic,
    ephemeralPublicKey,
  ]);

  const ikm = Buffer.from(
    hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32)
  );

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, cekInfo, 16));

  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, nonceInfo, 12));

  // Separate ciphertext and tag (tag is last 16 bytes)
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

  // Decrypt
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(authTag);
  const framedPlaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  // Remove trailing delimiter (0x02)
  if (framedPlaintext[framedPlaintext.length - 1] !== 0x02) {
    throw new Error("Missing frame delimiter");
  }
  return framedPlaintext.subarray(0, framedPlaintext.length - 1).toString("utf-8");
}

describe("encryptPayload", () => {
  it("RFC 8291 Appendix A test vector", () => {
    // Test vectors from RFC 8291 Section 5 / Appendix A
    const plaintext = "When I grow up, I want to be a watermelon";

    const as_private = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const as_public =
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

    const ua_private = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";
    const salt = "DGv6ra1nlYgDCS1FRnbzlw";

    // Expected output from RFC Section 5
    const expected =
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    // Decrypt helper needs recipient private key
    const encrypted = encryptPayload(plaintext, ua_public, auth_secret, {
      salt: decodeBase64Url(salt),
      ephemeralKey: decodeBase64Url(as_private),
    });

    // Compare with expected (both as base64url for readability)
    expect(encrypted.toString("base64url")).toBe(expected);
  });

  it("RFC vector roundtrip: decrypt with ua_private", () => {
    const plaintext = "When I grow up, I want to be a watermelon";

    const as_private = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const ua_private = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";
    const salt = "DGv6ra1nlYgDCS1FRnbzlw";

    const encrypted = encryptPayload(plaintext, ua_public, auth_secret, {
      salt: decodeBase64Url(salt),
      ephemeralKey: decodeBase64Url(as_private),
    });

    const decrypted = decryptPayload(
      encrypted,
      decodeBase64Url(ua_private),
      decodeBase64Url(auth_secret)
    );

    expect(decrypted).toBe(plaintext);
  });

  it("round trip with fresh random salt and ephemeral key", () => {
    const plaintext = "Hello, World!";

    // Generate recipient key pair
    const recipientEcdh = createECDH("prime256v1");
    recipientEcdh.generateKeys();
    const recipientPrivate = recipientEcdh.getPrivateKey();
    const recipientPublic = recipientEcdh.getPublicKey();

    // Generate auth secret
    const auth = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      auth[i] = Math.floor(Math.random() * 256);
    }

    // Encrypt
    const encrypted = encryptPayload(plaintext, recipientPublic, auth);

    // Decrypt
    const decrypted = decryptPayload(encrypted, recipientPrivate, auth);

    expect(decrypted).toBe(plaintext);
  });

  it("two encryptions of same plaintext produce different ciphertexts (random salt/key)", () => {
    const plaintext = "Test message";
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    const encrypted1 = encryptPayload(plaintext, ua_public, auth_secret);
    const encrypted2 = encryptPayload(plaintext, ua_public, auth_secret);

    expect(encrypted1).not.toEqual(encrypted2);
  });

  it("plaintext of exactly MAX_PLAINTEXT_BYTES (2048) succeeds", () => {
    const plaintext = Buffer.alloc(MAX_PLAINTEXT_BYTES, "a");
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, ua_public, auth_secret)
    ).not.toThrow();
  });

  it("plaintext of 2049 bytes throws MAX_PLAINTEXT_BYTES error", () => {
    const plaintext = Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, "a");
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, ua_public, auth_secret)
    ).toThrow(/exceeds.*bytes/);
  });

  it("multi-byte UTF-8 is counted in bytes, not characters", () => {
    // "🎉" is 4 bytes in UTF-8
    const plaintext = "🎉".repeat(513); // 2052 bytes, exceeds 2048
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, ua_public, auth_secret)
    ).toThrow(/exceeds.*bytes/);

    // 512 * 4 = 2048 should work
    const plaintextValid = "🎉".repeat(512);
    expect(() =>
      encryptPayload(plaintextValid, ua_public, auth_secret)
    ).not.toThrow();
  });

  it("p256dh wrong length (64 bytes) throws", () => {
    const plaintext = "test";
    const p256dh = Buffer.alloc(64);
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, p256dh, auth_secret)
    ).toThrow(/p256dh must be 65 bytes/);
  });

  it("p256dh wrong prefix byte (not 0x04) throws", () => {
    const plaintext = "test";
    const p256dh = Buffer.alloc(65);
    p256dh[0] = 0x03; // wrong prefix
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, p256dh, auth_secret)
    ).toThrow(/p256dh must be 65 bytes starting with 0x04/);
  });

  it("p256dh off-curve point (all zeros except prefix) throws", () => {
    const plaintext = "test";
    const p256dh = Buffer.alloc(65);
    p256dh[0] = 0x04; // valid prefix but rest is zeros (not on curve)
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    expect(() =>
      encryptPayload(plaintext, p256dh, auth_secret)
    ).toThrow(/Invalid p256dh/);
  });

  it("auth secret 15 bytes throws", () => {
    const plaintext = "test";
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = Buffer.alloc(15);

    expect(() =>
      encryptPayload(plaintext, ua_public, auth_secret)
    ).toThrow(/Auth secret must be exactly 16 bytes/);
  });

  it("auth secret 17 bytes throws", () => {
    const plaintext = "test";
    const ua_public =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth_secret = Buffer.alloc(17);

    expect(() =>
      encryptPayload(plaintext, ua_public, auth_secret)
    ).toThrow(/Auth secret must be exactly 16 bytes/);
  });

  it("base64url string inputs for p256dh and auth work and match bytes", () => {
    const plaintext = "test";
    const ua_public_str =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const ua_public_buf = decodeBase64Url(ua_public_str);
    const auth_secret_str = "BTBZMqHH6r4Tts7J_aSIgg";
    const auth_secret_buf = decodeBase64Url(auth_secret_str);

    const encrypted1 = encryptPayload(plaintext, ua_public_str, auth_secret_str, {
      salt: Buffer.alloc(16, 0),
      ephemeralKey: Buffer.alloc(32, 1),
    });

    const encrypted2 = encryptPayload(plaintext, ua_public_buf, auth_secret_buf, {
      salt: Buffer.alloc(16, 0),
      ephemeralKey: Buffer.alloc(32, 1),
    });

    expect(encrypted1).toEqual(encrypted2);
  });

  it("error message for invalid p256dh does not contain key material", () => {
    const plaintext = "test";
    const p256dh = Buffer.alloc(65);
    p256dh[0] = 0x04;
    const auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";

    try {
      encryptPayload(plaintext, p256dh, auth_secret);
      expect.fail("Should have thrown");
    } catch (e) {
      const errorMsg = (e as Error).message;
      // Verify error message does not contain the hex representation of p256dh bytes
      expect(errorMsg).not.toContain("\x00");
      expect(errorMsg).not.toContain("\x04");
      // Should mention the problem without key details
      expect(errorMsg).toMatch(/Invalid p256dh|failed to compute|curve point/);
    }
  });
});
