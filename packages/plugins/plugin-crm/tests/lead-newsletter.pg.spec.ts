/** Migrations 023 (newsletter intake) and 024 (hourly cap) on a real Postgres: existing sources keep working, both CHECKs hold, and the store reads and writes the new columns. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { getLeadSource, insertLeadSource, listLeadSources, saveConfirmSecret, saveLeadSourceSettings, type LeadSource } from "../src/lead-store.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const T = `${NAMESPACE}.lead_sources`;

// The statements of CRM 0.46.2 (before this migration), verbatim in shape: old code must keep running on the new schema.
const OLD_COLUMNS = `id, company_id, client_kind, client_ref, label, site_id, site_url, public_key, previous_key, previous_key_until, signing_secret,
  status, canary, consent_text, privacy_url, success_message, turnstile_site_key, rate_limit_per_hour, accepted_count, rejected_count,
  last_submission_at, created_by, created_at, intake, target_project_id, target_agent_id`;
const OLD_INSERT = `INSERT INTO ${T}
      (id, company_id, client_kind, client_ref, label, site_id, site_url, public_key, signing_secret, status, canary,
       consent_text, privacy_url, success_message, turnstile_site_key, rate_limit_per_hour, created_by, intake, target_project_id, target_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`;
const OLD_UPDATE = `UPDATE ${T}
        SET label = $3, site_id = $4, site_url = $5, status = $6, consent_text = $7, privacy_url = $8, success_message = $9,
            turnstile_site_key = $10, rate_limit_per_hour = $11, updated_at = now()
      WHERE company_id = $1 AND id = $2`;

const NEWSLETTER_COLUMNS = "id, company_id, label, public_key, intake, apply_tags, confirm_url, confirm_from, confirm_secret, signing_secret, consent_text";
const full = { apply_tags: "[\"remotesaffa-subscribers\"]", confirm_url: "https://remotesaffa.co.za/subscribe/confirm", confirm_from: "hello@remotesaffa.co.za", confirm_secret: "pibs_c", signing_secret: "pibs_s", consent_text: "Yes, send me the Friday list." };

function newsletterRow(id: string, values: Record<string, string | null>) {
  return [id, "co-1", `Newsletter ${id}`, `pibl_${id.padEnd(24, "n")}`, "newsletter", values.apply_tags, values.confirm_url, values.confirm_from, values.confirm_secret, values.signing_secret, values.consent_text];
}

describe.skipIf(!available)("migrations 023 and 024 on an existing database", () => {
  it("keeps existing sources as they were, allows newsletter, and enforces lead_sources_newsletter both ways", async () => {
    const pg = await startPg({ upTo: 22 });
    const q = (sql: string, values: unknown[] = []) => pg.client.query(sql, values);
    try {
      await q(OLD_INSERT, ["s1", "co-1", null, null, "Contact", null, "https://acme.co.za", "pibl_aaaaaaaaaaaaaaaaaaaaaaaa", null, "active", false, "Yes", null, null, null, 120, "agent:a", "lead", null, null]);
      await q(OLD_INSERT, ["s2", "co-1", null, null, "Report", null, null, "pibl_bbbbbbbbbbbbbbbbbbbbbbbb", "pibs_x", "active", false, null, null, null, null, 120, "agent:a", "issue", "p1", null]);
      await q(readFileSync(new URL("../migrations/023_crm.sql", import.meta.url), "utf8"));
      await q(readFileSync(new URL("../migrations/024_crm.sql", import.meta.url), "utf8"));

      // Existing rows satisfy both CHECKs unchanged and read back with the defaults.
      expect((await q(`SELECT id, intake, apply_tags, confirm_url, confirm_from, confirm_secret, confirm_daily_cap, confirm_hourly_cap FROM ${T} ORDER BY id`)).rows).toEqual([
        { id: "s1", intake: "lead", apply_tags: [], confirm_url: null, confirm_from: null, confirm_secret: null, confirm_daily_cap: 300, confirm_hourly_cap: null },
        { id: "s2", intake: "issue", apply_tags: [], confirm_url: null, confirm_from: null, confirm_secret: null, confirm_daily_cap: 300, confirm_hourly_cap: null },
      ]);
      // The old insert, update and select statements run against the new schema.
      await q(OLD_INSERT, ["s3", "co-1", "company", "acc-1", "Quote", null, null, "pibl_cccccccccccccccccccccccc", null, "active", false, null, null, null, null, 120, null, "lead", null, null]);
      await q(OLD_UPDATE, ["co-1", "s1", "Contact us", null, "https://acme.co.za", "paused", "Yes please", null, null, null, 60]);
      expect((await q(`SELECT ${OLD_COLUMNS} FROM ${T} WHERE company_id = $1 ORDER BY created_at, id`, ["co-1"])).rows).toHaveLength(3);

      // intake: the three values, never a fourth.
      await q(`INSERT INTO ${T} (${NEWSLETTER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`, newsletterRow("n1", full));
      await expect(q(`UPDATE ${T} SET intake = 'survey' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_intake/);

      // A newsletter row missing any one required field is refused.
      const missing: Array<[string, Record<string, string | null>]> = [
        ["apply_tags", { ...full, apply_tags: "[]" }],
        ["apply_tags", { ...full, apply_tags: "{}" }],
        ["confirm_url", { ...full, confirm_url: null }],
        ["confirm_from", { ...full, confirm_from: null }],
        ["confirm_secret", { ...full, confirm_secret: null }],
        ["consent_text", { ...full, consent_text: null }],
      ];
      for (const [index, [field, values]] of missing.entries()) {
        await expect(q(`INSERT INTO ${T} (${NEWSLETTER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`, newsletterRow(`m${index}`, values)), field).rejects.toThrow(/lead_sources_newsletter/);
      }
      // No signing secret yet (only a person makes one): the newsletter row is accepted and reads back without one.
      await q(`INSERT INTO ${T} (${NEWSLETTER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`, newsletterRow("n2", { ...full, signing_secret: null }));
      expect((await q(`SELECT intake, apply_tags, confirm_url, confirm_secret, signing_secret FROM ${T} WHERE id = 'n2'`)).rows).toEqual([
        { intake: "newsletter", apply_tags: ["remotesaffa-subscribers"], confirm_url: full.confirm_url, confirm_secret: "pibs_c", signing_secret: null },
      ]);
      // Any other intake carries none of the newsletter settings.
      await expect(q(`UPDATE ${T} SET apply_tags = '["x"]' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_newsletter/);
      await expect(q(`UPDATE ${T} SET confirm_url = 'https://acme.co.za/c' WHERE id = 's2'`)).rejects.toThrow(/lead_sources_newsletter/);
      await expect(q(`UPDATE ${T} SET confirm_from = 'a@acme.co.za' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_newsletter/);
      await expect(q(`UPDATE ${T} SET confirm_secret = 'pibs_y' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_newsletter/);
      await expect(q(`UPDATE ${T} SET confirm_hourly_cap = 30 WHERE id = 's2'`)).rejects.toThrow(/lead_sources_newsletter/);
      // 024: a newsletter source has no hourly cap (the 0.51 insert above leaves it null) or one from 1 to 300.
      expect((await q(`SELECT confirm_hourly_cap FROM ${T} WHERE id = 'n1'`)).rows).toEqual([{ confirm_hourly_cap: null }]);
      await q(`UPDATE ${T} SET confirm_hourly_cap = 30 WHERE id = 'n1'`);
      await q(`UPDATE ${T} SET confirm_hourly_cap = 300 WHERE id = 'n1'`);
      for (const bad of [0, 301]) await expect(q(`UPDATE ${T} SET confirm_hourly_cap = $1 WHERE id = 'n1'`, [bad]), String(bad)).rejects.toThrow(/lead_sources_newsletter/);
      // A lead source cannot become a newsletter without its settings, nor a newsletter source drop them.
      await expect(q(`UPDATE ${T} SET intake = 'newsletter' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_newsletter/);
      await expect(q(`UPDATE ${T} SET intake = 'lead' WHERE id = 'n1'`)).rejects.toThrow(/lead_sources_newsletter/);
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it("the store writes and reads a newsletter source through the host's SQL rules, and an old source reads as before", async () => {
    const pg = await startPg();
    try {
      const base: LeadSource = {
        id: "n1", companyId: "co-1", clientKind: null, clientRef: null, label: "Newsletter", siteId: null, siteUrl: "https://remotesaffa.co.za",
        publicKey: "pibl_nnnnnnnnnnnnnnnnnnnnnnnn", previousKey: null, previousKeyUntil: null, signingSecret: "pibs_s", status: "active", canary: false,
        consentText: "Yes, send me the Friday list.", privacyUrl: null, successMessage: null, turnstileSiteKey: null, rateLimitPerHour: 20,
        acceptedCount: 0, rejectedCount: 0, lastSubmissionAt: null, createdBy: "user:u1", createdAt: null, intake: "newsletter", targetProjectId: null, targetAgentId: null,
        applyTags: ["remotesaffa-subscribers"], confirmUrl: "https://remotesaffa.co.za/subscribe/confirm", confirmFrom: "hello@remotesaffa.co.za", confirmSecret: "pibs_c", confirmDailyCap: 250, confirmHourlyCap: 30,
      };
      await insertLeadSource(pg.ctx, base);
      await insertLeadSource(pg.ctx, { ...base, id: "l1", label: "Contact", publicKey: "pibl_llllllllllllllllllllllll", signingSecret: null, intake: "lead", applyTags: [], confirmUrl: null, confirmFrom: null, confirmSecret: null, confirmDailyCap: 300, confirmHourlyCap: null });
      expect(await getLeadSource(pg.ctx, "co-1", "n1")).toMatchObject({ intake: "newsletter", applyTags: ["remotesaffa-subscribers"], confirmUrl: base.confirmUrl, confirmFrom: base.confirmFrom, confirmSecret: "pibs_c", confirmDailyCap: 250, confirmHourlyCap: 30 });
      await insertLeadSource(pg.ctx, { ...base, id: "n2", publicKey: "pibl_oooooooooooooooooooooooo", signingSecret: null });
      expect(await getLeadSource(pg.ctx, "co-1", "n2")).toMatchObject({ intake: "newsletter", signingSecret: null, confirmSecret: "pibs_c" });
      expect(await getLeadSource(pg.ctx, "co-1", "l1")).toMatchObject({ intake: "lead", applyTags: [], confirmUrl: null, confirmSecret: null, confirmDailyCap: 300, confirmHourlyCap: null });

      await saveLeadSourceSettings(pg.ctx, { ...base, applyTags: ["a", "b"], confirmDailyCap: 100, confirmHourlyCap: null });
      await saveConfirmSecret(pg.ctx, "co-1", "n1", "pibs_new");
      // The confirm secret is only ever set on a newsletter source.
      await saveConfirmSecret(pg.ctx, "co-1", "l1", "pibs_other");
      expect((await listLeadSources(pg.ctx, "co-1")).map((row) => [row.id, row.applyTags, row.confirmSecret, row.confirmDailyCap, row.confirmHourlyCap])).toEqual([
        ["n1", ["a", "b"], "pibs_new", 100, null],
        ["l1", [], null, 300, null],
        ["n2", ["remotesaffa-subscribers"], "pibs_c", 250, 30],
      ]);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
