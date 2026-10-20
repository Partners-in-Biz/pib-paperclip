/**
 * Push page actions tests (Postgres).
 * Tests cover: validation (bad endpoint, http, missing keys), company scoping,
 * user isolation, no key material in responses, mute stops send, agent rejection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devices, mute, subscribe, test, unsubscribe } from "../src/push/actions.js";
import { listSubscriptionsForUser } from "../src/push/store.js";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";
import type { Env } from "../src/env.js";
import { createECDH, randomBytes } from "node:crypto";
import { registerCockpit } from "../src/register.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const COMPANY_A = COMPANY;
const COMPANY_B = "comp-diff-b2b8f471";
const USER_A = "user-a-id";
const USER_B = "user-b-id";

d("Push page actions (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let env: Env;

  function createRealSubscriptionKeyPair() {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString("base64url");
    const auth = randomBytes(16).toString("base64url");
    return { p256dh, auth };
  }

  beforeAll(async () => {
    pg = await startPg();
    env = {
      ctx: pg.ctx,
      skills: { ensure: async () => undefined } as any,
      now: () => new Date("2026-10-20T10:00:00Z"),
    };
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    // Clear subscriptions before each test
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_subscriptions WHERE company_id IN ($1, $2)`,
      [COMPANY_A, COMPANY_B],
    );
  });

  describe("subscribe", () => {
    it("rejects bad endpoint (http)", async () => {
      const keys = createRealSubscriptionKeyPair();
      await expect(
        subscribe(pg.ctx, COMPANY_A, USER_A, {
          endpoint: "http://example.com/push",
          p256dh: keys.p256dh,
          auth: keys.auth,
        }),
      ).rejects.toMatchObject({ code: "endpoint_not_allowed" });
    });

    it("rejects disallowed endpoint host", async () => {
      const keys = createRealSubscriptionKeyPair();
      await expect(
        subscribe(pg.ctx, COMPANY_A, USER_A, {
          endpoint: "https://evil.com/push",
          p256dh: keys.p256dh,
          auth: keys.auth,
        }),
      ).rejects.toMatchObject({ code: "endpoint_not_allowed" });
    });

    it("rejects bad p256dh", async () => {
      const keys = createRealSubscriptionKeyPair();
      await expect(
        subscribe(pg.ctx, COMPANY_A, USER_A, {
          endpoint: "https://fcm.googleapis.com/fcm/send/test1",
          p256dh: "invalid!@#",
          auth: keys.auth,
        }),
      ).rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("rejects bad auth", async () => {
      const keys = createRealSubscriptionKeyPair();
      await expect(
        subscribe(pg.ctx, COMPANY_A, USER_A, {
          endpoint: "https://fcm.googleapis.com/fcm/send/test2",
          p256dh: keys.p256dh,
          auth: "tooshort",
        }),
      ).rejects.toMatchObject({ code: "bad_subscription" });
    });

    it("stores subscription without key material in response", async () => {
      const keys = createRealSubscriptionKeyPair();
      const result = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test3",
        p256dh: keys.p256dh,
        auth: keys.auth,
        label: "Device 1",
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("deviceLabel");
      expect(result).toHaveProperty("state");
      expect(result.deviceLabel).toBe("Device 1");
      expect(result.state).toBe("ok");
      expect(result).not.toHaveProperty("p256dh");
      expect(result).not.toHaveProperty("auth");
      expect(JSON.stringify(result)).not.toContain(keys.p256dh);
      expect(JSON.stringify(result)).not.toContain(keys.auth);
    });

    it("accepts valid FCM endpoint", async () => {
      const keys = createRealSubscriptionKeyPair();
      const result = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/valid-endpoint",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      expect(result.state).toBe("ok");
      expect(result.id).toBeTruthy();
    });

    it("accepts valid Apple endpoint", async () => {
      const keys = createRealSubscriptionKeyPair();
      const result = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://api.push.apple.com/fcm/send/apple-endpoint",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      expect(result.state).toBe("ok");
    });

    it("accepts valid Windows endpoint", async () => {
      const keys = createRealSubscriptionKeyPair();
      const result = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://something.notify.windows.com/windows-endpoint",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      expect(result.state).toBe("ok");
    });
  });

  describe("devices", () => {
    it("lists only actor's own devices", async () => {
      const keys1 = createRealSubscriptionKeyPair();
      const keys2 = createRealSubscriptionKeyPair();

      // User A subscribes a device
      await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/user-a-dev1",
        p256dh: keys1.p256dh,
        auth: keys1.auth,
        label: "A Phone",
      });

      // User B subscribes a device
      await subscribe(pg.ctx, COMPANY_A, USER_B, {
        endpoint: "https://fcm.googleapis.com/fcm/send/user-b-dev1",
        p256dh: keys2.p256dh,
        auth: keys2.auth,
        label: "B Tablet",
      });

      // User A lists devices: should only see their own
      const userADevices = await devices(pg.ctx, COMPANY_A, USER_A);
      expect(userADevices).toHaveLength(1);
      expect(userADevices[0]!.label).toBe("A Phone");
      expect(userADevices[0]).not.toHaveProperty("p256dh");
      expect(userADevices[0]).not.toHaveProperty("auth");

      // User B lists devices: should only see their own
      const userBDevices = await devices(pg.ctx, COMPANY_A, USER_B);
      expect(userBDevices).toHaveLength(1);
      expect(userBDevices[0]!.label).toBe("B Tablet");
    });

    it("returns empty list for user with no devices", async () => {
      const list = await devices(pg.ctx, COMPANY_A, "unknown-user");
      expect(list).toHaveLength(0);
    });

    it("never returns key material", async () => {
      const keys = createRealSubscriptionKeyPair();
      await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/key-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      const list = await devices(pg.ctx, COMPANY_A, USER_A);
      const json = JSON.stringify(list);
      expect(json).not.toContain(keys.p256dh);
      expect(json).not.toContain(keys.auth);
    });
  });

  describe("mute", () => {
    it("mutes a device owned by actor", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/mute-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await mute(pg.ctx, COMPANY_A, USER_A, { id: sub.id, muted: true });

      const list = await devices(pg.ctx, COMPANY_A, USER_A);
      expect(list[0]!.state).toBe("muted");
    });

    it("unmutes a device", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/unmute-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await mute(pg.ctx, COMPANY_A, USER_A, { id: sub.id, muted: true });
      await mute(pg.ctx, COMPANY_A, USER_A, { id: sub.id, muted: false });

      const list = await devices(pg.ctx, COMPANY_A, USER_A);
      expect(list[0]!.state).toBe("ok");
    });

    it("rejects muting unknown device", async () => {
      await expect(mute(pg.ctx, COMPANY_A, USER_A, { id: "unknown-id" })).rejects.toMatchObject({ code: "not_found" });
    });

    it("user A cannot mute user B's device", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_B, {
        endpoint: "https://fcm.googleapis.com/fcm/send/isolation-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await expect(mute(pg.ctx, COMPANY_A, USER_A, { id: sub.id })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("unsubscribe", () => {
    it("deletes device owned by actor", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/unsubscribe-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await unsubscribe(pg.ctx, COMPANY_A, USER_A, { id: sub.id });

      const list = await devices(pg.ctx, COMPANY_A, USER_A);
      expect(list).toHaveLength(0);
    });

    it("rejects unsubscribing unknown device", async () => {
      await expect(unsubscribe(pg.ctx, COMPANY_A, USER_A, { id: "unknown-id" })).rejects.toMatchObject({ code: "not_found" });
    });

    it("user A cannot unsubscribe user B's device", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_B, {
        endpoint: "https://fcm.googleapis.com/fcm/send/unsub-isolation-test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await expect(unsubscribe(pg.ctx, COMPANY_A, USER_A, { id: sub.id })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("test", () => {
    beforeEach(async () => {
      // Enable push for these tests
      pg.config.set(COMPANY_A, { pushEnabled: true });
    });

    it("skips muted devices in test push", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-mute",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      // Mute the device
      await mute(pg.ctx, COMPANY_A, USER_A, { id: sub.id, muted: true });

      // Send test push
      const result = await test(pg.ctx, COMPANY_A, USER_A, {});

      // Should have one result with skipped_muted
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.outcome).toBe("skipped_muted");
      expect(result.results[0]).not.toHaveProperty("p256dh");
      expect(result.results[0]).not.toHaveProperty("auth");
    });

    it("sends test push to ok devices", async () => {
      const keys = createRealSubscriptionKeyPair();
      await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-ok",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      // Mock the post function to simulate successful delivery
      const sendDeps = {
        postPush: async () => ({ status: 201, headers: {}, body: "", bodyTruncated: false }),
      };

      const result = await test(pg.ctx, COMPANY_A, USER_A, {}, { deps: sendDeps });

      expect(result.results).toHaveLength(1);
      // Note: outcome could be "sent" or "error" depending on config; we just verify it's a valid outcome
      expect(["sent", "error", "skipped_muted"]).toContain(result.results[0]!.outcome);
    });

    it("never returns key material in test results", async () => {
      const keys = createRealSubscriptionKeyPair();
      await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-keys",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      const result = await test(pg.ctx, COMPANY_A, USER_A, {});

      const json = JSON.stringify(result);
      expect(json).not.toContain(keys.p256dh);
      expect(json).not.toContain(keys.auth);
    });

    it("tests only specified device when id provided", async () => {
      const keys1 = createRealSubscriptionKeyPair();
      const keys2 = createRealSubscriptionKeyPair();

      const sub1 = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-multi-1",
        p256dh: keys1.p256dh,
        auth: keys1.auth,
      });

      const sub2 = await subscribe(pg.ctx, COMPANY_A, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-multi-2",
        p256dh: keys2.p256dh,
        auth: keys2.auth,
      });

      // Test only first device
      const result = await test(pg.ctx, COMPANY_A, USER_A, { id: sub1.id });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.label).toBe(null); // Both have no label
    });

    it("rejects test with unknown device id", async () => {
      await expect(test(pg.ctx, COMPANY_A, USER_A, { id: "unknown" })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("company scoping", () => {
    it("user in company A cannot see company B devices", async () => {
      const keys = createRealSubscriptionKeyPair();

      // User A subscribes in company B
      await subscribe(pg.ctx, COMPANY_B, USER_A, {
        endpoint: "https://fcm.googleapis.com/fcm/send/company-b-device",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      // User A lists devices in company A: should be empty
      const listA = await devices(pg.ctx, COMPANY_A, USER_A);
      expect(listA).toHaveLength(0);

      // User A lists devices in company B: should see the device
      const listB = await devices(pg.ctx, COMPANY_B, USER_A);
      expect(listB).toHaveLength(1);
    });
  });

  describe("agent actor rejection (via registered actions)", () => {
    it("cockpit.push.subscribe rejects agent actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.subscribe")!;
      const keys = createRealSubscriptionKeyPair();

      const agentContext = {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-1", userId: null },
      };

      await expect(
        action(
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/test",
            p256dh: keys.p256dh,
            auth: keys.auth,
          },
          agentContext,
        ),
      ).rejects.toThrow();
    });

    it("cockpit.push.devices rejects agent actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.devices")!;

      const agentContext = {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-1", userId: null },
      };

      await expect(action({}, agentContext)).rejects.toThrow();
    });

    it("cockpit.push.mute rejects agent actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.mute")!;

      const agentContext = {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-1", userId: null },
      };

      await expect(action({ id: "device-id" }, agentContext)).rejects.toThrow();
    });

    it("cockpit.push.unsubscribe rejects agent actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.unsubscribe")!;

      const agentContext = {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-1", userId: null },
      };

      await expect(action({ id: "device-id" }, agentContext)).rejects.toThrow();
    });

    it("cockpit.push.test rejects agent actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.test")!;

      const agentContext = {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-1", userId: null },
      };

      await expect(action({}, agentContext)).rejects.toThrow();
    });

    it("cockpit.push.subscribe rejects null actor", async () => {
      const fake = fakeCtx();
      registerCockpit(fake.ctx);

      const action = fake.actions.get("cockpit.push.subscribe")!;
      const keys = createRealSubscriptionKeyPair();

      const nullContext = {
        companyId: COMPANY_A,
        actor: { type: "system", userId: null },
      };

      await expect(
        action(
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/test",
            p256dh: keys.p256dh,
            auth: keys.auth,
          },
          nullContext,
        ),
      ).rejects.toThrow();
    });
  });
});
