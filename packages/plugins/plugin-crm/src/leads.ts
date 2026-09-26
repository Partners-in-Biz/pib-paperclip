/**
 * Lead hand-off: `lead.captured` from Social (inbox intent = lead) and the
 * Mailbox (mail triaged as a lead from an unknown sender).
 *
 * Each lead key is handled once (`receiveOnce`, key `lead:<key>` so it never
 * collides with the `mail:<id>` keys of `mail.received`):
 * find or create the contact (email, then social handle), log a
 * `lead_captured` activity, set lifecycle lead on a new contact, take the
 * Jev lead score, and open one follow-up issue for the contact's agent or
 * owner (else the company owner from the Cockpit roles).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  companyRoles,
  configSaved,
  HANDOFF_EVENTS,
  isModuleEnabled,
  PIB_PLUGINS,
  pluginEvent,
  receiveOnce,
  type LeadCaptured,
} from "@partnersinbiz/pib-plugin-kit";
import { asRecord, contactsByEmail, contactsByHandle, getAccount, getContact, insertActivityOnce, insertContact, insertLink } from "./db.js";
import { createContact, linkContact, LOCAL_BOARD_USER_ID, normalizeEmail, type ContactDraft } from "./domain.js";
import { leadBand } from "./lead-levels.js";
import { openIssueOnce, scoreLead } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { emitChanges } from "./sync.js";

/** The two senders of `lead.captured` the CRM listens to. */
export const LEAD_EVENTS = [
  pluginEvent(PIB_PLUGINS.social, HANDOFF_EVENTS.leadCaptured),
  pluginEvent(PIB_PLUGINS.mailbox, HANDOFF_EVENTS.leadCaptured),
] as const;

const SOURCE_LABELS: Record<LeadCaptured["source"], string> = { social: "social media", email: "email", form: "a form", other: "another channel" };

function str(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Validates the payload. Null when it is unusable (no key, or no way to reach the person). */
export function asLead(payload: unknown): LeadCaptured | null {
  const body = asRecord(payload);
  const key = str(body.key, 200);
  if (!key) return null;
  const source = body.source === "social" || body.source === "email" || body.source === "form" ? body.source : "other";
  const rawEmail = str(body.email, 320);
  const email = rawEmail && rawEmail.includes("@") ? rawEmail.toLowerCase() : null;
  const handle = str(body.handle, 120)?.replace(/^@+/, "") ?? null;
  if (!email && !handle) return null;
  const clientKind = body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null;
  const confidence = typeof body.confidence === "number" && Number.isFinite(body.confidence) ? body.confidence : null;
  return {
    key,
    source,
    name: str(body.name, 200),
    email,
    handle,
    platform: str(body.platform, 40)?.toLowerCase() ?? null,
    text: str(body.text, 300) ?? "",
    url: str(body.url, 1000),
    clientKind,
    clientRef: clientKind ? str(body.clientRef, 200) : null,
    confidence,
    capturedAt: str(body.capturedAt, 40) ?? new Date().toISOString(),
  };
}

/** `instagram:jane.doe` — the form stored in `custom.handles`. */
export function handleKey(lead: Pick<LeadCaptured, "handle" | "platform">): string | null {
  if (!lead.handle) return null;
  return `${lead.platform ?? "social"}:${lead.handle.toLowerCase()}`;
}

export interface LeadOutcome extends Record<string, unknown> {
  contactId: string;
  created: boolean;
  issueId: string | null;
  scored: boolean;
}

export async function onLeadCaptured(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const lead = asLead(event.payload);
  const companyId = event.companyId;
  if (!lead || !companyId) return;
  try {
    if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) return;
    // The host refuses issue calls for a company whose CRM settings were never saved.
    if (!(await configSaved(ctx, companyId))) return;
    await receiveOnce(ctx, companyId, event.eventType, `lead:${lead.key}`, () => handleLead(ctx, companyId, lead));
  } catch (error) {
    ctx.logger.error("CRM lead intake failed", { key: lead.key, error: error instanceof Error ? error.message : String(error) });
  }
}

async function findContact(ctx: PluginContext, companyId: string, lead: LeadCaptured): Promise<ContactDraft | null> {
  if (lead.email) {
    const byEmail = await contactsByEmail(ctx, companyId, lead.email);
    if (byEmail[0]) return byEmail[0];
  }
  const handle = handleKey(lead);
  if (handle) {
    const byHandle = await contactsByHandle(ctx, companyId, handle);
    if (byHandle[0]) return byHandle[0];
  }
  return null;
}

export async function handleLead(ctx: PluginContext, companyId: string, lead: LeadCaptured): Promise<LeadOutcome> {
  let contact = await findContact(ctx, companyId, lead);
  let created = false;
  if (!contact) {
    const handle = handleKey(lead);
    contact = createContact({
      companyId,
      name: lead.name ?? lead.email ?? (lead.handle ? `@${lead.handle}` : "New lead"),
      emails: lead.email ? [normalizeEmail(lead.email)] : [],
      lifecycle: "lead",
      custom: { leadSource: lead.source, ...(lead.platform ? { leadPlatform: lead.platform } : {}), ...(handle ? { handles: [handle] } : {}) },
      tags: ["lead"],
    });
    await insertContact(ctx, contact);
    created = true;
    // A lead from mail whose sender's domain matched a CRM company works there.
    if (lead.source === "email" && lead.clientKind === "company" && lead.clientRef) {
      const account = await getAccount(ctx, lead.clientRef).catch(() => null);
      if (account && account.companyId === companyId) {
        await insertLink(ctx, linkContact({ companyId, contactId: contact.id, accountId: account.id, roleLabel: "staff" })).catch(() => undefined);
      }
    }
  }

  const where = lead.platform ? `${lead.platform}${lead.source === "social" ? "" : ` (${SOURCE_LABELS[lead.source]})`}` : SOURCE_LABELS[lead.source];
  await insertActivityOnce(ctx, {
    companyId,
    recordType: "contact",
    recordId: contact.id,
    kind: "lead_captured",
    body: `${created ? "New lead" : "Lead"} from ${where}: ${lead.text || "(no message)"}`.slice(0, 1000),
    meta: { key: lead.key, source: lead.source, platform: lead.platform, handle: lead.handle, url: lead.url, confidence: lead.confidence, clientKind: lead.clientKind, clientRef: lead.clientRef },
    sourceKey: `lead:${lead.key}`,
  });

  const score = await scoreLead(ctx, companyId, contact.id).catch(() => null);
  const fresh = (await getContact(ctx, contact.id)) ?? contact;
  const issueId = await openIssueOnce(ctx, {
    companyId,
    originId: `lead:${lead.key}`,
    title: `Follow up ${created ? "new lead" : "lead"}: ${fresh.name}`.slice(0, 200),
    description: leadIssueDescription(fresh, lead, { created, score: score ? leadBand(score) : null }),
    assignee: await leadAssignee(ctx, companyId, fresh),
    wakeReason: "A new lead came in",
  });

  if (created) {
    try {
      await emitChanges(ctx, companyId, 120);
    } catch (error) {
      ctx.logger.info("CRM change broadcast deferred", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { contactId: contact.id, created, issueId, scored: Boolean(score) };
}

/** The contact's agent, else its owner, else the company owner from the Cockpit roles, else nobody (the board). */
export async function leadAssignee(ctx: PluginContext, companyId: string, contact: Pick<ContactDraft, "assigneeAgentId" | "ownerUserId">): Promise<{ assigneeAgentId?: string; assigneeUserId?: string }> {
  if (contact.assigneeAgentId) return { assigneeAgentId: contact.assigneeAgentId };
  if (contact.ownerUserId && contact.ownerUserId !== LOCAL_BOARD_USER_ID) return { assigneeUserId: contact.ownerUserId };
  const owner = (await companyRoles(ctx, companyId))?.ownerUserId;
  return owner ? { assigneeUserId: owner } : {};
}

export function leadIssueDescription(contact: ContactDraft, lead: LeadCaptured, info: { created: boolean; score: "cold" | "warm" | "hot" | null }): string {
  const reach = [
    lead.email ? `- Email: ${lead.email}` : null,
    lead.handle ? `- ${lead.platform ? `${lead.platform.charAt(0).toUpperCase()}${lead.platform.slice(1)}` : "Social"}: @${lead.handle}` : null,
    lead.url ? `- Link: ${lead.url}` : null,
    lead.clientRef ? `- Came in for: ${lead.clientKind === "contact" ? "client contact" : "client"} \`${lead.clientRef}\`` : null,
    info.score ? `- Lead score: ${info.score}` : null,
    lead.confidence != null ? `- Triage confidence: ${Math.round(lead.confidence * 100)}%` : null,
  ].filter((line): line is string => Boolean(line));
  return [
    `${info.created ? "A new lead" : `${contact.name}, already in the CRM,`} showed buying intent on ${SOURCE_LABELS[lead.source]}${info.created ? `. The CRM added ${contact.name} as a contact (lifecycle lead).` : "."}`,
    "",
    ...reach,
    "",
    `> ${(lead.text || "(no message)").replace(/\n+/g, " ")}`,
    "",
    "Reply within one working day in the same channel. Then log what happened on the contact (`log-activity`) and set the next action (`update-contact` with nextActionKind and nextActionDueAt), or create a deal when they want a quote.",
    `Contact id: \`${contact.id}\``,
  ].join("\n");
}
