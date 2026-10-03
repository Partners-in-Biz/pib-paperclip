/**
 * Erasing one person from Billing (audit Q10-13, POPIA).
 *
 * The CRM sends an approved `contact.erase.requested` (a person approved it; the kit refuses one without).
 * Billing answers for what it holds about that person, and the law decides what it may drop:
 *
 * Erased now
 * - drafts that were never issued (invoices, quotes and their lines, with any payment link): not records;
 * - the CRM projection row for the contact, proofs-of-payment text (sender, subject, snippet), email delivery
 *   records (recipients and subject), internal follow-up notes, unbilled time, the reason on an opt-out;
 * - the person's email and phone wherever they sit on someone else's documents (a company's invoice that
 *   was sent to them), and in a quote's recipients;
 * - subscriptions are cancelled and lose the name.
 *
 * Kept, with the reason, as a minimal record
 * - issued invoices, credit notes and their payments are tax records (Tax Administration Act s29 and VAT
 *   Act s55: five years; Companies Act s24: seven). The frozen customer details are cut to what a tax
 *   invoice must show (name, address, VAT and registration numbers): email, phone and contact name go.
 *   A hold records the day the period ends (invoice date plus `privacy.retentionYears`, default 7), and the
 *   nightly job then replaces the name and address too. Proof-of-payment files and invoice PDFs stay in
 *   the private bucket for the same period (deleting a stored object is not something Billing does).
 * - the host's own log of webhook deliveries (a Stripe payment payload names the payer, their email and
 *   address) is outside what a plugin can read or delete: the answer says so, for the host operator to purge.
 *
 * Every step is idempotent: a second run finds nothing more to drop and answers the same retained list.
 * Billing keeps proof that the erasure happened without the person: a hash of the subject key.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { consentSubjectKey, PIB_PLUGINS, registerEraseReceiver, type ContactEraseRequested, type EraseOutcome } from "@partnersinbiz/pib-plugin-kit";
import { billingSettings } from "./config.js";
import { table } from "./db.js";

const MIN_YEARS = 5;
const MAX_YEARS = 15;

export function retentionYears(settings: { privacy?: { retentionYears?: number } }): number {
  const years = Number(settings.privacy?.retentionYears ?? 7);
  return Number.isFinite(years) ? Math.max(MIN_YEARS, Math.min(MAX_YEARS, Math.floor(years))) : 7;
}

const RETENTION_WHY = "Tax Administration Act s29 and VAT Act s55 (five years) and Companies Act s24 (seven): issued invoices, credit notes and their payments are accounting records.";

interface Subject {
  contactIds: string[];
  email: string | null;
  phone: string | null;
}

async function resolveSubject(ctx: PluginContext, companyId: string, request: ContactEraseRequested): Promise<Subject> {
  const s = request.subject;
  const email = s.email?.trim().toLowerCase() || null;
  const phone = s.phone?.replace(/[^0-9+]/g, "") || null;
  const ids = new Set<string>();
  if (s.contactId) ids.add(s.contactId);
  if (s.clientKind === "contact" && s.clientRef) ids.add(s.clientRef);
  if (email) {
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND $2 = ANY(SELECT lower(e) FROM unnest(emails) AS e)`,
      [companyId, email],
    );
    for (const row of rows) ids.add(row.id);
  }
  return { contactIds: [...ids], email, phone };
}

async function count(ctx: PluginContext, sql: string, params: unknown[]): Promise<number> {
  const rows = await ctx.db.query<{ n: string | number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const asJson = (list: string[]) => JSON.stringify(list);
const ids = (n: number) => `(SELECT jsonb_array_elements_text($${n}::jsonb))`;

export async function eraseFromBilling(ctx: PluginContext, request: ContactEraseRequested, companyId: string): Promise<EraseOutcome> {
  const counts: Record<string, number> = {};
  const retained: Array<{ what: string; why: string }> = [];
  // Billing holds no marketing data: a marketing-only request has nothing here.
  if (request.scope === "marketing_only") return { counts, retained };
  const subject = await resolveSubject(ctx, companyId, request);
  const bump = (kind: string, n: number) => {
    if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
  };
  const settings = await billingSettings(ctx, companyId);
  const years = retentionYears(settings);

  for (const contactId of subject.contactIds) {
    // 1. Drafts that were never issued are not records.
    const draftInvoices = (await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND status = 'draft'`, [companyId, contactId])).map((r) => r.id);
    if (draftInvoices.length) {
      await ctx.db.execute(`DELETE FROM ${table(ctx, "payment_links")} WHERE invoice_id IN ${ids(1)}`, [asJson(draftInvoices)]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "invoice_lines")} WHERE invoice_id IN ${ids(1)}`, [asJson(draftInvoices)]);
      bump("draft_invoices", (await ctx.db.execute(`DELETE FROM ${table(ctx, "invoices")} WHERE id IN ${ids(1)} AND status = 'draft'`, [asJson(draftInvoices)])).rowCount ?? 0);
    }
    const draftQuotes = (await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND status = 'draft'`, [companyId, contactId])).map((r) => r.id);
    if (draftQuotes.length) {
      await ctx.db.execute(`DELETE FROM ${table(ctx, "quote_lines")} WHERE quote_id IN ${ids(1)}`, [asJson(draftQuotes)]);
      bump("draft_quotes", (await ctx.db.execute(`DELETE FROM ${table(ctx, "quotes")} WHERE id IN ${ids(1)} AND status = 'draft'`, [asJson(draftQuotes)])).rowCount ?? 0);
    }

    const docs = await ctx.db.query<{ kind: string; id: string }>(
      `SELECT 'invoice' AS kind, id FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2
       UNION ALL SELECT 'quote' AS kind, id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2`,
      [companyId, contactId],
    );
    const invoiceIds = docs.filter((d) => d.kind === "invoice").map((d) => d.id);
    const quoteIds = docs.filter((d) => d.kind === "quote").map((d) => d.id);

    // 2. Issued invoices: cut the frozen customer details to what a tax invoice shows. The live copy too.
    if (invoiceIds.length) {
      const minimal = (col: string) => `jsonb_strip_nulls(jsonb_build_object('name', ${col}->'name', 'address', ${col}->'address', 'vatNumber', ${col}->'vatNumber', 'registrationNumber', ${col}->'registrationNumber', 'refKind', ${col}->'refKind', 'refId', ${col}->'refId'))`;
      const res = await ctx.db.execute(
        `UPDATE ${table(ctx, "invoices")}
            SET customer = ${minimal("customer")},
                customer_snapshot = CASE WHEN customer_snapshot IS NULL THEN NULL ELSE ${minimal("customer_snapshot")} END,
                send_to = '[]'::jsonb, updated_at = now()
          WHERE id IN ${ids(1)} AND (customer->>'email' IS NOT NULL OR customer->>'contactName' IS NOT NULL OR customer->>'phone' IS NOT NULL OR customer_snapshot->>'email' IS NOT NULL OR customer_snapshot->>'contactName' IS NOT NULL OR customer_snapshot->>'phone' IS NOT NULL OR send_to <> '[]'::jsonb)`,
        [asJson(invoiceIds)],
      );
      bump("invoice_contact_details", res.rowCount ?? 0);
      await ctx.db.execute(`UPDATE ${table(ctx, "payment_links")} SET url = NULL WHERE invoice_id IN ${ids(1)} AND url IS NOT NULL`, [asJson(invoiceIds)]);
      const issued = await count(ctx, `SELECT count(*)::text AS n FROM ${table(ctx, "invoices")} WHERE id IN ${ids(1)} AND status <> 'draft'`, [asJson(invoiceIds)]);
      if (issued > 0) {
        const notes = await count(ctx, `SELECT count(*)::text AS n FROM ${table(ctx, "credit_notes")} WHERE invoice_id IN ${ids(1)}`, [asJson(invoiceIds)]);
        const payments = await count(ctx, `SELECT count(*)::text AS n FROM ${table(ctx, "payments")} WHERE invoice_id IN ${ids(1)}`, [asJson(invoiceIds)]);
        await ctx.db.execute(
          `INSERT INTO ${table(ctx, "privacy_holds")} (company_id, customer_kind, customer_ref, request_id, retain_until)
           SELECT $1, 'contact', $2, $3, (max(COALESCE(sent_at, created_at)) + make_interval(years => $4::int))::date FROM ${table(ctx, "invoices")}
            WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND status <> 'draft' HAVING count(*) > 0
           ON CONFLICT (company_id, customer_kind, customer_ref) DO UPDATE SET retain_until = GREATEST(${table(ctx, "privacy_holds")}.retain_until, EXCLUDED.retain_until), released_at = NULL`,
          [companyId, contactId, request.requestId, years],
        );
        const hold = (await ctx.db.query<{ retain_until: string }>(`SELECT retain_until::text AS retain_until FROM ${table(ctx, "privacy_holds")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2`, [companyId, contactId]))[0];
        const until = hold?.retain_until ?? "the end of the retention period";
        retained.push({
          what: `${issued} issued invoice${issued === 1 ? "" : "s"}${notes ? `, ${notes} credit note${notes === 1 ? "" : "s"}` : ""}${payments ? ` and ${payments} payment${payments === 1 ? "" : "s"}` : ""} (name and address only; email, phone and contact name removed)`,
          why: `${RETENTION_WHY} Name and address are removed on ${until}.`,
        });
      }
    }

    // 3. Quotes (not tax records): the customer details go, the numbers stay.
    if (quoteIds.length) {
      const res = await ctx.db.execute(
        `UPDATE ${table(ctx, "quotes")} SET customer = jsonb_build_object('name', '[erased]'), send_to = '[]'::jsonb, updated_at = now()
          WHERE id IN ${ids(1)} AND (customer->>'name' <> '[erased]' OR send_to <> '[]'::jsonb)`,
        [asJson(quoteIds)],
      );
      bump("quotes", res.rowCount ?? 0);
    }

    // 4. Email delivery records, internal notes, proofs of payment text.
    const docIds = [...invoiceIds, ...quoteIds];
    if (docIds.length) {
      bump("email_records", (await ctx.db.execute(`UPDATE ${table(ctx, "deliveries")} SET recipients = '[]'::jsonb, subject = '[erased]', updated_at = now() WHERE company_id = $1 AND doc_id IN ${ids(2)} AND (recipients <> '[]'::jsonb OR subject <> '[erased]')`, [companyId, asJson(docIds)])).rowCount ?? 0);
      bump("follow_up_notes", (await ctx.db.execute(`DELETE FROM ${table(ctx, "follow_ups")} WHERE company_id = $1 AND subject_id IN ${ids(2)}`, [companyId, asJson(docIds)])).rowCount ?? 0);
    }
    if (invoiceIds.length) {
      bump("proof_of_payment_text", (await ctx.db.execute(`UPDATE ${table(ctx, "pops")} SET from_email = NULL, from_name = NULL, subject = NULL, snippet = NULL, attachments = '[]'::jsonb WHERE company_id = $1 AND invoice_id IN ${ids(2)} AND (from_email IS NOT NULL OR from_name IS NOT NULL OR subject IS NOT NULL OR snippet IS NOT NULL)`, [companyId, asJson(invoiceIds)])).rowCount ?? 0);
      const files = await count(ctx, `SELECT count(*)::text AS n FROM ${table(ctx, "pops")} WHERE company_id = $1 AND invoice_id IN ${ids(2)} AND file_key IS NOT NULL`, [companyId, asJson(invoiceIds)]);
      if (files > 0) retained.push({ what: `${files} proof-of-payment file${files === 1 ? "" : "s"} and the invoice PDFs in private storage`, why: `${RETENTION_WHY} Billing does not delete stored files; they are removed with the records at the end of the period.` });
      // The host keeps every webhook delivery (payload and headers) in its own log, and a Stripe payment payload carries the payer's name, email and address.
      const paidOnline = await count(ctx, `SELECT count(*)::text AS n FROM ${table(ctx, "payment_links")} WHERE company_id = $1 AND invoice_id IN ${ids(2)} AND status = 'paid' AND provider <> 'mock'`, [companyId, asJson(invoiceIds)]);
      if (paidOnline > 0) {
        retained.push({
          what: `${paidOnline} online payment notification${paidOnline === 1 ? "" : "s"} in the Paperclip host's webhook delivery log (the payer's name, email and billing address as the provider sent them)`,
          why: "The host stores every webhook delivery it receives (payload and headers) in its own table, which a plugin can neither read nor delete and which has no retention period. Billing cannot erase these: ask the host operator to purge the old delivery rows of this plugin.",
        });
      }
    }

    // 5. Time, subscriptions, opt-outs, the CRM projection.
    bump("unbilled_time", (await ctx.db.execute(`DELETE FROM ${table(ctx, "time_entries")} WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND invoice_id IS NULL`, [companyId, contactId])).rowCount ?? 0);
    bump("subscriptions", (await ctx.db.execute(`UPDATE ${table(ctx, "subscriptions")} SET customer_name = '[erased]', description = '[erased]', status = 'cancelled', updated_at = now() WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND (customer_name <> '[erased]' OR status <> 'cancelled')`, [companyId, contactId])).rowCount ?? 0);
    await ctx.db.execute(`UPDATE ${table(ctx, "dunning_optouts")} SET reason = NULL WHERE company_id = $1 AND customer_kind = 'contact' AND customer_ref = $2 AND reason IS NOT NULL`, [companyId, contactId]);
    bump("crm_contacts", (await ctx.db.execute(`DELETE FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND id = $2`, [companyId, contactId])).rowCount ?? 0);
  }

  // 6. The person's own address and number on other customers' documents (a company's invoice sent to them).
  if (subject.email) {
    const email = subject.email;
    const withoutEmail = (col: string) => `COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(${col}) AS item WHERE lower(item->>'email') <> $2), '[]'::jsonb)`;
    bump("other_documents", (await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET send_to = ${withoutEmail("send_to")}, updated_at = now() WHERE company_id = $1 AND send_to::text ILIKE '%' || $2 || '%'`, [companyId, email])).rowCount ?? 0);
    bump("other_documents", (await ctx.db.execute(`UPDATE ${table(ctx, "quotes")} SET send_to = ${withoutEmail("send_to")}, updated_at = now() WHERE company_id = $1 AND send_to::text ILIKE '%' || $2 || '%'`, [companyId, email])).rowCount ?? 0);
    bump("other_documents", (await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET customer = customer - 'email' - 'contactName' - 'phone', updated_at = now() WHERE company_id = $1 AND lower(customer->>'email') = $2`, [companyId, email])).rowCount ?? 0);
    bump("other_documents", (await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET customer_snapshot = customer_snapshot - 'email' - 'contactName' - 'phone' WHERE company_id = $1 AND lower(customer_snapshot->>'email') = $2`, [companyId, email])).rowCount ?? 0);
    bump("other_documents", (await ctx.db.execute(`UPDATE ${table(ctx, "quotes")} SET customer = customer - 'email' - 'contactName' - 'phone', updated_at = now() WHERE company_id = $1 AND lower(customer->>'email') = $2`, [companyId, email])).rowCount ?? 0);
    bump("email_records", (await ctx.db.execute(`UPDATE ${table(ctx, "deliveries")} SET recipients = ${withoutEmail("recipients")}, updated_at = now() WHERE company_id = $1 AND recipients::text ILIKE '%' || $2 || '%'`, [companyId, email])).rowCount ?? 0);
    bump("proof_of_payment_text", (await ctx.db.execute(`UPDATE ${table(ctx, "pops")} SET from_email = NULL, from_name = NULL, subject = NULL, snippet = NULL, attachments = '[]'::jsonb WHERE company_id = $1 AND lower(from_email) = $2`, [companyId, email])).rowCount ?? 0);
    bump("crm_contacts", (await ctx.db.execute(`DELETE FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND $2 = ANY(SELECT lower(e) FROM unnest(emails) AS e)`, [companyId, email])).rowCount ?? 0);
  }

  const key = consentSubjectKey(request.subject);
  const status = Object.values(counts).some((n) => n > 0) ? "erased" : retained.length ? "retained" : "nothing_found";
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "erasures")} (company_id, request_id, subject_hash, status, counts, retained, approved_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) ON CONFLICT (company_id, request_id) DO UPDATE SET status = EXCLUDED.status, counts = EXCLUDED.counts, retained = EXCLUDED.retained, completed_at = now()`,
    [companyId, request.requestId, createHash("sha256").update(key ?? request.requestId).digest("hex"), status, JSON.stringify(counts), JSON.stringify(retained), request.approvedByUserId],
  );
  return { counts, retained };
}

/** Nightly: a hold whose period has ended gets the name and address replaced too, and is released. Returns how many it finished. */
export async function finishErasureHolds(ctx: PluginContext, companyId: string, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const due = await ctx.db.query<{ customer_kind: string; customer_ref: string }>(
    `SELECT customer_kind, customer_ref FROM ${table(ctx, "privacy_holds")} WHERE company_id = $1 AND released_at IS NULL AND retain_until <= $2::date`,
    [companyId, today],
  );
  for (const hold of due) {
    const erased = `jsonb_build_object('name', '[erased]')`;
    await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET customer = ${erased}, customer_snapshot = CASE WHEN customer_snapshot IS NULL THEN NULL ELSE ${erased} END, updated_at = now() WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3`, [companyId, hold.customer_kind, hold.customer_ref]);
    await ctx.db.execute(`UPDATE ${table(ctx, "privacy_holds")} SET released_at = now() WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3`, [companyId, hold.customer_kind, hold.customer_ref]);
  }
  return due.length;
}

/** Subscribes to the CRM's approved erasure requests (call once in `setup`). */
export function registerBillingErasure(ctx: PluginContext): void {
  registerEraseReceiver(ctx, { plugin: PIB_PLUGINS.billing, erase: (request, companyId) => eraseFromBilling(ctx, request, companyId) });
}
