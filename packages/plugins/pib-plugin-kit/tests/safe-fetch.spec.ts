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
});
