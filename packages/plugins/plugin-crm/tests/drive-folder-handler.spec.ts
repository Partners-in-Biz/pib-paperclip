import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { driveFolderPage } from "../src/drive/tools.js";
import type { Broker } from "../src/drive/broker.js";
import type { Viewer } from "../src/domain.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const CO = "co-1";
const HOST_COMPANY = "host-co";
const CRM_COMPANY = "acme";
const OWNER = { type: "user" as const, userId: "local-board" };

/**
 * A small in-memory stand-in for the CRM namespace (same as worker.spec.ts).
 */
function fakeDb(store: Store) {
  const tableOf = (sql: string) => new RegExp(`(?:FROM|INTO|UPDATE)\\s+${NAMESPACE}\\.(\\w+)`).exec(sql)?.[1] ?? "";
  const rowsOf = (name: string) => (store[name] ??= []);
  return {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      const name = tableOf(sql);
      const rows = rowsOf(name);
      if (/WHERE id = \$1/.test(sql)) return rows.filter((row) => row.id === params[0]);
      const inCompany = rows.filter((row) => row.company_id === params[0]);
      return inCompany;
    },
    async execute(sql: string, params: unknown[] = []) {
      const name = tableOf(sql);
      if (/^\s*INSERT/.test(sql)) {
        const columns = /\(([^)]+)\)\s*VALUES/.exec(sql)![1]!.split(",").map((column) => column.trim());
        rowsOf(name).push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    },
  };
}

function seedStore(): Store {
  return {};
}

async function boot(config: Record<string, unknown> = {}) {
  const store = seedStore();
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", ...config } });
  harness.seed({ companies: [{ id: HOST_COMPANY, issuePrefix: "PIB", name: "PiB" } as never] });
  (harness.ctx as unknown as { db: ReturnType<typeof fakeDb> }).db = fakeDb(store);
  await plugin.definition.setup(harness.ctx);
  return { harness, store };
}

/** Stage B-3 (PAR-15205): the old `drive-folder` data handler is the action `crm.drive-folder`; the same answers. */
describe("crm.drive-folder (driveFolderPage)", () => {
  const viewer: Viewer = { companyId: HOST_COMPANY, userId: "local-board", agentId: null, role: "owner" };
  const page = (harness: Awaited<ReturnType<typeof boot>>["harness"], params: Record<string, unknown>, broker: Partial<Broker> | null | Error) =>
    driveFolderPage(harness.ctx, viewer, params, { brokerFor: vi.fn(async () => { if (broker instanceof Error) throw broker; return broker as Broker | null; }) });

  it("resolves the CRM company's folder on the caller's company: its last path segment and its link", async () => {
    const { harness } = await boot();
    const resolve = vi.fn().mockResolvedValue({ path: "Acme/John Doe", folder_url: "https://drive.google.com/drive/folders/acme123", folder_id: "acme123" });
    const brokerFor = vi.fn(async () => ({ resolve }) as unknown as Broker);
    expect(await driveFolderPage(harness.ctx, viewer, { crmCompanyId: CRM_COMPANY }, { brokerFor })).toEqual({ folder: { name: "John Doe", url: "https://drive.google.com/drive/folders/acme123" } });
    expect(brokerFor).toHaveBeenCalledWith(expect.any(Object), HOST_COMPANY);
    expect(resolve).toHaveBeenCalledWith("crm_company", CRM_COMPANY);
  });

  it("no folder, no broker, a broker error or a missing crmCompanyId: {folder: null}", async () => {
    const { harness } = await boot();
    expect(await page(harness, { crmCompanyId: CRM_COMPANY }, { resolve: vi.fn().mockResolvedValue(null) })).toEqual({ folder: null });
    expect(await page(harness, { crmCompanyId: CRM_COMPANY }, null)).toEqual({ folder: null });
    expect(await page(harness, { crmCompanyId: CRM_COMPANY }, { resolve: vi.fn().mockRejectedValue(new Error("Broker error")) })).toEqual({ folder: null });
    expect(await page(harness, { crmCompanyId: CRM_COMPANY }, new Error("not bound"))).toEqual({ folder: null });
    const brokerFor = vi.fn();
    expect(await driveFolderPage(harness.ctx, viewer, {}, { brokerFor })).toEqual({ folder: null });
    expect(brokerFor).not.toHaveBeenCalled();
  });

  it("a path with one segment is its own name", async () => {
    const { harness } = await boot();
    const resolve = vi.fn().mockResolvedValue({ path: "SingleFolder", folder_url: "https://drive.google.com/drive/folders/single", folder_id: "single" });
    expect((await page(harness, { crmCompanyId: CRM_COMPANY }, { resolve })).folder?.name).toBe("SingleFolder");
  });
});

describe("crm.drive-folder on the real native broker (only Google is faked)", () => {
  const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };
  const FOLDER = "application/vnd.google-apps.folder";

  beforeEach(() => clearServiceAccountTokenCache());

  afterEach(() => vi.unstubAllGlobals());

  // The page action through the guard (switch off: it passes), on the host company of the call.
  const handler = (harness: Awaited<ReturnType<typeof boot>>["harness"]) =>
    harness.performAction<{ folder: { name: string; url: string } | null }>("crm.drive-folder", { crmCompanyId: CRM_COMPANY }, { companyId: HOST_COMPANY, actor: OWNER });

  it("returns the company folder Drive holds for the CRM company: its name and its Drive link", async () => {
    const google = fakeGoogle();
    google.files.push({ id: "cf1", name: "Acme (John Doe)", mimeType: FOLDER, parents: [DRIVE_ID], description: "Acme (John Doe)", appProperties: { pibEntityType: "crm_company", pibEntityId: CRM_COMPANY } });
    google.files.push({ id: "cf2", name: "Other (Someone)", mimeType: FOLDER, parents: [DRIVE_ID], description: "Other (Someone)", appProperties: { pibEntityType: "crm_company", pibEntityId: "other" } });
    vi.stubGlobal("fetch", google.fetchFn);
    const { harness } = await boot(NATIVE);

    expect(await handler(harness)).toEqual({ folder: { name: "Acme (John Doe)", url: "https://drive.google.com/drive/folders/cf1" } });
    // Read-only: it looked the folder up and created nothing
    expect(google.calls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(google.files).toHaveLength(2);
  });

  it("a company with no folder yet is {folder: null}, and the handler never creates one", async () => {
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchFn);
    const { harness } = await boot(NATIVE);

    expect(await handler(harness)).toEqual({ folder: null });
    expect(google.files).toHaveLength(0);
  });

  it("an unconfigured Drive (no key, or no Shared Drive) never calls Google, and Google refusing the service account: both are {folder: null}", async () => {
    const unconfigured = fakeGoogle();
    vi.stubGlobal("fetch", unconfigured.fetchFn);
    expect(await handler((await boot({})).harness)).toEqual({ folder: null });
    expect(await handler((await boot({ driveServiceAccountJson: KEY_JSON })).harness)).toEqual({ folder: null });
    expect(unconfigured.calls).toHaveLength(0);

    clearServiceAccountTokenCache();
    vi.stubGlobal("fetch", fakeGoogle({ filesStatus: 403 }).fetchFn);
    expect(await handler((await boot(NATIVE)).harness)).toEqual({ folder: null });
  });
});
