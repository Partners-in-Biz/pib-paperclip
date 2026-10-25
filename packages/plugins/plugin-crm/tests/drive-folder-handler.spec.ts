import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

// Mock the drive/tools module before importing
vi.mock("../src/drive/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/drive/tools.js")>();
  return {
    ...actual,
    createBrokerForCompany: vi.fn(),
  };
});

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

describe("drive-folder data handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("happy path with both companyId and crmCompanyId => calls createBrokerForCompany and resolve with correct params", async () => {
    const { harness } = await boot();

    // Import the mocked module to get access to the mock function
    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    const mockBroker = {
      resolve: vi.fn().mockResolvedValue({
        path: "Acme/John Doe",
        folder_url: "https://drive.google.com/drive/folders/acme123",
        folder_id: "acme123",
      }),
    };
    (createBrokerForCompany as any).mockResolvedValue(mockBroker);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    // Assert that createBrokerForCompany was called with the host company id
    expect(createBrokerForCompany).toHaveBeenCalledWith(expect.any(Object), HOST_COMPANY);
    // Assert that broker.resolve was called with ("crm_company", crmCompanyId)
    expect(mockBroker.resolve).toHaveBeenCalledWith("crm_company", CRM_COMPANY);
    // Assert the structure and values of the result
    expect(result).toEqual({
      folder: {
        name: "John Doe", // Last path segment
        url: "https://drive.google.com/drive/folders/acme123",
      },
    });
  });

  it("resolve returns null => returns {folder: null}", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    const mockBroker = {
      resolve: vi.fn().mockResolvedValue(null),
    };
    (createBrokerForCompany as any).mockResolvedValue(mockBroker);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    expect(result).toEqual({ folder: null });
  });

  it("createBrokerForCompany returns null => returns {folder: null}", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    (createBrokerForCompany as any).mockResolvedValue(null);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    expect(result).toEqual({ folder: null });
  });

  it("missing companyId => returns {folder: null} and broker is not created", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { crmCompanyId: CRM_COMPANY },
    );

    expect(result).toEqual({ folder: null });
    expect(createBrokerForCompany).not.toHaveBeenCalled();
  });

  it("missing crmCompanyId => returns {folder: null} and broker is not created", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY },
    );

    expect(result).toEqual({ folder: null });
    expect(createBrokerForCompany).not.toHaveBeenCalled();
  });

  it("resolve throws an error => returns {folder: null}", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    const mockBroker = {
      resolve: vi.fn().mockRejectedValue(new Error("Broker error")),
    };
    (createBrokerForCompany as any).mockResolvedValue(mockBroker);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    expect(result).toEqual({ folder: null });
  });

  it("extracts folder name from last path segment", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    const mockBroker = {
      resolve: vi.fn().mockResolvedValue({
        path: "Very/Long/Path/Hierarchy/FolderName",
        folder_url: "https://drive.google.com/drive/folders/xyz789",
        folder_id: "xyz789",
      }),
    };
    (createBrokerForCompany as any).mockResolvedValue(mockBroker);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    expect(result.folder?.name).toBe("FolderName");
  });

  it("uses full path when no path segments exist", async () => {
    const { harness } = await boot();

    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    const mockBroker = {
      resolve: vi.fn().mockResolvedValue({
        path: "SingleFolder",
        folder_url: "https://drive.google.com/drive/folders/single",
        folder_id: "single",
      }),
    };
    (createBrokerForCompany as any).mockResolvedValue(mockBroker);

    const result = await harness.getData<{ folder: { name: string; url: string } | null }>(
      "drive-folder",
      { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY },
    );

    expect(result.folder?.name).toBe("SingleFolder");
  });
});

describe("drive-folder data handler on the real native broker (only Google is faked)", () => {
  const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };
  const FOLDER = "application/vnd.google-apps.folder";

  beforeEach(async () => {
    vi.clearAllMocks();
    clearServiceAccountTokenCache();
    // Run the genuine createBrokerForCompany inside the handler instead of the stub above.
    const actual = await vi.importActual<typeof import("../src/drive/tools.js")>("../src/drive/tools.js");
    const { createBrokerForCompany } = await import("../src/drive/tools.js");
    (createBrokerForCompany as any).mockImplementation(actual.createBrokerForCompany);
  });

  afterEach(() => vi.unstubAllGlobals());

  const handler = (harness: Awaited<ReturnType<typeof boot>>["harness"]) =>
    harness.getData<{ folder: { name: string; url: string } | null }>("drive-folder", { companyId: HOST_COMPANY, crmCompanyId: CRM_COMPANY });

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
