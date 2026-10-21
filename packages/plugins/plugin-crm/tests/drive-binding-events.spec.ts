import { describe, it, expect, beforeEach } from "vitest";
import { boot, CO, tool, toolRaw } from "./helpers/crm.js";
import { onDriveBindingSetEvent } from "../src/drive/binding.js";

describe("Drive binding events", () => {
  let setup: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    setup = await boot({
      config: {
        timezone: "Africa/Johannesburg",
        driveBrokerUrl: "https://broker.test",
        driveBrokerToken: "test-token",
        drive: { sharedDriveId: "" },
      },
    });
  });

  describe("event emission", () => {
    it("emits bare event name without secrets for discover/set/status", async () => {
      const drives = [{ id: "d1", name: "Test" }, { id: "d2", name: "Other" }];

      // Test discover
      await tool(setup.harness, "drive_binding_discover", { drives });
      let calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe(CO);
      expect(JSON.stringify(calls[0][2])).not.toMatch(/token|secret|Bearer|auth/i);

      setup.emit.mockClear();

      // Test set
      await tool(setup.harness, "drive_binding_set", { sharedDriveId: "d1" });
      calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toMatchObject({ bound: true, sharedDriveId: "d1" });
      expect(JSON.stringify(calls[0][2])).not.toMatch(/token|secret/i);

      setup.emit.mockClear();

      // Test status (without token fetch)
      await tool(setup.harness, "drive_binding_status", {});
      calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0][2])).not.toMatch(/token|secret/i);
    });

    it("does not fail tool when event emit throws", async () => {
      const originalEmit = setup.harness.ctx.events.emit;
      setup.harness.ctx.events.emit = async () => {
        throw new Error("Emit failed");
      };

      const drives = [{ id: "d1", name: "Test" }];
      const result = await toolRaw(setup.harness, "drive_binding_discover", { drives });
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();

      setup.harness.ctx.events.emit = originalEmit;
    });

    it("status after discover emits connected:true with stored candidates", async () => {
      const drives = [{ id: "d1", name: "Drive1" }, { id: "d2", name: "Drive2" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mockClear();

      // Call status without binding anything
      await tool(setup.harness, "drive_binding_status", {});
      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      const payload = calls[0][2];
      expect(payload).toMatchObject({
        connected: true, // because candidates.length > 0
        bound: false,
        candidates: [
          { id: "d1", name: "Drive1" },
          { id: "d2", name: "Drive2" },
        ],
      });
    });

    it("status with nothing stored emits connected:false and empty candidates", async () => {
      setup.emit.mockClear();
      await tool(setup.harness, "drive_binding_status", {});
      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      const payload = calls[0][2];
      expect(payload).toMatchObject({
        connected: false,
        bound: false,
        candidates: [],
      });
    });

    it("set-event payload has exact keys and candidates structure", async () => {
      const drives = [{ id: "d1", name: "Test1" }, { id: "d2", name: "Test2" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mockClear();

      await tool(setup.harness, "drive_binding_set", { sharedDriveId: "d1" });
      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      const payload = calls[0][2] as Record<string, unknown>;

      // Verify exact keys (sorted)
      const keys = Object.keys(payload).sort();
      expect(keys).toEqual(["bound", "candidates", "companyId", "connected", "serviceAccountIsMember", "sharedDriveId"]);

      // Verify candidates structure
      expect(payload.candidates).toEqual([
        { id: "d1", name: "Test1" },
        { id: "d2", name: "Test2" },
      ]);

      // serviceAccountEmail should be absent when unknown
      expect(payload).not.toHaveProperty("serviceAccountEmail");
    });

    it("rejected id event leaves drive_binding_status bound:false", async () => {
      const drives = [{ id: "d1", name: "Test" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mockClear();

      // Try to bind an invalid id via event (should fail silently)
      await onDriveBindingSetEvent(setup.harness.ctx, {
        companyId: CO,
        payload: { sharedDriveId: "invalid-id" },
      });

      // Check status - should still be unbound
      setup.emit.mockClear();
      await tool(setup.harness, "drive_binding_status", {});
      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toMatchObject({
        bound: false,
      });
    });

    it("malformed event payload neither throws nor emits", async () => {
      setup.emit.mockClear();

      // Missing sharedDriveId
      await expect(
        onDriveBindingSetEvent(setup.harness.ctx, {
          companyId: CO,
          payload: {},
        })
      ).resolves.not.toThrow();

      // sharedDriveId is a number instead of string
      await expect(
        onDriveBindingSetEvent(setup.harness.ctx, {
          companyId: CO,
          payload: { sharedDriveId: 123 },
        })
      ).resolves.not.toThrow();

      // No binding events should have been emitted for these invalid payloads
      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(0);
    });

    it("rejects discovery id not in candidates", async () => {
      const drives = [{ id: "d1", name: "Test" }];
      await tool(setup.harness, "drive_binding_discover", { drives });

      const result = await toolRaw(setup.harness, "drive_binding_set", { sharedDriveId: "invalid" });
      expect(result.error).toContain("not in discovered list");
    });
  });

  describe("onDriveBindingSetEvent handler", () => {
    it("binds valid candidate and emits event", async () => {
      const drives = [{ id: "d1", name: "Test" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mockClear();

      await onDriveBindingSetEvent(setup.harness.ctx, {
        companyId: CO,
        payload: { sharedDriveId: "d1" },
      });

      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toMatchObject({ bound: true, sharedDriveId: "d1" });
    });

    it("rejects unlisted id without storing or emitting", async () => {
      const drives = [{ id: "d1", name: "Test" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mockClear();

      await onDriveBindingSetEvent(setup.harness.ctx, {
        companyId: CO,
        payload: { sharedDriveId: "unlisted" },
      });

      const calls = setup.emit.mock.calls.filter((c) => c[0] === "drive.binding");
      expect(calls).toHaveLength(0);
    });

    it("handler errors do not throw", async () => {
      const drives = [{ id: "d1", name: "Test" }];
      await tool(setup.harness, "drive_binding_discover", { drives });

      const originalSet = setup.harness.ctx.state.set;
      setup.harness.ctx.state.set = async () => {
        throw new Error("State failed");
      };

      await expect(
        onDriveBindingSetEvent(setup.harness.ctx, {
          companyId: CO,
          payload: { sharedDriveId: "d1" },
        }),
      ).resolves.not.toThrow();

      setup.harness.ctx.state.set = originalSet;
    });
  });
});
