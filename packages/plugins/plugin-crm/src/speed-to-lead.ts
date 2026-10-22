/**
 * Speed-to-lead (PAR-2262): draft-only first reply when a lead with email is stored.
 * Consent gate → short EN/AF draft → Peet care approval → `mail.draft.requested`.
 * Send only via care-approvals person-done path. This module never enqueues a send.
 * Metrics: t_arrival / t_draft_ready here; t_approved / t_sent in speedToLeadHooks.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { enqueue, MAIL_EVENTS, readConfig, type MailDraftRequested } from "@partnersinbiz/pib-plugin-kit";
import { getContact, insertActivityOnce } from "./db.js";
import { textToHtml } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { requestApproval, type MailApprovalHooks, type MailDraft } from "./outbound.js";

const AF_MARKERS =
  /\b(asseblief|baie\s+dankie|dankie|goeie\s+dag|goeiemôre|goeiemore|ek\s+wil|ek\s+soek|hoeveel|pryslys|kwotasie|besigheids|webwerf)\b/i;

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

/** Short draft (~90 words) with call CTA (2 slots) and Peet sign-off. No prices. */
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
      ? `${hi}\n\nDankie vir jou navraag. Kan ons kort skakel?\n- [Slot 1: dag + tyd]\n- [Slot 2: dag + tyd]\n\nAntwoord watter slot pas. Geen pryse hier.\n\nGroete,\nPeet`
      : `${hi}\n\nThanks for getting in touch. Quick call?\n- [Slot 1: day + time]\n- [Slot 2: day + time]\n\nReply with a slot. No prices here.\n\nThanks,\nPeet`;
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

/** After a lead is stored with an email: draft + Peet approval only; never queues a send. */
export async function onLeadStoredForSpeedToLead(ctx: PluginContext, input: SpeedToLeadInput): Promise<{ skipped: boolean; reason?: string; approvalId?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    ctx.logger.info("CRM speed-to-lead skipped: no email", { contactId: input.contactId, leadKey: input.leadKey });
    return { skipped: true, reason: "no_email" };
  }
  const contact = await getContact(ctx, input.contactId);
  if (!contact || contact.companyId !== input.companyId) {
    ctx.logger.info("CRM speed-to-lead skipped: contact missing", { contactId: input.contactId, leadKey: input.leadKey });
    return { skipped: true, reason: "no_contact" };
  }
  if (isOptedOut(contact.emailStatus)) {
    ctx.logger.info("CRM speed-to-lead skipped: opted out", { contactId: input.contactId, emailStatus: contact.emailStatus, leadKey: input.leadKey });
    return { skipped: true, reason: "opted_out" };
  }

  const tArrival = input.arrivedAt && Number.isFinite(Date.parse(input.arrivedAt)) ? new Date(input.arrivedAt).toISOString() : new Date().toISOString();
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
      `A new lead (${input.source}) arrived with an email. Draft first reply for Peet to approve.`,
      "Mark **done** to send from the Mailbox. Nothing is sent until then.",
      `Language: ${lang === "af" ? "Afrikaans" : "English"}.`,
    ],
    draft,
    payload: { meta: { kind: "speed_to_lead" }, leadKey: input.leadKey, source: input.source, lang, metrics },
    checks: ["Warm and brief; no prices.", "Call CTA has two placeholder slots.", "Recipient is not unsubscribed or bounced."],
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
    body: `Speed-to-lead draft ready (${lang}); waiting for Peet to approve before any send.`,
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
  async onRefused() {},
  async onFailed() {},
};
