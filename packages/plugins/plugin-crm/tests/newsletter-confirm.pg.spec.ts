/** Newsletter confirm on a real database (PAR-10853): the tag UPDATE keeps a concurrent edit, and two clicks at once write one of everything. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { insertContact } from "../src/db.js";
import { createContact } from "../src/domain.js";
import { getLeadSource } from "../src/lead-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { processConfirm } from "../src/newsletter-confirm.js";
import { mintConfirmToken } from "../src/newsletter-token.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const SITE = "https://remotesaffa.co.za";
const EMAIL = "thandi@example.co.za";
const TAG = "remotesaffa-subscribers";

async function setup(pg: PgHarness) {
  const ctx = { ...pg.ctx, events: { emit: vi.fn(async () => undefined) } } as unknown as PluginContext;
  const id = randomUUID();
  await pg.client.query(
    `INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, site_url, public_key, signing_secret, consent_text, intake, apply_tags, confirm_url, confirm_from, confirm_secret)
     VALUES ($1, 'co-1', 'RemoteSaffa', $2, 'pk_test', 'signing-secret', 'Yes, send me the Friday list.', 'newsletter', $3::jsonb, $4, 'hello@remotesaffa.co.za', $5)`,
    [id, SITE, JSON.stringify([TAG]), `${SITE}/subscribe/confirm`, "s".repeat(48)],
  );
  const source = (await getLeadSource(ctx, "co-1", id))!;
  const now = new Date();
  const token = mintConfirmToken({ id, confirmSecret: source.confirmSecret!, consentText: source.consentText! }, { email: EMAIL, pagePath: "/jobs", issuedAt: now.getTime() });
  return { ctx, source, input: { token, now, ipHash: "hash", salt: "salt" } };
}

const rows = async (pg: PgHarness, sql: string) => (await pg.client.query(sql)).rows as Array<Record<string, any>>;

describe.skipIf(!available)("newsletter confirm on a real database", () => {
  it("a contact edit made between the read and the tag UPDATE survives", async () => {
    const pg = await startPg();
    try {
      const { ctx, source, input } = await setup(pg);
      await insertContact(ctx, createContact({ id: "known", companyId: "co-1", name: "Thandi", emails: [EMAIL], lifecycle: "customer", tags: ["VIP"] }));
      // A person edits the contact after processConfirm read it and just before the tag UPDATE runs.
      const execute = ctx.db.execute.bind(ctx.db);
      vi.spyOn(ctx.db, "execute").mockImplementation(async (sql: string, params?: unknown[]) => {
        if (/SET tags = c\.tags \|\|/.test(sql)) await pg.client.query(`UPDATE ${NAMESPACE}.contacts SET name = 'Thandi M', tags = tags || '["edited"]'::jsonb WHERE id = 'known'`);
        return execute(sql, params);
      });

      expect(await processConfirm(ctx, source, input)).toEqual({ ok: true, status: "confirmed" });

      const [row] = await rows(pg, `SELECT name, lifecycle, tags FROM ${NAMESPACE}.contacts WHERE id = 'known'`);
      expect(row).toEqual({ name: "Thandi M", lifecycle: "customer", tags: ["VIP", "edited", TAG] });
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it("two simultaneous confirms for a new address produce one contact, one consent record and the tag once", async () => {
    const pg = await startPg();
    try {
      const { ctx, source, input } = await setup(pg);

      const outcomes = await Promise.all([processConfirm(ctx, source, input), processConfirm(ctx, source, { ...input, now: new Date(input.now.getTime() + 1) })]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const contacts = await rows(pg, `SELECT id, lifecycle, tags, custom FROM ${NAMESPACE}.contacts`);
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({ lifecycle: "lead", tags: [TAG], custom: { origin: "newsletter" } });
      const consent = await rows(pg, `SELECT purpose, contact_id FROM ${NAMESPACE}.consent_records`);
      expect(consent).toEqual([{ purpose: "newsletter", contact_id: contacts[0]!.id }]);
      expect(await rows(pg, `SELECT kind FROM ${NAMESPACE}.activities WHERE kind = 'newsletter_confirmed'`)).toHaveLength(1);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
