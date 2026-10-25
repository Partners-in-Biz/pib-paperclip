import { describe, it, expect, vi } from "vitest";
import { recordingKey, r2Put, r2Head } from "../src/r2-store.js";

describe("recordingKey", () => {
  it("formats correctly with default and custom prefix", () => {
    expect(recordingKey({ prefix: "" }, "c1", "r1")).toBe("crm-telephony/recordings/c1/r1.wav");
    expect(recordingKey({ prefix: "custom" }, "c2", "r2")).toBe("custom/recordings/c2/r2.wav");
  });
});

describe("r2Put", () => {
  it("sends PUT with correct URL, method, and x-amz-meta-sha256", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await r2Put(
      { accountId: "acc", bucket: "bkt", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      new Uint8Array([1, 2]),
      "sha",
      fakeFetch
    );

    expect(fakeFetch.mock.calls.length).toBeGreaterThan(0);
    const call = fakeFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, opts] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://bkt.acc.r2.cloudflarestorage.com/key");
    expect(opts.method).toBe("PUT");
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-amz-meta-sha256"]).toBe("sha");
  });

  it("includes authorization header with AWS4-HMAC-SHA256", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await r2Put(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      new Uint8Array(),
      "sha",
      fakeFetch
    );

    const call = fakeFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [, opts] = call as unknown as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("throws without leaking secret on error", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 500 }));
    try {
      await r2Put(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "verysecret", prefix: "p" },
        "key",
        new Uint8Array(),
        "sha",
        fakeFetch
      );
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).toBe("R2 PUT failed: HTTP 500");
      expect((e as Error).message).not.toContain("verysecret");
    }
  });
});

describe("r2Head", () => {
  it("returns bytes and sha256 on success", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": "1024", "x-amz-meta-sha256": "ABC" },
        })
    );

    const result = await r2Head(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      fakeFetch
    );

    expect(result).toEqual({ bytes: 1024, sha256: "abc" });
    expect(fakeFetch.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns null on 404, throws on 403", async () => {
    const fetch404 = vi.fn(async () => new Response(null, { status: 404 }));
    expect(
      await r2Head(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "key",
        fetch404
      )
    ).toBeNull();

    const fetch403 = vi.fn(async () => new Response(null, { status: 403 }));
    try {
      await r2Head(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "key",
        fetch403
      );
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).toBe("R2 HEAD failed: HTTP 403");
    }
  });

  it("returns null sha256 when header missing", async () => {
    const fakeFetch = vi.fn(
      async () => new Response(null, { status: 200, headers: { "content-length": "512" } })
    );

    const result = await r2Head(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      fakeFetch
    );

    expect(result).toEqual({ bytes: 512, sha256: null });
  });
});
