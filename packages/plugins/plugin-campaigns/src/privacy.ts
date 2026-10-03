/**
 * Consent records and erasure for campaign recipients (Q10-13, POPIA).
 *
 * Consent. SMS and WhatsApp marketing needs a recorded opt-in per sender and
 * channel (`channel_consents`); email is opt-out and needs none. Records arrive as
 * the kit's `consent.recorded` (a form, an import, a reply) or from an agent
 * through `record-channel-consent`. A withdrawal puts the address on the
 * do-not-contact list of the sender the event names (`senderKeyOf(subject)`: `own`
 * for PiB's own marketing, `company:<id>` or `contact:<id>` for a client's), never
 * on every list: a client's unsubscribe must not silence PiB or another client.
 *
 * Erasure. `contact.erase.requested` (the CRM sends it after one person's
 * approval; the kit receiver refuses it without one and never runs it twice)
 * removes what Campaigns holds about the person: their enrollments, step events,
 * reply log, Mailbox send requests and SMS or WhatsApp messages, their consents, and
 * the personal text in the step, reply and failed-send issues (the issues stay,
 * cancelled, with the person's name and message removed). Two things stay, and are
 * reported as `retained`: their do-not-contact entries, rewritten to a hash so the
 * address itself is gone but they are never contacted again, and the comments agents
 * wrote on issues, which a plugin cannot edit. A request for `marketing_only` only
 * adds the opt-outs and stops the running campaigns.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  getCrmContact,
  senderKeyOf,
  suppressionEmail,
  textArrayParam,
  type ConsentPurpose,
  type ConsentRecorded,
  type ContactEraseRequested,
  type EraseOutcome,
} from "@partnersinbiz/pib-plugin-kit";
import {
  addChannelSuppression,
  addressHash,
  crmContactsByEmail,
  crmContactsByPhone,
  listSteps,
  stopEnrollmentsForSender,
  table,
  upsertConsent,
} from "./db.js";
import { normalizePhone, type Channel } from "./channels.js";
import { campaignMailKey } from "./domain.js";
import { addSuppression } from "./db.js";
import { optOutChannel } from "./sms.js";
import { cancelStepIssue, suppressAddress } from "./suppress.js";
import { PLUGIN_ID } from "./namespace.js";
import { CAMPAIGN_ORIGINS } from "./origins.js";

const PURPOSE_CHANNEL: Record<ConsentPurpose, Channel | null> = {
  marketing_email: "email",
  newsletter: "email",
  marketing_sms: "sms",
  profiling: null,
  service_messages: null,
};

/** `consent.recorded` from the CRM, the Mailbox or Social. */
export async function onConsentRecorded(ctx: PluginContext, companyId: string, consent: ConsentRecorded): Promise<void> {
  const channel = PURPOSE_CHANNEL[consent.purpose];
  if (!channel) return;
  const address = channel === "email" ? (consent.subject.email ? suppressionEmail(consent.subject.email) : null) : normalizePhone(consent.subject.phone, "+27");
  if (!address) return;
  const senderKey = senderKeyOf(consent.subject);
  const stored = await upsertConsent(ctx, {
    companyId,
    channel,
    address,
    senderKey,
    granted: consent.granted,
    basis: consent.basis,
    source: consent.source,
    evidence: consent.evidence?.wording ?? null,
    contactId: consent.subject.contactId ?? null,
    recordedAt: consent.recordedAt,
    recordedBy: consent.recordedBy ?? null,
  });
  if (!stored || consent.granted) return;
  // Withdrawn: on the list of the sender the event names, the same one the consent was stored for. The same
  // event is not announced again (a plugin never hears itself).
  const contactIds = consent.subject.contactId ? [consent.subject.contactId] : [];
  if (channel === "email") {
    await suppressAddress(ctx, { companyId, email: address, reason: "unsubscribe", scope: "marketing", source: consent.recordedBy ?? "consent", senderKey, contactId: consent.subject.contactId ?? null });
  } else {
    await optOutChannel(ctx, { companyId, channel, address, senderKey, reason: "consent_withdrawn", source: consent.recordedBy ?? "consent", contactIds, announce: false });
  }
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/** Replaces the personal text of an issue the plugin opened and closes it. True when it changed. */
async function scrubIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return false;
    await ctx.issues.update(issueId, { title: "Erased contact", description: "The person this issue was about asked for their data to be erased (POPIA). The text was removed.", status: "cancelled" }, companyId);
    return true;
  } catch (error) {
    ctx.logger.info("Could not scrub an issue during an erasure", { issueId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Rewrites the do-not-contact entries of one address (one per sender, and per channel for a
 * number) from the address to its hash. A person who was erased, wrote to us again and
 * opted out again already has a hash entry for that sender, and the table's key
 * (company, address, sender) would refuse a second one: the old entry folds into the
 * existing one (the wider scope wins) instead of failing the whole erasure. Returns how many
 * entries it handled.
 */
async function rehashEntries(
  ctx: PluginContext,
  input: { list: "suppressions" | "channel_suppressions"; column: "email" | "address"; companyId: string; plain: string },
): Promise<number> {
  const { list, column, companyId, plain } = input;
  const hash = addressHash(plain);
  const byChannel = list === "channel_suppressions";
  const entries = await ctx.db.query<{ sender_key: string; scope: string; channel?: string }>(
    `SELECT sender_key, scope${byChannel ? ", channel" : ""} FROM ${table(ctx, list)} WHERE company_id = $1 AND ${column} = $2`,
    [companyId, plain],
  );
  for (const entry of entries) {
    const key = (value: string) => (byChannel ? [companyId, value, entry.sender_key, entry.channel] : [companyId, value, entry.sender_key]);
    const where = `company_id = $1 AND ${column} = $2 AND sender_key = $3${byChannel ? " AND channel = $4" : ""}`;
    const existing = await ctx.db.query<{ scope: string }>(`SELECT scope FROM ${table(ctx, list)} WHERE ${where}`, key(hash));
    if (existing[0]) {
      if (entry.scope === "all" && existing[0].scope !== "all") await ctx.db.execute(`UPDATE ${table(ctx, list)} SET scope = 'all', updated_at = now() WHERE ${where}`, key(hash));
      await ctx.db.execute(`DELETE FROM ${table(ctx, list)} WHERE ${where}`, key(plain));
    } else {
      await ctx.db.execute(`UPDATE ${table(ctx, list)} SET ${column} = $${byChannel ? 5 : 4}, contact_id = NULL, updated_at = now() WHERE ${where}`, [...key(plain), hash]);
    }
  }
  return entries.length;
}

/** Erases one person from Campaigns (the receiver registered in the worker calls this). Safe to run twice. */
export async function eraseSubject(ctx: PluginContext, request: ContactEraseRequested, companyId: string): Promise<EraseOutcome> {
  const subject = request.subject;
  const emails = new Set<string>(subject.email ? [suppressionEmail(subject.email)] : []);
  const phones = new Set<string>();
  if (subject.phone) {
    const phone = normalizePhone(subject.phone, "+27");
    if (phone) phones.add(phone);
  }
  const contactIds = new Set<string>(subject.contactId ? [subject.contactId] : []);
  if (subject.contactId) {
    const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, subject.contactId).catch(() => null);
    for (const email of contact?.emails ?? []) emails.add(suppressionEmail(email));
    for (const raw of contact?.phones ?? []) {
      const phone = normalizePhone(raw, "+27");
      if (phone) phones.add(phone);
    }
  }
  for (const email of [...emails]) for (const contact of await crmContactsByEmail(ctx, companyId, email)) contactIds.add(contact.id);
  for (const phone of [...phones]) {
    for (const contact of await crmContactsByPhone(ctx, companyId, phone.replace(/\D/g, "").slice(-9))) {
      const full = await getCrmContact(ctx, ctx.db.namespace, companyId, contact.id).catch(() => null);
      if ((full?.phones ?? []).some((raw) => normalizePhone(raw, "+27") === phone)) contactIds.add(contact.id);
    }
  }
  const counts: Record<string, number> = {};
  const retained: Array<{ what: string; why: string }> = [];
  const errors: string[] = [];
  const count = (kind: string, n: number) => {
    if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
  };

  // Stop everything first, whatever the scope: nothing more goes to this person.
  for (const contactId of contactIds) {
    for (const stopped of await stopEnrollmentsForSender(ctx, companyId, contactId, "")) {
      count("enrollments_stopped", 1);
      if (stopped.open_issue_id) await cancelStepIssue(ctx, companyId, stopped.open_issue_id, "This person", "stopped");
    }
  }

  if (request.scope === "marketing_only") {
    for (const email of emails) {
      if (await addSuppression(ctx, { companyId, email, reason: "manual", scope: "marketing", source: PLUGIN_ID, contactId: null, campaignId: null, senderKey: "" })) count("opt_outs", 1);
    }
    for (const phone of phones) {
      for (const channel of ["sms", "whatsapp"] as const) {
        if (await addChannelSuppression(ctx, { companyId, channel, address: phone, senderKey: "", reason: "manual", scope: "marketing", source: PLUGIN_ID })) count("opt_outs", 1);
      }
    }
    return { counts, retained, ...(errors.length ? { errors } : {}) };
  }

  let scrubbed = 0;
  for (const contactId of contactIds) {
    const enrollments = await ctx.db.query<{ id: string; campaign_id: string; open_issue_id: string | null }>(
      `SELECT id, campaign_id, open_issue_id FROM ${table(ctx, "campaign_enrollments")} WHERE company_id = $1 AND contact_id = $2`,
      [companyId, contactId],
    );
    for (const enrollment of enrollments) {
      try {
        const positions = [...new Set((await listSteps(ctx, enrollment.campaign_id)).map((step) => step.position))];
        const replyIds = (await ctx.db.query<{ source_key: string | null }>(
          `SELECT source_key FROM ${table(ctx, "campaign_step_events")} WHERE enrollment_id = $1 AND event_type = 'reply'`,
          [enrollment.id],
        )).map((row) => String(row.source_key ?? "").replace(/^reply:/, "")).filter(Boolean);
        const issueIds = new Set<string>(enrollment.open_issue_id ? [enrollment.open_issue_id] : []);
        const origins = [
          ...positions.map((position) => `${CAMPAIGN_ORIGINS.step}${enrollment.id}:${position}`),
          ...positions.map((position) => `${CAMPAIGN_ORIGINS.sendFailed}${enrollment.id}:${position}`),
          ...replyIds.map((messageId) => `${CAMPAIGN_ORIGINS.reply}${enrollment.id}:${messageId}`),
        ];
        for (const originId of origins) {
          const found = await ctx.issues.list({ companyId, originKind: `plugin:${PLUGIN_ID}`, originId, limit: 5 }).catch(() => []);
          for (const issue of found) issueIds.add(issue.id);
        }
        for (const issueId of issueIds) if (await scrubIssue(ctx, companyId, issueId)) scrubbed += 1;
        // Rows that reference the enrollment, children first (step events point at it).
        const events = await ctx.db.execute(`DELETE FROM ${table(ctx, "campaign_step_events")} WHERE enrollment_id = $1`, [enrollment.id]);
        count("step_events", events.rowCount);
        const replies = await ctx.db.execute(`DELETE FROM ${table(ctx, "reply_log")} WHERE enrollment_id = $1`, [enrollment.id]);
        count("reply_log", replies.rowCount);
        const messages = await ctx.db.execute(`DELETE FROM ${table(ctx, "channel_messages")} WHERE enrollment_id = $1`, [enrollment.id]);
        count("messages", messages.rowCount);
        for (const position of positions) {
          const mail = await ctx.db.execute(`DELETE FROM ${table(ctx, "outbox")} WHERE key = $1`, [campaignMailKey(enrollment.id, position)]);
          count("mail_requests", mail.rowCount);
        }
        const removed = await ctx.db.execute(`DELETE FROM ${table(ctx, "campaign_enrollments")} WHERE id = $1`, [enrollment.id]);
        count("enrollments", removed.rowCount);
      } catch (error) {
        errors.push(`enrollment ${enrollment.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
    }
  }
  count("issues_scrubbed", scrubbed);

  // Consents: the records of what the person agreed to go with them.
  for (const address of [...emails, ...phones]) {
    const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "channel_consents")} WHERE company_id = $1 AND address = $2`, [companyId, address]);
    count("consents", res.rowCount);
  }

  // The do-not-contact entries stay, as a hash.
  let hashed = 0;
  try {
    for (const email of emails) hashed += await rehashEntries(ctx, { list: "suppressions", column: "email", companyId, plain: email });
    for (const phone of phones) hashed += await rehashEntries(ctx, { list: "channel_suppressions", column: "address", companyId, plain: phone });
  } catch (error) {
    errors.push(`do-not-contact entries: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
  }
  if (hashed > 0) retained.push({ what: `${hashed} do-not-contact entr${hashed === 1 ? "y" : "ies"} (as a one-way hash, no address)`, why: "So the person is never emailed or texted again by a campaign; the address itself is gone." });

  // The CRM copy this plugin keeps: blanked now, the CRM's own deletion follows.
  for (const contactId of contactIds) {
    const res = await ctx.db.execute(
      `UPDATE ${table(ctx, "crm_contacts")} SET name = '[erased]', emails = ${textArrayParam(3)}, phones = ${textArrayParam(3)}, tags = ${textArrayParam(3)}, deleted = true, updated_at = now() WHERE company_id = $1 AND id = $2`,
      [companyId, contactId, "[]"],
    );
    count("contact_copies", res.rowCount);
  }
  if (scrubbed > 0) retained.push({ what: "comments agents wrote on campaign issues", why: "Paperclip stores issue comments, and a plugin cannot edit or delete them. The issue titles and descriptions were cleared." });
  return { counts, retained, ...(errors.length ? { errors } : {}) };
}
