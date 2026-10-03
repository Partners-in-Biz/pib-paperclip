/**
 * Consent the CRM records (kit `privacy.ts`, POPIA).
 *
 * A person who ticks the marketing box on a lead form has agreed to hear from
 * the sender of that form: us for our own form, the client for the client's.
 * The record keeps what they saw (the wording), where (the form and page),
 * when, and a keyed hash of their address (not the address). One record per
 * sender, subject and purpose; the newest wins (`consentIsNewer`). The record
 * is announced to the other modules with `consent.recorded` (a hand-off,
 * re-sent hourly for a day).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { consentIsNewer, consentKey, consentSubjectKey, HANDOFF_EVENTS, PIB_PLUGINS, senderKeyOf, type ConsentPurpose, type ConsentRecorded, type ConsentSource, type LawfulBasis } from "@partnersinbiz/pib-plugin-kit";
import { sendHandoff } from "./handoffs.js";
import { consentsOfSubject, getConsent, putConsent, type ConsentRow } from "./lead-store.js";
import type { ClientKind } from "./refs.js";

export interface ConsentInput {
  companyId: string;
  /** Whose list the consent is on: a client, or null for our own. */
  client: { kind: ClientKind; id: string } | null;
  email: string;
  contactId?: string | null;
  purpose?: ConsentPurpose;
  basis?: LawfulBasis;
  granted: boolean;
  source: ConsentSource;
  wording?: string | null;
  formId?: string | null;
  url?: string | null;
  policyVersion?: string | null;
  ipHash?: string | null;
  recordedAt?: string;
  expiresAt?: string | null;
  /** Who recorded it: a plugin, or `agent:<id>` / `user:<id>` when someone wrote it by hand. Default: the CRM. */
  recordedBy?: string | null;
}

export interface ConsentOutcome {
  /** `recorded`: stored (new or newer); `stale`: an older record than the one kept, ignored. */
  status: "recorded" | "stale";
  senderKey: string;
  key: string;
}

/** Stores one consent record (newest wins) and announces it to the other modules. */
export async function recordConsent(ctx: PluginContext, input: ConsentInput): Promise<ConsentOutcome | null> {
  const purpose = input.purpose ?? "marketing_email";
  const subject = { email: input.email, contactId: input.contactId ?? null };
  const subjectKey = consentSubjectKey(subject);
  if (!subjectKey) return null;
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const senderKey = senderKeyOf(input.client ? { clientKind: input.client.kind, clientRef: input.client.id } : null);
  const key = consentKey(subject, purpose, recordedAt) ?? `consent:${subjectKey}:${purpose}:${recordedAt}`;
  const current = await getConsent(ctx, input.companyId, senderKey, subjectKey, purpose);
  if (current && !consentIsNewer(current, { recordedAt })) return { status: "stale", senderKey, key };
  await putConsent(ctx, {
    companyId: input.companyId,
    senderKey,
    subjectKey,
    email: input.email.trim().toLowerCase(),
    contactId: input.contactId ?? null,
    purpose,
    basis: input.basis ?? "consent",
    granted: input.granted,
    source: input.source,
    wording: input.wording ?? null,
    formId: input.formId ?? null,
    url: input.url ?? null,
    policyVersion: input.policyVersion ?? null,
    ipHash: input.ipHash ?? null,
    recordedAt,
    expiresAt: input.expiresAt ?? null,
    recordedBy: input.recordedBy ?? PIB_PLUGINS.crm,
  });
  const event: ConsentRecorded = {
    key,
    subject: { email: input.email.trim().toLowerCase(), contactId: input.contactId ?? null, clientKind: input.client?.kind ?? null, clientRef: input.client?.id ?? null },
    purpose,
    basis: input.basis ?? "consent",
    granted: input.granted,
    source: input.source,
    evidence: { wording: input.wording ?? null, formId: input.formId ?? null, url: input.url ?? null, policyVersion: input.policyVersion ?? null },
    recordedAt,
    expiresAt: input.expiresAt ?? null,
    recordedBy: PIB_PLUGINS.crm,
  };
  try {
    await sendHandoff(ctx, input.companyId, HANDOFF_EVENTS.consentRecorded, event as unknown as { key: string } & Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("CRM consent hand-off deferred", { error: error instanceof Error ? error.message : String(error) });
  }
  return { status: "recorded", senderKey, key };
}

/** What consent is on file for a person, one line each (no address, no hash). For the contact view and the agent tools. */
export async function consentSummary(ctx: PluginContext, companyId: string, email: string): Promise<Array<{ sender: string; purpose: string; basis: string; granted: boolean; source: string; recordedAt: string; expiresAt: string | null; wording: string | null }>> {
  const subjectKey = consentSubjectKey({ email });
  if (!subjectKey) return [];
  const rows: ConsentRow[] = await consentsOfSubject(ctx, companyId, subjectKey);
  return rows.map((row) => ({ sender: row.senderKey, purpose: row.purpose, basis: row.basis, granted: row.granted, source: row.source, recordedAt: row.recordedAt, expiresAt: row.expiresAt, wording: row.wording }));
}
