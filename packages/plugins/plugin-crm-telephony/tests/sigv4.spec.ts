import { describe, it, expect } from "vitest";
import { signR2Headers, sha256Hex, signingKey } from "../src/sigv4.js";

describe("sha256Hex", () => {
  it("hashes string and bytes correctly", () => {
    expect(sha256Hex("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    expect(sha256Hex(Buffer.from("test"))).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});

describe("signingKey", () => {
  it("AWS documented example derivation", () => {
    const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
    expect(key.toString("hex")).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });
});

describe("signR2Headers", () => {
  it("includes all required headers", () => {
    const headers = signR2Headers({
      method: "PUT",
      host: "test.123456789.r2.cloudflarestorage.com",
      path: "/rec.wav",
      headers: { "content-type": "audio/wav" },
      payloadSha256: "abc123",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(headers["x-amz-date"]).toBeTruthy();
    expect(headers["x-amz-content-sha256"]).toBe("abc123");
    expect(headers["content-type"]).toBe("audio/wav");
  });

  it("includes x-amz-meta-sha256 in SignedHeaders", () => {
    const headers = signR2Headers({
      method: "PUT",
      host: "b.a.r2.cloudflarestorage.com",
      path: "/k",
      headers: { "x-amz-meta-sha256": "metasha" },
      payloadSha256: "p",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    const signed = headers.authorization.match(/SignedHeaders=([^,]+)/)?.[1] || "";
    expect(signed).toContain("x-amz-meta-sha256");
  });

  it("uses auto region by default", () => {
    const headers = signR2Headers({
      method: "PUT",
      host: "b.a.r2.cloudflarestorage.com",
      path: "/k",
      headers: {},
      payloadSha256: "p",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    expect(headers.authorization).toContain("/auto/s3/aws4_request");
  });

  it("deterministic: same input gives same signature", () => {
    const now = new Date("2025-10-13T12:00:00Z");
    const input = {
      method: "PUT" as const,
      host: "b.a.r2.cloudflarestorage.com",
      path: "/k",
      headers: { "x-amz-meta-sha256": "v1" },
      payloadSha256: "p",
      accessKeyId: "k",
      secretAccessKey: "s",
      now,
    };

    const h1 = signR2Headers(input);
    const h2 = signR2Headers(input);
    expect(h1.authorization).toBe(h2.authorization);
  });
});
