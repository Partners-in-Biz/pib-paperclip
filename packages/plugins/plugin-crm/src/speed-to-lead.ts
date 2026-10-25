/**
 * Speed-to-lead (PAR-2262 / PAR-4754 / PAR-4757): draft-only first reply when a lead with email is stored.
 * Triggers: handleLead / lead.captured, Jagter sequence replies, client_leads channel stores.
 * Consent + spam gates → short EN/AF draft → owner care approval → `mail.draft.requested` → CEO ping.
 * Send only via care-approvals person-done path. This module never enqueues a send.
 * Metrics: t_arrival / t_draft_ready here; t_approved / t_sent in speedToLeadHooks.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { enqueue, MAIL_EVENTS, readConfig, roleAgentUsable, type MailDraftRequested } from "@partnersinbiz/pib-plugin-kit";
import { approvalsForClient } from "./care-store.js";
import { contactsByEmail, getContact, insertActivityOnce, saveContact } from "./db.js";
import { textToHtml } from "./domain.js";
import { openIssueOnce } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { originFor } from "./origins.js";
import { approvalLink, requestApproval, type MailApprovalHooks, type MailDraft } from "./outbound.js";
import type { ClientKind } from "./refs.js";

const AF_MARKERS =
  /\b(asseblief|baie\s+dankie|dankie|goeie\s+dag|goeiemôre|goeiemore|ek\s+wil|ek\s+soek|hoeveel|pryslys|kwotasie|besigheids|webwerf)\b/i;

const STALE_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Opt-out only when the whole trimmed message is the opt-out, or an explicit phrase.
 * Bare "stop" / "unsubscribe" inside real lead sentences must not tag do-not-contact.
 */
const OPT_OUT_WHOLE = /^(stop|unsubscribe|remove\s+me|opt[\s-]?out)[.!\s]*$/i;
const OPT_OUT_PHRASE =
  /\b(stop\s+emailing\s+me|unsubscribe\s+me(?:\s+from\s+(?:your|the)\s+(?:list|newsletter|emails?))?|remove\s+me\s+from\s+(?:your|the)\s+(?:list|mailing\s+list|emails?)|do\s+not\s+contact\s+me|don'?t\s+(?:email|contact)\s+me|opt[\s-]?out\s+of\s+(?:your|these|all)\s+emails?)\b/i;

/**
 * Spec §3 / §8 fixtures only: newsletter, receipt, SEO inbound pitch.
 * no-reply is the local-part check below. Weak rows (crypto/ooo/vendor) dropped
 * so real leads are not silently skipped.
 */
const SPAM_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  {
    reason: "newsletter",
    re: /\b((?:weekly|monthly)\s+newsletter|newsletter\s+(?:digest|blast)|unsubscribe\s+from\s+this\s+list|view\s+in\s+browser|manage\s+(?:your\s+)?email\s+preferences)\b/i,
  },
  {
    reason: "receipt",
    re: /\b(your\s+receipt|order\s+(?:confirmation|receipt)|payment\s+received|your\s+invoice(?:\s+is|\s+for|\s+#)|invoice\s+attached)\b/i,
  },
  {
    reason: "seo_pitch",
    re: /\b(we\s+can\s+rank\s+your\s+site|guest\s+post|buy\s+backlinks?|link[\s-]?building\s+services\s+we\s+offer|we\s+offer\s+(?:guest\s+post|link[\s-]?building))\b/i,
  },
];

/** Automated senders only — not notifications@ / newsletter@ shared inboxes. */
const NOREPLY_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon)\b/i;

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
  /** Gmail thread to keep a sequence reply in the same conversation. */
  threadId?: string | null;
}

/** Client-channel lead (POPIA: no new CRM contact). Reuses the same draft-only path. */
export interface ClientLeadSpeedToLeadInput {
  companyId: string;
  client: { kind: ClientKind; id: string };
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

/** True when the contact carries the do-not-contact tag (any casing). */
export function hasDoNotContactTag(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).some((tag) => tag.trim().toLowerCase() === "do-not-contact");
}

/** Opt-out wording in the inbound itself (spec §2 step 1). */
export function hasOptOutText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return OPT_OUT_WHOLE.test(trimmed) || OPT_OUT_PHRASE.test(trimmed);
}

/**
 * Spec §3 spam / not-a-lead gate. Returns a short reason when no draft should be made.
 * Pure: email local-part + lead text only (headers are not on the lead-stored path).
 */
export function classifyNotALead(input: { email: string; text: string }): string | null {
  const local = input.email.trim().toLowerCase().split("@")[0] ?? "";
  if (NOREPLY_LOCAL.test(local)) return "no_reply_sender";
  for (const row of SPAM_PATTERNS) {
    if (row.re.test(input.text)) return row.reason;
  }
  return null;
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

/** Short draft with call CTA and a team sign-off. No prices. */
export function composeSpeedToLeadDraft(input: {
  name: string | null;
  email: string;
  text: string;
  langHint?: string | null;
  contactId?: string | null;
  threadId?: string | null;
}): { lang: SpeedToLeadLang; draft: MailDraft } {
  const lang = detectSpeedToLeadLang(input.text, input.langHint);
  const who = firstName(input.name);
  const hi = who ? (lang === "af" ? `Hallo ${who},` : `Hi ${who},`) : lang === "af" ? "Hallo," : "Hi,";
  const text =
    lang === "af"
      ? `${hi}\n\nDankie vir jou navraag. Kan ons kort skakel?\n\nAntwoord met 'n dag en tyd wat vir jou pas, en ons bevestig dit. Geen pryse hier.\n\nGroete,\nDie span`
      : `${hi}\n\nThanks for getting in touch. Quick call?\n\nReply with a day and time that suits you and we'll lock it in. No prices here.\n\nThanks,\nThe team`;
  const subject = lang === "af" ? "Jou navraag — kort skakel?" : "Your enquiry — quick call?";
  return {
    lang,
    draft: { to: [{ email: input.email, name: input.name }], subject, text, html: textToHtml(text), contactId: input.contactId ?? null, threadId: input.threadId ?? null },
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

async function tagDoNotContact(ctx: PluginContext, contact: Awaited<ReturnType<typeof getContact>>): Promise<void> {
  if (!contact || hasDoNotContactTag(contact.tags)) return;
  contact.tags = [...contact.tags, "do-not-contact"];
  await saveContact(ctx, contact).catch(() => undefined);
}

/** Spec §2 step 6: 3-line summary + link to the approval card for the CEO agent. */
async function pingCeoSpeedToLead(
  ctx: PluginContext,
  input: {
    companyId: string;
    approvalId: string;
    issueId: string | null;
    who: string;
    source: string;
    email: string;
    lang: SpeedToLeadLang;
  },
): Promise<void> {
  let assigneeAgentId: string | null = null;
  try {
    const agents = await ctx.agents.list({ companyId: input.companyId, limit: 200 });
    const usable = agents.filter((agent) => roleAgentUsable(String(agent.status ?? "")));
    const byRole = usable.find((agent) => String((agent as { role?: string }).role ?? "").trim().toLowerCase() === "ceo");
    const byName = usable.find((agent) => {
      const name = String(agent.name ?? "").trim();
      const urlKey = String((agent as { urlKey?: string }).urlKey ?? "").trim().toLowerCase();
      return /^elon$/i.test(name) || urlKey === "elon" || urlKey === "pib";
    });
    const elon = byRole ?? byName;
    assigneeAgentId = elon ? String(elon.id) : null;
  } catch {
    assigneeAgentId = null;
  }
  if (!assigneeAgentId) {
    ctx.logger.info("CRM speed-to-lead CEO ping skipped: no live CEO agent", { approvalId: input.approvalId });
    return;
  }

  const card = (await approvalLink(ctx, input.companyId, input.issueId)) ?? (input.issueId ? `/issues/${input.issueId}` : `(approval ${input.approvalId})`);
  const lines = [
    `New speed-to-lead draft for ${input.who} <${input.email}>.`,
    `Source ${input.source}; language ${input.lang === "af" ? "Afrikaans" : "English"}; waiting on owner approval (draft only).`,
    `Card: ${card}`,
  ];
  await openIssueOnce(ctx, {
    companyId: input.companyId,
    originId: originFor.stlPing(input.approvalId),
    title: `Speed-to-lead ready: ${input.who}`.slice(0, 200),
    description: lines.join("\n"),
    assignee: { assigneeAgentId },
    wakeReason: "Speed-to-lead draft needs a look",
    priority: "high",
  }).catch((error) => {
    ctx.logger.info("CRM speed-to-lead CEO ping failed", {
      approvalId: input.approvalId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** After a lead is stored with an email: draft + owner approval only; never queues a send. */
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

  // Explicit opt-out phrase before spam so "unsubscribe me from your newsletter"
  // tags do-not-contact. Bare "unsubscribe" in a newsletter footer is not an
  // explicit phrase, so the spam gate below skips without tagging.
  if (hasOptOutText(input.text)) {
    await tagDoNotContact(ctx, contact);
    ctx.logger.info("CRM speed-to-lead skipped: opt-out text", { contactId: input.contactId, leadKey: input.leadKey });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "opted_out",
      body: "Speed-to-lead skipped: opted out (inbound asked to stop).",
    });
    return { skipped: true, reason: "opted_out" };
  }

  const spamReason = classifyNotALead({ email, text: input.text });
  if (spamReason) {
    ctx.logger.info("CRM speed-to-lead skipped: not a lead", { contactId: input.contactId, leadKey: input.leadKey, spamReason });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "not_a_lead",
      body: `Speed-to-lead skipped: not a lead (${spamReason}).`,
      sourceKey: `stl-skip-spam:${input.leadKey}:${spamReason}`,
    });
    return { skipped: true, reason: "not_a_lead" };
  }

  if (hasDoNotContactTag(contact.tags) || isOptedOut(contact.emailStatus)) {
    const reasonDetail = hasDoNotContactTag(contact.tags)
      ? "tag do-not-contact"
      : `email status ${contact.emailStatus ?? "unknown"}`;
    ctx.logger.info("CRM speed-to-lead skipped: opted out", { contactId: input.contactId, emailStatus: contact.emailStatus, leadKey: input.leadKey });
    await logSpeedToLeadSkipped(ctx, {
      companyId: input.companyId,
      contactId: input.contactId,
      leadKey: input.leadKey,
      reason: "opted_out",
      body: `Speed-to-lead skipped: opted out (${reasonDetail}).`,
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
    threadId: input.threadId,
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
      `A new lead (${input.source}) arrived with an email. Draft first reply for review (Reviewer, then owner approval).`,
      "Mark **done** to send from the Mailbox. Nothing is sent until then.",
      `Language: ${lang === "af" ? "Afrikaans" : "English"}.`,
    ],
    draft,
    payload: { meta: { kind: "speed_to_lead" }, leadKey: input.leadKey, source: input.source, lang, metrics },
    checks: ["Warm and brief; no prices.", "Call CTA asks for a day and time (no slot placeholders).", "Recipient is not unsubscribed or bounced."],
    outward: true,
    wakeReason: "A speed-to-lead draft needs the owner's approval",
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

  await pingCeoSpeedToLead(ctx, {
    companyId: input.companyId,
    approvalId: opened.approvalId,
    issueId: opened.issueId,
    who,
    source: input.source,
    email,
    lang,
  });

  return { skipped: false, approvalId: opened.approvalId };
}

/**
 * Client-channel lead stored in `client_leads` (no handleLead). If that email
 * already has a CRM contact, reuse `onLeadStoredForSpeedToLead`. Otherwise open
 * the same draft-only care approval keyed to the client (POPIA: no new contact).
 */
export async function onClientLeadStoredForSpeedToLead(
  ctx: PluginContext,
  input: ClientLeadSpeedToLeadInput,
): Promise<{ skipped: boolean; reason?: string; approvalId?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    ctx.logger.info("CRM speed-to-lead skipped: no email", { leadKey: input.leadKey, client: input.client });
    return { skipped: true, reason: "no_email" };
  }

  const matches = await contactsByEmail(ctx, input.companyId, email);
  if (matches[0]) {
    return onLeadStoredForSpeedToLead(ctx, {
      companyId: input.companyId,
      contactId: matches[0].id,
      leadKey: input.leadKey,
      source: input.source,
      text: input.text,
      name: input.name ?? matches[0].name,
      email,
      langHint: input.langHint ?? langFromContact(matches[0], null),
      arrivedAt: input.arrivedAt,
    });
  }

  if (hasOptOutText(input.text)) {
    ctx.logger.info("CRM speed-to-lead skipped: opt-out text", { leadKey: input.leadKey });
    return { skipped: true, reason: "opted_out" };
  }

  const spamReason = classifyNotALead({ email, text: input.text });
  if (spamReason) {
    ctx.logger.info("CRM speed-to-lead skipped: not a lead", { leadKey: input.leadKey, spamReason });
    return { skipped: true, reason: "not_a_lead" };
  }

  const tArrival = input.arrivedAt && Number.isFinite(Date.parse(input.arrivedAt)) ? new Date(input.arrivedAt).toISOString() : new Date().toISOString();
  const arrivalMs = Date.parse(tArrival);
  if (Number.isFinite(arrivalMs) && Date.now() - arrivalMs > STALE_LEAD_MS) {
    ctx.logger.info("CRM speed-to-lead skipped: stale lead", { leadKey: input.leadKey, arrivedAt: tArrival });
    return { skipped: true, reason: "stale_lead" };
  }

  const existing = await approvalsForClient(ctx, input.companyId, "speed_to_lead", input.client, ["open", "approved"], 1);
  if (existing.length > 0) {
    ctx.logger.info("CRM speed-to-lead skipped: open approval exists", { leadKey: input.leadKey, approvalId: existing[0]!.id, client: input.client });
    return { skipped: true, reason: "open_approval_exists" };
  }

  const { lang, draft } = composeSpeedToLeadDraft({
    name: input.name,
    email,
    text: input.text,
    langHint: input.langHint,
    contactId: null,
  });
  const metrics: SpeedToLeadMetrics = { t_arrival: tArrival, t_draft_ready: new Date().toISOString() };
  const who = firstName(input.name) || email;
  const opened = await requestApproval(ctx, {
    companyId: input.companyId,
    kind: "speed_to_lead",
    client: input.client,
    subjectId: input.leadKey,
    title: `Approve speed-to-lead reply to ${who}`.slice(0, 200),
    intro: [
      `A client-channel lead (${input.source}) arrived with an email. Draft first reply for review (Reviewer, then owner approval).`,
      "Mark **done** to send from the Mailbox. Nothing is sent until then.",
      `Language: ${lang === "af" ? "Afrikaans" : "English"}.`,
      "No CRM contact was created (client-channel / POPIA).",
    ],
    draft,
    payload: { meta: { kind: "speed_to_lead" }, leadKey: input.leadKey, source: input.source, lang, metrics, clientChannel: true },
    checks: ["Warm and brief; no prices.", "Call CTA asks for a day and time (no slot placeholders).", "Recipient is not unsubscribed or bounced."],
    outward: true,
    wakeReason: "A speed-to-lead draft needs the owner's approval",
  });

  const config = await readConfig(ctx, input.companyId).catch(() => ({} as Record<string, unknown>));
  const mailDraft: MailDraftRequested = {
    key: `crm:stl-draft:${opened.approvalId}`,
    from: typeof config.mailFrom === "string" && config.mailFrom.includes("@") ? config.mailFrom.trim() : null,
    to: draft.to.map((a) => ({ email: a.email, name: a.name ?? null })),
    subject: draft.subject,
    text: draft.text,
    html: draft.html ?? textToHtml(draft.text),
    context: { plugin: PLUGIN_ID, kind: "speed_to_lead", id: opened.approvalId, clientKind: input.client.kind, clientRef: input.client.id },
  };
  await enqueue(ctx, input.companyId, MAIL_EVENTS.draftRequested, mailDraft as unknown as { key: string } & Record<string, unknown>);

  await insertActivityOnce(ctx, {
    companyId: input.companyId,
    recordType: input.client.kind === "contact" ? "contact" : "company",
    recordId: input.client.id,
    kind: "speed_to_lead_draft",
    body: `Speed-to-lead draft ready (${lang}) for client-channel lead; waiting for review and approval before any send.`,
    meta: { leadKey: input.leadKey, approvalId: opened.approvalId, metrics, lang, clientChannel: true },
    sourceKey: `stl:${input.leadKey}`,
    issueId: opened.issueId,
  }).catch(() => undefined);

  await pingCeoSpeedToLead(ctx, {
    companyId: input.companyId,
    approvalId: opened.approvalId,
    issueId: opened.issueId,
    who,
    source: input.source,
    email,
    lang,
  });

  return { skipped: false, approvalId: opened.approvalId };
}

function activityRecord(approval: { client?: { kind: string; id: string } | null }): { recordType: "contact" | "company"; recordId: string } | null {
  if (!approval.client) return null;
  if (approval.client.kind === "contact" || approval.client.kind === "company") {
    return { recordType: approval.client.kind, recordId: approval.client.id };
  }
  return null;
}

/** Stamp t_approved / t_sent when the person-done path sends (contact or client-channel company). */
export const speedToLeadHooks: MailApprovalHooks = {
  async onSent(ctx, approval, info) {
    const record = activityRecord(approval);
    if (!record) return;
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
      recordType: record.recordType,
      recordId: record.recordId,
      kind: "speed_to_lead_sent",
      body: info.dryRun ? "Speed-to-lead reply approved (canary dry run)." : "Speed-to-lead reply sent after the owner approved.",
      meta: { approvalId: approval.id, metrics, dryRun: info.dryRun },
      sourceKey: `stl-sent:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
  async onRefused(ctx, approval, by) {
    const record = activityRecord(approval);
    if (!record) return;
    await insertActivityOnce(ctx, {
      companyId: approval.companyId,
      recordType: record.recordType,
      recordId: record.recordId,
      kind: "speed_to_lead_discarded",
      body: "Speed-to-lead reply was discarded before send.",
      meta: { approvalId: approval.id, by },
      sourceKey: `stl-discarded:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
  async onFailed(ctx, approval, error) {
    const record = activityRecord(approval);
    if (!record) return;
    await insertActivityOnce(ctx, {
      companyId: approval.companyId,
      recordType: record.recordType,
      recordId: record.recordId,
      kind: "speed_to_lead_refused",
      body: `Speed-to-lead reply was not sent: ${error}`.slice(0, 1000),
      meta: { approvalId: approval.id, reason: error },
      sourceKey: `stl-refused:${approval.id}`,
      issueId: approval.issueId,
    }).catch(() => undefined);
  },
};
