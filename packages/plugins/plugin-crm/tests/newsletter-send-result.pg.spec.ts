/** The newsletter send result and the outbox clean-up on a real database: the statements run as written. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { handleNewsletterSendResult, purgeSettledSignupMails } from "../src/newsletter-send-result.js";
import { processSignup } from "../src/newsletter-signup.js";
import { getLeadSource } from "../src/lead-store.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const SITE = "https://remotesaffa.co.za";

describe.skipIf(!available)("newsletter send result on a real database", () => {
  it("a failed confirmation marks the signup once and deletes the row; the job step deletes only settled crm:nl: rows", async () => {
    const pg = await startPg();
    try {
      const ctx = { ...pg.ctx, events: { emit: vi.fn(async () => undefined) } } as unknown as PluginContext;
      const id = randomUUID();
      await pg.client.query(
        `INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, site_url, public_key, signing_secret, consent_text, intake, apply_tags, confirm_url, confirm_from, confirm_secret)
         VALUES ($1, 'co-1', 'RemoteSaffa', $2, 'pk_test', 'signing-secret', 'Yes, send me the Friday list.', 'newsletter', '["remotesaffa-subscribers"]'::jsonb, $3, 'hello@remotesaffa.co.za', $4)`,
        [id, SITE, `${SITE}/subscribe/confirm`, "s".repeat(48)],
      );
      const source = (await getLeadSource(ctx, "co-1", id))!;
      await processSignup(ctx, source, { email: "thandi@example.co.za", pageUrl: `${SITE}/jobs`, attribution: {}, now: new Date(), ipHash: null, salt: "salt" });
      const [mail] = (await pg.client.query(`SELECT key FROM ${NAMESPACE}.outbox`)).rows as Array<{ key: string }>;
      const result = { key: mail!.key, status: "failed" as const, permanent: true, error: "bounced", context: { plugin: "partnersinbiz.crm", kind: "client_message" as const, id: "x" } };

      expect(await handleNewsletterSendResult(ctx, result, "co-1")).toBe("failed");
      expect(await handleNewsletterSendResult(ctx, result, "co-1")).toBe("ignored");
      expect((await pg.client.query(`SELECT outcome FROM ${NAMESPACE}.lead_captures`)).rows).toEqual([{ outcome: "confirmation_failed" }]);
      expect((await pg.client.query(`SELECT rejected_count FROM ${NAMESPACE}.lead_sources`)).rows).toEqual([{ rejected_count: 1 }]);
      expect((await pg.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.outbox`)).rows[0]).toEqual({ n: 0 });

      for (const [key, status] of [["crm:nl:gave-up", "failed"], ["crm:nl:done", "done"], ["crm:nl:waiting", "pending"], ["crm:seq:e1:1", "failed"], ["crm:nlx:other", "failed"]]) {
        await pg.client.query(`INSERT INTO ${NAMESPACE}.outbox (key, company_id, event, payload, status) VALUES ($1, 'co-1', 'mail.send.requested', '{}'::jsonb, $2)`, [key, status]);
      }
      expect(await purgeSettledSignupMails(ctx)).toBe(2);
      const left = ((await pg.client.query(`SELECT key FROM ${NAMESPACE}.outbox ORDER BY key`)).rows as Array<{ key: string }>).map((row) => row.key);
      expect(left).toEqual(["crm:nl:waiting", "crm:nlx:other", "crm:seq:e1:1"]);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
