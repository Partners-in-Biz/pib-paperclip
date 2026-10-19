// RFC 8291 Web Push payload encryption.
// Implements aes128gcm content coding per RFC 8188 framing, ECDH key agreement, HKDF derivation.
// No key material is logged or stored after use.

import {
  createECDH,
  hkdfSync,
  createCipheriv,
  randomBytes,
} from "node:crypto";

export const MAX_PLAINTEXT_BYTES = 2048;

const RECORD_SIZE = 4096;

export function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export interface EncryptOptions {
  // 16 bytes of salt (RFC 8188). Only for testing against RFC vectors.
  salt?: Uint8Array;
  // 32-byte P-256 PRIVATE key (RFC test only; fresh key generated otherwise).
  ephemeralKey?: Uint8Array;
}

export function encryptPayload(
  plaintext: string | Uint8Array,
  p256dh: string | Uint8Array,
  auth: string | Uint8Array,
  opts?: EncryptOptions
): Buffer {
  const p256dhBuf = typeof p256dh === "string" ? decodeBase64Url(p256dh) : Buffer.from(p256dh);
  const authBuf = typeof auth === "string" ? decodeBase64Url(auth) : Buffer.from(auth);
  const plaintextBuf =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : Buffer.from(plaintext);

  if (plaintextBuf.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`Plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  if (authBuf.length !== 16) {
    throw new Error("Auth secret must be exactly 16 bytes");
  }
  if (p256dhBuf.length !== 65 || p256dhBuf[0] !== 0x04) {
    throw new Error("p256dh must be 65 bytes starting with 0x04");
  }

  const salt = opts?.salt ? Buffer.from(opts.salt) : randomBytes(16);
  if (salt.length !== 16) {
    throw new Error("Salt must be 16 bytes");
  }

  const ecdh = createECDH("prime256v1");
  let ephemeralPublic: Buffer;

  if (opts?.ephemeralKey) {
    const ephemeralKey = Buffer.from(opts.ephemeralKey);
    if (ephemeralKey.length !== 32) {
      throw new Error("Ephemeral key must be 32 bytes");
    }
    ecdh.setPrivateKey(ephemeralKey);
    ephemeralPublic = ecdh.getPublicKey();
  } else {
    ecdh.generateKeys();
    ephemeralPublic = ecdh.getPublicKey();
  }

  let sharedSecret: Buffer;
  try {
    sharedSecret = Buffer.from(ecdh.computeSecret(p256dhBuf));
  } catch {
    throw new Error("Invalid p256dh: failed to compute ECDH secret (not a valid curve point)");
  }

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    p256dhBuf,
    ephemeralPublic,
  ]);

  const ikm = Buffer.from(
    hkdfSync("sha256", sharedSecret, authBuf, keyInfo, 32)
  );

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, cekInfo, 16)
  );

  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, nonceInfo, 12)
  );

  const framedPlaintext = Buffer.concat([plaintextBuf, Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(framedPlaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const rs = Buffer.allocUnsafe(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const idlen = Buffer.from([ephemeralPublic.length]);

  return Buffer.concat([salt, rs, idlen, ephemeralPublic, ciphertext, authTag]);
}
