/**
 * The canary client (audit Q1b-2): one internal test client the acceptance agent
 * runs the lead-to-cash journey on, so the chain can be proven end to end
 * without touching a real client.
 *
 * `ensureCanaryClient` is idempotent (asking again returns the same client) and
 * everything about it is flagged (`canary-flag.ts`): ids, tag, custom fields and
 * email addresses that no mail system can deliver to. Sequence email to it is a dry
 * run (`mail.ts`); the other modules are told by the flags and by the rules this
 * returns. `cleanupCanary` removes only what is flagged, and only on `confirm: true`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CANARY_DOMAIN, CANARY_NAME, CANARY_RULES, CANARY_TAG, canaryAccountId, canaryContactId, canaryEmail, isCanaryAccount, isCanaryContact, isCanaryEmail } from "./canary-flag.js";
import { deleteCareDataOfClient } from "./care-store.js";
import { deleteRevenueOfDeals } from "./attribution-store.js";
import { deleteGrowthDataOfClient } from "./growth-erase.js";
import { getAccount, getContact, insertAccount, insertContact, insertLink, listDeals, listLinks, table } from "./db.js";
import { createAccount, createContact, CrmError, linkContact, type Viewer } from "./domain.js";
import { deleteCompanyRecord } from "./handoffs.js";
import { createLeadEndpoint } from "./lead-capture.js";
import { deleteLeadSourcesOf, listLeadSources } from "./lead-store.js";
import { companyPrefix, crmLink, refOf } from "./refs.js";
import { deleteServiceSteps } from "./service-onboarding.js";
import { emitContactDeleted } from "./sync.js";

export const CANARY_JOURNEY: readonly string[] = [
  "Lead: send one test enquiry to the canary form (leadForm.curl, with an address ending @canary.invalid). It shows under Leads from their channels on the canary client's page and opens a lead issue.",
  "Qualify: log what you found on the client (`log-activity`) and set the contact's lifecycle to prospect.",
  "Quote: `create-deal` for the canary company, then draft the quote in Billing (`pib-invoice-draft`) with the deal id. Say in the request that it is the canary. Approvals run as usual.",
  "Sign: `create-sign-document` (template proposal) for the canary company with the deal, then `send-for-signature` (the plugin must know its public address, so open the CRM page once first) and approve the email as usual (it is a dry run: nothing is queued). `get-sign-document` returns the canary's own link; open it, type a name, tick the box and sign. Then `verify-sign-document` must say ok, the deal moves to won and `deal.accepted` goes to Billing. Never ask for a real client's link: you will not be given one.",
  "Won: accept the quote in Billing; the CRM moves the deal to won and the Cockpit opens the onboarding issue once.",
  "Invoice: convert the accepted quote to an invoice in Billing as a draft. Never send it.",
  "Payment proof: record the payment as a test payment in Billing; the CRM logs invoice.paid on the client. A test payment is never counted as revenue: it is not in the attribution report or the goal numbers, and `cleanup-canary` removes any trace of it.",
  "Site events and attribution: `create-event-key` for the canary company, send one test event (`install.curl`), then `site-events-report` shows the visit and `attribution-report` shows the lead under its channel. Install nothing on any site.",
  "Care: `open-support-case` for the canary (answer it and resolve it), `create-client-action` with an https link, then `build-client-report` and `send-client-report`. Each email goes through its approval as usual, and because the address ends @canary.invalid the send is a dry run: the action waits, the report shows as a dry run.",
  "Clean up: `cleanup-canary` with confirm true.",
];

/** Finds or creates the canary company, its contact and its lead form. Idempotent. */
export async function ensureCanaryClient(ctx: PluginContext, viewer: Viewer) {
  const companyId = viewer.companyId;
  const accountId = canaryAccountId(companyId);
  const contactId = canaryContactId(companyId);
  let created = false;

  let account = await getAccount(ctx, accountId);
  if (account && account.companyId !== companyId) throw new CrmError("The canary id belongs to another workspace");
  if (!account) {
    account = createAccount({ id: accountId, companyId, name: CANARY_NAME, domain: CANARY_DOMAIN, lifecycle: "prospect", custom: { canary: true, dryRun: true }, tags: [CANARY_TAG] });
    await insertAccount(ctx, account);
    created = true;
  }

  let contact = await getContact(ctx, contactId);
  if (contact && contact.companyId !== companyId) throw new CrmError("The canary id belongs to another workspace");
  if (!contact) {
    contact = createContact({ id: contactId, companyId, name: "Canary Contact", emails: [canaryEmail()], lifecycle: "lead", custom: { canary: true, dryRun: true }, tags: [CANARY_TAG, "lead"] });
    await insertContact(ctx, contact);
    created = true;
  }
  const linked = (await listLinks(ctx, companyId)).some((link) => link.accountId === accountId && link.contactId === contactId);
  if (!linked) {
    await insertLink(ctx, linkContact({ companyId, contactId, accountId, roleLabel: "owner" }));
    created = true;
  }

  const form = await createLeadEndpoint(ctx, viewer, { client: refOf("company", accountId), label: "Canary form" }, "agent", { canary: true });
  const prefix = await companyPrefix(ctx, companyId);
  return {
    created,
    client: refOf("company", accountId),
    name: account.name,
    link: crmLink(prefix, "company", accountId),
    contact: { ref: refOf("contact", contactId), email: canaryEmail() },
    leadForm: form.source,
    rules: CANARY_RULES,
    journey: CANARY_JOURNEY,
    next: "Run the journey with the refs above. Every outward step stays a draft or a dry run; when you are done, cleanup-canary (confirm true).",
  };
}

const ids = (list: string[]) => JSON.stringify(list);

/** What a cleanup removed, by kind. */
export interface CleanupResult {
  cleaned: boolean;
  company: string | null;
  contacts: number;
  deals: number;
  leadSources: number;
  note?: string;
}

/**
 * Removes the canary client's own records and nothing else: the company and the
 * contacts linked to it that are flagged, their deals, sequences enrollments,
 * activities, profile, leads, lead forms, consent, service steps, sites and project
 * links. A contact linked to it that is not flagged is unlinked, not deleted.
 * Records other modules hold for it (quotes, invoices, posts) are theirs to remove;
 * they are told with `company.deleted`.
 */
export async function cleanupCanary(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<CleanupResult> {
  if (params.confirm !== true) throw new CrmError("cleanup-canary deletes the canary client's records: pass confirm true.");
  const companyId = viewer.companyId;
  const accountId = canaryAccountId(companyId);
  const account = await getAccount(ctx, accountId);
  if (!account || account.companyId !== companyId) return { cleaned: false, company: null, contacts: 0, deals: 0, leadSources: 0, note: "There is no canary client in this workspace." };
  // The guard: never delete a company that is not flagged, whatever its id.
  if (account.custom?.canary !== true || !isCanaryAccount(account) || !accountId.startsWith("canary-")) throw new CrmError("The record with the canary id is not flagged as the canary: it was left alone.");

  const links = (await listLinks(ctx, companyId)).filter((link) => link.accountId === accountId);
  const flagged: string[] = [];
  for (const link of links) {
    const contact = await getContact(ctx, link.contactId);
    if (contact && contact.companyId === companyId && isCanaryContact(contact) && contact.emails.every((email) => isCanaryEmail(email) || !email)) flagged.push(contact.id);
  }
  const deals = (await listDeals(ctx, companyId)).filter((deal) => deal.companyId === companyId && (deal.accountId === accountId || (deal.contactId != null && flagged.includes(deal.contactId))));
  const dealIds = deals.map((deal) => deal.id);
  const recordIds = [accountId, ...flagged, ...dealIds];

  if (flagged.length) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "enrollments")} WHERE company_id = $1 AND contact_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(flagged)]);
  }
  if (dealIds.length) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "deal_products")} WHERE company_id = $1 AND deal_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(dealIds)]);
    // A payment that named only a canary deal (no client on the invoice) is a test payment too: it leaves no revenue behind.
    await deleteRevenueOfDeals(ctx, companyId, dealIds);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "deals")} WHERE company_id = $1 AND id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(dealIds)]);
  }
  await ctx.db.execute(`DELETE FROM ${table(ctx, "activities")} WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(recordIds)]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "facts")} WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(recordIds)]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "record_grants")} WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(recordIds)]);

  // Sites, their log and sign-off state, and the project links (the Paperclip projects themselves stay).
  const sites = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2 LIMIT 100`, [companyId, accountId]);
  for (const site of sites) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "site_changes")} WHERE company_id = $1 AND site_id = $2`, [companyId, site.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "site_signoff")} WHERE company_id = $1 AND site_id = $2`, [companyId, site.id]);
  }
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2`, [companyId, accountId]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2`, [companyId, accountId]);

  const leadSources = (await listLeadSources(ctx, companyId, { kind: "company", id: accountId })).length;
  await deleteLeadSourcesOf(ctx, companyId, "company", accountId);
  await deleteServiceSteps(ctx, companyId, "company", accountId);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND sender_key = $2`, [companyId, `company:${accountId}`]);
  for (const contactId of flagged) {
    await deleteCareDataOfClient(ctx, companyId, { kind: "contact", id: contactId });
    await deleteGrowthDataOfClient(ctx, companyId, { kind: "contact", id: contactId });
    await ctx.db.execute(`DELETE FROM ${table(ctx, "client_profiles")} WHERE company_id = $1 AND client_kind = 'contact' AND client_ref = $2`, [companyId, contactId]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND contact_id = $2`, [companyId, contactId]);
  }

  // The company (and its profile, leads, links) goes through the same path a person's delete takes: it tells the other modules.
  await deleteCompanyRecord(ctx, companyId, account);
  if (flagged.length) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "contacts")} WHERE company_id = $1 AND id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, ids(flagged)]);
    for (const contactId of flagged) await emitContactDeleted(ctx, companyId, contactId);
  }
  return { cleaned: true, company: refOf("company", accountId), contacts: flagged.length, deals: dealIds.length, leadSources };
}

