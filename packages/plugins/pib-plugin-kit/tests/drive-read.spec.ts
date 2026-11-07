import { describe, expect, it } from "vitest";
import { CRM_PLUGIN_ID } from "../src/crm-projection.js";
import { DRIVE_READ_EVENTS, driveList, driveRead, registerDriveReadReplies } from "../src/drive-read.js";

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
    expect(b.handlers.size).toBe(4);
  });
});
