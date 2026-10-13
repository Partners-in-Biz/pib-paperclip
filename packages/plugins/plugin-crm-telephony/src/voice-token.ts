import { createHmac } from "node:crypto";

export interface VoiceTokenInput {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
  ttlSeconds?: number;
  nowSeconds?: number;
}

export function buildVoiceAccessToken(i: VoiceTokenInput): string {
  if (!i.identity) {
    throw new Error("identity cannot be empty");
  }

  const iat = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  let ttl = i.ttlSeconds ?? 3600;
  if (ttl < 1 || ttl > 3600) {
    ttl = 3600;
  }
  const exp = iat + ttl;

  // Header
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const headerEncoded = base64url(JSON.stringify(header));

  // Payload
  const payload = {
    jti: `${i.apiKeySid}-${iat}`,
    iss: i.apiKeySid,
    sub: i.accountSid,
    iat,
    exp,
    grants: {
      identity: i.identity,
      voice: {
        incoming: { allow: false },
        outgoing: { application_sid: i.twimlAppSid },
      },
    },
  };
  const payloadEncoded = base64url(JSON.stringify(payload));

  // Signature
  const data = `${headerEncoded}.${payloadEncoded}`;
  const signatureDigest = createHmac("sha256", i.apiKeySecret).update(data).digest();
  const signatureEncoded = base64url(signatureDigest);

  return `${data}.${signatureEncoded}`;
}

// Base64url encoding without padding
function base64url(input: string | Buffer): string {
  const base64 = typeof input === "string"
    ? Buffer.from(input, "utf8").toString("base64")
    : Buffer.from(input).toString("base64");
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
