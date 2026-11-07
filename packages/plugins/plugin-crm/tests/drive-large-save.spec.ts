/**
 * PAR-8125: Drive saves over 5 MiB. A generated file (random bytes, never client data) goes from a producer to the CRM
 * over the host's REAL plugin event bus as a signed R2 link, is read in chunks and sent to a Google resumable upload.
 * The link never shows up in a reply, a log line or an error.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { driveSave, isR2ObjectUrl, DRIVE_TRANSFER_MAX_BYTES } from "@partnersinbiz/pib-plugin-kit";
import { registerDriveSaveRoute, type DriveSaveRouteDeps } from "../src/drive/save-route.js";
import { r2Chunks, R2StreamError } from "../src/drive/r2-stream.js";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { generateKeyPairSync } from "node:crypto";

const BUS_MODULE = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;
async function hostBus(): Promise<any> {
  const mod = (await import(/* @vite-ignore */ BUS_MODULE)) as { createPluginEventBus: () => any };
  return mod.createPluginEventBus();
}
function pluginCtx(bus: any, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
  const logs: unknown[] = [];
  const log = (...args: unknown[]) => void logs.push(args);
  return {
    logs,
    events: {
      on: (name: string, ...rest: unknown[]) => {
        scoped.subscribe(name, rest[rest.length - 1] as (e: any) => Promise<void>);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: unknown) => {
        await scoped.emit(name, companyId, payload);
      },
    },
    logger: { info: log, warn: log, error: log, debug: log },
  } as any;
}

const SIGNED = "https://acc0unt1d.r2.cloudflarestorage.com/pib-studio/assets/a1.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef";
const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A fake R2 response that streams `bytes` in uneven pieces, like a real socket. */
function r2Response(bytes: Uint8Array, piece = 3 * MiB + 17): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) return c.close();
      c.enqueue(bytes.subarray(at, Math.min(at + piece, bytes.byteLength)));
      at += piece;
    },
  });
  return new Response(body, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
}

describe("R2 host guard", () => {
  it.each([
    [SIGNED, true],
    ["https://abc.eu.r2.cloudflarestorage.com/b/k", true],
    ["http://abc.r2.cloudflarestorage.com/b/k", false],
    ["https://abc.r2.cloudflarestorage.com.evil.com/b/k", false],
    ["https://evil.com/abc.r2.cloudflarestorage.com/b/k", false],
    ["https://abc.r2.cloudflarestorage.com:8443/b/k", false],
    ["https://u:p@abc.r2.cloudflarestorage.com/b/k", false],
    ["https://169.254.169.254/latest", false],
    ["https://pub-123.r2.dev/k", false],
  ])("%s -> %s", (url, ok) => expect(isR2ObjectUrl(url)).toBe(ok));

  it("r2Chunks refuses a non-R2 link and never fetches it", async () => {
    const fetchFn = vi.fn();
    await expect(r2Chunks("https://evil.com/x", 10, { fetchFn }).next()).rejects.toBeInstanceOf(R2StreamError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("r2Chunks asks for no redirects and its errors never echo the link", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`fetch failed for ${SIGNED}`);
    });
    const err = await r2Chunks(SIGNED, 10, { fetchFn }).next().catch((e: Error) => e);
    expect((fetchFn.mock.calls[0] as any)[1].redirect).toBe("error");
    expect(String((err as Error).message)).not.toContain("X-Amz-Signature");
  });
});

describe("r2Chunks", () => {
  it("re-chunks a 20 MiB generated file into 8 MiB pieces with the same bytes", async () => {
    const bytes = new Uint8Array(randomBytes(20 * MiB));
    const parts: number[] = [];
    const h = createHash("sha256");
    for await (const c of r2Chunks(SIGNED, bytes.byteLength, { fetchFn: async () => r2Response(bytes) })) {
      parts.push(c.byteLength);
      h.update(c);
    }
    expect(parts).toEqual([8 * MiB, 8 * MiB, 4 * MiB]);
    expect(h.digest("hex")).toBe(sha(bytes));
  });

  it("refuses a body that is not the declared size", async () => {
    const bytes = new Uint8Array(randomBytes(1000));
    const run = async () => {
      for await (const _ of r2Chunks(SIGNED, 999, { fetchFn: async () => new Response(bytes, { status: 200 }) })) void _;
    };
    await expect(run()).rejects.toMatchObject({ code: "size_mismatch" });
  });
});

function testKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { clientEmail: `sa-${Math.random()}@x.iam.gserviceaccount.com`, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), tokenUri: "https://oauth2.googleapis.com/token" } as any;
}

describe("Google resumable upload", () => {
  it("sends a generated 20 MiB file in 8 MiB chunks and never holds more than one", async () => {
    clearServiceAccountTokenCache();
    const bytes = new Uint8Array(randomBytes(20 * MiB));
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ";
    const puts: Array<{ range: string; len: number }> = [];
    const received = createHash("sha256");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (url.includes("/drive/v3/files?") && !url.includes("upload")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      if (url.includes("uploadType=resumable") && init?.method === "POST") {
        expect((init.headers as Record<string, string>)["X-Upload-Content-Length"]).toBe(String(bytes.byteLength));
        return new Response("", { status: 200, headers: { location: SESSION } });
      }
      if (url === SESSION && init?.method === "PUT") {
        const chunk = init.body as Uint8Array;
        const range = (init.headers as Record<string, string>)["Content-Range"]!;
        puts.push({ range, len: chunk.byteLength });
        received.update(chunk);
        const end = Number(range.split("-")[1]!.split("/")[0]);
        if (end + 1 < bytes.byteLength) return new Response("", { status: 308, headers: { range: `bytes=0-${end}` } });
        return new Response(JSON.stringify({ id: "f1", name: "n", mimeType: "video/mp4", size: String(bytes.byteLength), webViewLink: "https://drive.google.com/file/d/f1/view" }), { status: 200 });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const broker = createGoogleDriveBroker(fetchFn as any, testKey(), "drive1");
    const progress: number[] = [];
    const res = await broker.uploadFileStream!({
      name: "2026-11-07 clip v1.mp4", mimeType: "video/mp4", parentFolderId: "folder1", size: bytes.byteLength, sha256: sha(bytes),
      chunks: r2Chunks(SIGNED, bytes.byteLength, { fetchFn: async () => r2Response(bytes) }),
      onProgress: (d) => void progress.push(d),
    });
    expect(res).toMatchObject({ fileId: "f1", deduplicated: false, sha256: sha(bytes) });
    expect(puts).toEqual([
      { range: `bytes 0-${8 * MiB - 1}/${20 * MiB}`, len: 8 * MiB },
      { range: `bytes ${8 * MiB}-${16 * MiB - 1}/${20 * MiB}`, len: 8 * MiB },
      { range: `bytes ${16 * MiB}-${20 * MiB - 1}/${20 * MiB}`, len: 4 * MiB },
    ]);
    expect(received.digest("hex")).toBe(sha(bytes));
    expect(progress).toEqual([8 * MiB, 16 * MiB, 20 * MiB]);
  });

  it("cancels the session before the last chunk when the sha256 does not match", async () => {
    clearServiceAccountTokenCache();
    const bytes = new Uint8Array(randomBytes(9 * MiB));
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ";
    const methods: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (!url.includes("upload")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      if (init?.method === "POST") return new Response("", { status: 200, headers: { location: SESSION } });
      methods.push(init!.method!);
      return new Response("", { status: 308, headers: { range: `bytes=0-${8 * MiB - 1}` } });
    });
    const broker = createGoogleDriveBroker(fetchFn as any, testKey(), "drive1");
    await expect(
      broker.uploadFileStream!({ name: "2026-11-07 clip v1.mp4", mimeType: "video/mp4", size: bytes.byteLength, sha256: "0".repeat(64), chunks: r2Chunks(SIGNED, bytes.byteLength, { fetchFn: async () => r2Response(bytes) }) }),
    ).rejects.toMatchObject({ code: "sha_mismatch" });
    expect(methods).toEqual(["PUT", "DELETE"]);
  });

  it("refuses a file over the transfer limit before it talks to Google", async () => {
    const fetchFn = vi.fn();
    const broker = createGoogleDriveBroker(fetchFn as any, testKey(), "drive1");
    await expect(broker.uploadFileStream!({ name: "x", mimeType: "video/mp4", size: DRIVE_TRANSFER_MAX_BYTES + 1, sha256: "a".repeat(64), chunks: (async function* () {})() })).rejects.toMatchObject({ code: "too_large" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("large save over the host event bus (PAR-8125)", () => {
  const base = { companyId: "company-a", kind: "marketing", name: "2026-11-07 clip abcd1234 v1.mp4", mimeType: "video/mp4", subfolder: "02 Assets" as const, client: { kind: "company" as const, ref: "co-a" } };

  it("passes the link to the CRM, reports progress and keeps the wait alive past timeoutMs", async () => {
    const bus = await hostBus();
    const crm = pluginCtx(bus, "partnersinbiz.crm");
    const save = vi.fn(async (_ctx: unknown, _viewer: unknown, input: any) => {
      // Three chunks, each slower than the producer's timeoutMs: progress keeps the wait alive.
      for (const done of [8 * MiB, 16 * MiB, 20 * MiB]) {
        await new Promise((r) => setTimeout(r, 120));
        await input.onProgress(done, 20 * MiB);
      }
      return { status: "saved", driveFileId: "f1", url: "https://drive.google.com/file/d/f1/view" };
    });
    const deps = { resolveProject: vi.fn(async () => "p1"), save } as unknown as DriveSaveRouteDeps;
    registerDriveSaveRoute(crm, deps);
    const studio = pluginCtx(bus, "partnersinbiz.studio");
    const seen: number[] = [];
    const result = await driveSave(studio, { ...base, r2Url: SIGNED, size: 20 * MiB, sha256: "ab".repeat(32), timeoutMs: 200, onProgress: (p) => void seen.push(p.bytesDone) });
    expect(result).toMatchObject({ status: "saved", driveFileId: "f1" });
    expect(seen).toEqual([8 * MiB, 16 * MiB, 20 * MiB]);
    const input = save.mock.calls[0]![2];
    expect(input).toMatchObject({ r2Url: SIGNED, size: 20 * MiB, sha256: "ab".repeat(32) });
    expect(input.contentBase64).toBeUndefined();
    expect(JSON.stringify([crm.logs, studio.logs, result])).not.toContain("X-Amz-Signature");
  });

  it("a producer link that is not R2 is refused before it leaves the producer", async () => {
    const bus = await hostBus();
    const save = vi.fn();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), { resolveProject: vi.fn(async () => "p1"), save } as any);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.studio"), { ...base, r2Url: "https://evil.com/a.mp4", size: 6 * MiB, sha256: "ab".repeat(32), timeoutMs: 500 });
    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(save).not.toHaveBeenCalled();
  });

  it("a small file still goes inline as base64, as before", async () => {
    const bus = await hostBus();
    const save = vi.fn(async () => ({ status: "saved", driveFileId: "f2", url: "u" }));
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), { resolveProject: vi.fn(async () => "p1"), save } as any);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.seo"), { ...base, bytes: Buffer.from("small"), timeoutMs: 1000 });
    expect(result.status).toBe("saved");
    const input = (save.mock.calls[0] as any)[2];
    expect(input.contentBase64).toBe(Buffer.from("small").toString("base64"));
    expect(input.r2Url).toBeUndefined();
    expect(input.onProgress).toBeUndefined();
  });
});
