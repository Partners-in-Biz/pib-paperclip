/**
 * Test helpers for push notification tests.
 */

import crypto from "node:crypto";

/**
 * Generate a P-256 keypair for testing subscriber keys.
 */
export function generateP256Keys(): {
  privateKey: string;
  publicKey: string;
  p256dh: string;
  auth: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  // Export as JWK to get x, y coordinates
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const xBuffer = Buffer.from(publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const yBuffer = Buffer.from(publicKeyJwk.y.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), xBuffer, yBuffer]);
  const p256dh = uncompressedPoint.toString("base64url");

  // Generate 16-byte auth secret
  const auth = crypto.randomBytes(16).toString("base64url");

  // Store private key for later decryption
  const privateKeyJwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
  const dBuffer = Buffer.from(privateKeyJwk.d!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const privateKeyB64u = dBuffer.toString("base64url");

  return { privateKey: privateKeyB64u, publicKey: p256dh, p256dh, auth };
}

/**
 * Decrypt a push payload using RFC 8291.
 */
export function decryptPayload(
  encryptedBuffer: Buffer,
  subscriberPrivateKeyB64u: string,
  authSecretB64u: string
): string {
  // Decode keys
  const privateKeyBuffer = Buffer.from(
    subscriberPrivateKeyB64u + "=".repeat((4 - (subscriberPrivateKeyB64u.length % 4)) % 4),
    "base64url"
  );
  const authSecret = Buffer.from(authSecretB64u + "=".repeat((4 - (authSecretB64u.length % 4)) % 4), "base64url");

  // Parse encrypted payload
  const salt = encryptedBuffer.slice(0, 16);
  const rs = encryptedBuffer.readUInt32BE(16);
  const idlen = encryptedBuffer[20];
  const ephemeralPublic = encryptedBuffer.slice(21, 21 + idlen);
  const ciphertextAndTag = encryptedBuffer.slice(21 + idlen);

  if (ciphertextAndTag.length < 16) throw new Error("Ciphertext too short");

  const ciphertext = ciphertextAndTag.slice(0, -16);
  const authTag = ciphertextAndTag.slice(-16);

  // Recreate subscriber public key from private
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privateKeyBuffer);
  const subscriberPublic = ecdh.getPublicKey();

  // Compute shared secret
  const sharedSecret = Buffer.from(ecdh.computeSecret(ephemeralPublic));

  // Derive keys using HKDF
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), subscriberPublic, ephemeralPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, cekInfo, 16));

  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, nonceInfo, 12));

  // Decrypt
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Remove framing byte (0x02 at the end)
  if (plaintext[plaintext.length - 1] === 0x02) {
    return plaintext.slice(0, -1).toString("utf-8");
  }
  return plaintext.toString("utf-8");
}

