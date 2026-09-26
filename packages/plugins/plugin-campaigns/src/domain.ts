import { createHash, randomUUID } from "node:crypto";
import type { ClientKind, ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { experimentVerdict, type Verdict } from "@partnersinbiz/pib-plugin-kit";

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
  /** issue: a due step opens an issue (default). email: the Mailbox sends it (after the launch approval). */
  delivery: CampaignDelivery;
  /** Who gets reply issues: the creator (a user or an agent). */
  ownerUserId: string | null;
  ownerAgentId: string | null;
}

export const CAMPAIGN_DELIVERIES = ["issue", "email"] as const;
export type CampaignDelivery = (typeof CAMPAIGN_DELIVERIES)[number];

export function assertDelivery(value: unknown): CampaignDelivery {
  if (value == null || value === "") return "issue";
  if (value !== "issue" && value !== "email") throw new CampaignError("delivery must be issue or email");
  return value;
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
  /** Outbox key of the step email waiting for the Mailbox's result. */
  sendingKey?: string | null;
  mailThreadId?: string | null;
  mailLastMessageId?: string | null;
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
  delivery?: string | null;
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
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
    delivery: assertDelivery(input.delivery),
    ownerUserId: input.ownerUserId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
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
  /** The A/B arm this contact gets (see `pickVariant`); defaults to the first step's variant. */
  variant?: "a" | "b";
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
    variant: input.variant ?? first.variant,
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
  // The contact keeps its A/B arm across steps; a step without a B version sends A (`stepFor`).
  return {
    ...enrollment,
    status: "running",
    stepPosition: next.position,
    variant: enrollment.variant,
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

// ---------------------------------------------------------------------------
// A/B arms, Mailbox sends and replies
// ---------------------------------------------------------------------------

/**
 * The arm a new enrollment gets: the declared winner, else an even split by
 * a stable hash of campaign and contact when any step has a B version, else A.
 */
export function pickVariant(
  campaign: Pick<CampaignDraft, "id" | "winnerVariant">,
  steps: Array<Pick<CampaignStepDraft, "variant">>,
  contactId: string,
): "a" | "b" {
  if (campaign.winnerVariant) return campaign.winnerVariant;
  if (!steps.some((step) => step.variant === "b")) return "a";
  const byte = createHash("sha256").update(`${campaign.id}:${contactId}`).digest()[0]!;
  return byte % 2 === 0 ? "a" : "b";
}

/** The step to send at a position for an arm; falls back to A when the position has no B version. */
export function stepFor(steps: CampaignStepDraft[], position: number, variant: "a" | "b"): CampaignStepDraft | null {
  return steps.find((step) => step.position === position && step.variant === variant)
    ?? steps.find((step) => step.position === position && step.variant === "a")
    ?? null;
}

export function campaignMailKey(enrollmentId: string, position: number): string {
  return `campaigns:step:${enrollmentId}:${position}`;
}

export interface PersonalVars {
  name: string;
  email?: string | null;
  company?: string | null;
}

/** Fills {{first_name}}, {{last_name}}, {{name}}, {{company}}, {{email}}; `{{first_name|there}}` has a fallback. */
export function personalize(template: string, vars: PersonalVars): string {
  const parts = vars.name.trim().split(/\s+/).filter(Boolean);
  const values: Record<string, string> = {
    first_name: parts[0] ?? "",
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : "",
    name: vars.name.trim(),
    company: vars.company?.trim() ?? "",
    email: vars.email?.trim() ?? "",
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (match, rawKey: string, fallback: string | undefined) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) return match;
    return values[key]! || (fallback ?? "").trim();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export const REPLY_KINDS = ["interested", "question", "not_now", "unsubscribe", "out_of_office", "bounce", "other"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export const REPLY_KIND_LABELS: Record<ReplyKind, string> = {
  interested: "interested",
  question: "a question",
  not_now: "not now",
  unsubscribe: "unsubscribe",
  out_of_office: "out of office",
  bounce: "a bounce",
  other: "something else",
};

export function isReplyKind(value: unknown): value is ReplyKind {
  return typeof value === "string" && (REPLY_KINDS as readonly string[]).includes(value);
}

/** What a campaign does with a reply. */
export interface CampaignReplyPlan {
  /** Step event to record (null: an auto-reply that is not a real reply). */
  event: "reply" | "bounce" | "unsubscribe" | null;
  /** this: stop the replied enrollment. contact: stop every campaign for the contact (`stopEnrollmentsForContact`). */
  stop: "none" | "this" | "contact";
  suppress: "unsubscribe" | "bounce" | null;
  pushDays: number | null;
  issue: "follow-up" | "review" | null;
  summary: string;
}

/** `confident` is false below the `update` threshold or without Jev: a person decides. */
export function campaignReplyPlan(kind: ReplyKind | null, confident: boolean): CampaignReplyPlan {
  const base: CampaignReplyPlan = { event: "reply", stop: "none", suppress: null, pushDays: null, issue: null, summary: "" };
  if (!kind || !confident) return { ...base, issue: "review", summary: "Opened an issue for the campaign owner to decide." };
  switch (kind) {
    case "interested":
    case "question":
      return { ...base, stop: "this", issue: "follow-up", summary: "Stopped this campaign for the contact and opened a follow-up issue." };
    case "not_now":
      return { ...base, stop: "this", summary: "Stopped this campaign for the contact." };
    case "unsubscribe":
      return { ...base, event: "unsubscribe", stop: "contact", suppress: "unsubscribe", summary: "Stopped every campaign for the contact and suppressed the address." };
    case "bounce":
      return { ...base, event: "bounce", stop: "contact", suppress: "bounce", summary: "Stopped every campaign for the contact and suppressed the address." };
    case "out_of_office":
      return { ...base, event: null, pushDays: 5, summary: "Moved the next step 5 days later." };
    default:
      return { ...base, issue: "review", summary: "Opened an issue for the campaign owner to decide." };
  }
}

export function pushDate(current: string | null, now: Date, days: number): string {
  const base = current ? Math.max(Date.parse(current) || 0, now.getTime()) : now.getTime();
  return new Date(base + days * 86_400_000).toISOString();
}

export interface AbSuggestion {
  verdict: Verdict;
  /** The variant to declare, or null when there is no clear winner yet. */
  suggestion: "a" | "b" | null;
  sends: { a: number; b: number };
  replies: { a: number; b: number };
  replyRate: { a: number | null; b: number | null };
  reason: string;
}

export const AB_MIN_SENDS = 20;
const AB_BATCH = 5;

function batchRates(sends: boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + AB_BATCH <= sends.length; i += AB_BATCH) {
    out.push(sends.slice(i, i + AB_BATCH).filter(Boolean).length / AB_BATCH);
  }
  return out;
}

/**
 * Suggests an A/B winner from reply rates. Each send is true when it got a
 * reply; sends are in the order they went out. Below 20 sends per variant it
 * is inconclusive. Otherwise the reply rates of batches of 5 sends go through
 * the kit `experimentVerdict` (B is the variant, A the control). A person
 * still declares the winner.
 */
export function abSuggestion(input: { a: boolean[]; b: boolean[] }): AbSuggestion {
  const count = (xs: boolean[]) => xs.filter(Boolean).length;
  const rate = (xs: boolean[]) => (xs.length ? count(xs) / xs.length : null);
  const base = {
    sends: { a: input.a.length, b: input.b.length },
    replies: { a: count(input.a), b: count(input.b) },
    replyRate: { a: rate(input.a), b: rate(input.b) },
  };
  if (input.a.length < AB_MIN_SENDS || input.b.length < AB_MIN_SENDS) {
    return { ...base, verdict: "inconclusive", suggestion: null, reason: `Needs at least ${AB_MIN_SENDS} sends per variant (A ${input.a.length}, B ${input.b.length}).` };
  }
  const verdict = experimentVerdict({ control: batchRates(input.a), variant: batchRates(input.b), minPerArm: 3 });
  const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const rates = `Reply rate A ${pct(base.replyRate.a)}, B ${pct(base.replyRate.b)}.`;
  if (verdict.verdict === "win") return { ...base, verdict: "win", suggestion: "b", reason: `B looks better. ${rates}` };
  if (verdict.verdict === "loss") return { ...base, verdict: "loss", suggestion: "a", reason: `A looks better. ${rates}` };
  return { ...base, verdict: verdict.verdict, suggestion: null, reason: `No clear winner yet. ${rates}` };
}
