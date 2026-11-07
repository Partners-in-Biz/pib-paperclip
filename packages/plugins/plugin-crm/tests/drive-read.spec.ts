/**
 * The drive.list / drive.read routes (PAR-8107): a read reaches only the asked-for client's own assets folders.
 * The folder lookup (driveFolderEnsure / resolveProducerSaveProject) is faked; the broker is a fake with two clients' files.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FOLDERS: Record<string, { path: string; folder_id: string; tree: Array<{ path: string; folderId: string }> }> = {
  "p-acme": {
    path: "Clients/Acme",
    folder_id: "f-acme",
    tree: [
      { path: "Clients/Acme/Assets/Images", folderId: "f-acme-img" },
      { path: "Clients/Acme/Assets/Social", folderId: "f-acme-soc" },
      { path: "Clients/Acme/Contracts & Quotes", folderId: "f-acme-contracts" },
    ],
  },
  "p-beta": { path: "Clients/Beta", folder_id: "f-beta", tree: [{ path: "Clients/Beta/Assets/Images", folderId: "f-beta-img" }] },
};
const PROJECT_OF: Record<string, string> = { "company:acme": "p-acme", "company:beta": "p-beta" };

vi.mock("../src/drive/tools.js", () => ({
  createBrokerForCompany: vi.fn(),
  resolveProducerSaveProject: vi.fn(async (_ctx: unknown, _co: string, input: { clientKind?: string; clientRef?: string }) => PROJECT_OF[`${input.clientKind}:${input.clientRef}`] ?? null),
  driveFolderEnsure: vi.fn(async (_ctx: unknown, _viewer: unknown, p: { entity_id: string }) => ({ status: "exists", ...FOLDERS[p.entity_id] })),
}));

const { listAssetFiles, readAssetFile, registerDriveReadRoutes } = await import("../src/drive/read.js");

const file = (id: string, parent: string, name = `${id}.png`, size = 3) => ({ id, name, mimeType: "image/png", size, parents: [parent] });
const FILES = [file("acmeImage000001", "f-acme-img"), file("acmeSocial00001", "f-acme-soc"), file("acmeContract001", "f-acme-contracts", "quote.pdf"), file("betaImage000001", "f-beta-img"), file("acmeHuge0000001", "f-acme-img", "huge.png", 6 * 1024 * 1024)];
const downloads: string[] = [];
const broker = {
  listFiles: vi.fn(async (parent: string) => FILES.filter((f) => f.parents.includes(parent))),
  fileMeta: vi.fn(async (id: string) => FILES.find((f) => f.id === id) ?? null),
  downloadFile: vi.fn(async (id: string) => {
    downloads.push(id);
    return new Uint8Array([1, 2, 3]);
  }),
};
const brokerFor = async () => broker as never;
const ctx = { logger: { info: vi.fn() } } as never;
const ACME = { clientKind: "company", clientRef: "acme" };

describe("Drive read routes", () => {
  beforeEach(() => {
    downloads.length = 0;
  });

  it("lists only the client's Assets folders, with no links", async () => {
    const out = await listAssetFiles(ctx, "co-1", ACME, brokerFor);
    expect(out.status).toBe("ok");
    const files = (out as { files: Array<Record<string, unknown>> }).files;
    expect(files.map((f) => f.id)).toEqual(["acmeImage000001", "acmeHuge0000001", "acmeSocial00001"]);
    expect(Object.keys(files[0]!)).toEqual(["id", "name", "mimeType", "size"]);
  });

  it("reads a file in the client's own assets folder", async () => {
    const out = await readAssetFile(ctx, "co-1", ACME, "acmeImage000001", brokerFor);
    expect(out).toMatchObject({ status: "ok", file: { id: "acmeImage000001", size: 3 }, contentBase64: "AQID" });
  });

  it("refuses another client's file, a non-assets folder and a too-large file without downloading", async () => {
    expect(await readAssetFile(ctx, "co-1", ACME, "betaImage000001", brokerFor)).toMatchObject({ status: "not_in_client_folder" });
    expect(await readAssetFile(ctx, "co-1", ACME, "acmeContract001", brokerFor)).toMatchObject({ status: "not_in_client_folder" });
    expect(await readAssetFile(ctx, "co-1", ACME, "acmeHuge0000001", brokerFor)).toMatchObject({ status: "too_large" });
    expect(await readAssetFile(ctx, "co-1", ACME, "missing00000001", brokerFor)).toMatchObject({ status: "not_found" });
    expect(await readAssetFile(ctx, "co-1", ACME, "../x", brokerFor)).toMatchObject({ status: "invalid_input" });
    expect(await readAssetFile(ctx, "co-1", { clientKind: "company", clientRef: "nobody" }, "acmeImage000001", brokerFor)).toMatchObject({ status: "no_project" });
    expect(downloads).toEqual([]);
  });

  it("answers the events on the CRM reply names, for the event's company", async () => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    const emit = vi.fn(async (..._args: unknown[]) => undefined);
    const evCtx = { logger: { info: vi.fn() }, events: { on: (n: string, h: (e: unknown) => Promise<void>) => handlers.set(n, h), emit } } as never;
    registerDriveReadRoutes(evCtx, brokerFor);
    await handlers.get("drive.read-requested")!({ companyId: "co-1", payload: { requestId: "r1", fileId: "betaImage000001", ...ACME } });
    await handlers.get("drive.list-requested")!({ companyId: "co-1", payload: { requestId: "r2", ...ACME } });
    expect(emit.mock.calls[0]).toEqual(["plugin.partnersinbiz.crm.drive.read.failed", "co-1", { requestId: "r1", reason: "not_in_client_folder", hint: expect.any(String) }]);
    expect(emit.mock.calls[1]![0]).toBe("plugin.partnersinbiz.crm.drive.files.listed");
  });
});
