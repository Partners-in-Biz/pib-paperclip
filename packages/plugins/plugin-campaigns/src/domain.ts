import { randomUUID } from "node:crypto";

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
}

export interface CampaignStepDraft {
  position: number;
  delayDays: number;
  subject: string;
  body: string;
}

export interface EnrollmentDraft {
  id: string;
  companyId: string;
  campaignId: string;
  contactId: string;
  status: "running" | "stopped" | "done";
  stepPosition: number;
  nextDueAt: string | null;
  openIssueId: string | null;
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
  startAt?: string | null;
  endAt?: string | null;
  id?: string;
}): CampaignDraft {
  const name = input.name.trim();
  if (!name) throw new CampaignError("Campaign name is required");
  const fromLocal = (input.fromLocal ?? "campaigns").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(fromLocal)) throw new CampaignError("From local part must be a valid email local part");
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
  };
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
    openIssueId: null,
    nextDueAt: new Date(now.getTime() + next.delayDays * 86_400_000).toISOString(),
  };
}

export function stepIssueCopy(contactName: string, step: CampaignStepDraft): { title: string; description: string } {
  return {
    title: `${step.subject}: ${contactName}`,
    description: step.body,
  };
}

export function matchesAudience(contactTags: string[], audienceTags: string[]): boolean {
  if (audienceTags.length === 0) return true;
  const contact = new Set(contactTags.map((tag) => tag.toLowerCase()));
  return audienceTags.some((tag) => contact.has(tag.toLowerCase()));
}
