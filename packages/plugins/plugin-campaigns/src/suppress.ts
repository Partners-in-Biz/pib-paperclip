/**
 * One do-not-email list across the CRM, Campaigns and the Mailbox.
 *
 * - Campaigns keeps its own table (`suppressions`) and never enrolls, emails
 *   or opens a step issue for an address on it.
 * - A campaign reply that unsubscribes emits `contact.suppressed` (scope
 *   marketing). The CRM and the Mailbox store it too.
 * - `contact.suppressed` from the CRM and the Mailbox (unsubscribes, hard
 *   bounces) lands in the same table and stops the contact's running
 *   campaigns at once; an open step issue is cancelled with a note.
 * - Events are at-most-once, so the hourly job re-announces what Campaigns
 *   found in the last 3 days (receivers upsert by address).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  HANDOFF_EVENTS,
  pluginEvent,
  suppressionEmail,
  suppressionScope,
  SUPPRESSION_SOURCES,
  type ContactSuppressed,
  type SuppressionReason,
} from "@partnersinbiz/pib-plugin-kit";
import {
  addSuppression,
  crmContactsByEmail,
  openStepIssuesForContact,
  ownSuppressionsSince,
  stopEnrollmentsForContact,
} from "./db.js";
import { campaignSuppressionReason, kitSuppressionReason, SUPPRESSION_REASON_LABELS, type CampaignSuppressionReason } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";

export const REANNOUNCE_HOURS = 72;
const KIT_REASONS: SuppressionReason[] = ["unsubscribed", "bounced", "complained", "manual"];
const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The events Campaigns listens to: every other plugin that suppresses addresses. */
export function suppressionEvents(): string[] {
  return SUPPRESSION_SOURCES.filter((source) => source !== PLUGIN_ID).map((source) => pluginEvent(source, HANDOFF_EVENTS.contactSuppressed));
}

/** A valid `contact.suppressed` payload, or null. */
export function asContactSuppressed(payload: unknown, sender: string | null): ContactSuppressed | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const email = typeof body.email === "string" ? suppressionEmail(body.email) : "";
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return null;
  const reason = KIT_REASONS.includes(body.reason as SuppressionReason) ? (body.reason as SuppressionReason) : null;
  if (!reason) return null;
  const scope = body.scope === "all" || body.scope === "marketing" ? body.scope : suppressionScope(reason);
  return {
    key: typeof body.key === "string" && body.key ? body.key : `suppress:${email}:${reason}`,
    email,
    reason,
    scope,
    source: typeof body.source === "string" && body.source ? body.source : sender ?? "unknown",
    clientKind: body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null,
    clientRef: typeof body.clientRef === "string" ? body.clientRef : null,
    at: typeof body.at === "string" ? body.at : new Date().toISOString(),
  };
}

/** `plugin.partnersinbiz.crm.contact.suppressed` → `partnersinbiz.crm`. */
function senderOf(eventType: string): string | null {
  const suffix = `.${HANDOFF_EVENTS.contactSuppressed}`;
  return eventType.startsWith("plugin.") && eventType.endsWith(suffix) ? eventType.slice("plugin.".length, -suffix.length) : null;
}

export interface SuppressOutcome {
  created: boolean;
  stoppedContacts: number;
  cancelledIssues: number;
}

/**
 * Adds the address to the list, stops every running campaign of the contacts
 * that use it, and cancels their open step issues with a note, so nobody
 * emails them by hand either.
 */
export async function suppressAddress(
  ctx: PluginContext,
  input: { companyId: string; email: string; reason: CampaignSuppressionReason; scope: "marketing" | "all"; source: string; contactId?: string | null; campaignId?: string | null },
): Promise<SuppressOutcome> {
  const email = suppressionEmail(input.email);
  const created = await addSuppression(ctx, {
    companyId: input.companyId,
    email,
    reason: input.reason,
    scope: input.scope,
    source: input.source,
    contactId: input.contactId ?? null,
    campaignId: input.campaignId ?? null,
  });
  const contactIds = new Set<string>(input.contactId ? [input.contactId] : []);
  for (const contact of await crmContactsByEmail(ctx, input.companyId, email)) contactIds.add(contact.id);
  let cancelledIssues = 0;
  for (const contactId of contactIds) {
    const open = await openStepIssuesForContact(ctx, input.companyId, contactId);
    await stopEnrollmentsForContact(ctx, input.companyId, contactId);
    for (const row of open) {
      if (await cancelStepIssue(ctx, input.companyId, row.open_issue_id, email, input.reason)) cancelledIssues += 1;
    }
  }
  return { created, stoppedContacts: contactIds.size, cancelledIssues };
}

async function cancelStepIssue(ctx: PluginContext, companyId: string, issueId: string, email: string, reason: CampaignSuppressionReason): Promise<boolean> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || issue.status === "done" || issue.status === "cancelled") return false;
    await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
    await ctx.issues.createComment(
      issueId,
      `Do not send this. ${email} ${SUPPRESSION_REASON_LABELS[reason]}, so every campaign for this contact stopped (POPIA). Nothing else to do here.`,
      companyId,
    );
    return true;
  } catch (error) {
    ctx.logger.info("Could not cancel the step issue of a suppressed contact", { issueId, error: message(error) });
    return false;
  }
}

/** Tells the CRM and the Mailbox. Never throws. */
export async function announceSuppression(ctx: PluginContext, companyId: string, payload: ContactSuppressed): Promise<boolean> {
  try {
    await ctx.events.emit(HANDOFF_EVENTS.contactSuppressed, companyId, payload as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    ctx.logger.info("contact.suppressed emit failed; the hourly job announces it again", { email: payload.email, error: message(error) });
    return false;
  }
}

export function suppressionPayload(input: {
  email: string;
  reason: CampaignSuppressionReason;
  scope: "marketing" | "all";
  clientKind?: "company" | "contact" | null;
  clientRef?: string | null;
  at?: string;
}): ContactSuppressed {
  const email = suppressionEmail(input.email);
  const reason = kitSuppressionReason(input.reason);
  return {
    key: `suppress:${email}:${reason}`,
    email,
    reason,
    scope: input.scope,
    source: PLUGIN_ID,
    clientKind: input.clientKind ?? null,
    clientRef: input.clientRef ?? null,
    at: input.at ?? new Date().toISOString(),
  };
}

/** `contact.suppressed` from the CRM or the Mailbox. */
export async function onContactSuppressed(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  const payload = asContactSuppressed(event.payload, senderOf(String(event.eventType)));
  if (!companyId || !payload) return;
  try {
    await suppressAddress(ctx, {
      companyId,
      email: payload.email,
      reason: campaignSuppressionReason(payload.reason),
      scope: payload.scope,
      source: payload.source,
    });
  } catch (error) {
    ctx.logger.error("Campaign suppression failed", { email: payload.email, error: message(error) });
  }
}

/** Hourly: announce again what Campaigns suppressed in the last 3 days. */
export async function reannounceSuppressions(ctx: PluginContext, now = Date.now()): Promise<number> {
  const since = new Date(now - REANNOUNCE_HOURS * 3_600_000).toISOString();
  let sent = 0;
  for (const row of await ownSuppressionsSince(ctx, PLUGIN_ID, since)) {
    // Only unsubscribes are announced: the Mailbox itself decides which bounces are hard.
    if (row.reason !== "unsubscribe") continue;
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? new Date(now).toISOString());
    if (await announceSuppression(ctx, row.company_id, suppressionPayload({ email: row.email, reason: row.reason, scope: row.scope, at }))) sent += 1;
  }
  return sent;
}
