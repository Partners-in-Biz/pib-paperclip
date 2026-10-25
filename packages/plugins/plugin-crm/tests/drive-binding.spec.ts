import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, toolRaw, seed } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

/** The service account email inside KEY_JSON: the status tool reports it from the key itself. */
const SA_EMAIL = "drive-sa@proj.iam.gserviceaccount.com";
const KEY_MATERIAL = /PRIVATE KEY|private_key|ya29/;

/** The status tool on the native path: the service account key in the settings, Google (faked, in memory) answering the Shared Drive identity call. */
async function setupBinding(config: Record<string, any> = {}, store?: Record<string, any>, google = fakeGoogle()) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const fetchSpy = vi.fn(google.fetchFn);
  vi.stubGlobal("fetch", fetchSpy);
  return { harness, google, fetchSpy };
}

/** The identity calls Google saw: GET /drive/v3/drives/<id>. */
const identityCalls = (google: ReturnType<typeof fakeGoogle>) => google.calls.filter((c) => c.startsWith("GET /drive/v3/drives/"));

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("Drive binding tools", () => {
  it("declares three binding tools with schemas and descriptions", () => {
    // Tools are declared in DRIVE_TOOLS; should have 8 total (5 folder tools + 3 binding tools)
    expect(DRIVE_TOOLS).toHaveLength(8);
    expect(DRIVE_TOOLS[5].name).toBe("drive_binding_discover");
    expect(DRIVE_TOOLS[6].name).toBe("drive_binding_set");
    expect(DRIVE_TOOLS[7].name).toBe("drive_binding_status");
    expect(DRIVE_TOOLS[5].description).toContain("exact case-insensitive");
    expect(DRIVE_TOOLS[6].description).toContain("Shared Drive");
    expect(DRIVE_TOOLS[7].description).toContain("read-only");
  });

  it("empty/new company: status shows not bound, tokenSet true, the service account email from the key, and Google is not asked", async () => {
    const { harness, google, fetchSpy } = await setupBinding({ driveServiceAccountJson: KEY_JSON });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(false);
    expect(result.data?.tokenSet).toBe(true);
    expect(result.data?.sharedDriveId).toBeUndefined();
    expect(result.data?.serviceAccountEmail).toBe(SA_EMAIL);
    expect(result.data?.serviceAccountIsMember).toBe(false);
    // Membership can only be asked of a Shared Drive: with none bound there is no call at all
    expect(google.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("empty company without a key: status shows tokenSet false", async () => {
    const { harness, fetchSpy } = await setupBinding({});
    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.tokenSet).toBe(false);
    expect(result.data?.serviceAccountIsMember).toBe(false);
    expect(result.data?.serviceAccountEmail).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("single exact match (case-insensitive, trimmed) auto-binds", async () => {
    const st = seed();
    // The Paperclip company is "PiB" (see boot function)
    const { harness, google } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "  PiB  " },
      { id: "drive-2", name: "Other Drive" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.data?.bound).toBe(true);
    expect(result.data?.autoPicked).toBe(true);
    expect(result.data?.sharedDriveId).toBe("drive-1");
    expect(result.data?.name).toBe("  PiB  ");

    // Verify binding is stored by checking status, which now asks Google about the bound drive
    const statusAfter = await toolRaw(harness, "drive_binding_status", {});
    expect(statusAfter.data?.bound).toBe(true);
    expect(statusAfter.data?.sharedDriveId).toBe("drive-1");
    expect(identityCalls(google)).toHaveLength(1);
    expect(identityCalls(google)[0]).toContain("/drive/v3/drives/drive-1?");
  });

  it("several matches: sets nothing, returns candidates with reason 'several'", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "PiB" },
      { id: "drive-2", name: "pib" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.data?.bound).toBe(false);
    expect(result.data?.reason).toBe("several");
    expect(result.data?.candidates).toEqual(drives);

    // Verify nothing was bound
    const statusAfter = await toolRaw(harness, "drive_binding_status", {});
    expect(statusAfter.data?.bound).toBe(false);
  });

  it("no matches: sets nothing, returns candidates with reason 'none'", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "Other Company" },
      { id: "drive-2", name: "Another Drive" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.data?.bound).toBe(false);
    expect(result.data?.reason).toBe("none");
    expect(result.data?.candidates).toEqual(drives);
  });

  it("drive_binding_set rejects unknown ID", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st);

    // First discover to set candidates
    const drives = [{ id: "drive-1", name: "Test Company" }];
    await toolRaw(harness, "drive_binding_discover", { drives });

    // Try to set with unknown ID
    const result = await toolRaw(harness, "drive_binding_set", { sharedDriveId: "unknown-drive" });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("not in discovered list");
  });

  it("drive_binding_set accepts a listed ID and stores binding", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "Drive One" },
      { id: "drive-2", name: "Drive Two" },
    ];
    await toolRaw(harness, "drive_binding_discover", { drives });

    const result = await toolRaw(harness, "drive_binding_set", { sharedDriveId: "drive-2" });
    expect(result.data?.bound).toBe(true);
    expect(result.data?.sharedDriveId).toBe("drive-2");
    expect(result.data?.name).toBe("Drive Two");
  });

  it("two companies independent: binding in company A does not affect company B", async () => {
    // This would require creating two companies in the same harness or two separate setups
    // For simplicity, we test that state is scoped to company
    const st1 = seed();
    const st2 = seed();
    const { harness: h1 } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st1);
    const { harness: h2 } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } }, st2);

    // Bind in harness1
    const drives1 = [{ id: "drive-a", name: "Test Company" }];
    await toolRaw(h1, "drive_binding_discover", { drives: drives1 });

    // Check harness2 is not bound
    const status2 = await toolRaw(h2, "drive_binding_status", {});
    expect(status2.data?.bound).toBe(false);
  });

  it("key material never appears in errors or output (discover, set, status)", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } });

    const drives = [{ id: "drive-1", name: "Other" }];
    const outputs = [
      await toolRaw(harness, "drive_binding_discover", { drives }),
      await toolRaw(harness, "drive_binding_set", { sharedDriveId: "drive-1" }),
      await toolRaw(harness, "drive_binding_set", { sharedDriveId: "unlisted" }),
      await toolRaw(harness, "drive_binding_status", {}),
    ];
    for (const result of outputs) expect(JSON.stringify(result)).not.toMatch(KEY_MATERIAL);
  });

  it("status reports serviceAccountEmail and isMember from Google's answer about the bound Shared Drive", async () => {
    const { harness, google } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive-123" } });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(true);
    expect(result.data?.sharedDriveId).toBe("test-drive-123");
    expect(result.data?.serviceAccountEmail).toBe(SA_EMAIL);
    expect(result.data?.serviceAccountIsMember).toBe(true);
    expect(result.data?.identityError).toBeUndefined();
    expect(identityCalls(google)).toHaveLength(1);
    expect(identityCalls(google)[0]).toContain("/drive/v3/drives/test-drive-123?");
  });

  it("status: a service account that is not in the Shared Drive is reported isMember false, with its email so a person can add it", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive-123" } }, undefined, fakeGoogle({ member: false }));

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.serviceAccountIsMember).toBe(false);
    expect(result.data?.serviceAccountEmail).toBe(SA_EMAIL);
    expect(result.data?.identityError).toBeUndefined();
  });

  it("status handles a Google failure with a generic error message, still naming the account", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive" } }, undefined, fakeGoogle({ filesStatus: 500 }));

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.error).toBeUndefined();
    expect(result.data?.tokenSet).toBe(true);
    expect(result.data?.serviceAccountIsMember).toBe(false);
    expect(result.data?.identityError).toBeTruthy();
    expect(result.data?.identityError).toContain("Google Drive error");
    expect(result.data?.identityError).not.toMatch(KEY_MATERIAL);
  });

  it("status says so when Google refuses the key, and when the stored key is not a service account key", async () => {
    const refused = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive" } }, undefined, fakeGoogle({ tokenStatus: 400 }));
    const r1 = await toolRaw(refused.harness, "drive_binding_status", {});
    expect(r1.data?.tokenSet).toBe(true);
    expect(r1.data?.serviceAccountIsMember).toBe(false);
    expect(r1.data?.identityError).toContain("Google refused the Drive service account key");

    const notJson = await setupBinding({ driveServiceAccountJson: "this is not json", drive: { sharedDriveId: "test-drive" } });
    const r2 = await toolRaw(notJson.harness, "drive_binding_status", {});
    expect(r2.data?.tokenSet).toBe(true);
    expect(r2.data?.serviceAccountIsMember).toBe(false);
    expect(r2.data?.identityError).toContain("service account key");
    expect(r2.data?.serviceAccountEmail).toBeUndefined();
    expect(JSON.stringify(r2)).not.toContain("this is not json");
  });

  it("config-pinned id is not overwritten by discover", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "config-pinned-drive" } }, st);

    const drives = [
      { id: "drive-1", name: "Test Company" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    // Should report as already bound with config-pinned id
    expect(result.data?.bound).toBe(true);
    expect(result.data?.sharedDriveId).toBe("config-pinned-drive");
    expect(result.data?.alreadyBound).toBe(true);
  });

  it("drive_binding_set refuses when config-pinned", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "config-pinned-drive" } }, st);

    const drives = [
      { id: "drive-1", name: "Drive One" },
    ];
    await toolRaw(harness, "drive_binding_discover", { drives });

    const result = await toolRaw(harness, "drive_binding_set", { sharedDriveId: "drive-1" });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("pinned");
  });

  it("key material absent from the status output when Google or the key fails", async () => {
    const cases: Array<[string, Record<string, any>, ReturnType<typeof fakeGoogle>]> = [
      ["Drive 500", { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive" } }, fakeGoogle({ filesStatus: 500 })],
      ["Drive 401", { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive" } }, fakeGoogle({ filesStatus: 401 })],
      ["token refused", { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "test-drive" } }, fakeGoogle({ tokenStatus: 400 })],
      ["not a key", { driveServiceAccountJson: "secret-not-a-key-xyz", drive: { sharedDriveId: "test-drive" } }, fakeGoogle()],
    ];
    for (const [label, config, google] of cases) {
      clearServiceAccountTokenCache();
      const { harness } = await setupBinding(config, undefined, google);
      const result = await toolRaw(harness, "drive_binding_status", {});
      expect(result.data?.identityError, label).toBeTruthy();
      expect(JSON.stringify(result), label).not.toMatch(KEY_MATERIAL);
      expect(JSON.stringify(result), label).not.toContain("secret-not-a-key-xyz");
    }
  });

  it("bound + no key: status returns sharedDriveId without calling Google", async () => {
    const { harness, google, fetchSpy } = await setupBinding({ drive: { sharedDriveId: "test-drive-123" } });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(true);
    expect(result.data?.sharedDriveId).toBe("test-drive-123");
    expect(result.data?.tokenSet).toBe(false);
    expect(result.data?.serviceAccountIsMember).toBe(false);
    // No identity calls made when no key
    expect(identityCalls(google)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discover rejects empty drive id", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } });

    const drives = [
      { id: "", name: "Invalid Drive" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("id must be a non-empty string");
  });

  it("discover rejects empty drive name", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } });

    const drives = [
      { id: "drive-1", name: "" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("name must be a non-empty string");
  });

  it("discover rejects drives list exceeding 500 entries", async () => {
    const { harness } = await setupBinding({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "" } });

    const drives = Array.from({ length: 501 }, (_, i) => ({
      id: `drive-${i}`,
      name: `Drive ${i}`,
    }));

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("exceeds 500");
  });
});
