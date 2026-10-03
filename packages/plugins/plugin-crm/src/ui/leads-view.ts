/**
 * Pure helpers for the lead forms card (no React, no host): what a form says
 * about itself in a line, and its status wording. Tested without a browser.
 */

export type LeadFormStatus = "active" | "paused" | "revoked";

export interface LeadFormView {
  id: string;
  label: string;
  status: LeadFormStatus;
  canary: boolean;
  key: string;
  site: string | null;
  ownedBy: "client" | "us";
  accepted: number;
  rejected: number;
  lastLeadAt: string | null;
  serverSecret: { set: boolean; keyId?: string };
  consentText: string | null;
  privacyUrl: string | null;
  turnstile: boolean;
  previousKeyValidUntil: string | null;
  warnings?: string[];
  embed: { snippet: string; curl: string; signedCurl: string | null; steps: string[]; endpoint: string; example: string } | null;
  embedNote?: string;
}

/** The result of making a form: the form, and a signing secret that is shown once. */
export interface CreatedLeadForm {
  created: boolean;
  source: LeadFormView;
  serverSecret?: string;
  serverSecretNote?: string;
  note?: string;
}

export const FORM_STATUS_LABEL: Record<LeadFormStatus, string> = { active: "Taking leads", paused: "Paused", revoked: "Switched off" };

export function formStatusTone(status: LeadFormStatus): "ok" | "warn" | "neutral" {
  return status === "active" ? "ok" : status === "paused" ? "warn" : "neutral";
}

/** "3 leads, the last 2 days ago" / "No lead yet". `when` is how the page words a time (kept out of here so this stays pure). */
export function leadsLine(form: Pick<LeadFormView, "accepted" | "lastLeadAt">, when: (at: string | null) => string | null): string {
  if (form.accepted <= 0) return "No lead yet";
  const last = when(form.lastLeadAt);
  return `${form.accepted} ${form.accepted === 1 ? "lead" : "leads"}${last ? `, the last ${last}` : ""}`;
}

/** The facts under a form's name, in one line. */
export function formFacts(form: LeadFormView, when: (at: string | null) => string | null): string {
  return [
    leadsLine(form, when),
    form.rejected > 0 ? `${form.rejected} refused (spam or a bad address)` : null,
    form.turnstile ? "Turnstile check on" : null,
    form.serverSecret.set ? `server secret ${form.serverSecret.keyId ?? "set"}` : null,
    form.site ? form.site.replace(/^https?:\/\//, "") : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

/** Whether a form can be changed (a form switched off for good cannot). */
export function formEditable(form: Pick<LeadFormView, "status">): boolean {
  return form.status !== "revoked";
}

/** A form lead's contact details in one line (email and phone), for the client's page. */
export function leadReach(lead: { email?: string | null; phone?: string | null }): string {
  return [lead.email, lead.phone].filter((part): part is string => Boolean(part)).join(" · ");
}

/** Where a form lead came from, in one line: the campaign tags, the page, and whether they ticked the marketing box. */
export function leadOrigin(meta: { sourceLabel?: string; attribution?: Record<string, string | null>; consent?: boolean } | null | undefined): string {
  if (!meta) return "";
  const a = meta.attribution ?? {};
  const tags = [a.utmSource, a.utmMedium, a.utmCampaign].filter((part): part is string => Boolean(part));
  const page = a.pageUrl ? a.pageUrl.replace(/^https?:\/\/(www\.)?/, "") : null;
  return [meta.sourceLabel, tags.length ? `via ${tags.join(" / ")}` : null, page ? `on ${page}` : null, meta.consent === true ? "marketing email ticked" : meta.consent === false ? "marketing email not ticked" : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
