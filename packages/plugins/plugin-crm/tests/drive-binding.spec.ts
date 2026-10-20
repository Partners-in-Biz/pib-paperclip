import { describe, it, expect } from "vitest";
import { boot, CO, toolRaw, seed } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";
import { effectiveSharedDriveId } from "../src/drive/binding.js";

async function setupBinding(config: Record<string, any> = {}, store?: Record<string, any>) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  return { harness };
}

describe("Drive binding tools", () => {
  it("declares two binding tools with schemas and descriptions", () => {
    // Tools are declared in DRIVE_TOOLS; should have 6 total (4 folder tools + 2 binding tools)
    expect(DRIVE_TOOLS).toHaveLength(6);
    expect(DRIVE_TOOLS[4].name).toBe("drive_binding_discover");
    expect(DRIVE_TOOLS[5].name).toBe("drive_binding_set");
    expect(DRIVE_TOOLS[4].description).toContain("exact case-insensitive");
    expect(DRIVE_TOOLS[5].description).toContain("Shared Drive");
  });

  it("single exact match (case-insensitive, trimmed) auto-binds", async () => {
    const st = seed();
    // The Paperclip company is "PiB" (see boot function)
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "  PiB  " },
      { id: "drive-2", name: "Other Drive" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.data?.bound).toBe(true);
    expect(result.data?.autoPicked).toBe(true);
    expect(result.data?.sharedDriveId).toBe("drive-1");
    expect(result.data?.name).toBe("  PiB  ");
  });

  it("several matches: sets nothing, returns candidates with reason 'several'", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st);

    const drives = [
      { id: "drive-1", name: "PiB" },
      { id: "drive-2", name: "pib" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.data?.bound).toBe(false);
    expect(result.data?.reason).toBe("several");
    expect(result.data?.candidates).toEqual(drives);
  });

  it("no matches: sets nothing, returns candidates with reason 'none'", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st);

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
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st);

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
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st);

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

  it("two companies independent: binding state is scoped to company", async () => {
    // This tests that state is scoped to company (two separate harnesses)
    const st1 = seed();
    const st2 = seed();
    const { harness: h1 } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st1);
    const { harness: h2 } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st2);

    // Set binding in harness1 after discover to ensure state is recorded
    const drives1 = [{ id: "drive-a", name: "First Drive" }];
    await toolRaw(h1, "drive_binding_discover", { drives: drives1 });
    const set1 = await toolRaw(h1, "drive_binding_set", { sharedDriveId: "drive-a" });
    expect(set1.data?.bound).toBe(true);

    // Discover in harness2 should return empty state (no binding yet)
    const drives2 = [{ id: "drive-b", name: "Second Drive" }];
    const discover2 = await toolRaw(h2, "drive_binding_discover", { drives: drives2 });
    expect(discover2.data?.bound).toBe(false);
    expect(discover2.data?.reason).toBe("none"); // No match for "Second Drive"
  });

  it("token value never appears in errors or output", async () => {
    const { harness } = await setupBinding({
      driveBrokerToken: "secret-fake-token-12345",
      drive: { sharedDriveId: "" },
    });

    const drives = [{ id: "drive-1", name: "Other" }];
    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    const jsonStr = JSON.stringify(result);
    expect(jsonStr).not.toContain("secret-fake-token-12345");
  });

  it("config-pinned id is not overwritten by discover", async () => {
    const st = seed();
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "config-pinned-drive" } }, st);

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
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "config-pinned-drive" } }, st);

    const drives = [
      { id: "drive-1", name: "Drive One" },
    ];
    await toolRaw(harness, "drive_binding_discover", { drives });

    const result = await toolRaw(harness, "drive_binding_set", { sharedDriveId: "drive-1" });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("pinned");
  });

  it("discover rejects empty drive id", async () => {
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } });

    const drives = [
      { id: "", name: "Invalid Drive" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("id must be a non-empty string");
  });

  it("discover rejects empty drive name", async () => {
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } });

    const drives = [
      { id: "drive-1", name: "" },
    ];

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("name must be a non-empty string");
  });

  it("discover rejects drives list exceeding 500 entries", async () => {
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } });

    const drives = Array.from({ length: 501 }, (_, i) => ({
      id: `drive-${i}`,
      name: `Drive ${i}`,
    }));

    const result = await toolRaw(harness, "drive_binding_discover", { drives });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("exceeds 500");
  });

  it("malformed drives input in discover", async () => {
    const { harness } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } });

    const result = await toolRaw(harness, "drive_binding_discover", { drives: "not an array" });
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Missing or invalid");
  });
});
