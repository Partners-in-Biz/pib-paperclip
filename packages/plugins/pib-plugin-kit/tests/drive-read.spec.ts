import { describe, expect, it } from "vitest";
import { CRM_PLUGIN_ID } from "../src/crm-projection.js";
import { DRIVE_READ_EVENTS, driveList, driveRead, driveReadToR2, driveThumbs, registerDriveReadReplies } from "../src/drive-read.js";

type Handler = (event: { companyId: string; payload: unknown }) => Promise<void> | void;

/** A fake event bus: emitted requests are answered by `answer`, replies go to the subscribed handlers. */
function bus(answer: (name: string, companyId: string, payload: Record<string, unknown>) => { event: string; companyId?: string; payload: Record<string, unknown> } | null) {
  const handlers = new Map<string, Handler[]>();
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    events: {
      on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => {
        emitted.push({ name, companyId, payload });
        const reply = answer(name, companyId, payload);
        if (!reply) return;
        queueMicrotask(() => {
          for (const h of handlers.get(`plugin.${CRM_PLUGIN_ID}.${reply.event}`) ?? []) void h({ companyId: reply.companyId ?? companyId, payload: reply.payload });
        });
      },
    },
  };
  return { ctx: ctx as never, emitted, handlers };
}

const FILE = { id: "1AbCdEfGhIjKlMnOp", name: "hero.png", mimeType: "image/png", size: 3 };

describe("driveList / driveRead", () => {
  it("lists with the client and returns names, types, sizes and ids only", async () => {
    const b = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.listed, payload: { requestId: p.requestId, files: [{ ...FILE, webViewLink: "https://x", owners: ["a"] }, { bad: true }] } }));
    const out = await driveList(b.ctx, { companyId: "co-1", client: { kind: "company", ref: "c-1" } });
    expect(out).toMatchObject({ status: "listed", files: [FILE] });
    expect(Object.keys((out as { files: object[] }).files[0]!)).toEqual(["id", "name", "mimeType", "size"]);
    expect(b.emitted[0]).toMatchObject({ name: DRIVE_READ_EVENTS.listRequested, companyId: "co-1", payload: { clientKind: "company", clientRef: "c-1" } });
  });

  it("reads bytes and passes refusals through", async () => {
    const ok = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.read, payload: { requestId: p.requestId, file: FILE, contentBase64: Buffer.from([1, 2, 3]).toString("base64") } }));
    const read = await driveRead(ok.ctx, { companyId: "co-1", fileId: FILE.id });
    expect(read.status).toBe("read");
    expect(Array.from((read as { bytes: Uint8Array }).bytes)).toEqual([1, 2, 3]);

    const refused = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.readFailed, payload: { requestId: p.requestId, reason: "not_in_client_folder" } }));
    expect(await driveRead(refused.ctx, { companyId: "co-1", fileId: FILE.id })).toMatchObject({ status: "failed", reason: "not_in_client_folder" });
  });

  it("ignores a reply for another company and times out", async () => {
    const b = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.listed, companyId: "co-other", payload: { requestId: p.requestId, files: [FILE] } }));
    expect(await driveList(b.ctx, { companyId: "co-1", timeoutMs: 30 })).toMatchObject({ status: "no_ack" });
  });

  it("refuses a bad file id and a reply for a different file without trusting it", async () => {
    const b = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.read, payload: { requestId: p.requestId, file: { ...FILE, id: "2ZzZzZzZzZzZzZzZz" }, contentBase64: "AQ==" } }));
    expect(await driveRead(b.ctx, { companyId: "co-1", fileId: "../etc" })).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(b.emitted).toHaveLength(0);
    expect(await driveRead(b.ctx, { companyId: "co-1", fileId: FILE.id })).toMatchObject({ status: "failed", reason: "bad_reply" });
  });

  it("subscribes once per context", () => {
    const b = bus(() => null);
    registerDriveReadReplies(b.ctx);
    registerDriveReadReplies(b.ctx);
    expect([...b.handlers.values()].every((h) => h.length === 1)).toBe(true);
    expect(b.handlers.size).toBe(7);
  });
});

describe("driveReadToR2 (PAR-8125)", () => {
  const PUT = "https://acct.r2.cloudflarestorage.com/a/b.mp4?X-Amz-Signature=s";
  const SHA = "a".repeat(64);

  it("sends the link, waits through progress longer than timeoutMs, and returns size and sha256", async () => {
    const handlers = new Map<string, Handler[]>();
    const fire = (event: string, payload: Record<string, unknown>) => {
      for (const h of handlers.get(`plugin.${CRM_PLUGIN_ID}.${event}`) ?? []) void h({ companyId: "co-1", payload });
    };
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = {
      events: {
        on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
        emit: async (_n: string, _c: string, p: Record<string, unknown>) => {
          emitted.push(p);
          // Three progress replies 20 ms apart, then the result: 80 ms in all, with a 40 ms idle wait.
          for (let i = 1; i <= 3; i++) setTimeout(() => fire(DRIVE_READ_EVENTS.readProgress, { requestId: p.requestId, bytesDone: i, bytesTotal: 3 }), i * 20);
          setTimeout(() => fire(DRIVE_READ_EVENTS.read, { requestId: p.requestId, file: FILE, size: 3, sha256: SHA }), 80);
        },
      },
    } as never;
    const seen: number[] = [];
    const out = await driveReadToR2(ctx, { companyId: "co-1", fileId: FILE.id, r2PutUrl: PUT, timeoutMs: 40, onProgress: (p) => seen.push(p.bytesDone) });
    expect(out).toMatchObject({ status: "stored", size: 3, sha256: SHA, file: { id: FILE.id } });
    expect(seen).toEqual([1, 2, 3]);
    expect(emitted[0]).toMatchObject({ fileId: FILE.id, r2PutUrl: PUT });
  });

  it("refuses a non-R2 link and a bad reply", async () => {
    const b = bus((_n, _c, p) => ({ event: DRIVE_READ_EVENTS.read, payload: { requestId: p.requestId, file: FILE, size: 3, sha256: "nope" } }));
    expect(await driveReadToR2(b.ctx, { companyId: "co-1", fileId: FILE.id, r2PutUrl: "https://evil.example/x" })).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(b.emitted).toHaveLength(0);
    expect(await driveReadToR2(b.ctx, { companyId: "co-1", fileId: FILE.id, r2PutUrl: PUT })).toMatchObject({ status: "failed", reason: "bad_reply" });
  });
});

describe("driveThumbs (PAR-8124)", () => {
  it("returns only asked-for previews, caps their size, and names the missing ones", async () => {
    const big = Buffer.alloc(200 * 1024).toString("base64");
    const b = bus((_n, _c, p) => ({
      event: DRIVE_READ_EVENTS.thumbs,
      payload: {
        requestId: p.requestId,
        thumbs: [
          { id: "aaaaaaaaaa01", mimeType: "image/jpeg", contentBase64: "AQID" },
          { id: "aaaaaaaaaa02", mimeType: "image/jpeg", contentBase64: big },
          { id: "zzzzzzzzzz99", mimeType: "image/jpeg", contentBase64: "AQID" },
          { id: "aaaaaaaaaa03", mimeType: "text/html", contentBase64: "AQID" },
        ],
      },
    }));
    const out = await driveThumbs(b.ctx, { companyId: "co-1", client: { kind: "company", ref: "acme" }, fileIds: ["aaaaaaaaaa01", "aaaaaaaaaa02", "aaaaaaaaaa03", "aaaaaaaaaa04"] });
    expect(b.emitted[0]).toMatchObject({ name: DRIVE_READ_EVENTS.thumbsRequested, payload: { fileIds: ["aaaaaaaaaa01", "aaaaaaaaaa02", "aaaaaaaaaa03", "aaaaaaaaaa04"], size: "small", clientKind: "company", clientRef: "acme" } });
    expect(out.status).toBe("thumbs");
    if (out.status !== "thumbs") return;
    expect(out.thumbs.map((t) => ("bytes" in t ? [t.id, Array.from(t.bytes)] : [t.id, t.reason]))).toEqual([
      ["aaaaaaaaaa01", [1, 2, 3]],
      ["aaaaaaaaaa02", "too_large"],
      ["aaaaaaaaaa03", "no_preview"],
      ["aaaaaaaaaa04", "no_reply"],
    ]);
  });

  it("refuses an empty, bad or too long id list without asking the CRM", async () => {
    const b = bus(() => null);
    expect(await driveThumbs(b.ctx, { companyId: "co-1", fileIds: [] })).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(await driveThumbs(b.ctx, { companyId: "co-1", fileIds: ["../etc/passwd"] })).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(await driveThumbs(b.ctx, { companyId: "co-1", fileIds: Array.from({ length: 25 }, (_, i) => `abcdefghij${i}`) })).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(b.emitted).toEqual([]);
  });
});
