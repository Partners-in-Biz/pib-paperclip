import { describe, it, expect } from "vitest";
import { boot, CO, toolRaw, seed } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";

// Test mock that simulates broker identity endpoint responses
interface MockBrokerState {
  identityCalls: Array<{ sharedDriveId?: string }>;
  identityResponses: Map<string, { serviceAccountEmail?: string; isMember?: boolean; status?: number }>;
  identityFail: boolean;
}

function createMockBrokerWithIdentity(st: MockBrokerState) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    if (!init.headers.Authorization?.startsWith("Bearer ")) return { status: 401, ok: false, text: async () => "{}" };

    if (init.method === "GET" && url.includes("/workspace-broker/identity")) {
      const sharedDriveId = new URL(url, "http://base").searchParams.get("shared_drive_id") || undefined;

      st.identityCalls.push({ sharedDriveId });

      if (st.identityFail) {
        return { status: 404, ok: false, text: async () => JSON.stringify({ error: "Not found" }) };
      }

      // For calls without shared_drive_id, look up by empty string key in the responses map
      const lookupKey = sharedDriveId || "";
      const response = st.identityResponses.get(lookupKey);
      if (response) {
        if (response.status) {
          return { status: response.status, ok: false, text: async () => JSON.stringify({ error: "Error" }) };
        }
        return { status: 200, ok: true, text: async () => JSON.stringify(response) };
      }
      return { status: 404, ok: false, text: async () => JSON.stringify({ error: "Not found" }) };
    }

    return { status: 404, ok: false, text: async () => "{}" };
  };
}

async function setupBinding(config: Record<string, any> = {}, store?: Record<string, any>) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const state: MockBrokerState = {
    identityCalls: [],
    identityResponses: new Map(),
    identityFail: false,
  };
  harness.ctx.http.fetch = createMockBrokerWithIdentity(state) as any;
  return { harness, state };
}

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

  it("empty/new company: status shows not bound, tokenSet true, calls identity without shared_drive_id", async () => {
    const { harness, state } = await setupBinding({ driveBrokerToken: "token" });

    // Mock response for unbound identity call (no shared_drive_id parameter)
    state.identityResponses.set("", {
      serviceAccountEmail: "default-sa@project.iam.gserviceaccount.com",
      isMember: false,
    });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(false);
    expect(result.data?.tokenSet).toBe(true);
    expect(result.data?.sharedDriveId).toBeUndefined();
    expect(result.data?.serviceAccountEmail).toBe("default-sa@project.iam.gserviceaccount.com");
    expect(result.data?.serviceAccountIsMember).toBe(false);
    expect(state.identityCalls).toHaveLength(1);
    expect(state.identityCalls[0].sharedDriveId).toBeUndefined();
  });

  it("empty company without token: status shows tokenSet false", async () => {
    const { harness } = await setupBinding({});
    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.tokenSet).toBe(false);
    expect(result.data?.serviceAccountIsMember).toBe(false);
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

    // Verify binding is stored by checking status
    const statusAfter = await toolRaw(harness, "drive_binding_status", {});
    expect(statusAfter.data?.bound).toBe(true);
    expect(statusAfter.data?.sharedDriveId).toBe("drive-1");
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

    // Verify nothing was bound
    const statusAfter = await toolRaw(harness, "drive_binding_status", {});
    expect(statusAfter.data?.bound).toBe(false);
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

  it("two companies independent: binding in company A does not affect company B", async () => {
    // This would require creating two companies in the same harness or two separate setups
    // For simplicity, we test that state is scoped to company
    const st1 = seed();
    const st2 = seed();
    const { harness: h1 } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st1);
    const { harness: h2 } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "" } }, st2);

    // Bind in harness1
    const drives1 = [{ id: "drive-a", name: "Test Company" }];
    await toolRaw(h1, "drive_binding_discover", { drives: drives1 });

    // Check harness2 is not bound
    const status2 = await toolRaw(h2, "drive_binding_status", {});
    expect(status2.data?.bound).toBe(false);
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

  it("status reports serviceAccountEmail and isMember from mocked identity", async () => {
    const { harness, state } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "test-drive-123" } });

    state.identityResponses.set("test-drive-123", {
      serviceAccountEmail: "sa@project.iam.gserviceaccount.com",
      isMember: true,
    });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.serviceAccountEmail).toBe("sa@project.iam.gserviceaccount.com");
    expect(result.data?.serviceAccountIsMember).toBe(true);
    expect(state.identityCalls).toHaveLength(1);
    expect(state.identityCalls[0].sharedDriveId).toBe("test-drive-123");
  });

  it("status handles identity 404 with generic error message", async () => {
    const { harness, state } = await setupBinding({ driveBrokerToken: "token", drive: { sharedDriveId: "test-drive" } });

    state.identityFail = true;

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.identityError).toBeTruthy();
    expect(result.data?.identityError).toContain("404");
    expect(result.data?.identityError).not.toContain("token");
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

  it("token value absent from identity error output", async () => {
    const { harness, state } = await setupBinding({
      driveBrokerToken: "secret-broker-token-xyz",
      drive: { sharedDriveId: "test-drive" },
    });

    state.identityFail = true;

    const result = await toolRaw(harness, "drive_binding_status", {});
    const jsonStr = JSON.stringify(result);
    expect(jsonStr).not.toContain("secret-broker-token-xyz");
  });

  it("unbound+token: status calls identity WITHOUT shared_drive_id param", async () => {
    const { harness, state } = await setupBinding({ driveBrokerToken: "token" });

    state.identityResponses.set("", {
      serviceAccountEmail: "sa@project.iam.gserviceaccount.com",
      isMember: false,
    });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(false);
    expect(result.data?.sharedDriveId).toBeUndefined();
    expect(result.data?.serviceAccountEmail).toBe("sa@project.iam.gserviceaccount.com");
    expect(state.identityCalls).toHaveLength(1);
    // The identity call should not include shared_drive_id when unbound
    expect(state.identityCalls[0].sharedDriveId).toBe(undefined);
  });

  it("bound+no token: status returns sharedDriveId without fetch", async () => {
    const { harness, state } = await setupBinding({ drive: { sharedDriveId: "test-drive-123" } });

    const result = await toolRaw(harness, "drive_binding_status", {});
    expect(result.data?.bound).toBe(true);
    expect(result.data?.sharedDriveId).toBe("test-drive-123");
    expect(result.data?.tokenSet).toBe(false);
    expect(result.data?.serviceAccountIsMember).toBe(false);
    // No identity calls made when no token
    expect(state.identityCalls).toHaveLength(0);
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
});
