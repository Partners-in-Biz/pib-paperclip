/**
 * PAR-9264: the agent tools studio-drive-save and studio-drive-transfer wrap the page's Drive save. Generated data
 * only. The large path runs over the host's real event bus with a fake CRM save route on it (no cross-package source import: tsconfig rootDir).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { driveSave as realDriveSave } from "@partnersinbiz/pib-plugin-kit";

const MiB = 1024 * 1024;
const ID = "11111111-2222-3333-4444-555555555555";
const SHA = "a".repeat(64);
const SIGNED = "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=deadbeef";
const row = { id: ID, name: "Film", mime: "video/mp4", bytes: 50 * MiB, r2_key: `studio/co-1/own/${ID}/v1.mp4`, created_at: "2026-11-01T10:00:00.000Z", current_version: 1, client_kind: null, client_id: null };
const links: string[] = [];
const BUS = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;

vi.mock("../src/assets.js", () => ({
  LINK_TARGETS: ["issue", "project"],
  getAssetRow: vi.fn(async (_c: unknown, co: string, id: string) => {
    if (co !== "co-1" || id !== ID) throw Object.assign(new Error(`Asset ${id} was not found in this company.`), { name: "StudioError" });
    return row;
  }),
  addLink: vi.fn(async (_c: unknown, _co: string, _id: string, t: string, target: string) => void links.push(`${t}:${target}`)),
}));
vi.mock("../src/storage.js", () => ({
  assertOwnKey: vi.fn(),
  extFor: () => "mp4",
  getObject: vi.fn(async () => new Uint8Array([1, 2, 3])),
  objectUrl: () => SIGNED,
}));
vi.mock("../src/config.js", () => ({ StudioConfig: class { async bucket() { return {}; } } }));

const { saveAssetToDrive } = await import("../src/drive.js");
const { getTransfer, resetTransfers } = await import("../src/drive-jobs.js");
const { STUDIO_TOOLS } = await import("../src/tools.js");

const ctx = { db: { namespace: "plugin_studio_test", query: vi.fn(async () => [{ sha256: SHA }]) } } as never;

type Handler = (event: unknown) => unknown;
interface Scoped { subscribe: (name: string, fn: Handler) => void; emit: (name: string, companyId: string, payload: unknown) => Promise<unknown> }
interface Bus { forPlugin: (id: string) => Scoped }
interface CrmRequest { onProgress: (done: number, total: number) => Promise<void>; r2Url: string; size: number; sha256: string }

function pluginCtx(bus: Bus, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
  const logs: unknown[] = [];
  const log = (...a: unknown[]) => void logs.push(a);
  return {
    logs,
    events: {
      on: (name: string, ...rest: unknown[]) => (scoped.subscribe(name, rest[rest.length - 1] as Handler), () => undefined),
      emit: async (name: string, companyId: string, payload: unknown) => void (await scoped.emit(name, companyId, payload)),
    },
    logger: { info: log, warn: log, error: log, debug: log },
  };
}

/** A small stand-in for the CRM save route: hears the studio's request, calls `save`, replies with the bare names. */
function fakeCrmRoute(crm: ReturnType<typeof pluginCtx>, save: (input: CrmRequest) => Promise<{ driveFileId: string; url: string }>) {
  crm.events.on("plugin.partnersinbiz.studio.drive.save-requested", async (event: unknown) => {
    const e = event as { companyId: string; payload: Record<string, unknown> };
    const requestId = e.payload.requestId;
    const reply = (name: string, body: Record<string, unknown>) => crm.events.emit(name, e.companyId, { ...body, requestId });
    try {
      const input: CrmRequest = {
        r2Url: String(e.payload.r2Url),
        size: Number(e.payload.size),
        sha256: String(e.payload.sha256),
        onProgress: (bytesDone, bytesTotal) => reply("drive.transfer.progress", { bytesDone, bytesTotal }),
      };
      const r = await save(input);
      await reply("drive.file.saved", { driveFileId: r.driveFileId, url: r.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      crm.logger.info("Drive save event handler failed", { error: message });
      await reply("drive.file.failed", { reason: "handler_error", hint: message });
    }
  });
}

async function newBus(): Promise<Bus> {
  const mod = (await import(/* @vite-ignore */ BUS)) as { createPluginEventBus: () => Bus };
  return mod.createPluginEventBus();
}

async function settleTransfer(transferId: string) {
  let view = getTransfer("co-1", transferId);
  for (let i = 0; i < 100 && view.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    view = getTransfer("co-1", transferId);
  }
  return view;
}

beforeEach(() => {
  resetTransfers();
  links.length = 0;
  row.bytes = 50 * MiB;
});

describe("studio-drive tools", () => {
  it("names 5 MB, 200 MB and the status tool in the descriptions", () => {
    const save = STUDIO_TOOLS.find((t) => t.name === "studio-drive-save")!;
    expect(save.description).toMatch(/5 MB/);
    expect(save.description).toMatch(/200 MB/);
    expect(save.description).toMatch(/studio-drive-transfer/);
    expect(STUDIO_TOOLS.find((t) => t.name === "studio-drive-transfer")).toBeTruthy();
  });

  it("an inline save (5 MiB) returns the url", async () => {
    row.bytes = 5 * MiB;
    const save = vi.fn(async () => ({ status: "saved" as const, requestId: "r", driveFileId: "1AbCdEfGhIjKlMnOp", url: "x" }));
    expect(await saveAssetToDrive(ctx, "co-1", ID, save as never)).toMatchObject({ url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" });
  });

  it("a 50 MiB asset becomes a transfer that reaches done with the url, over the event bus and the CRM save route", async () => {
    const bus = await newBus();
    const crm = pluginCtx(bus, "partnersinbiz.crm");
    const seen: CrmRequest[] = [];
    fakeCrmRoute(crm, async (input) => {
      seen.push(input);
      await input.onProgress(8 * MiB, 50 * MiB);
      return { driveFileId: "1AbCdEfGhIjKlMnOp", url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" };
    });
    const studio = pluginCtx(bus, "partnersinbiz.studio");
    const started = (await saveAssetToDrive(ctx, "co-1", ID, (_c, o) => realDriveSave(studio as never, o as never) as never)) as { transferId: string; status: string };
    expect(started.status).toBe("running");
    const view = await settleTransfer(started.transferId);
    expect(view).toMatchObject({ status: "done", result: { url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" } });
    expect(seen[0]).toMatchObject({ r2Url: SIGNED, size: 50 * MiB, sha256: SHA });
    expect(JSON.stringify([started, view, crm.logs, studio.logs])).not.toMatch(/X-Amz-Signature|r2\.cloudflarestorage\.com/);
  });

  it("a failed save whose error message carries the signed link leaks it neither to the transfer nor to the logs", async () => {
    const bus = await newBus();
    const crm = pluginCtx(bus, "partnersinbiz.crm");
    fakeCrmRoute(crm, async () => {
      throw new Error(`fetch failed for ${SIGNED}`);
    });
    const studio = pluginCtx(bus, "partnersinbiz.studio");
    const started = (await saveAssetToDrive(ctx, "co-1", ID, (_c, o) => realDriveSave(studio as never, o as never) as never)) as { transferId: string };
    const view = await settleTransfer(started.transferId);
    expect(view.status).toBe("failed");
    // The CRM's own log line is the CRM plugin's; here the transfer text and the studio's logs must be clean.
    expect(JSON.stringify([view, studio.logs])).not.toMatch(/X-Amz-Signature|r2\.cloudflarestorage\.com/);
  });

  it("refuses an unknown transferId, another company's transferId and another company's assetId in plain words", async () => {
    expect(() => getTransfer("co-1", "nope")).toThrow(/isn't running any more/);
    const started = (await saveAssetToDrive(ctx, "co-1", ID, (() => new Promise(() => undefined)) as never)) as { transferId: string };
    expect(() => getTransfer("co-2", started.transferId)).toThrow(/isn't running any more/);
    await expect(saveAssetToDrive(ctx, "co-2", ID, vi.fn() as never)).rejects.toThrow(/was not found in this company/);
    await expect(saveAssetToDrive(ctx, "co-1", "", vi.fn() as never)).rejects.toThrow(/assetId is required/);
  });
});
