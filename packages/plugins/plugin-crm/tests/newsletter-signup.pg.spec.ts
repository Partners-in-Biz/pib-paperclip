/** Newsletter signup on a real database: two signups for one address at the same moment make one capture row and one mail. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { countCaptures, getLeadSource } from "../src/lead-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { processSignup, SIGNUP_MAIL_PREFIX } from "../src/newsletter-signup.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

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
});
