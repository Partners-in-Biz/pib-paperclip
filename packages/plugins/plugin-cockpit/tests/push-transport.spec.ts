import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  isPrivateAddress,
  postPush,
  PushTransportError,
  type PushTransportDeps,
} from "../src/push/transport.js";

function createMockResponse(statusCode: number, headers: Record<string, any>) {
  const res = new PassThrough() as any;
  res.statusCode = statusCode;
  res.headers = headers;
  return res;
}

describe("isPrivateAddress", () => {
  describe("IPv4", () => {
    it("returns true for private ranges", () => {
      expect(isPrivateAddress("127.0.0.1")).toBe(true);
      expect(isPrivateAddress("10.1.2.3")).toBe(true);
      expect(isPrivateAddress("172.16.0.1")).toBe(true);
      expect(isPrivateAddress("192.168.1.1")).toBe(true);
      expect(isPrivateAddress("169.254.169.254")).toBe(true);
      expect(isPrivateAddress("0.0.0.0")).toBe(true);
      expect(isPrivateAddress("100.64.0.1")).toBe(true);
      expect(isPrivateAddress("224.0.0.1")).toBe(true);
    });

    it("returns false for public addresses", () => {
      expect(isPrivateAddress("8.8.8.8")).toBe(false);
      expect(isPrivateAddress("142.250.1.1")).toBe(false);
    });
  });

  describe("IPv6", () => {
    it("returns true for link-local, ULA, multicast", () => {
      expect(isPrivateAddress("::1")).toBe(true);
      expect(isPrivateAddress("::")).toBe(true);
      expect(isPrivateAddress("fe80::1")).toBe(true);
      expect(isPrivateAddress("fc00::1")).toBe(true);
      expect(isPrivateAddress("ff02::1")).toBe(true);
    });

    it("returns true for IPv4-compatible ::a.b.c.d", () => {
      expect(isPrivateAddress("::7f00:1")).toBe(true); // ::127.0.0.1
      expect(isPrivateAddress("::127.0.0.1")).toBe(true);
    });

    it("returns true for IPv4-mapped ::ffff:a.b.c.d", () => {
      expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
      expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    });

    it("returns false for IPv4-mapped public addresses", () => {
      expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
      expect(isPrivateAddress("::ffff:808:808")).toBe(false);
    });

    it("returns true for 0::/8 unless exception", () => {
      expect(isPrivateAddress("::808:808")).toBe(true);
      expect(isPrivateAddress("12:0:0:0:0:ffff:808:808")).toBe(true); // groups[0] != 0: not IPv4-mapped
    });

    it("returns true for NAT64 64:ff9b::/96 with private IPv4", () => {
      expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    });

    it("returns false for NAT64 with public IPv4", () => {
      expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
    });

    it("returns true for invalid NAT64 (groups[5] != 0)", () => {
      expect(isPrivateAddress("64:ff9b::1:808:808")).toBe(true); // groups[5] = 1, not 0
    });

    it("returns true for 6to4 2002::/16 with private IPv4", () => {
      expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
    });

    it("returns false for 6to4 with public IPv4", () => {
      expect(isPrivateAddress("2002:0808:0808::")).toBe(false);
    });

    it("returns false for public IPv6", () => {
      expect(isPrivateAddress("2607:f8b0:4004:800::200e")).toBe(false);
    });

    it("returns true for invalid/zone ID", () => {
      expect(isPrivateAddress("not-an-ip")).toBe(true);
      expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    });
  });
});

describe("postPush", () => {
  it("rejects disallowed endpoints", async () => {
    await expect(postPush("http://fcm.googleapis.com/push", {}, Buffer.alloc(0))).rejects.toMatchObject({
      code: "endpoint_not_allowed",
    });
  });

  it("rejects private addresses", async () => {
    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    };
    await expect(postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps)).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("rejects oversized body", async () => {
    await expect(postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(4097))).rejects.toMatchObject({
      code: "body_too_large",
    });
  });

  it("sets correct request options", { timeout: 10000 }, async () => {
    let capturedOptions: any;
    const requestFn = vi.fn((options, callback) => {
      capturedOptions = options;
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      const res = createMockResponse(201, {});
      callback(res);
      setTimeout(() => res.end(), 20);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    await postPush("https://fcm.googleapis.com/push/token", {}, Buffer.alloc(0), deps);

    expect(capturedOptions.host).toBe("142.250.1.1");
    expect(capturedOptions.servername).toBe("fcm.googleapis.com");
    expect(capturedOptions.path).toBe("/push/token");
  });

  it("round-trips body bytes", { timeout: 10000 }, async () => {
    let capturedBody: Buffer | null = null;
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn((body) => {
        capturedBody = body;
      });
      const res = createMockResponse(201, {});
      callback(res);
      setTimeout(() => res.end(), 20);
      return req;
    });

    const testBody = Buffer.from([0, 1, 255]);
    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    await postPush("https://fcm.googleapis.com/push", {}, testBody, deps);

    expect(Buffer.compare(capturedBody!, testBody)).toBe(0);
  });

  it("sets headers correctly", { timeout: 10000 }, async () => {
    let capturedHeaders: any;
    const requestFn = vi.fn((options, callback) => {
      capturedHeaders = options.headers;
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      const res = createMockResponse(200, {});
      callback(res);
      setTimeout(() => res.end(), 20);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    await postPush("https://fcm.googleapis.com/push", { Authorization: "Bearer X" }, Buffer.from("test"), deps);

    expect(capturedHeaders.Host).toBe("fcm.googleapis.com");
    expect(capturedHeaders["Content-Length"]).toBe("4");
    expect(capturedHeaders["Content-Encoding"]).toBe("aes128gcm");
    expect(capturedHeaders.Authorization).toBe("Bearer X");
  });

  it("rejects redirects", async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      const res = createMockResponse(301, {});
      res.destroy = vi.fn();
      callback(res);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    await expect(postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps)).rejects.toMatchObject({
      code: "redirect",
    });
  });

  it("resolves success normally", { timeout: 10000 }, async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      const res = createMockResponse(200, { x: "y" });
      callback(res);
      setTimeout(() => res.end(), 20);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    const result = await postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps);

    expect(result.status).toBe(200);
    expect(result.body).toBe("");
    expect(result.bodyTruncated).toBe(false);
  });

  it("truncates oversized response at cap", { timeout: 10000 }, async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      const res = createMockResponse(200, {});
      res.destroy = vi.fn();
      callback(res);
      setTimeout(() => {
        res.emit("data", Buffer.alloc(3000));
        res.emit("data", Buffer.alloc(2000)); // Will exceed 4096
      }, 20);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
      maxResponseBytes: 4096,
    };

    const result = await postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps);

    expect(result.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(result.body)).toBe(4096);
  });

  it("rejects with timeout", { timeout: 10000 }, async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      req.end = vi.fn();
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
      timeoutMs: 10,
    };

    await expect(postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rejects on request error", async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      setTimeout(() => req.emit("error", new Error("ECONNREFUSED")), 5);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    await expect(postPush("https://fcm.googleapis.com/push", {}, Buffer.alloc(0), deps)).rejects.toMatchObject({
      code: "network",
    });
  });

  it("does not leak endpoint URL in errors", async () => {
    const requestFn = vi.fn((options, callback) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      setTimeout(() => req.emit("error", new Error("connection failed")), 5);
      return req;
    });

    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
      request: requestFn,
    };

    try {
      await postPush("https://fcm.googleapis.com/fcm/send/SECRETTOKEN", {}, Buffer.alloc(0), deps);
    } catch (e) {
      if (e instanceof Error) {
        expect(e.message).not.toContain("SECRETTOKEN");
        expect(e.message).not.toContain("/fcm/send");
      }
    }
  });

  it("rejects bad headers with CR/LF", async () => {
    const deps: PushTransportDeps = {
      lookup: async () => [{ address: "142.250.1.1", family: 4 }],
    };
    await expect(
      postPush("https://fcm.googleapis.com/push", { "X-Bad\r\nHeader": "value" }, Buffer.alloc(0), deps)
    ).rejects.toMatchObject({ code: "bad_headers" });
  });
});
