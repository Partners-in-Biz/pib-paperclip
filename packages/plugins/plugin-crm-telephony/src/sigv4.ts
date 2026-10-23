import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: "PUT" | "HEAD";
  host: string;
  path: string; // already URI-encoded, starts with /
  headers: Record<string, string>; // extra headers to sign, lowercase names
  payloadSha256: string; // hex of body
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
  region?: string; // default "auto"
}

export function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

export function uriEncodePath(key: string): string {
  const parts = key.split("/");
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", "AWS4" + secret).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  return kSigning;
}

export function signR2Headers(i: SignInput): Record<string, string> {
  const region = i.region ?? "auto";
  const now = i.now ?? new Date();

  // Format timestamps
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  // Build canonical headers: host + all passed headers + x-amz-content-sha256 + x-amz-date
  const allHeaders: Record<string, string> = {
    host: i.host,
    ...i.headers,
    "x-amz-content-sha256": i.payloadSha256,
    "x-amz-date": amzDate,
  };

  // Sort header names lowercase
  const sortedHeaderNames = Object.keys(allHeaders)
    .map((k) => k.toLowerCase())
    .sort();

  // Canonical headers string: name:value\n for each sorted header
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${allHeaders[name]?.trim() ?? ""}`).join("\n") + "\n";

  // Signed headers: sorted lowercase header names
  const signedHeaders = sortedHeaderNames.join(";");

  // Canonical request
  const canonicalRequest = [i.method, i.path, "", canonicalHeaders, signedHeaders, i.payloadSha256].join("\n");

  // Hash canonical request
  const canonicalRequestHash = sha256Hex(canonicalRequest);

  // String to sign
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, canonicalRequestHash].join("\n");

  // Calculate signature
  const kSigning = signingKey(i.secretAccessKey, dateStamp, region, "s3");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  // Build authorization header
  const authHeader = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Return all headers to send
  return {
    host: i.host,
    ...i.headers,
    "x-amz-content-sha256": i.payloadSha256,
    "x-amz-date": amzDate,
    authorization: authHeader,
  };
}
