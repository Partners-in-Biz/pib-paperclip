/**
 * PAR-8114: the Drive list and read routes (From Drive, PAR-8107) over the host's REAL plugin event bus
 * (server/src/services/plugin-event-bus.ts), with Studio's kit `driveList` / `driveRead` and the CRM both subscribed.
 * Project and folder lookups are stubbed (they need Postgres and Google); the event names, producer allowlist,
 * company and client scoping run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tools = vi.hoisted(() => ({
  // company-a owns client co-a (folder fA) and co-b (folder fB); company-b owns nothing.
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

import { driveList, driveRead } from "@partnersinbiz/pib-plugin-kit";
import { registerDriveReadRoutes } from "../src/drive/read.js";

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

function pluginCtx(bus: HostBus, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

const FILE_A = "fileAAAAAAAAAAAA";
const FILE_B = "fileBBBBBBBBBBBB";
const BYTES = Buffer.from("png-bytes-of-a");

function broker() {
  const files: Record<string, { id: string; name: string; mimeType: string; size: number; parents: string[] }> = {
    [FILE_A]: { id: FILE_A, name: "hero.png", mimeType: "image/png", size: BYTES.byteLength, parents: ["fA"] },
    [FILE_B]: { id: FILE_B, name: "other.png", mimeType: "image/png", size: 3, parents: ["fB"] },
  };
  return {
    listFiles: vi.fn(async (folderId: string) => Object.values(files).filter((f) => f.parents.includes(folderId))),
    fileMeta: vi.fn(async (id: string) => files[id] ?? null),
    downloadFile: vi.fn(async () => new Uint8Array(BYTES)),
  };
}

async function setup() {
  const bus = await hostBus();
  const b = broker();
  const brokerFor = vi.fn(async (_ctx: unknown, _companyId: string) => b as any);
  registerDriveReadRoutes(pluginCtx(bus, "partnersinbiz.crm"), brokerFor);
  return { bus, b, brokerFor, studio: pluginCtx(bus, "partnersinbiz.studio") };
}

const client = { kind: "company", ref: "co-a" };

describe("Drive list and read routes on the host event bus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Studio's driveList reaches the CRM and gets the client's 02 Assets files back", async () => {
    const { studio, brokerFor } = await setup();
    const result = await driveList(studio, { companyId: "company-a", client, timeoutMs: 2_000 });
    expect(result).toMatchObject({ status: "listed", files: [{ id: FILE_A, name: "hero.png" }] });
    expect(brokerFor).toHaveBeenCalledWith(expect.anything(), "company-a");
  });

  it("Studio's driveRead gets the file bytes back", async () => {
    const { studio } = await setup();
    const result = await driveRead(studio, { companyId: "company-a", client, fileId: FILE_A, timeoutMs: 2_000 });
    expect(result.status).toBe("read");
    if (result.status === "read") expect(Buffer.from(result.bytes).toString()).toBe(BYTES.toString());
  });

  it("a file in another client's folder of the same company is refused, no bytes leave", async () => {
    const { studio, b } = await setup();
    const result = await driveRead(studio, { companyId: "company-a", client, fileId: FILE_B, timeoutMs: 2_000 });
    expect(result).toMatchObject({ status: "failed", reason: "not_in_client_folder" });
    expect(b.downloadFile).not.toHaveBeenCalled();
  });

  it("another company can't reach company-a's client: no project in its own company, no bytes", async () => {
    const { studio, b, brokerFor } = await setup();
    const result = await driveRead(studio, { companyId: "company-b", client, fileId: FILE_A, timeoutMs: 2_000 });
    expect(result).toMatchObject({ status: "failed", reason: "no_project" });
    expect(brokerFor).not.toHaveBeenCalledWith(expect.anything(), "company-a");
    expect(b.downloadFile).not.toHaveBeenCalled();
  });

  it("an unknown plugin's list and read requests are never heard", async () => {
    const { bus, b, brokerFor } = await setup();
    const other = pluginCtx(bus, "someone.else");
    expect((await driveList(other, { companyId: "company-a", client, timeoutMs: 100 })).status).toBe("no_ack");
    expect((await driveRead(other, { companyId: "company-a", client, fileId: FILE_A, timeoutMs: 100 })).status).toBe("no_ack");
    expect(brokerFor).not.toHaveBeenCalled();
    expect(b.downloadFile).not.toHaveBeenCalled();
  });

  it("a broker error comes back as a failure reply, not a timeout", async () => {
    const { studio, b } = await setup();
    b.listFiles.mockRejectedValueOnce(new Error("google down"));
    expect(await driveList(studio, { companyId: "company-a", client, timeoutMs: 2_000 })).toMatchObject({ status: "failed", reason: "broker_error", hint: "google down" });
  });
});
