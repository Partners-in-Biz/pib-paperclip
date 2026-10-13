import { describe, expect, it } from "vitest";
import { createMediaSteps } from "../src/media-steps.js";
import type { PipelineStepCtx } from "../src/pipeline.js";
import { sha256Hex } from "../src/sigv4.js";

describe("media-steps", () => {
  const FIXTURE = new Uint8Array([1, 2, 3, 4, 5]);
  const FIXTURE_SHA = sha256Hex(FIXTURE);
  const r2Store = new Map<string, { body: Uint8Array; sha256: string | null }>();

  function getUrl(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
  }

  function makeFetch(calls: any[]) {
    return async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") {
          const key = new URL(url).pathname.slice(1);
          r2Store.set(key, { body: new Uint8Array(init?.body as ArrayBuffer), sha256: (init?.headers as Record<string, string>)?.["x-amz-meta-sha256"] ?? null });
          return new Response(null, { status: 200 });
        }
        if (method === "HEAD") {
          const key = new URL(url).pathname.slice(1);
          const obj = r2Store.get(key);
          if (!obj) return new Response(null, { status: 404 });
          const headers: Record<string, string> = { "content-length": String(obj.body.length) };
          if (obj.sha256) headers["x-amz-meta-sha256"] = obj.sha256;
          return new Response(null, { status: 200, headers });
        }
      }

      if (url.includes("api.twilio.com")) {
        if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
        if (url.includes("Recordings/") && method === "DELETE") return new Response(null, { status: 204 });
      }

      return new Response(null, { status: 404 });
    };
  }

  function mockCtx(overrides?: any) {
    const secrets = new Map<string, string>([
      ["TWILIO_API_KEY_SID", "SKtest"],
      ["TWILIO_API_KEY_SECRET", "secrettest"],
    ]);
    for (const [k, v] of Object.entries(overrides?.secrets ?? {})) {
      if (v === null) secrets.delete(k);
      else secrets.set(k, v as string);
    }

    return {
      ctx: {
        secrets: {
          resolve: async (name: string) => {
            if (!secrets.has(name)) throw new Error(`Secret not found: ${name}`);
            return secrets.get(name)!;
          },
        },
      },
      namespace: "test",
      row: {
        company_id: "comp-1",
        call_sid: "CA123",
        recording_sid: "RE123",
        twilio_url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123",
        r2_key: null,
        bytes: null,
        sha256: null,
        ...overrides?.row,
      },
      extendLease: async () => true,
    } as any as PipelineStepCtx;
  }

  function mockR2Config() {
    return async () => ({
      accountId: "account123",
      bucket: "test-bucket",
      accessKeyId: "key123",
      secretAccessKey: "secret123",
      prefix: "crm-telephony",
    });
  }

  function setRowPatch(sc: any, patch: any) {
    if (patch) {
      sc.row.r2_key = patch.r2Key;
      sc.row.bytes = patch.bytes;
      sc.row.sha256 = patch.sha256;
    }
  }

  it("happy path: received -> downloaded -> twilio_deleted", async () => {
    const calls: any[] = [];
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const steps = createMediaSteps({ fetch: makeFetch(calls) as any, r2Config: mockR2Config() });
    const res = await steps.received!(sc);
    expect(res.state).toBe("downloaded");
    expect(res.patch?.r2Key).toBe("crm-telephony/recordings/CA123/RE123.wav");
    expect(res.patch?.sha256).toBe(FIXTURE_SHA);

    setRowPatch(sc, res.patch);
    const del = await steps.downloaded!(sc);
    expect(del.state).toBe("twilio_deleted");

    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["GET", "PUT", "HEAD", "DELETE"]);
  });

  it("duplicate received: same key, one R2 object", async () => {
    const calls: any[] = [];
    const steps = createMediaSteps({ fetch: makeFetch(calls) as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res1 = await steps.received!(sc);
    const putCount1 = calls.filter((c) => c.method === "PUT").length;

    calls.length = 0;
    await steps.received!(sc);
    const putCount2 = calls.filter((c) => c.method === "PUT").length;

    expect(putCount1).toBe(1);
    expect(putCount2).toBe(1);
    expect(r2Store.size).toBe(1);
  });

  it("crash: DELETE 204 then 404 both succeed", async () => {
    const calls: any[] = [];
    let deleteCount = 0;
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") {
          const key = new URL(url).pathname.slice(1);
          r2Store.set(key, { body: new Uint8Array(init?.body as ArrayBuffer), sha256: (init?.headers as Record<string, string>)?.["x-amz-meta-sha256"] ?? null });
          return new Response(null, { status: 200 });
        }
        if (method === "HEAD") {
          const key = new URL(url).pathname.slice(1);
          const obj = r2Store.get(key);
          if (!obj) return new Response(null, { status: 404 });
          const headers: Record<string, string> = { "content-length": String(obj.body.length) };
          if (obj.sha256) headers["x-amz-meta-sha256"] = obj.sha256;
          return new Response(null, { status: 200, headers });
        }
      }

      if (url.includes("Recordings/") && method === "DELETE") {
        deleteCount++;
        return new Response(null, { status: deleteCount === 1 ? 204 : 404 });
      }

      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);
    await steps.downloaded!(sc);
    await steps.downloaded!(sc);

    expect(calls.filter((c) => c.method === "DELETE").length).toBe(2);
  });

  it("HEAD size mismatch: rejects, no DELETE", async () => {
    const calls: any[] = [];
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") return new Response(null, { status: 200 });
        if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "999", "x-amz-meta-sha256": FIXTURE_SHA } });
      }

      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);

    await expect(steps.downloaded!(sc)).rejects.toThrow(/size mismatch/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("HEAD sha mismatch: rejects, no DELETE", async () => {
    const calls: any[] = [];
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") return new Response(null, { status: 200 });
        if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(FIXTURE.length), "x-amz-meta-sha256": "wrongsha" } });
      }

      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);

    await expect(steps.downloaded!(sc)).rejects.toThrow(/hash mismatch/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("HEAD missing sha: rejects, no DELETE", async () => {
    const calls: any[] = [];
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") return new Response(null, { status: 200 });
        if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(FIXTURE.length) } });
      }

      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);

    await expect(steps.downloaded!(sc)).rejects.toThrow(/hash mismatch/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("HEAD 404 missing: rejects, no DELETE", async () => {
    const calls: any[] = [];
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") return new Response(null, { status: 200 });
        if (method === "HEAD") return new Response(null, { status: 404 });
      }

      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);

    await expect(steps.downloaded!(sc)).rejects.toThrow(/object missing/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("Twilio 404: dead state", async () => {
    const steps = createMediaSteps({
      fetch: (async (input: any) => {
        const url = getUrl(input);
        if (url.includes("Recordings/")) return new Response(null, { status: 404 });
        return new Response(null, { status: 404 });
      }) as any,
      r2Config: mockR2Config(),
    });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    expect(res.state).toBe("dead");
    expect(res.error).toContain("no longer exists");
  });

  it("Twilio 410: dead state", async () => {
    const steps = createMediaSteps({
      fetch: (async (input: any) => {
        const url = getUrl(input);
        if (url.includes("Recordings/")) return new Response(null, { status: 410 });
        return new Response(null, { status: 404 });
      }) as any,
      r2Config: mockR2Config(),
    });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    expect(res.state).toBe("dead");
  });

  it("Twilio 500: throws", async () => {
    const steps = createMediaSteps({
      fetch: (async (input: any) => {
        const url = getUrl(input);
        if (url.includes("Recordings/")) return new Response(null, { status: 500 });
        return new Response(null, { status: 404 });
      }) as any,
      r2Config: mockR2Config(),
    });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    await expect(steps.received!(sc)).rejects.toThrow(/HTTP 500/);
  });

  it("DELETE 500: throws", async () => {
    const calls: any[] = [];
    const fetch = async (input: any, init?: RequestInit) => {
      const url = getUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.includes("r2.cloudflarestorage.com")) {
        if (method === "PUT") return new Response(null, { status: 200 });
        if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(FIXTURE.length), "x-amz-meta-sha256": FIXTURE_SHA } });
      }

      if (url.includes("Recordings/") && method === "DELETE") return new Response(null, { status: 500 });
      if (url.includes("Recordings/") && method === "GET") return new Response(FIXTURE.buffer, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const steps = createMediaSteps({ fetch: fetch as any, r2Config: mockR2Config() });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    const res = await steps.received!(sc);
    setRowPatch(sc, res.patch);

    await expect(steps.downloaded!(sc)).rejects.toThrow(/HTTP 500/);
  });

  it("missing secret: names secret, no leak", async () => {
    const steps = createMediaSteps({ r2Config: mockR2Config() });
    const ctx = mockCtx({ secrets: { TWILIO_API_KEY_SID: null } });
    const sc = { ...ctx, extendLease: async () => true };

    const err = await steps.received!(sc).catch((e) => e);
    expect(err.message).toContain("TWILIO_API_KEY_SID");
    expect(err.message).not.toContain("SKtest");
    expect(err.message).not.toContain("secrettest");
  });

  it("no company_id: throws", async () => {
    const steps = createMediaSteps({ r2Config: mockR2Config() });
    const ctx = mockCtx({ row: { company_id: null } });
    const sc = { ...ctx, extendLease: async () => true };

    await expect(steps.received!(sc)).rejects.toThrow(/company_id/);
  });

  it("R2 not configured: throws", async () => {
    const steps = createMediaSteps({ r2Config: async () => null });
    const ctx = mockCtx();
    const sc = { ...ctx, extendLease: async () => true };

    await expect(steps.received!(sc)).rejects.toThrow(/R2 not configured/);
  });
});
