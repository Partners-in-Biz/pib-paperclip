/**
 * PAR-10212: the Drive save route logs one line when a producer's request arrives and one when it ends, each with
 * elapsed ms, so a slow save can be told from a hung one in the journal. No file name, bytes or link in the logs.
 */
import { describe, expect, it } from "vitest";
import { DRIVE_EVENTS, producerEventName } from "@partnersinbiz/pib-plugin-kit";
import { registerDriveSaveRoute, type DriveSaveRouteDeps } from "../src/drive/save-route.js";

const PRODUCER = "partnersinbiz.social";
const CO = "co-1";

function fakeCtx() {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    events: {
      on: (name: string, fn: (event: unknown) => Promise<void>) => void handlers.set(name, fn),
      emit: async (name: string, _companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, payload }),
    },
    logger: { info: (message: string, meta: Record<string, unknown>) => void logs.push({ message, meta }), warn: () => undefined, error: () => undefined, debug: () => undefined },
  };
  const send = (payload: Record<string, unknown>) => {
    const name = producerEventName(PRODUCER, DRIVE_EVENTS.saveRequested);
    return handlers.get(name)!({ eventType: name, companyId: CO, payload });
  };
  return { ctx: ctx as never, logs, emitted, send };
}

/** A clock that moves 100 ms per read, so every elapsed value is known. */
function steppedClock() {
  let t = 1_000;
  return () => (t += 100);
}

const CONTENT = Buffer.from("secret file body").toString("base64");

describe("Drive save route timing logs (PAR-10212)", () => {
  it("logs received and finished with elapsed, project and save ms; never the name or bytes", async () => {
    const { ctx, logs, emitted, send } = fakeCtx();
    const deps: DriveSaveRouteDeps = {
      resolveProject: async () => "proj-1",
      save: async () => ({ status: "saved", driveFileId: "f1", url: "https://drive/f1" }),
      now: steppedClock(),
    };
    registerDriveSaveRoute(ctx, deps, [PRODUCER]);
    await send({ requestId: "r1", kind: "social", name: "2026-11-12 Acme Client secret.png", mimeType: "image/png", contentBase64: CONTENT, subfolder: "02 Assets", clientKind: "company", clientRef: "c1" });

    expect(emitted.map((e) => e.name)).toEqual([DRIVE_EVENTS.saved]);
    expect(logs.map((l) => l.message)).toEqual(["Drive save request received", "Drive save finished"]);
    expect(logs[0]!.meta).toMatchObject({ requestId: "r1", producer: PRODUCER, companyId: CO, kind: "social", subfolder: "02 Assets", mode: "bytes", base64Length: CONTENT.length });
    // startedAt 1100; resolve 1200..1300; save 1400..1500; finish reads 1600
    expect(logs[1]!.meta).toMatchObject({ requestId: "r1", outcome: "saved", projectId: "proj-1", resolveProjectMs: 100, saveMs: 100, elapsedMs: 500 });
    const text = JSON.stringify(logs);
    expect(text).not.toContain("Acme Client secret");
    expect(text).not.toContain(CONTENT);
  });

  it("logs a refused save (no project) with its elapsed ms", async () => {
    const { ctx, logs, send } = fakeCtx();
    registerDriveSaveRoute(ctx, { resolveProject: async () => null, save: async () => ({ status: "saved" }), now: steppedClock() }, [PRODUCER]);
    await send({ requestId: "r2", kind: "ops", name: "x.png", mimeType: "image/png", contentBase64: CONTENT, ownWork: true });
    expect(logs[1]).toMatchObject({ message: "Drive save finished", meta: { requestId: "r2", outcome: "no_project", resolveProjectMs: 100, elapsedMs: 300 } });
  });

  it("logs a failed save and a thrown save with elapsed ms", async () => {
    const failed = fakeCtx();
    registerDriveSaveRoute(failed.ctx, { resolveProject: async () => "p", save: async () => ({ status: "broker_error", hint: "Google said no" }), now: steppedClock() }, [PRODUCER]);
    await failed.send({ requestId: "r3", kind: "ops", name: "x.png", mimeType: "image/png", contentBase64: CONTENT, ownWork: true });
    expect(failed.logs[1]!.meta).toMatchObject({ outcome: "broker_error", saveMs: 100, elapsedMs: 500 });

    const thrown = fakeCtx();
    registerDriveSaveRoute(thrown.ctx, { resolveProject: async () => { throw new Error("db down"); }, save: async () => ({ status: "saved" }), now: steppedClock() }, [PRODUCER]);
    await thrown.send({ requestId: "r4", kind: "ops", name: "x.png", mimeType: "image/png", contentBase64: CONTENT, ownWork: true });
    expect(thrown.logs[1]).toMatchObject({ message: "Drive save event handler failed", meta: { requestId: "r4", error: "db down", elapsedMs: 200 } });
  });
});
