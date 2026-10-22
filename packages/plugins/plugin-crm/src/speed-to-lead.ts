/**
 * Speed-to-lead (PAR-2262): draft-only first reply when a lead with email is stored.
 * Consent gate → short EN/AF draft → Peet care approval → `mail.draft.requested`.
 * Send only via care-approvals person-done path. This module never enqueues a send.
 * Metrics: t_arrival / t_draft_ready here; t_approved / t_sent in speedToLeadHooks.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { enqueue, MAIL_EVENTS, readConfig, type MailDraftRequested } from "@partnersinbiz/pib-plugin-kit";
import { approvalsForClient } from "./care-store.js";
import { getContact, insertActivityOnce } from "./db.js";
import { textToHtml } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { requestApproval, type MailApprovalHooks, type MailDraft } from "./outbound.js";

const AF_MARKERS =
  /\b(asseblief|baie\s+dankie|dankie|goeie\s+dag|goeiemôre|goeiemore|ek\s+wil|ek\s+soek|hoeveel|pryslys|kwotasie|besigheids|webwerf)\b/i;

const STALE_LEAD_MS = 24 * 60 * 60 * 1000;

export type SpeedToLeadLang = "en" | "af";

export interface SpeedToLeadInput {
  companyId: string;
  contactId: string;
  leadKey: string;
  source: string;
  text: string;
  name: string | null;
  email: string;
  langHint?: string | null;
  arrivedAt?: string | null;
}

export interface SpeedToLeadMetrics {
  t_arrival: string;
  t_draft_ready: string;
  t_approved?: string;
  t_sent?: string;
}

export function isOptedOut(emailStatus: string | null | undefined): boolean {
  return emailStatus === "unsubscribed" || emailStatus === "bounced";
}

/** AF when lead text has common AF markers or lang hint says af; else EN. */
export function detectSpeedToLeadLang(text: string, langHint?: string | null): SpeedToLeadLang {
  const hint = (langHint ?? "").trim().toLowerCase();
  if (hint === "af" || hint.startsWith("af-") || hint === "afrikaans") return "af";
  if (hint === "en" || hint.startsWith("en-") || hint === "english") return "en";
  return AF_MARKERS.test(text) ? "af" : "en";
}

function firstName(name: string | null | undefined): string {
  const part = (name ?? "").trim().split(/\s+/)[0];
  return part && part.length <= 40 ? part : "";
}

/** Short draft with call CTA and Peet sign-off. No prices. */
export function composeSpeedToLeadDraft(input: {
  name: string | null;
  email: string;
  text: string;
  langHint?: string | null;
  contactId: string;
  threadId?: string | null;
}): { lang: SpeedToLeadLang; draft: MailDraft } {
  const lang = detectSpeedToLeadLang(input.text, input.langHint);
  const who = firstName(input.name);
  const hi = who ? (lang === "af" ? `Hallo ${who},` : `Hi ${who},`) : lang === "af" ? "Hallo," : "Hi,";
  const text =
    lang === "af"
      ? `${hi}\n\nDankie vir jou navraag. Kan ons kort skakel?\n\nAntwoord met 'n dag en tyd wat vir jou pas, en ons bevestig dit. Geen pryse hier.\n\nGroete,\nPeet`
      : `${hi}\n\nThanks for getting in touch. Quick call?\n\nReply with a day and time that suits you and we'll lock it in. No prices here.\n\nThanks,\nPeet`;
  const subject = lang === "af" ? "Jou navraag — kort skakel?" : "Your enquiry — quick call?";
  return {
    lang,
    draft: { to: [{ email: input.email, name: input.name }], subject, text, html: textToHtml(text), contactId: input.contactId, threadId: input.threadId ?? null },
  };
}

function langFromContact(contact: { custom?: Record<string, unknown> } | null, hint?: string | null): string | null {
  if (hint) return hint;
  for (const key of ["language", "lang", "preferredLanguage"]) {
    const value = contact?.custom?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function logSpeedToLeadSkipped(
  ctx: PluginContext,
  input: { companyId: string; contactId: string; leadKey: string; reason: string; body: string; sourceKey?: string },
): Promise<void> {
  await insertActivityOnce(ctx, {
    companyId: input.companyId,
    recordType: "contact",
    recordId: input.contactId,
    kind: "speed_to_lead_skipped",
    body: input.body,
    meta: { leadKey: input.leadKey, reason: input.reason },
    sourceKey: input.sourceKey ?? `stl-skip:${input.leadKey}:${input.reason}`,
  }).catch(() => undefined);
}

/** After a lead is stored with an email: draft + Peet approval only; never queues a send. */
export async function onLeadStoredForSpeedToLead(ctx: PluginContext, input: SpeedToLeadInput): Promise<{ skipped: boolean; reason?: string; approvalId?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    ctx.logger.info("CRM speed-to-lead skipped: no email", { contactId: input.contactId, leadKey: input.leadKey });
    const contact = await getContact(ctx, input.contactId);
    if (contact && contact.companyId === input.companyId) {
      await logSpeedToLeadSkipped(ctx, {
        companyId: input.companyId,
        contactId: input.contactId,
        leadKey: input.leadKey,
        reason: "no_email",
        body: "Speed-to-lead skipped: no usable email on the lead.",
      });
    }
    return { skipped: true, reason: "no_email" };
  }
  const contact = await getContact(ctx, input.contactId);
  if (!contact || contact.companyId !== input.companyId) {
    ctx.logger.info("CRM speed-to-lead skipped: contact missing", { contactId: input.contactId, leadKey: input.leadKey });
    return { skipped: true, reason: "no_contact" };
  }
  if (isOptedOut(contact.emailStatus)) {
    ctx.logger.info("CRM speed-to-lead skipped: opted out", { contactId: input.contactId, emailStatus: contact.emailStatus, leadKey: input.leadKey });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "opted_out",
      body: `Speed-to-lead skipped: contact email status is ${contact.emailStatus ?? "unknown"}.`,
    });
    return { skipped: true, reason: "opted_out" };
  }

  const tArrival = input.arrivedAt && Number.isFinite(Date.parse(input.arrivedAt)) ? new Date(input.arrivedAt).toISOString() : new Date().toISOString();
  const arrivalMs = Date.parse(tArrival);
  if (Number.isFinite(arrivalMs) && Date.now() - arrivalMs > STALE_LEAD_MS) {
    ctx.logger.info("CRM speed-to-lead skipped: stale lead", { contactId: input.contactId, leadKey: input.leadKey, arrivedAt: tArrival });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "stale_lead",
      body: "Speed-to-lead skipped: lead arrival is older than 24 hours.",
      sourceKey: `stl-skip-stale:${input.leadKey}`,
    });
    return { skipped: true, reason: "stale_lead" };
  }

  const existing = await approvalsForClient(ctx, input.companyId, "speed_to_lead", { kind: "contact", id: input.contactId }, ["open", "approved"], 1);
  if (existing.length > 0) {
    ctx.logger.info("CRM speed-to-lead skipped: open approval exists", { contactId: input.contactId, leadKey: input.leadKey, approvalId: existing[0]!.id });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "open_approval_exists",
      body: "Speed-to-lead skipped: this contact already has an open or approved speed-to-lead reply waiting.",
      sourceKey: `stl-skip-open:${input.contactId}:${input.leadKey}`,
    });
    return { skipped: true, reason: "open_approval_exists" };
  }

  const { lang, draft } = composeSpeedToLeadDraft({
    name: input.name ?? contact.name,
    email,
    text: input.text,
    langHint: langFromContact(contact, input.langHint),
    contactId: input.contactId,
  });
  const metrics: SpeedToLeadMetrics = { t_arrival: tArrival, t_draft_ready: new Date().toISOString() };
  const who = firstName(input.name ?? contact.name) || email;
  const opened = await requestApproval(ctx, {
    companyId: input.companyId,
    kind: "speed_to_lead",
    client: { kind: "contact", id: input.contactId },
    subjectId: input.leadKey,
    title: `Approve speed-to-lead reply to ${who}`.slice(0, 200),
    intro: [
      `A new lead (${input.source}) arrived with an email. Draft first reply for review (Reviewer, then Peet approval).`,
      "Mark **done** to send from the Mailbox. Nothing is sent until then.",
      `Language: ${lang === "af" ? "Afrikaans" : "English"}.`,
    ],
    draft,
    payload: { meta: { kind: "speed_to_lead" }, leadKey: input.leadKey, source: input.source, lang, metrics },
    checks: ["Warm and brief; no prices.", "Call CTA asks for a day and time (no slot placeholders).", "Recipient is not unsubscribed or bounced."],
    outward: true,
    wakeReason: "A speed-to-lead draft needs Peet's approval",
  });

  const config = await readConfig(ctx, input.companyId).catch(() => ({} as Record<string, unknown>));
  const mailDraft: MailDraftRequested = {
    key: `crm:stl-draft:${opened.approvalId}`,
    from: typeof config.mailFrom === "string" && config.mailFrom.includes("@") ? config.mailFrom.trim() : null,
    to: draft.to.map((a) => ({ email: a.email, name: a.name ?? null })),
    subject: draft.subject,
    text: draft.text,
    html: draft.html ?? textToHtml(draft.text),
    context: { plugin: PLUGIN_ID, kind: "speed_to_lead", id: opened.approvalId, clientKind: "contact", clientRef: input.contactId },
  };
  await enqueue(ctx, input.companyId, MAIL_EVENTS.draftRequested, mailDraft as unknown as { key: string } & Record<string, unknown>);

  await insertActivityOnce(ctx, {
    companyId: input.companyId,
    recordType: "contact",
    recordId: input.contactId,
    kind: "speed_to_lead_draft",
    body: `Speed-to-lead draft ready (${lang}); waiting for review and approval before any send.`,
    meta: { leadKey: input.leadKey, approvalId: opened.approvalId, metrics, lang },
    sourceKey: `stl:${input.leadKey}`,
    issueId: opened.issueId,
  }).catch(() => undefined);

  return { skipped: false, approvalId: opened.approvalId };
}

/** Stamp t_approved / t_sent on a contact note when the person-done path sends. */
export const speedToLeadHooks: MailApprovalHooks = {
  async onSent(ctx, approval, info) {
    if (approval.client?.kind !== "contact") return;
    const prev = (approval.payload.metrics as SpeedToLeadMetrics | undefined) ?? ({} as SpeedToLeadMetrics);
    const now = new Date().toISOString();
    const metrics: SpeedToLeadMetrics = {
      ...prev,
      t_arrival: prev.t_arrival ?? approval.createdAt ?? now,
      t_draft_ready: prev.t_draft_ready ?? approval.createdAt ?? now,
      t_approved: approval.decidedAt ?? now,
      ...(info.dryRun ? {} : { t_sent: now }),
    };
    await insertActivityOnce(ctx, {
      companyId: approval.companyId,
      recordType: "contact",
      recordId: approval.client.id,
      kind: "speed_to_lead_sent",
      body: info.dryRun ? "Speed-to-lead reply approved (canary dry run)." : "Speed-to-lead reply sent after Peet approved.",
      meta: { approvalId: approval.id, metrics, dryRun: info.dryRun },
      sourceKey: `stl-sent:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
  async onRefused(ctx, approval, by) {
    if (approval.client?.kind !== "contact") return;
    await insertActivityOnce(ctx, {
      companyId: approval.companyId,
      recordType: "contact",
      recordId: approval.client.id,
      kind: "speed_to_lead_discarded",
      body: "Speed-to-lead reply was discarded before send.",
      meta: { approvalId: approval.id, by },
      sourceKey: `stl-discarded:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
  async onFailed(ctx, approval, error) {
    if (approval.client?.kind !== "contact") return;
    await insertActivityOnce(ctx, {
      companyId: approval.companyId,
      recordType: "contact",
      recordId: approval.client.id,
      kind: "speed_to_lead_refused",
      body: `Speed-to-lead reply was not sent: ${error}`.slice(0, 1000),
      meta: { approvalId: approval.id, reason: error },
      sourceKey: `stl-refused:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
};
