import { randomUUID } from "node:crypto";
import type { ClientKind, ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "active", "paused", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export class CampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignError";
  }
}

export interface CampaignDraft {
  id: string;
  companyId: string;
  name: string;
  description: string;
  status: CampaignStatus;
  fromName: string;
  fromLocal: string;
  replyTo: string | null;
  audienceTags: string[];
  startAt: string | null;
  endAt: string | null;
  approvalIssueId: string | null;
  winnerVariant: "a" | "b" | null;
  /** Null for PiB's own work. */
  clientKind: ClientKind | null;
  clientRef: string | null;
  /** CRM name when the campaign was scoped, for issue titles. */
  clientName: string | null;
  audienceMode: AudienceMode;
}

/**
 * Who a launch enrolls.
 * - `tags`: CRM contacts matching `audienceTags` (empty = every contact).
 * - `client_contacts`: contacts at the client company, narrowed by `audienceTags` when set.
 * - `client_contact`: the client contact (a sole trader) alone.
 */
export const AUDIENCE_MODES = ["tags", "client_contacts", "client_contact"] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

/** The client a campaign is for, as resolved from the CRM. */
export interface CampaignClient {
  kind: ClientKind;
  id: string;
  name: string;
}

export interface CampaignStepDraft {
  position: number;
  delayDays: number;
  subject: string;
  body: string;
  htmlBody: string | null;
  variant: "a" | "b";
}

export interface EnrollmentDraft {
  id: string;
  companyId: string;
  campaignId: string;
  contactId: string;
  status: "running" | "stopped" | "done";
  stepPosition: number;
  variant: "a" | "b";
  nextDueAt: string | null;
  openIssueId: string | null;
}

export function assertVariant(value: string): "a" | "b" {
  if (value !== "a" && value !== "b") throw new CampaignError("Variant must be a or b");
  return value;
}

export function assertCampaignStatus(value: string): CampaignStatus {
  if (!CAMPAIGN_STATUSES.includes(value as CampaignStatus)) {
    throw new CampaignError("Campaign status must be draft, scheduled, active, paused, or completed");
  }
  return value as CampaignStatus;
}

export function createCampaign(input: {
  companyId: string;
  name: string;
  description?: string;
  fromName?: string;
  fromLocal?: string;
  replyTo?: string | null;
  audienceTags?: string[];
  audienceMode?: string | null;
  client?: CampaignClient | null;
  startAt?: string | null;
  endAt?: string | null;
  id?: string;
}): CampaignDraft {
  const name = input.name.trim();
  if (!name) throw new CampaignError("Campaign name is required");
  const fromLocal = (input.fromLocal ?? "campaigns").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(fromLocal)) throw new CampaignError("From local part must be a valid email local part");
  const client = input.client ?? null;
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    description: (input.description ?? "").trim(),
    status: "draft",
    fromName: (input.fromName ?? "").trim(),
    fromLocal,
    replyTo: input.replyTo?.trim() || null,
    audienceTags: (input.audienceTags ?? []).map((tag) => tag.trim()).filter(Boolean),
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    approvalIssueId: null,
    winnerVariant: null,
    clientKind: client?.kind ?? null,
    clientRef: client?.id ?? null,
    clientName: client?.name ?? null,
    audienceMode: assertAudienceMode(input.audienceMode, client),
  };
}

/** The scope a campaign row belongs to. */
export function campaignScope(campaign: Pick<CampaignDraft, "clientKind" | "clientRef">): ClientScope {
  if (!campaign.clientRef) return null;
  return { kind: campaign.clientKind ?? "company", id: campaign.clientRef };
}

/** A company client enrolls its people; a contact client is the audience itself. */
export function defaultAudienceMode(client: ClientScope): AudienceMode {
  if (!client) return "tags";
  return client.kind === "company" ? "client_contacts" : "client_contact";
}

/** Validates an audience mode against the campaign's client. Empty means the default for the client. */
export function assertAudienceMode(value: string | null | undefined, client: ClientScope): AudienceMode {
  if (value == null || value === "") return defaultAudienceMode(client);
  if (!AUDIENCE_MODES.includes(value as AudienceMode)) {
    throw new CampaignError("audienceMode must be tags, client_contacts, or client_contact");
  }
  if (value === "client_contacts" && client?.kind !== "company") {
    throw new CampaignError("The client_contacts audience (contacts at this company) needs a company client");
  }
  if (value === "client_contact" && client?.kind !== "contact") {
    throw new CampaignError("The client_contact audience needs a contact client");
  }
  return value as AudienceMode;
}

/**
 * Sets the campaign's client (null = own work) and audience mode. Without an
 * explicit mode, the mode is kept for the same client and resets to the new
 * client's default when the client changes.
 */
export function withClient(campaign: CampaignDraft, client: CampaignClient | null, audienceMode?: string | null): CampaignDraft {
  const before = campaignScope(campaign);
  const after: ClientScope = client ? { kind: client.kind, id: client.id } : null;
  const same = before && after ? before.kind === after.kind && before.id === after.id : before === after;
  const mode = audienceMode != null && audienceMode !== ""
    ? assertAudienceMode(audienceMode, after)
    : same ? campaign.audienceMode : defaultAudienceMode(after);
  return {
    ...campaign,
    clientKind: client?.kind ?? null,
    clientRef: client?.id ?? null,
    clientName: client?.name ?? null,
    audienceMode: mode,
  };
}

export type AudienceSource =
  | { kind: "tags"; tags: string[] }
  | { kind: "company-contacts"; crmCompanyId: string; tags: string[] }
  | { kind: "contact"; contactId: string };

/** Where launch finds the contacts to enroll. A mode that no longer fits the client falls back to tags. */
export function audienceSource(campaign: Pick<CampaignDraft, "audienceMode" | "audienceTags" | "clientKind" | "clientRef">): AudienceSource {
  const scope = campaignScope(campaign);
  if (campaign.audienceMode === "client_contacts" && scope?.kind === "company") {
    return { kind: "company-contacts", crmCompanyId: scope.id, tags: campaign.audienceTags };
  }
  if (campaign.audienceMode === "client_contact" && scope?.kind === "contact") {
    return { kind: "contact", contactId: scope.id };
  }
  return { kind: "tags", tags: campaign.audienceTags };
}

/** `[Client name] ` for issue titles of client work, empty for own work. */
export function clientPrefix(clientName: string | null | undefined): string {
  const name = clientName?.trim();
  return name ? `[${name}] ` : "";
}

export function assertCanRequestApproval(status: CampaignStatus): void {
  if (status !== "draft") throw new CampaignError("Only a draft campaign can be sent for approval");
}

export function assertCanLaunch(status: CampaignStatus): void {
  if (status !== "draft" && status !== "paused") {
    throw new CampaignError("Only a draft or paused campaign can be launched");
  }
}

export function assertCanPause(status: CampaignStatus): void {
  if (status !== "active" && status !== "scheduled") {
    throw new CampaignError("Only an active or scheduled campaign can be paused");
  }
}

export function assertCanComplete(status: CampaignStatus): void {
  if (status !== "active" && status !== "paused") {
    throw new CampaignError("Only an active or paused campaign can be completed");
  }
}

export function startEnrollment(input: {
  companyId: string;
  campaignId: string;
  contactId: string;
  existing: Array<{ status: string }>;
  steps: CampaignStepDraft[];
  now: Date;
  id?: string;
}): EnrollmentDraft {
  if (input.existing.some((row) => row.status === "running")) {
    throw new CampaignError("Contact already has a running enrollment in this campaign");
  }
  const first = [...input.steps].sort((a, b) => a.position - b.position)[0];
  if (!first) throw new CampaignError("Campaign has no steps");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    campaignId: input.campaignId,
    contactId: input.contactId,
    status: "running",
    stepPosition: first.position,
    variant: first.variant,
    nextDueAt: new Date(input.now.getTime() + first.delayDays * 86_400_000).toISOString(),
    openIssueId: null,
  };
}

export function advanceEnrollment(
  enrollment: EnrollmentDraft,
  steps: CampaignStepDraft[],
  now: Date,
): EnrollmentDraft {
  const later = steps
    .filter((step) => step.position > enrollment.stepPosition)
    .sort((a, b) => a.position - b.position);
  const next = later[0];
  if (!next) {
    return { ...enrollment, status: "done", openIssueId: null, nextDueAt: null };
  }
  return {
    ...enrollment,
    status: "running",
    stepPosition: next.position,
    variant: next.variant,
    openIssueId: null,
    nextDueAt: new Date(now.getTime() + next.delayDays * 86_400_000).toISOString(),
  };
}

export function stepIssueCopy(
  contactName: string,
  step: CampaignStepDraft,
  clientName?: string | null,
): { title: string; description: string } {
  return {
    title: `${clientPrefix(clientName)}${step.subject}: ${contactName}`,
    description: step.body,
  };
}

export function matchesAudience(contactTags: string[], audienceTags: string[]): boolean {
  if (audienceTags.length === 0) return true;
  const contact = new Set(contactTags.map((tag) => tag.toLowerCase()));
  return audienceTags.some((tag) => contact.has(tag.toLowerCase()));
}

export function assertCanDeclareWinner(status: CampaignStatus): void {
  if (status !== "active" && status !== "paused") throw new CampaignError("Only an active or paused campaign can declare a winner");
}

export function assertEventType(value: string): "open" | "click" {
  if (value !== "open" && value !== "click") throw new CampaignError("Event type must be open or click");
  return value;
}

export interface CampaignTemplateDraft {
  id: string;
  companyId: string;
  name: string;
  description: string;
  steps: Array<{ subject: string; body: string; delayDays: number }>;
}

export function createCampaignTemplate(input: {
  companyId: string;
  name: string;
  description?: string;
  steps?: Array<{ subject: string; body?: string; delayDays?: number }>;
  id?: string;
}): CampaignTemplateDraft {
  const name = input.name.trim();
  if (!name) throw new CampaignError("Template name is required");
  const steps = (input.steps ?? []).map((step) => ({
    subject: step.subject.trim(),
    body: (step.body ?? "").trim(),
    delayDays: step.delayDays ?? 0,
  }));
  if (steps.some((step) => !step.subject)) throw new CampaignError("Every template step needs a subject");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    description: (input.description ?? "").trim(),
    steps,
  };
}

/** What the CRM client workspace shows for Campaigns (`GET /client-summary`). */
export interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

export function campaignClientSummary(counts: { total: number; active: number; enrolledContacts: number; dueSteps: number }): ClientSummary {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const headline = counts.active > 0
    ? plural(counts.active, "active campaign")
    : counts.total > 0
      ? `${plural(counts.total, "campaign")}, none active`
      : "No campaigns";
  return {
    headline,
    stats: [
      { label: "Active campaigns", value: counts.active, ...(counts.active > 0 ? { tone: "ok" as const } : {}) },
      { label: "Enrolled contacts", value: counts.enrolledContacts },
      { label: "Due steps", value: counts.dueSteps, ...(counts.dueSteps > 0 ? { tone: "warn" as const } : {}) },
    ],
  };
}
