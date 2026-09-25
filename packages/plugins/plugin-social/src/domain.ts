import { randomUUID } from "node:crypto";

export const POST_STATUSES = ["draft", "review", "approved", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export type AccountScope = "org" | "personal";

export class SocialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialError";
  }
}

const TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ["review"],
  review: ["approved", "draft"],
  approved: ["scheduled"],
  scheduled: ["publishing"],
  publishing: ["published", "failed"],
  published: [],
  failed: ["draft"],
};

export function assertTransition(from: PostStatus, to: PostStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new SocialError(`A ${from} post cannot move to ${to}`);
}

export function assertAgentTransition(from: PostStatus, to: PostStatus): void {
  if (to === "approved" || to === "publishing" || to === "published") {
    throw new SocialError("Agents draft and schedule. A person approves before publishing.");
  }
  assertTransition(from, to);
}

export function assertDestination(input: {
  postScope: AccountScope;
  accountScope: AccountScope;
  accountOwnerUserId: string | null;
  actorUserId: string | null;
}): void {
  if (input.postScope === "org" && input.accountScope === "personal") {
    throw new SocialError("An organisation post cannot target a personal account");
  }
  if (input.accountScope === "personal" && input.accountOwnerUserId !== input.actorUserId) {
    throw new SocialError("A personal account can only be used by its owner");
  }
}

export function publishResult(secretRef: string | null, now = new Date()): { status: "published" | "failed"; result: Record<string, unknown> } {
  if (!secretRef) return { status: "failed", result: { reason: "Account has no credential reference" } };
  return { status: "published", result: { acceptedAt: now.toISOString() } };
}

export function createPost(input: { companyId: string; body: string; scope?: AccountScope; ownerUserId: string | null }): {
  id: string;
  companyId: string;
  body: string;
  status: PostStatus;
  scope: AccountScope;
  ownerUserId: string | null;
  scheduledAt: string | null;
} {
  const body = input.body.trim();
  if (!body) throw new SocialError("Post body is required");
  return {
    id: randomUUID(),
    companyId: input.companyId,
    body,
    status: "draft",
    scope: input.scope ?? "org",
    ownerUserId: input.ownerUserId,
    scheduledAt: null,
  };
}

export interface TemplateDraft {
  id: string;
  companyId: string;
  name: string;
  body: string;
  platform: string | null;
}

export function createTemplate(input: {
  companyId: string;
  name: string;
  body: string;
  platform?: string | null;
  id?: string;
}): TemplateDraft {
  const name = input.name.trim();
  if (!name) throw new SocialError("Template name is required");
  const body = input.body.trim();
  if (!body) throw new SocialError("Template body is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    body,
    platform: input.platform?.trim() || null,
  };
}
