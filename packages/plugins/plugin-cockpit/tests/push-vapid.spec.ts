import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildVapidAuthorization, generateVapidKeyPair, signVapidJwt } from "../src/push/vapid.js";

function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("VAPID JWT (S1)", () => {
  it("generates a valid EC P-256 keypair", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();

    // Decode to check format
    const pubBuffer = base64urlDecode(publicKey);
    const privBuffer = base64urlDecode(privateKey);

    // Public key should be 65 bytes starting with 0x04 (uncompressed point)
    expect(pubBuffer.length).toBe(65);
    expect(pubBuffer[0]).toBe(0x04);

    // Private key should be 32 bytes (d scalar)
    expect(privBuffer.length).toBe(32);
  });

  it("signs a JWT with correct header and claims", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();
    const now = new Date("2026-01-01T12:00:00.000Z").getTime();
    const endpoint = "https://fcm.googleapis.com/fcm/send/xyz";
    const subject = "mailto:push@example.com";

    const jwt = signVapidJwt({
      endpoint,
      subject,
      publicKey,
      privateKey,
      now,
      ttlSeconds: 3600,
    });

    // JWT should have 3 parts separated by dots
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode header
    const headerBuffer = base64urlDecode(parts[0]);
    const header = JSON.parse(headerBuffer.toString());
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    // Decode payload
    const payloadBuffer = base64urlDecode(parts[1]);
    const payload = JSON.parse(payloadBuffer.toString());
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe(subject);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 3600);
  });

  it("verifies JWT signature with the public key", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();
    const endpoint = "https://updates.push.services.mozilla.com/push/v1/xyz";
    const subject = "https://example.com";

    const jwt = signVapidJwt({
      endpoint,
      subject,
      publicKey,
      privateKey,
      now: Date.now(),
      ttlSeconds: 7200,
    });

    const [headerEnc, payloadEnc, signatureEnc] = jwt.split(".");
    const signature = base64urlDecode(signatureEnc);

    // Reconstruct public key from base64url
    const pubBuffer = base64urlDecode(publicKey);
    const x = pubBuffer.slice(1, 33);
    const y = pubBuffer.slice(33, 65);

    const publicKeyJwk = {
      kty: "EC",
      crv: "P-256",
      x: base64urlEncode(x),
      y: base64urlEncode(y),
    };

    const publicKeyObject = crypto.createPublicKey({ key: publicKeyJwk, format: "jwk" });

    // Verify signature using createVerify for EC keys
    const message = `${headerEnc}.${payloadEnc}`;
    const verifier = crypto.createVerify("sha256");
    verifier.update(message);
    const isValid = verifier.verify({ key: publicKeyObject, dsaEncoding: "ieee-p1363" }, signature);
    expect(isValid).toBe(true);
  });

  it("extracts origin only from endpoint URL", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();
    const now = Date.now();

    const endpoint1 = "https://fcm.googleapis.com/fcm/send/xyz?abc=def";
    const endpoint2 = "https://fcm.googleapis.com/different/path/123";

    const jwt1 = signVapidJwt({
      endpoint: endpoint1,
      subject: "mailto:x@y.com",
      publicKey,
      privateKey,
      now,
    });

    const jwt2 = signVapidJwt({
      endpoint: endpoint2,
      subject: "mailto:x@y.com",
      publicKey,
      privateKey,
      now,
    });

    // Both should have the same aud since it's origin-only
    const parts1 = jwt1.split(".");
    const parts2 = jwt2.split(".");

    const payload1 = JSON.parse(base64urlDecode(parts1[1]).toString());
    const payload2 = JSON.parse(base64urlDecode(parts2[1]).toString());

    expect(payload1.aud).toBe("https://fcm.googleapis.com");
    expect(payload2.aud).toBe("https://fcm.googleapis.com");
    expect(payload1.aud).toBe(payload2.aud);
  });

  it("defaults exp to 12 hours from now", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();
    const now = 1000000; // ms

    const jwt = signVapidJwt({
      endpoint: "https://example.com/push",
      subject: "mailto:x@y.com",
      publicKey,
      privateKey,
      now,
    });

    const payload = JSON.parse(base64urlDecode(jwt.split(".")[1]).toString());
    const expectedExp = Math.floor(now / 1000) + 12 * 3600;
    expect(payload.exp).toBe(expectedExp);
  });

  it("clamps TTL to max 12 hours", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();
    const now = 1000000;

    const jwt = signVapidJwt({
      endpoint: "https://example.com/push",
      subject: "mailto:x@y.com",
      publicKey,
      privateKey,
      now,
      ttlSeconds: 24 * 3600, // Try to set 24 hours
    });

    const payload = JSON.parse(base64urlDecode(jwt.split(".")[1]).toString());
    const expectedExp = Math.floor(now / 1000) + 12 * 3600; // Should be clamped
    expect(payload.exp).toBe(expectedExp);
  });

  it("throws on invalid subject (must start with mailto: or https://)", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "invalid-subject",
        publicKey,
        privateKey,
      });
    }).toThrow();

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "http://example.com",
        publicKey,
        privateKey,
      });
    }).toThrow();
  });

  it("throws on invalid key sizes", () => {
    const shortKey = "AA"; // Too short

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "mailto:x@y.com",
        publicKey: shortKey,
        privateKey: shortKey,
      });
    }).toThrow();
  });

  it("throws on invalid TTL (zero, negative, or non-finite)", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "mailto:x@y.com",
        publicKey,
        privateKey,
        ttlSeconds: 0,
      });
    }).toThrow();

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "mailto:x@y.com",
        publicKey,
        privateKey,
        ttlSeconds: -1,
      });
    }).toThrow();

    expect(() => {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "mailto:x@y.com",
        publicKey,
        privateKey,
        ttlSeconds: Infinity,
      });
    }).toThrow();
  });

  it("builds Authorization header with correct format", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();

    const auth = buildVapidAuthorization({
      endpoint: "https://example.com/push",
      subject: "mailto:x@y.com",
      publicKey,
      privateKey,
    });

    expect(auth).toMatch(/^vapid t=[\w\-_.]+\.[\w\-_.]+\.[\w\-_.]+, k=[\w\-_]+$/);

    const [jwtPart, keyPart] = auth.split(", ");
    expect(jwtPart.startsWith("vapid t=")).toBe(true);
    expect(keyPart.startsWith("k=")).toBe(true);
    expect(keyPart.slice(2)).toBe(publicKey);
  });

  it("does not include key material in error messages", () => {
    const { publicKey, privateKey } = generateVapidKeyPair();

    try {
      signVapidJwt({
        endpoint: "https://example.com/push",
        subject: "invalid",
        publicKey,
        privateKey,
      });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(publicKey);
      expect(msg).not.toContain(privateKey);
    }
  });
});
