/**
 * Pure helpers for the Agreements and Growth card on a client's page (no React, no host): how a document, a site counter and a
 * channel read in a line, and which buttons make sense. Tested without a browser. The worker builds the data (`growth-view.ts`).
 */

export type AgreementTone = "ok" | "warn" | "bad" | "info" | "neutral";

export type DocStatus = "draft" | "awaiting_approval" | "sent" | "viewed" | "signed" | "declined" | "expired" | "void";

export interface AgreementDocView {
  documentId: string;
  kind: string;
  title: string;
  status: DocStatus;
  statusLine: string;
  to: string | null;
  dealId: string | null;
  quoteId: string | null;
  valueMinor: number | null;
  currency: string | null;
  createdAt: string;
  sentAt: string | null;
  viewedAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  signerName: string | null;
}

export interface AgreementsView {
  allowed: boolean;
  canary: boolean;
  enabledBy: string | null;
  enabledAt: string | null;
  templatesReviewed: boolean;
  templateVersion: string;
  documents: AgreementDocView[];
}

export interface GrowthChannelView {
  channel: string;
  label: string;
  firstLeads: number;
  lastLeads: number;
  qualified: number;
  won: number;
  revenue: string;
  cost: string;
}

export interface SiteKeyView {
  id: string;
  label: string;
  site: string | null;
  status: "active" | "paused" | "revoked";
  consentMode: "anonymous" | "required";
  counted: number;
  lastEventAt: string | null;
  warnings: string[];
}

export interface GrowthView {
  days: number;
  channels: GrowthChannelView[];
  totals: { firstLeads: number; revenue: string };
  unattributedLeads: number;
  siteKeys: SiteKeyView[];
  site: { visits: number; pageviews: number; conversions: number } | null;
}

export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Waiting for approval",
  sent: "Sent",
  viewed: "Opened",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  void: "Withdrawn",
};

export const KIND_LABEL: Record<string, string> = { proposal: "Proposal", quote: "Quote", contract: "Agreement" };

export function docTone(status: DocStatus): AgreementTone {
  switch (status) {
    case "signed": return "ok";
    case "declined": return "bad";
    case "expired": return "warn";
    case "sent":
    case "viewed":
    case "awaiting_approval": return "info";
    default: return "neutral";
  }
}

/** Documents a person still has to act on or wait for, first; then the signed ones, newest first. */
export function orderDocs(docs: readonly AgreementDocView[]): AgreementDocView[] {
  const rank = (doc: AgreementDocView): number => (doc.status === "viewed" || doc.status === "sent" ? 0 : doc.status === "awaiting_approval" ? 1 : doc.status === "draft" ? 2 : doc.status === "expired" || doc.status === "declined" ? 3 : doc.status === "signed" ? 4 : 5);
  return [...docs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** A draft or an expired document can go for signature (a person still approves the email); a signed one can never be withdrawn. */
export function canSend(doc: Pick<AgreementDocView, "status">, allowed: boolean): boolean {
  return allowed && (doc.status === "draft" || doc.status === "expired");
}

export function canWithdraw(doc: Pick<AgreementDocView, "status">): boolean {
  return doc.status !== "signed" && doc.status !== "void";
}

/** "ZAR 12500.00": a document's value, or null when it has none. Same on every machine (no locale). */
export function valueText(doc: Pick<AgreementDocView, "valueMinor" | "currency">): string | null {
  if (doc.valueMinor == null || !doc.currency) return null;
  return `${doc.currency} ${(doc.valueMinor / 100).toFixed(2)}`;
}

/** The e-sign state in one line for the top of the card. */
export function esignLine(a: Pick<AgreementsView, "allowed" | "canary" | "enabledBy" | "templatesReviewed" | "templateVersion">): { text: string; tone: AgreementTone } {
  if (a.canary) return { text: "The practice client: e-sign is always on here, for testing the whole journey.", tone: "info" };
  if (!a.allowed) return { text: "E-sign is off for this client. Agents cannot make or send documents for it until a person turns it on.", tone: "neutral" };
  return {
    text: `E-sign is on${a.enabledBy ? ` (turned on by ${a.enabledBy.startsWith("user:") ? "a person" : "an agent"})` : ""}. ${a.templatesReviewed ? "The owner said a lawyer reviewed the templates." : `The templates (version ${a.templateVersion}) are drafts no lawyer has reviewed.`}`,
    tone: a.templatesReviewed ? "ok" : "warn",
  };
}

/** A counter in one line: counted so far and when it last did. */
export function siteKeyLine(key: SiteKeyView, now: number): { text: string; tone: AgreementTone } {
  if (key.status === "paused") return { text: "Paused: nothing is counted", tone: "neutral" };
  const last = key.lastEventAt ? Date.parse(key.lastEventAt) : Number.NaN;
  if (!Number.isFinite(last)) return { text: key.warnings.length ? "Nothing counted yet: the snippet is probably not installed" : "Nothing counted yet", tone: key.warnings.length ? "warn" : "neutral" };
  const hours = Math.max(0, Math.round((now - last) / 3_600_000));
  const when = hours < 1 ? "under an hour ago" : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
  return { text: `${key.counted} counted, last ${when}`, tone: "ok" };
}

/** What a channel row says: first-touch and last-touch leads, and what became of them. */
export function channelLine(row: Pick<GrowthChannelView, "firstLeads" | "lastLeads" | "qualified" | "won" | "revenue">): string {
  const parts = [`${row.firstLeads} first-touch`, `${row.lastLeads} last-touch`];
  if (row.qualified) parts.push(`${row.qualified} qualified`);
  if (row.won) parts.push(`${row.won} won`);
  if (row.revenue && row.revenue !== "none") parts.push(row.revenue);
  return parts.join(" · ");
}

/** Whether the card has anything to show or do: documents, e-sign turned on, a counter, or leads with a channel. Always true for a company record: it is where e-sign is turned on. */
export function agreementsVisible(a: AgreementsView | null | undefined, g: GrowthView | null | undefined): boolean {
  return Boolean(a || (g && (g.channels.length > 0 || g.siteKeys.length > 0)));
}
