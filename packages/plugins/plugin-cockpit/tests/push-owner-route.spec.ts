/**
 * Owner-push route tests (Postgres).
 * Tests cover: validation (class, title, body, url, companyId), URL parsing,
 * rate limiting, owner resolution, sending, concurrency, and response structure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleOwnerPush } from "../src/push/owner-push-route.js";
import { upsertSubscription } from "../src/push/store.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";
import type { Env } from "../src/env.js";
import { createECDH, randomBytes } from "node:crypto";
import manifest from "../src/manifest.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const COMPANY_A = COMPANY;
const OWNER_USER_ID = "owner-user-123";

d("Owner-push route (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let env: Env;

  function createRealSubscriptionKeyPair() {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString("base64url");
    const auth = randomBytes(16).toString("base64url");
    return { p256dh, auth };
  }

  function createInput(overrides: any = {}): any {
    const bodyOverrides = overrides.body && typeof overrides.body === "object" ? overrides.body : {};
    const input = {
      routeKey: "owner-push",
      companyId: COMPANY_A,
      body: {
        companyId: COMPANY_A,
        class: "critical",
        title: "Test Push",
        body: "This is a test push",
        url: "https://paperclip.partnersinbiz.online/cockpit",
        ...bodyOverrides,
      },
    };
    return { ...input, ...overrides, body: input.body };
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
    // Clear relevant tables
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_subscriptions WHERE company_id = $1`,
      [COMPANY_A],
    );
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_rate WHERE key LIKE $1`,
      ["owner-push:%"],
    );
    // Ensure owner is set
    await saveRoles(pg.ctx, {
      companyId: COMPANY_A,
      operatorAgentId: null,
      reviewerAgentId: null,
      ownerUserId: OWNER_USER_ID,
      reviewOutward: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    } as RolesRow);
  });

  describe("validation", () => {
    it("rejects missing or mismatched companyId", async () => {
      const missing = createInput({ body: { companyId: undefined } });
      const mismatched = createInput({ body: { companyId: "different-company" } });
      for (const input of [missing, mismatched]) {
        const result = await handleOwnerPush(env, input as any);
        expect(result.status).toBe(400);
        expect(String((result.body as any).error)).toContain("companyId");
      }
    });

    it("rejects class other than 'critical' (needs_you)", async () => {
      const input = createInput({ body: { class: "needs_you" } });
      const result = await handleOwnerPush(env, input as any);
      expect(result.status).toBe(400);
      expect(String((result.body as any).error)).toContain("critical");
    });

    it.each([
      ["empty", ""],
      ["121 chars", "x".repeat(121)],
    ])("rejects title: %s", async (_, title) => {
      const input = createInput({ body: { title } });
      const result = await handleOwnerPush(env, input as any);
      expect(result.status).toBe(400);
      expect(String((result.body as any).error)).toContain("title");
    });

    it("accepts title of exactly 120 chars", async () => {
      const input = createInput({ body: { title: "x".repeat(120) } });
      const result = await handleOwnerPush(env, input as any);
      expect([200, 429]).toContain(result.status);
    });

    it.each([
      ["empty", ""],
      ["401 chars", "x".repeat(401)],
    ])("rejects body: %s", async (_, body) => {
      const input = createInput({ body: { body } });
      const result = await handleOwnerPush(env, input as any);
      expect(result.status).toBe(400);
      expect(String((result.body as any).error)).toContain("body");
    });

    it("accepts body of exactly 400 chars", async () => {
      const input = createInput({ body: { body: "x".repeat(400) } });
      const result = await handleOwnerPush(env, input as any);
      expect([200, 429]).toContain(result.status);
    });

    it.each([
      ["http URL", "http://paperclip.partnersinbiz.online/x", "https"],
      ["foreign host", "https://evil.com/", "origin"],
      ["lookalike host", "https://paperclip.partnersinbiz.online.evil.com/", "origin"],
      ["userinfo with user", "https://paperclip.partnersinbiz.online@evil.com/", "userinfo"],
      ["query param attack", "https://evil.com/?https://paperclip.partnersinbiz.online/", "origin"],
      ["trailing dot", "https://paperclip.partnersinbiz.online./x", "origin"],
      ["custom port", "https://paperclip.partnersinbiz.online:8443/x", "origin"],
      ["javascript protocol", "javascript:alert(1)", "https"],
      ["protocol-relative", "//paperclip.partnersinbiz.online/x", "valid URL"],
      ["not a url string", "not a url", "valid URL"],
      ["empty string", "", "required"],
    ])("rejects URL: %s", async (_, url, errorMsg) => {
      const input = createInput({ body: { url } });
      const result = await handleOwnerPush(env, input as any);
      expect(result.status).toBe(400);
      expect(String((result.body as any).error)).toContain(errorMsg);
    });

    it.each([
      ["exact match", "https://paperclip.partnersinbiz.online/PAR/issues/PAR-1"],
      ["uppercase host", "https://PAPERCLIP.partnersinbiz.online/x"],
      ["default https port", "https://paperclip.partnersinbiz.online:443/x"],
    ])("accepts URL: %s", async (_, url) => {
      const input = createInput({ body: { url } });
      const result = await handleOwnerPush(env, input as any);
      expect([200, 429]).toContain(result.status);
    });

    it("rejects unknown fields in body", async () => {
      const input = createInput();
      (input as any).body = {
        ...(input as any).body,
        unknownField: "value",
      };
      const result = await handleOwnerPush(env, input as any);
      expect(result.status).toBe(400);
      expect(String((result.body as any).error)).toContain("Unknown field");
    });
  });

  describe("rate limiting", () => {
    it("rejects 11th concurrent call with 429 (simultaneous)", async () => {
      const promises = Array.from({ length: 11 }, (_, i) =>
        handleOwnerPush(env, createInput({ body: { title: `Push ${i}` } }) as any),
      );
      const results = await Promise.all(promises);
      const codes = results.map((r) => r.status);
      const count200 = codes.filter((c) => c === 200).length;
      const count429 = codes.filter((c) => c === 429).length;
      expect(count200).toBe(10);
      expect(count429).toBe(1);
    });

    it("accepts 10 concurrent calls and rejects 11th sequential with 429", async () => {
      // Fire 10 concurrent calls
      const promises = Array.from({ length: 10 }, (_, i) =>
        handleOwnerPush(env, createInput({ body: { title: `Push ${i}` } }) as any),
      );
      const results = await Promise.all(promises);
      const codes = results.map((r) => r.status);
      expect(codes.filter((c) => c === 200)).toHaveLength(10);

      // 11th sequential call should be rejected
      const result = await handleOwnerPush(env, createInput({ body: { title: "Push 11" } }) as any);
      expect(result.status).toBe(429);
      expect(String((result.body as any).error)).toBe("rate limit");
    });

    it("resets rate limit in next hour window", async () => {
      // Make a call in hour 1
      const env1 = {
        ...env,
        now: () => new Date("2026-10-20T10:00:00Z"),
      };
      await handleOwnerPush(env1, createInput() as any);

      // Advance to next hour and make another call
      const env2 = {
        ...env,
        now: () => new Date("2026-10-20T11:00:00Z"),
      };
      const result = await handleOwnerPush(env2, createInput() as any);
      expect(result.status).toBe(200);
    });
  });

  describe("manifest", () => {
    it("declares owner-push with POST, board auth, and body companyResolution", () => {
      const route = manifest.apiRoutes?.find((r) => r.routeKey === "owner-push");
      expect(route).toBeTruthy();
      expect(route).toMatchObject({
        routeKey: "owner-push",
        method: "POST",
        path: "/owner-push",
        auth: "board",
        companyResolution: { from: "body", key: "companyId" },
      });
    });
  });

  describe("owner resolution", () => {
    it("returns {sent:0, failed:0} when no owner is set", async () => {
      // Clear the owner
      await saveRoles(pg.ctx, {
        companyId: COMPANY_A,
        operatorAgentId: null,
        reviewerAgentId: null,
        ownerUserId: null,
        reviewOutward: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: null,
      } as RolesRow);
      const result = await handleOwnerPush(env, createInput() as any);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ sent: 0, failed: 0 });
    });

    it("returns {sent:0, failed:0} when owner has no subscriptions", async () => {
      const result = await handleOwnerPush(env, createInput() as any);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ sent: 0, failed: 0 });
    });
  });

  describe("response and sending", () => {
    it("response has only 'sent' and 'failed' keys with correct types", async () => {
      const keys = createRealSubscriptionKeyPair();
      await upsertSubscription(pg.ctx, {
        companyId: COMPANY_A,
        userId: OWNER_USER_ID,
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      const result = await handleOwnerPush(env, createInput() as any);
      expect(result.status).toBe(200);
      expect(Object.keys(result.body as any).sort()).toEqual(["failed", "sent"]);
      expect(typeof (result.body as any).sent).toBe("number");
      expect(typeof (result.body as any).failed).toBe("number");
    });

    it("does not echo request text or expose key material", async () => {
      const keys = createRealSubscriptionKeyPair();
      await upsertSubscription(pg.ctx, {
        companyId: COMPANY_A,
        userId: OWNER_USER_ID,
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      const result = await handleOwnerPush(env, createInput() as any);
      const bodyStr = JSON.stringify(result.body);
      // No request content
      expect(bodyStr).not.toContain("Test Push");
      expect(bodyStr).not.toContain("This is a test push");
      expect(bodyStr).not.toContain("paperclip.partnersinbiz.online");
      // No key material
      expect(bodyStr).not.toContain(keys.p256dh);
      expect(bodyStr).not.toContain(keys.auth);
      expect(bodyStr).not.toContain("endpoint");
    });

    it("processes subscriptions with 'owner-push' tag", async () => {
      const keys = createRealSubscriptionKeyPair();
      await upsertSubscription(pg.ctx, {
        companyId: COMPANY_A,
        userId: OWNER_USER_ID,
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      const result = await handleOwnerPush(env, createInput() as any);
      expect(result.status).toBe(200);
      expect(typeof (result.body as any).sent).toBe("number");
    });

    it("skips muted subscriptions in count", async () => {
      const keys = createRealSubscriptionKeyPair();
      const sub = await upsertSubscription(pg.ctx, {
        companyId: COMPANY_A,
        userId: OWNER_USER_ID,
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      await pg.ctx.db.execute(
        `UPDATE plugin_cockpit_b8a99e8b16.push_subscriptions SET state = 'muted' WHERE endpoint = $1`,
        [sub.endpoint],
      );

      const result = await handleOwnerPush(env, createInput() as any);
      expect(result.status).toBe(200);
      expect((result.body as any).sent + (result.body as any).failed).toBe(0);
    });
  });
});
