/**
 * PAR-8125: a large Drive read, streamed from Drive into a signed R2 PUT link, over the host's REAL plugin event bus
 * (server/src/services/plugin-event-bus.ts), with a producer's kit `driveReadToR2` and the CRM both subscribed.
 * Project and folder lookups are stubbed (they need Postgres and Google); Drive and R2 are fake streams. The file is
 * generated random bytes, never client data.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const tools = vi.hoisted(() => ({
  resolveProducerSaveProject: vi.fn(async (_ctx: unknown, companyId: string, client: { clientRef?: string }) => {
    if (companyId === "company-a" && client.clientRef === "co-a") return "pA";
    if (companyId === "company-a" && client.clientRef === "co-b") return "pB";
    return null;
  }),
  driveFolderEnsure: vi.fn(async (_ctx: unknown, _viewer: unknown, input: { entity_id: string }) => {
    const id = input.entity_id === "pA" ? "A" : "B";
    return { status: "exists", folder_id: `root${id}`, path: `Clients/${id}`, tree: [{ path: `Clients/${id}/Assets/02 Assets`, folderId: `f${id}` }] };
  }),
  createBrokerForCompany: vi.fn(async () => null),
}));
vi.mock("../src/drive/tools.js", () => tools);

import { CRM_PLUGIN_ID, DRIVE_PRODUCER_PLUGINS, DRIVE_TRANSFER_MAX_BYTES, driveRead, driveReadToR2 } from "@partnersinbiz/pib-plugin-kit";
import { clearAssetFolderCache, registerDriveReadRoutes } from "../src/drive/read.js";
import { putToR2 } from "../src/drive/r2-put.js";

interface ScopedBus {
  subscribe(pattern: string, fn: (event: any) => Promise<void> | void): void;
  emit(name: string, companyId: string, payload: unknown): Promise<{ errors: unknown[] }>;
}
interface HostBus {
  forPlugin(pluginId: string): ScopedBus;
}

const BUS_MODULE = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;
async function hostBus(): Promise<HostBus> {
  const mod = (await import(/* @vite-ignore */ BUS_MODULE)) as { createPluginEventBus: () => HostBus };
  return mod.createPluginEventBus();
}

const logs: unknown[] = [];
function pluginCtx(bus: HostBus, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
  const log = (...args: unknown[]) => void logs.push(args);
  return {
    events: {
      on: (name: string, ...rest: unknown[]) => {
        scoped.subscribe(name, rest[rest.length - 1] as (event: any) => Promise<void>);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: unknown) => {
        await scoped.emit(name, companyId, payload);
      },
    },
    logger: { info: vi.fn(log), warn: vi.fn(log), error: vi.fn(log), debug: vi.fn(log) },
  } as any;
}

const SIZE = 20 * 1024 * 1024 + 12345;
const FILE = randomBytes(SIZE);
const FILE_SHA = createHash("sha256").update(FILE).digest("hex");
const FILE_A = "fileAAAAAAAAAAAA";
const FILE_B = "fileBBBBBBBBBBBB";
const PUT_URL = "https://acct123.r2.cloudflarestorage.com/studio/assets/new.mp4?X-Amz-Signature=deadbeefsecret&X-Amz-Expires=900";

/** Drive's body in 256 KiB pieces, as a network would send it. */
function driveBody(bytes: Buffer, piece = 256 * 1024): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.byteLength) return c.close();
      c.enqueue(new Uint8Array(bytes.subarray(at, at + piece)));
      at += piece;
    },
  });
}

function broker(bytes: Buffer = FILE, listedSize = bytes.byteLength) {
  const files: Record<string, { id: string; name: string; mimeType: string; size: number; parents: string[] }> = {
    [FILE_A]: { id: FILE_A, name: "clip.mp4", mimeType: "video/mp4", size: listedSize, parents: ["fA"] },
    [FILE_B]: { id: FILE_B, name: "other.mp4", mimeType: "video/mp4", size: listedSize, parents: ["fB"] },
  };
  return {
    listFiles: vi.fn(async () => []),
    fileMeta: vi.fn(async (id: string) => files[id] ?? null),
    downloadFile: vi.fn(async () => new Uint8Array(3)),
    downloadStream: vi.fn(async () => ({ body: driveBody(bytes), size: null })),
  };
}

/** A fake R2: reads the PUT body as a stream and keeps only its hash, size and largest piece. */
function fakeR2(status = 200) {
  const seen = { calls: 0, bytes: 0, maxPiece: 0, sha: "", headers: {} as Record<string, string>, redirect: "" };
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    seen.calls++;
    seen.headers = init?.headers as Record<string, string>;
    seen.redirect = String(init?.redirect);
    const hash = createHash("sha256");
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.bytes += value.byteLength;
        seen.maxPiece = Math.max(seen.maxPiece, value.byteLength);
        hash.update(value);
      }
    } catch (e) {
      throw new TypeError(`fetch failed for ${_url}: ${String(e)}`);
    }
    seen.sha = hash.digest("hex");
    return new Response(null, { status });
  });
  return { fetchFn, seen };
}

const PRODUCER = DRIVE_PRODUCER_PLUGINS[0]!;

async function setup(b = broker(), r2 = fakeR2()) {
  const bus = await hostBus();
  const crm = pluginCtx(bus, CRM_PLUGIN_ID);
  registerDriveReadRoutes(crm, async () => b as never, DRIVE_PRODUCER_PLUGINS, r2.fetchFn as never);
  return { producer: pluginCtx(bus, PRODUCER), b, r2 };
}

function noSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/X-Amz-Signature|deadbeefsecret/);
}

describe("large Drive read into R2 (PAR-8125), on the real event bus", () => {
  beforeEach(() => {
    clearAssetFolderCache();
    logs.length = 0;
  });

  it("streams a generated 20 MiB file from Drive to the R2 link, with progress and the same sha256", async () => {
    const { producer, r2, b } = await setup();
    const progress: Array<{ bytesDone: number; bytesTotal: number }> = [];
    const out = await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A, r2PutUrl: PUT_URL, onProgress: (p) => progress.push(p) });
    expect(out).toMatchObject({ status: "stored", size: SIZE, sha256: FILE_SHA, file: { id: FILE_A, name: "clip.mp4", mimeType: "video/mp4", size: SIZE } });
    expect(r2.seen).toMatchObject({ calls: 1, bytes: SIZE, sha: FILE_SHA, redirect: "error" });
    expect(r2.seen.headers["content-length"]).toBe(String(SIZE));
    expect(r2.seen.headers["content-type"]).toBe("video/mp4");
    // Never the whole file at once: the PUT sees Drive's pieces as they come.
    expect(r2.seen.maxPiece).toBeLessThanOrEqual(256 * 1024);
    expect(b.downloadFile).not.toHaveBeenCalled();
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toEqual({ bytesDone: SIZE, bytesTotal: SIZE });
    noSecret(out);
    noSecret(logs);
  });

  it("refuses a file in another client's folder before anything is fetched", async () => {
    const { producer, r2, b } = await setup();
    const out = await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_B, r2PutUrl: PUT_URL });
    expect(out).toMatchObject({ status: "failed", reason: "not_in_client_folder" });
    expect(b.downloadStream).not.toHaveBeenCalled();
    expect(r2.fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a file over the transfer limit in plain words", async () => {
    const { producer, r2 } = await setup(broker(Buffer.alloc(8), DRIVE_TRANSFER_MAX_BYTES + 1));
    const out = await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A, r2PutUrl: PUT_URL });
    expect(out).toMatchObject({ status: "failed", reason: "too_large" });
    expect((out as { hint?: string }).hint).toMatch(/^This file is 200 MB\. Drive transfers take files up to 200 MB, the largest file Studio keeps\.$/);
    expect(r2.fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a link that is not R2 at both ends, without fetching", async () => {
    const { producer, r2, b } = await setup();
    // The kit refuses it before it is sent.
    expect(await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A, r2PutUrl: "https://169.254.169.254/latest" })).toMatchObject({ status: "failed", reason: "invalid_input" });
    // A producer that skips the kit is refused by the CRM.
    const replies: unknown[] = [];
    producer.events.on(`plugin.${CRM_PLUGIN_ID}.drive.read.failed`, (e: { payload: unknown }) => void replies.push(e.payload));
    await producer.events.emit("drive.read-requested", "company-a", { requestId: "abc123", fileId: FILE_A, clientKind: "company", clientRef: "co-a", r2PutUrl: "http://acct.r2.cloudflarestorage.com/x" });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ reason: "invalid_input" });
    expect(b.downloadStream).not.toHaveBeenCalled();
    expect(r2.fetchFn).not.toHaveBeenCalled();
  });

  it("fails without the link when Drive sends fewer bytes than it lists", async () => {
    const { producer } = await setup(broker(FILE.subarray(0, 1024 * 1024), SIZE));
    const out = await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A, r2PutUrl: PUT_URL });
    expect(out.status).toBe("failed");
    expect(["size_mismatch", "storage_failed"]).toContain((out as { reason: string }).reason);
    noSecret(out);
    noSecret(logs);
  });

  it("fails without the link when R2 refuses the PUT", async () => {
    const { producer } = await setup(broker(), fakeR2(403));
    const out = await driveReadToR2(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A, r2PutUrl: PUT_URL });
    expect(out).toMatchObject({ status: "failed", reason: "storage_failed" });
    expect((out as { hint: string }).hint).toMatch(/HTTP 403/);
    noSecret(out);
    noSecret(logs);
  });

  it("leaves a small read as it was: bytes inline, no R2", async () => {
    const { producer, r2, b } = await setup(broker(Buffer.from([1, 2, 3])));
    const out = await driveRead(producer, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, fileId: FILE_A });
    expect(out.status).toBe("read");
    expect(b.downloadFile).toHaveBeenCalled();
    expect(b.downloadStream).not.toHaveBeenCalled();
    expect(r2.fetchFn).not.toHaveBeenCalled();
  });
});

describe("putToR2", () => {
  it("refuses a body longer than the size", async () => {
    const r2 = fakeR2();
    await expect(putToR2(PUT_URL, 10, driveBody(Buffer.alloc(20), 4), { fetchFn: r2.fetchFn as never })).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("refuses a non-R2 link and cancels the source", async () => {
    const cancel = vi.fn();
    const src = new ReadableStream<Uint8Array>({ cancel });
    await expect(putToR2("https://example.com/x", 10, src)).rejects.toMatchObject({ code: "not_r2" });
    expect(cancel).toHaveBeenCalled();
  });
});
