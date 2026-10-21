import { describe, it, expect, beforeEach } from "vitest";
import { boot, CO, tool, toolRaw } from "./helpers/crm.js";
import { DRIVE_BINDING_EVENT } from "../src/drive/binding.js";

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

  describe("drive.binding event emission", () => {
    it("emits drive.binding event after discover with unbound candidates", async () => {
      const drives = [
        { id: "d1", name: "Shared Drive One" },
        { id: "d2", name: "Shared Drive Two" },
      ];

      await tool(setup.harness, "drive_binding_discover", { drives });

      // Check that emit was called with the right event name
      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      expect(bindingCalls).toHaveLength(1);

      const [eventName, companyId, payloadUntyped] = bindingCalls[0];
      const payload = payloadUntyped as any;
      expect(eventName).toBe(DRIVE_BINDING_EVENT);
      expect(companyId).toBe(CO);

      // Verify payload shape and no secrets
      expect(payload).toMatchObject({
        companyId: CO,
        connected: true,
        bound: false,
        serviceAccountIsMember: false,
        candidates: drives,
      });

      // Ensure no secrets in payload
      expect(JSON.stringify(payload)).not.toMatch(/token|secret|Bearer|auth/i);
    });

    it("emits drive.binding event after successful set", async () => {
      const drives = [
        { id: "d1", name: "Shared Drive One" },
        { id: "d2", name: "Shared Drive Two" },
      ];

      // First discover to populate candidates
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mock.calls = []; // Clear previous calls

      // Now set the binding
      await tool(setup.harness, "drive_binding_set", { sharedDriveId: "d1" });

      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      expect(bindingCalls).toHaveLength(1);

      const [eventName, companyId, payloadUntyped] = bindingCalls[0];
      const payload = payloadUntyped as any;
      expect(eventName).toBe(DRIVE_BINDING_EVENT);
      expect(companyId).toBe(CO);

      // Verify bound state
      expect(payload).toMatchObject({
        companyId: CO,
        connected: true,
        bound: true,
        sharedDriveId: "d1",
        serviceAccountIsMember: false,
      });

      // Ensure candidates are included
      expect(payload.candidates).toBeDefined();
      expect(payload.candidates).toEqual(drives);
    });

    it("rejects set with id not in candidates", async () => {
      const drives = [{ id: "d1", name: "Shared Drive One" }];

      // First discover to populate candidates
      await tool(setup.harness, "drive_binding_discover", { drives });
      setup.emit.mock.calls = []; // Clear previous calls

      // Try to set with id not in candidates
      const result = await toolRaw(setup.harness, "drive_binding_set", { sharedDriveId: "d_invalid" });

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not in discovered list");

      // Verify no event was emitted (because tool failed)
      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      expect(bindingCalls).toHaveLength(0);
    });

    it("emits drive.binding event with exact payload keys", async () => {
      const drives = [{ id: "d1", name: "Test Drive" }];

      await tool(setup.harness, "drive_binding_discover", { drives });

      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      const payload = bindingCalls[0][2];

      // Check for exact keys (no extra, no missing)
      const keys = Object.keys(payload as any).sort();
      const expectedKeys = [
        "candidates",
        "companyId",
        "connected",
        "bound",
        "serviceAccountIsMember",
      ].sort();

      expect(keys).toEqual(expectedKeys);
    });

    it("emits event with optional serviceAccountEmail when available", async () => {
      // Mock the broker fetch to return identity info
      setup.harness.ctx.http.fetch = async (url: string) => {
        if (url.includes("identity")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                serviceAccountEmail: "sa@project.iam.gserviceaccount.com",
                isMember: true,
              }),
          } as any as Response;
        }
        return { ok: false, status: 404, text: async () => "{}" } as any as Response;
      };

      // First set up a binding
      const drives = [{ id: "d1", name: "Test Drive" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      await tool(setup.harness, "drive_binding_set", { sharedDriveId: "d1" });

      setup.emit.mock.calls = []; // Clear

      // Call status which fetches identity
      await tool(setup.harness, "drive_binding_status", {});

      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      expect(bindingCalls).toHaveLength(1);

      const payload = bindingCalls[0][2] as any;
      expect(payload.serviceAccountEmail).toBe("sa@project.iam.gserviceaccount.com");
      expect(payload.serviceAccountIsMember).toBe(true);

      // Ensure no token in payload
      expect(JSON.stringify(payload)).not.toMatch(/test-token|Bearer/);
    });

    it("does not include token or identity errors in event payload", async () => {
      // Mock broker to fail
      setup.harness.ctx.http.fetch = async () => {
        return { ok: false, status: 500, text: async () => "{}" } as any as Response;
      };

      // Set up a binding first
      const drives = [{ id: "d1", name: "Test Drive" }];
      await tool(setup.harness, "drive_binding_discover", { drives });
      await tool(setup.harness, "drive_binding_set", { sharedDriveId: "d1" });

      setup.emit.mock.calls = []; // Clear

      // Call status which will fail to get identity
      await tool(setup.harness, "drive_binding_status", {});

      const calls = setup.emit.mock.calls;
      const bindingCalls = calls.filter((c) => c[0] === DRIVE_BINDING_EVENT);
      const payload = bindingCalls[0][2] as any;

      // Ensure identityError is not in payload (it's in the tool response, not the event)
      expect("identityError" in payload).toBe(false);

      // Ensure no error text in payload
      expect(JSON.stringify(payload)).not.toMatch(/unavailable|error/i);
    });
  });

  describe("event emission resilience", () => {
    it("does not fail tool when event emit fails", async () => {
      // Mock emit to throw
      const originalEmit = setup.harness.ctx.events.emit;
      let emitFailed = false;
      setup.harness.ctx.events.emit = async () => {
        emitFailed = true;
        throw new Error("Emit failed");
      };

      const drives = [{ id: "d1", name: "Test Drive" }];

      // Tool should succeed despite emit failure
      const result = await toolRaw(setup.harness, "drive_binding_discover", { drives });
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(emitFailed).toBe(true);

      // Restore
      setup.harness.ctx.events.emit = originalEmit;
    });
  });
});
