import { describe, it, expect, vi } from "vitest";
import { r2Delete, r2List } from "../src/r2-store.js";
import { signR2Headers, sha256Hex } from "../src/sigv4.js";

describe("r2Delete", () => {
  it("sends DELETE with correct URL and method", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await r2Delete(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      fakeFetch
    );

    const call = fakeFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, opts] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://b.a.r2.cloudflarestorage.com/key");
    expect(opts.method).toBe("DELETE");
  });

  it("returns success on 204, 200, 404", async () => {
    for (const status of [204, 200, 404]) {
      const fakeFetch = vi.fn(async () => new Response(null, { status }));
      await expect(
        r2Delete(
          { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
          "key",
          fakeFetch
        )
      ).resolves.toBeUndefined();
    }
  });

  it("throws on other status codes", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      r2Delete(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "key",
        fakeFetch
      )
    ).rejects.toThrow("R2 DELETE failed: HTTP 500");
  });

  it("includes authorization header", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await r2Delete(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "key",
      fakeFetch
    );

    const call = fakeFetch.mock.calls[0];
    const [, opts] = call as unknown as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });
});

describe("r2List", () => {
  function makeFetch(responses: Array<{ body: string; status: number }>) {
    let index = 0;
    return async (input: any, init?: RequestInit) => {
      const resp = responses[index];
      index++;
      return new Response(resp.body, { status: resp.status });
    };
  }

  it("lists single page correctly", async () => {
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test</Name>
  <Prefix>p/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>p/file1.txt</Key>
  </Contents>
  <Contents>
    <Key>p/file2.txt</Key>
  </Contents>
</ListBucketResult>`;

    const fakeFetch = vi.fn(makeFetch([{ body: xmlBody, status: 200 }]));
    const keys = await r2List(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "p/",
      fakeFetch
    );

    expect(keys).toEqual(["p/file1.txt", "p/file2.txt"]);
  });

  it("paginates with continuation token", async () => {
    const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>p/file1.txt</Key></Contents>
  <NextContinuationToken>token123</NextContinuationToken>
</ListBucketResult>`;

    const page2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>p/file2.txt</Key></Contents>
</ListBucketResult>`;

    const fakeFetch = vi.fn(makeFetch([{ body: page1, status: 200 }, { body: page2, status: 200 }]));
    const keys = await r2List(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "p/",
      fakeFetch
    );

    expect(keys).toEqual(["p/file1.txt", "p/file2.txt"]);

    // Check that second request includes continuation-token
    const call1 = fakeFetch.mock.calls[0];
    const call2 = fakeFetch.mock.calls[1];
    expect(call1[0]).toContain("list-type=2");
    expect(call2[0]).toContain("continuation-token=token123");
  });

  it("includes Authorization header with SignedHeaders in GET requests", async () => {
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

    const fakeFetch = vi.fn(makeFetch([{ body: xmlBody, status: 200 }]));
    await r2List(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "p/",
      fakeFetch
    );

    const call = fakeFetch.mock.calls[0];
    const [, opts] = call as unknown as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(headers.authorization).toContain("SignedHeaders=");
  });

  it("decodes XML entities", async () => {
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>p/file&amp;name.txt</Key></Contents>
  <Contents><Key>p/file&lt;tag&gt;.txt</Key></Contents>
  <Contents><Key>p/file&quot;quoted&quot;.txt</Key></Contents>
</ListBucketResult>`;

    const fakeFetch = vi.fn(makeFetch([{ body: xmlBody, status: 200 }]));
    const keys = await r2List(
      { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
      "p/",
      fakeFetch
    );

    expect(keys).toEqual([
      'p/file&name.txt',
      'p/file<tag>.txt',
      'p/file"quoted".txt',
    ]);
  });

  it("rejects empty prefix", async () => {
    const fakeFetch = vi.fn();
    await expect(
      r2List(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "",
        fakeFetch
      )
    ).rejects.toThrow("r2List prefix must be a non-empty path ending with /");
  });

  it("rejects bare slash", async () => {
    const fakeFetch = vi.fn();
    await expect(
      r2List(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "/",
        fakeFetch
      )
    ).rejects.toThrow("r2List prefix must be a non-empty path ending with /");
  });

  it("throws on HTTP error", async () => {
    const fakeFetch = vi.fn(makeFetch([{ body: "", status: 500 }]));
    await expect(
      r2List(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "p/",
        fakeFetch
      )
    ).rejects.toThrow("R2 LIST failed: HTTP 500");
  });

  it("throws when exceeding 20 pages", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => ({
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>p/file${i}.txt</Key></Contents>
  <NextContinuationToken>token${i}</NextContinuationToken>
</ListBucketResult>`,
      status: 200,
    }));

    const fakeFetch = vi.fn(makeFetch(pages));
    await expect(
      r2List(
        { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "p" },
        "p/",
        fakeFetch
      )
    ).rejects.toThrow("R2 LIST exceeded 20 pages");
  });
});

describe("signR2Headers backward compatibility", () => {
  it("PUT signature unchanged with fixed now (with empty query string in canonical request)", () => {
    const now = new Date("2025-10-13T12:00:00Z");
    const sig = signR2Headers({
      method: "PUT",
      host: "b.a.r2.cloudflarestorage.com",
      path: "/k",
      headers: { "x-amz-meta-sha256": "v1" },
      payloadSha256: "p",
      accessKeyId: "k",
      secretAccessKey: "s",
      now,
    });

    // The signature changed because the canonical request now includes empty query string
    expect(sig.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=k/20251013/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=3fe84b88de2aa207abefbbed14d79c6eab1d84c24387d7cb788648e78252a74e"
    );
  });
});
