import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { safeFetch, safeFetchBytes } from "../src/safe-fetch.js";

describe("safeFetch and safeFetchBytes", () => {
  let ctx: PluginContext;
  let fetchCalls: { url: string; init: any }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    const mockFetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, init });

      // Handle file:// redirect (scheme violation)
      if (fetchCalls.length === 1 && url === "https://example.com/redirect-to-file") {
        return {
          status: 302,
          ok: false,
          headers: new Map([["location", "file:///etc/passwd"]]),
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      }

      // Handle ftp:// redirect (scheme violation)
      if (fetchCalls.length === 1 && url === "https://example.com/redirect-to-ftp") {
        return {
          status: 302,
          ok: false,
          headers: new Map([["location", "ftp://ftp.example.com/file"]]),
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      }

      // Handle relative redirect (should work)
      if (fetchCalls.length === 1 && url === "https://example.com/page") {
        return {
          status: 302,
          ok: false,
          headers: new Map([["location", "/final"]]),
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      }

      // Handle final response to relative redirect
      if (fetchCalls.length === 2 && url === "https://example.com/final") {
        return {
          status: 200,
          ok: true,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "success",
          arrayBuffer: async () => new TextEncoder().encode("success").buffer,
          body: null,
        };
      }

      // Default success response
      return {
        status: 200,
        ok: true,
        headers: new Map([["content-type", "application/octet-stream"]]),
        text: async () => "content",
        arrayBuffer: async () => new TextEncoder().encode("content").buffer,
        body: null,
      };
    });

    ctx = {
      http: { fetch: mockFetch },
    } as any;
  });

  it("safeFetch: redirect to file:// is rejected without second fetch", async () => {
    const promise = safeFetch(ctx, "https://example.com/redirect-to-file");
    await expect(promise).rejects.toThrow("Redirect to disallowed scheme: file:");
    // Should have only one fetch call (the first one that returned the file:// redirect)
    expect(fetchCalls).toHaveLength(1);
  });

  it("safeFetchBytes: redirect to ftp:// is rejected without second fetch", async () => {
    const promise = safeFetchBytes(ctx, "https://example.com/redirect-to-ftp");
    await expect(promise).rejects.toThrow("Redirect to disallowed scheme: ftp:");
    // Should have only one fetch call
    expect(fetchCalls).toHaveLength(1);
  });

  it("safeFetch: relative redirect resolves correctly", async () => {
    const result = await safeFetch(ctx, "https://example.com/page");
    expect(result.url).toBe("https://example.com/final");
    expect(result.redirects).toEqual(["https://example.com/page"]);
    expect(result.text).toBe("success");
    // Should have two fetch calls: first (redirect), second (final)
    expect(fetchCalls).toHaveLength(2);
  });

  it("safeFetchBytes: relative redirect resolves correctly", async () => {
    const result = await safeFetchBytes(ctx, "https://example.com/page");
    expect(result.url).toBe("https://example.com/final");
    expect(result.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(result.bytes)).toBe("success");
    // Should have two fetch calls
    expect(fetchCalls).toHaveLength(2);
  });

  it("safeFetchBytes: Content-Length header above maxBytes is rejected without reading body", async () => {
    const mockFetch = vi.fn(async (url: string, init: any) => {
      // Create a body that would throw if getReader is called
      const bodyTouched = new Error("Body stream was accessed when it should not have been");
      return {
        status: 200,
        ok: true,
        headers: new Map([
          ["content-type", "application/octet-stream"],
          ["content-length", "100000000"], // 100 MB, way over default 25 MiB
        ]),
        text: async () => {
          throw bodyTouched;
        },
        arrayBuffer: async () => {
          throw bodyTouched;
        },
        body: {
          getReader: () => {
            throw bodyTouched;
          },
        },
      } as any;
    });

    ctx.http.fetch = mockFetch as any;

    const promise = safeFetchBytes(ctx, "https://example.com/oversized");
    await expect(promise).rejects.toThrow(
      "Response exceeds maxBytes limit (100000000 > 26214400) fetching"
    );
    // Verify body was never read
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("safeFetchBytes: streamed body larger than maxBytes with NO Content-Length is rejected", async () => {
    let readerWasCancelled = false;

    const mockFetch = vi.fn(async (url: string, init: any) => {
      return {
        status: 200,
        ok: true,
        headers: new Map([["content-type", "application/octet-stream"]]),
        // No Content-Length header
        text: async () => "should not reach here",
        arrayBuffer: async () => new ArrayBuffer(0),
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              // First chunk is small, second is large to exceed limit
              if (!readerWasCancelled) {
                readerWasCancelled = true;
                return { done: false, value: new Uint8Array(1000) };
              }
              // Second read would return huge chunk but should not get here
              return { done: false, value: new Uint8Array(50000000) };
            }),
            releaseLock: vi.fn(() => {
              // Mark that lock was released (stream was cancelled)
            }),
          }),
        },
      } as any;
    });

    ctx.http.fetch = mockFetch as any;
    const maxBytes = 1024;

    const promise = safeFetchBytes(ctx, "https://example.com/stream-oversized", {
      maxBytes,
    });
    await expect(promise).rejects.toThrow(
      `Response exceeds maxBytes limit (streamed data > ${maxBytes})`
    );
  });

  it("safeFetchBytes: streamed body with lying (too-small) Content-Length is rejected", async () => {
    const mockFetch = vi.fn(async (url: string, init: any) => {
      return {
        status: 200,
        ok: true,
        headers: new Map([
          ["content-type", "application/octet-stream"],
          ["content-length", "100"], // Claims 100 bytes
        ]),
        text: async () => "should not reach here",
        arrayBuffer: async () => new ArrayBuffer(0),
        body: {
          getReader: () => ({
            read: vi.fn(async function (this: any) {
              // Return more data than Content-Length claimed
              const readCount = (this.read.mock.callCount || 0) + 1;
              if (readCount === 1) {
                return { done: false, value: new Uint8Array(50) };
              }
              if (readCount === 2) {
                return { done: false, value: new Uint8Array(75) }; // Total 125 > 100
              }
              return { done: true };
            }),
            releaseLock: vi.fn(),
          }),
        },
      } as any;
    });

    ctx.http.fetch = mockFetch as any;
    const maxBytes = 100;

    const promise = safeFetchBytes(ctx, "https://example.com/lying-content-length", {
      maxBytes,
    });
    await expect(promise).rejects.toThrow(
      `Response exceeds maxBytes limit (streamed data > ${maxBytes})`
    );
  });

  it("safeFetchBytes: body exactly maxBytes long succeeds and returns exact bytes", async () => {
    const maxBytes = 256;
    const exactData = new Uint8Array(maxBytes);
    // Fill with recognizable pattern
    for (let i = 0; i < maxBytes; i++) {
      exactData[i] = i % 256;
    }

    let readCallCount = 0;
    const mockFetch = vi.fn(async (url: string, init: any) => {
      return {
        status: 200,
        ok: true,
        headers: new Map([
          ["content-type", "application/octet-stream"],
          ["content-length", maxBytes.toString()],
        ]),
        text: async () => "should not reach here",
        arrayBuffer: async () => exactData.buffer,
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              readCallCount += 1;
              if (readCallCount === 1) {
                // Return all data in one chunk
                return { done: false, value: new Uint8Array(exactData) };
              }
              // Second call indicates we're done
              return { done: true };
            }),
            releaseLock: vi.fn(),
          }),
        },
      } as any;
    });

    ctx.http.fetch = mockFetch as any;

    const result = await safeFetchBytes(ctx, "https://example.com/exact-size", {
      maxBytes,
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/octet-stream");
    expect(result.bytes.length).toBe(maxBytes);
    expect(result.bytes).toEqual(exactData);
  });
});
