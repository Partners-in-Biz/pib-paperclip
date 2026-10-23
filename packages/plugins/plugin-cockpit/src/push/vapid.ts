import crypto from "node:crypto";

/**
 * Generate a VAPID keypair for Web Push.
 * Returns the public and private keys in base64url format.
 * - publicKey: 65-byte uncompressed point (0x04 || x || y)
 * - privateKey: 32-byte private scalar (d)
 */
export function generateVapidKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  // Export public key as JWK to get x, y coordinates
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;

  // Decode x and y from base64url
  const xBuffer = Buffer.from(publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const yBuffer = Buffer.from(publicKeyJwk.y.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  // Construct uncompressed point: 0x04 || x || y
  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), xBuffer, yBuffer]);

  // Extract private key as JWK and get the d value
  const privateKeyJwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
  if (!privateKeyJwk.d) {
    throw new Error("Failed to extract private key d component");
  }

  // Decode base64url d to get the 32-byte private scalar
  const dBuffer = Buffer.from(privateKeyJwk.d.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (dBuffer.length !== 32) {
    throw new Error("Invalid private key d component length");
  }

  // Encode to base64url
  const publicKeyB64u = base64urlEncode(uncompressedPoint);
  const privateKeyB64u = base64urlEncode(dBuffer);

  return {
    publicKey: publicKeyB64u,
    privateKey: privateKeyB64u,
  };
}

/**
 * Sign a VAPID JWT using ES256.
 * RFC 8292 specifies the JWT format for VAPID.
 * CRITICAL: Callers must gate this endpoint with isAllowedPushEndpoint (from ./hosts) before signing.
 *
 * @param opts Configuration for signing
 * @param opts.endpoint The push service endpoint URL
 * @param opts.subject The VAPID subject (must start with "mailto:" or "https://")
 * @param opts.publicKey The base64url-encoded public key
 * @param opts.privateKey The base64url-encoded private key
 * @param opts.now Current time (Date or milliseconds). Defaults to Date.now().
 * @param opts.ttlSeconds TTL in seconds. Defaults to 12 hours, clamped to max 12 hours.
 * @returns The signed JWT
 */
export function signVapidJwt(opts: {
  endpoint: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  now?: Date | number;
  ttlSeconds?: number;
}): string {
  const now = typeof opts.now === "number" ? opts.now : (opts.now || new Date()).getTime();
  let ttlSeconds = opts.ttlSeconds ?? 12 * 3600;

  // Validate TTL
  if (ttlSeconds <= 0 || !isFinite(ttlSeconds)) {
    throw new Error("TTL must be a positive finite number");
  }
  if (ttlSeconds > 12 * 3600) {
    ttlSeconds = 12 * 3600;
  }

  // Validate subject
  if (!opts.subject.startsWith("mailto:") && !opts.subject.startsWith("https://")) {
    throw new Error("Subject must start with 'mailto:' or 'https://'");
  }

  // Validate and decode keys
  let publicKeyBuffer: Buffer;
  let privateKeyBuffer: Buffer;
  try {
    publicKeyBuffer = base64urlDecode(opts.publicKey);
    privateKeyBuffer = base64urlDecode(opts.privateKey);
  } catch (e) {
    throw new Error("Invalid base64url encoding in keys");
  }

  if (publicKeyBuffer.length !== 65) {
    throw new Error("Public key must be 65 bytes");
  }
  if (publicKeyBuffer[0] !== 0x04) {
    throw new Error("Public key must start with 0x04");
  }
  if (privateKeyBuffer.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }

  // Extract x and y from public key
  const x = publicKeyBuffer.slice(1, 33);
  const y = publicKeyBuffer.slice(33, 65);

  // Create private key object from JWK
  const privateKeyJwk = {
    kty: "EC",
    crv: "P-256",
    d: base64urlEncode(privateKeyBuffer),
    x: base64urlEncode(x),
    y: base64urlEncode(y),
  };

  const privateKeyObject = crypto.createPrivateKey({ key: privateKeyJwk, format: "jwk" });

  // Build header and payload
  const header = { typ: "JWT", alg: "ES256" };
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const aud = new URL(opts.endpoint).origin;
  const payload = {
    aud,
    exp,
    sub: opts.subject,
  };

  // Encode header and payload
  const headerEncoded = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const payloadEncoded = base64urlEncode(Buffer.from(JSON.stringify(payload)));

  // Sign using createSign for better control
  const message = `${headerEncoded}.${payloadEncoded}`;
  const signer = crypto.createSign("sha256");
  signer.update(message);
  const signature = signer.sign({
    key: privateKeyObject,
    dsaEncoding: "ieee-p1363",
  });

  const signatureEncoded = base64urlEncode(signature);

  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

/**
 * Build a VAPID Authorization header value.
 */
export function buildVapidAuthorization(opts: {
  endpoint: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  now?: Date | number;
  ttlSeconds?: number;
}): string {
  const jwt = signVapidJwt(opts);
  return `vapid t=${jwt}, k=${opts.publicKey}`;
}

/**
 * Encode a buffer to base64url (RFC 4648) without padding.
 */
function base64urlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Decode a base64url (RFC 4648) string to a buffer.
 */
function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
