/**
 * PiB host patch (PAR-5230): with `auth.disableSignUp` on, `POST
 * /sign-up/email` succeeds only for a valid, unaccepted, unexpired human invite
 * whose recorded email equals the sign-up email. Driven through the real Better
 * Auth mount against a migrated Postgres, like the credential sign-up suite.
 */

import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const EMAIL = "owner@client.example";
const PASSWORD = "correct-horse-battery-staple";
const CLOSED_CODE = "EMAIL_PASSWORD_SIGN_UP_DISABLED";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(authDisableSignUp: boolean): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("invite-gated sign-up while sign-up is closed", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let closedApp!: express.Express;
  let openApp!: express.Express;
  let companyX!: string;
  let tokenSeq = 0;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  function mount(disableSignUp: boolean) {
    const auth = createBetterAuthInstance(db, testConfig(disableSignUp), [ORIGIN]);
    const app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    return app;
  }

  async function makeInvite(overrides: Partial<typeof invites.$inferInsert> = {}, email: string | null = EMAIL) {
    const token = `pcp_invite_test_${(tokenSeq += 1)}`;
    await db.insert(invites).values({
      companyId: companyX,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: hash(token),
      defaultsPayload: email ? { invitedEmail: email } : null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    });
    return token;
  }

  function signUp(app: express.Express, body: Record<string, unknown>) {
    return request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ name: "Client Owner", password: PASSWORD, ...body });
  }

  async function userCount() {
    return (await db.select().from(authUsers)).length;
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-invite-signup-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-invite-signup-gate-");
    db = createDb(database.connectionString);
    closedApp = mount(true);
    openApp = mount(false);
    const [company] = await db
      .insert(companies)
      .values({ name: "Client X", issuePrefix: "CLX" })
      .returning();
    companyX = company!.id;
  }, 30_000);

  beforeEach(async () => {
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("refuses sign-up with no token", async () => {
    const res = await signUp(closedApp, { email: EMAIL });
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe(CLOSED_CODE);
    expect(await userCount()).toBe(0);
  });

  it("refuses an unknown token", async () => {
    const res = await signUp(closedApp, { email: EMAIL, inviteToken: "pcp_invite_nope" });
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe(CLOSED_CODE);
    expect(await userCount()).toBe(0);
  });

  it("refuses a valid token with a different email", async () => {
    const token = await makeInvite();
    const res = await signUp(closedApp, { email: "someone-else@client.example", inviteToken: token });
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe(CLOSED_CODE);
    expect(await userCount()).toBe(0);
  });

  it("refuses an invite that was issued without an email", async () => {
    const token = await makeInvite({}, null);
    const res = await signUp(closedApp, { email: EMAIL, inviteToken: token });
    expect(res.status).toBe(400);
    expect(await userCount()).toBe(0);
  });

  it("refuses expired, accepted and revoked invites", async () => {
    const expired = await makeInvite({ expiresAt: new Date(Date.now() - 1000) });
    const accepted = await makeInvite({ acceptedAt: new Date() });
    const revoked = await makeInvite({ revokedAt: new Date() });
    for (const inviteToken of [expired, accepted, revoked]) {
      const res = await signUp(closedApp, { email: EMAIL, inviteToken });
      expect(res.status).toBe(400);
      expect(res.body?.code).toBe(CLOSED_CODE);
    }
    expect(await userCount()).toBe(0);
  });

  it("refuses agent-only and bootstrap invites", async () => {
    const agentOnly = await makeInvite({ allowedJoinTypes: "agent" });
    const bootstrap = await makeInvite({ inviteType: "bootstrap_ceo", companyId: null });
    for (const inviteToken of [agentOnly, bootstrap]) {
      const res = await signUp(closedApp, { email: EMAIL, inviteToken });
      expect(res.status).toBe(400);
    }
    expect(await userCount()).toBe(0);
  });

  it("creates the account for a valid token and matching email (case-insensitive)", async () => {
    const token = await makeInvite();
    const res = await signUp(closedApp, { email: EMAIL.toUpperCase(), inviteToken: token });
    expect(res.status).toBe(200);
    expect(res.body?.user?.email?.toLowerCase()).toBe(EMAIL);
    expect(await userCount()).toBe(1);
  });

  it("grants no instance role and no company access by itself", async () => {
    const token = await makeInvite();
    const res = await signUp(closedApp, { email: EMAIL, inviteToken: token });
    expect(res.status).toBe(200);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hash(token)));
    expect(row?.companyId).toBe(companyX);
    expect(row?.acceptedAt).toBeNull();
  });

  it("does not let the same invite create a second account", async () => {
    const token = await makeInvite();
    expect((await signUp(closedApp, { email: EMAIL, inviteToken: token })).status).toBe(200);
    const again = await signUp(closedApp, { email: EMAIL, inviteToken: token });
    expect(again.status).not.toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("leaves sign-up untouched when it is not closed", async () => {
    const res = await signUp(openApp, { email: EMAIL });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });
});
