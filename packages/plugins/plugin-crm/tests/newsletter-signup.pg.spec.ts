/** Newsletter signup on a real database: two signups for one address at the same moment make one capture row and one mail. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_RPC_ERROR_CODES, type PluginContext } from "@paperclipai/plugin-sdk";
import { MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { handleLeadWebhook, LeadRejected, resetLeadCaches } from "../src/lead-capture.js";
import { generateLeadKey, generateSigningSecret } from "../src/lead-form.js";
import { countCaptures, getLeadSource } from "../src/lead-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { processSignup, SIGNUP_MAIL_PREFIX } from "../src/newsletter-signup.js";
import { signedDelivery } from "./helpers/leads.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const SITE = "https://remotesaffa.co.za";

describe.skipIf(!available)("newsletter signup on a real database", () => {
  it("two concurrent signups for one address produce one capture row and one mail", async () => {
    const pg = await startPg();
    try {
      const emit = vi.fn(async () => undefined);
      const ctx = { ...pg.ctx, events: { emit } } as unknown as PluginContext;
      const id = randomUUID();
      await pg.client.query(
        `INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, site_url, public_key, signing_secret, consent_text, intake, apply_tags, confirm_url, confirm_from, confirm_secret)
         VALUES ($1, 'co-1', 'RemoteSaffa', $2, 'pk_test', 'signing-secret', 'Yes, send me the Friday list.', 'newsletter', '["remotesaffa-subscribers"]'::jsonb, $3, 'hello@remotesaffa.co.za', $4)`,
        [id, SITE, `${SITE}/subscribe/confirm`, "s".repeat(48)],
      );
      const source = (await getLeadSource(ctx, "co-1", id))!;
      const now = new Date();
      const input = { email: "thandi@example.co.za", pageUrl: `${SITE}/jobs`, attribution: {}, now, ipHash: null, salt: "salt" };

      const outcomes = await Promise.all([processSignup(ctx, source, input), processSignup(ctx, source, { ...input, email: "Thandi@Example.co.za" })]);

      expect(outcomes.sort()).toEqual(["duplicate", "pending_confirmation"]);
      const captures = (await pg.client.query(`SELECT key, outcome, contact_id FROM ${NAMESPACE}.lead_captures`)).rows as Array<{ key: string; outcome: string; contact_id: string | null }>;
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({ outcome: "pending_confirmation", contact_id: null });
      const outbox = (await pg.client.query(`SELECT key, event FROM ${NAMESPACE}.outbox`)).rows as Array<{ key: string; event: string }>;
      expect(outbox).toEqual([{ key: `${SIGNUP_MAIL_PREFIX}${captures[0]!.key}`, event: MAIL_EVENTS.sendRequested }]);
      expect(emit).toHaveBeenCalledTimes(1);
      // The daily ceiling counts on the (company_id, source_id, created_at) index.
      expect(await countCaptures(ctx, "co-1", id, new Date(now.getTime() - 86_400_000).toISOString(), 300)).toBe(1);
      expect((await pg.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.contacts`)).rows[0]).toEqual({ n: 0 });
    } finally {
      await pg.stop();
    }
  }, 120_000);

  /** A newsletter source with an hourly cap, signups through the real webhook, and every mail kept in the outbox (`.test` addresses: none is deliverable). */
  async function capped(pg: PgHarness, confirmHourlyCap: number | null) {
    resetLeadCaches();
    const emit = vi.fn(async () => undefined);
    const ctx = { ...pg.ctx, events: { emit } } as unknown as PluginContext;
    const id = randomUUID();
    const key = generateLeadKey();
    const secret = generateSigningSecret();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, site_url, public_key, signing_secret, consent_text, intake, apply_tags, confirm_url, confirm_from, confirm_secret, canary, confirm_hourly_cap)
       VALUES ($1, 'co-1', 'RemoteSaffa', $2, $3, $4, 'Yes, send me the Friday list.', 'newsletter', '["remotesaffa-subscribers"]'::jsonb, $5, 'hello@remotesaffa.co.za', $6, true, $7)`,
      [id, SITE, key, secret, `${SITE}/subscribe/confirm`, "s".repeat(48), confirmHourlyCap],
    );
    const signup = (email: string, n: number) => handleLeadWebhook(ctx, signedDelivery(secret, { key, email, pageUrl: `${SITE}/jobs`, visitorIp: `203.0.113.${n}` }, { headers: { "x-real-ip": "198.51.100.1" } }));
    const count = async (table: string) => ((await pg.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.${table}`)).rows[0] as { n: number }).n;
    return { id, emit, signup, captures: () => count("lead_captures"), mails: () => count("outbox") };
  }

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LeadRejected);
    return error as LeadRejected;
  };

  it("confirmHourlyCap: the next signup past the cap is refused 429 with nothing written, and an hour later it goes through", async () => {
    const pg = await startPg();
    try {
      const nl = await capped(pg, 2);
      await nl.signup("ayanda@remotesaffa.test", 1);
      await nl.signup("bongi@remotesaffa.test", 2);
      expect([await nl.captures(), await nl.mails(), nl.emit.mock.calls.length]).toEqual([2, 2, 2]);

      const error = await refusal(nl.signup("chris@remotesaffa.test", 3));
      expect(error).toMatchObject({ outcome: "rate_limited", code: PLUGIN_RPC_ERROR_CODES.RATE_LIMITED, message: "Too many signups right now. Please try again later." });
      expect([await nl.captures(), await nl.mails(), nl.emit.mock.calls.length]).toEqual([2, 2, 2]);

      // The two rows fall out of the hour (the cap compares against the database's created_at).
      await pg.client.query(`UPDATE ${NAMESPACE}.lead_captures SET created_at = created_at - interval '61 minutes'`);
      await nl.signup("chris@remotesaffa.test", 3);
      expect([await nl.captures(), await nl.mails(), nl.emit.mock.calls.length]).toEqual([3, 3, 3]);
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it("confirmHourlyCap: a duplicate or already-subscribed signup writes no row, so it does not count; a canary dry run does", async () => {
    const pg = await startPg();
    try {
      const nl = await capped(pg, 2);
      await pg.client.query(`INSERT INTO ${NAMESPACE}.contacts (id, company_id, name, emails, tags) VALUES ('c1', 'co-1', 'Dineo', '["dineo@remotesaffa.test"]'::jsonb, '["remotesaffa-subscribers"]'::jsonb)`);
      await nl.signup("ayanda@remotesaffa.test", 1);
      await nl.signup("Ayanda@remotesaffa.test", 2); // duplicate the same day
      await nl.signup("dineo@remotesaffa.test", 3); // already subscribed
      expect([await nl.captures(), await nl.mails()]).toEqual([1, 1]);
      // A canary (.invalid) dry run sends nothing but writes its row, and that row counts.
      await nl.signup("canary-1@pib-canary.invalid", 4);
      expect([await nl.captures(), await nl.mails()]).toEqual([2, 1]);
      expect((await refusal(nl.signup("bongi@remotesaffa.test", 5))).code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
      // At the cap even a duplicate is refused: the cap is checked first, and nothing is written either way.
      expect((await refusal(nl.signup("ayanda@remotesaffa.test", 6))).outcome).toBe("rate_limited");
      expect([await nl.captures(), await nl.mails()]).toEqual([2, 1]);
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it("no confirmHourlyCap (null): only the daily ceiling applies, as before", async () => {
    const pg = await startPg();
    try {
      const nl = await capped(pg, null);
      for (let n = 1; n <= 5; n += 1) await nl.signup(`reader${n}@remotesaffa.test`, n);
      expect([await nl.captures(), await nl.mails()]).toEqual([5, 5]);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
