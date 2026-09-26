import type { PlatformOverride, SocialPlatform } from "../platforms.js";

/** Scope fields every scoped record carries. `client` is "company:<id>" / "contact:<id>", null for own work. */
export interface Scoped {
  client: string | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
}

/** A CRM company or contact, for "Belongs to" pickers. */
export interface ClientOption {
  kind: "company" | "contact";
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  lifecycle: string | null;
  client: string;
}

export interface Account extends Scoped {
  id: string;
  platform: SocialPlatform;
  scope: string;
  status: "connected" | "expiring" | "needs_reconnect" | "disabled";
  displayName: string;
  handle: string | null;
  externalId: string | null;
  avatarUrl: string | null;
  connected: boolean;
  tokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  kind: string | null;
  via: string | null;
  boardId: string | null;
  boardName: string | null;
  defaultSubreddit: string | null;
  instanceUrl: string | null;
  pageName: string | null;
  reconnectIssueId: string | null;
}

export interface MediaRef {
  assetId: string | null;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  altText: string | null;
}

export interface Destination {
  id: string;
  accountId: string;
  platform: SocialPlatform | null;
  accountName: string;
  accountStatus: string | null;
  status: "pending" | "publishing" | "retrying" | "published" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
  lastError: string | null;
  publishedAt: string | null;
  issueId: string | null;
}

export interface Post extends Scoped {
  id: string;
  body: string;
  status: "draft" | "review" | "approved" | "scheduled" | "publishing" | "published" | "partially_published" | "failed";
  scope: string;
  ownerUserId: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  firstComment: string | null;
  media: MediaRef[];
  overrides: Partial<Record<SocialPlatform, PlatformOverride>>;
  source: string;
  /** Growth Lab: the experiment and arm this post tests. */
  experimentId: string | null;
  experimentArm: "control" | "variant" | null;
  error: string | null;
  failureIssueId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  destinations: Destination[];
}

export interface MediaAsset extends Scoped {
  id: string;
  name: string;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  bytes: number | null;
  altText: string | null;
}

export interface Feed extends Scoped {
  id: string;
  url: string;
  title: string | null;
  accountIds: string[];
  isActive: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface InboxItem extends Scoped {
  id: string;
  accountId: string | null;
  platform: string | null;
  kind: string;
  author: string;
  body: string;
  status: string;
  permalink: string | null;
  postId: string | null;
  replyDraft: string | null;
  replyBody: string | null;
  repliedAt: string | null;
  receivedAt: string | null;
  canReply: boolean;
  /** Jev triage; null when not triaged (no key, or not yet). */
  triage: InboxTriage | null;
}

export interface InboxTriage {
  needsReply: boolean;
  intent: string;
  intentConfidence: number;
  sentiment: string;
  escalate: boolean;
  action: "spam_read" | "escalated" | "queued" | "none";
  corrected: string[];
  issueId: string | null;
  model: string;
  triagedAt: string | null;
}

export interface Template {
  id: string;
  name: string;
  body: string;
  platform: string | null;
}

export interface PlatformInfo {
  platform: SocialPlatform;
  label: string;
  mode: "oauth" | "credentials" | "instance";
  configured: boolean;
  missing: string[];
}

export interface Snapshot {
  /** The page's scope as sent to the worker ("company:<id>" / "contact:<id>"), null for own work. */
  scope: string | null;
  /** The client this page works for, null for own work. */
  client: ClientOption | null;
  config: {
    saved: boolean;
    publicBaseUrl: string | null;
    publicBaseUrlError: string | null;
    redirectUri: string | null;
    encryptionKey: boolean;
    r2: boolean;
    timezone: string;
    linkedinOrgPages: boolean;
    allowAgentReplies: boolean;
    blueskyDefaultPds: string;
    mastodonDefaultInstance: string | null;
    /** A Jev (TypeSafe) key is saved and switched on. */
    jev: boolean;
  };
  platforms: PlatformInfo[];
  accounts: Account[];
  posts: Post[];
  templates: Template[];
  media: MediaAsset[];
  feeds: Feed[];
  inbox: InboxItem[];
  /** Proposed and running Growth Lab experiments a post in this scope can be tagged with. */
  experiments: ExperimentOption[];
  agent: SocialAgent;
  pendingPickers: Array<{ pickerId: string; platform: string }>;
  viewer: { userId: string | null };
}

/** An agent in the company (hire popup assignees, link picker). */
export interface AgentOption {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  icon: string | null;
  createdAt: string | null;
  /** Social skill slugs the agent does not have (hire-options only). */
  missingSkills?: string[];
}

/** The hire task the plugin opened (kit agent-hire). */
export interface HireRecord {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  status: "open" | "linked" | "cancelled";
}

export type LinkedBy = "auto" | "manual" | "managed" | null;

/** The Social agent card. `hire` and `candidates` are only filled on the own page. */
export interface SocialAgent {
  agentKey: string;
  agentId: string | null;
  name: string | null;
  status: string | null;
  active: boolean;
  linkedBy: LinkedBy;
  hire: HireRecord | null;
  candidates: AgentOption[];
  missingSkills: string[];
}

/** `social.hire-options`. */
export interface HireOptions {
  draft: { title: string; description: string };
  agents: AgentOption[];
  defaultAssigneeAgentId: string | null;
  status: { agent: AgentOption | null; linkedBy: LinkedBy; hire: HireRecord | null; candidates: AgentOption[] };
}

export type RunAction = (key: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;

// ── Growth Lab ──────────────────────────────────────────────────────────────

export interface ExperimentArm {
  key: "control" | "variant";
  description: string;
}

export interface ExperimentOption {
  experimentId: string;
  hypothesis: string;
  hypothesisType: string;
  status: string;
  arms: ExperimentArm[];
}

export interface FeatureQuestion {
  key: string;
  type: "noul" | "choice" | "score";
  question: string;
  options?: string[];
  levels?: string[];
  status: "active" | "retired";
  proposedBy?: string | null;
  createdAt?: string;
}

export interface GrowthProgram {
  programId: string;
  client: string | null;
  clientName: string | null;
  objective: string;
  metric: string;
  autopilot: "off" | "safe" | "full";
  topics: string[];
  brandVoice: string | null;
  platforms: string | null;
  cadence: string | null;
  playbookVersion: number;
  scoreboard: Record<string, { wins: number; losses: number; noChange: number; inconclusive: number }>;
  featureQuestions: FeatureQuestion[];
  ownerUserId: string | null;
}

export interface ArmCount {
  posts: number;
  published: number;
  scored: number;
}

export interface GrowthExperiment {
  experimentId: string;
  status: "proposed" | "running" | "measured" | "rejected" | "abandoned";
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: ExperimentArm[];
  minPerArm: number;
  windowDays: number;
  proposedBy: string | null;
  approvalIssueId: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  measureBy: string | null;
  measuredAt: string | null;
  verdict: "win" | "loss" | "no_change" | "inconclusive" | null;
  reason: string | null;
  relativeChange: number | null;
  controlMedian: number | null;
  variantMedian: number | null;
  playbookDiff: string | null;
  playbookDecision: "pending" | "kept" | "discarded" | null;
  note: string | null;
  counts: { control: ArmCount; variant: ArmCount } | null;
  createdAt: string | null;
}

export interface GrowthChange {
  changeId: string;
  status: "pending" | "kept" | "discarded";
  op: "add" | "remove" | "replace";
  section: string | null;
  text: string | null;
  diff: string;
  reason: string;
  experimentId: string | null;
  baseVersion: number;
  resultVersion: number | null;
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string | null;
}

export interface GrowthPost {
  postId: string;
  caption: string;
  platforms: string[];
  publishedAt: string | null;
  lift: number | null;
  engagementRate: number | null;
  destinations: number;
  features: Record<string, string>;
  experimentId: string | null;
  arm: string | null;
}

export interface RankedType {
  type: string;
  tries: number;
  score: number | null;
  untried: boolean;
  running: boolean;
  observedLift: number | null;
  observedPosts: number;
}

export interface GrowthSnapshot {
  program: GrowthProgram;
  periodDays: number;
  summary: { postsScored: number; postsWithLift: number; medianLift: number | null };
  top: GrowthPost[];
  bottom: GrowthPost[];
  featureLifts: Array<{ key: string; count: number; medianLift: number }>;
  runningExperiments: GrowthExperiment[];
  proposedExperiments: GrowthExperiment[];
  pendingChanges: GrowthChange[];
  rankedHypothesisTypes: RankedType[];
  featureQuestions: { builtIn: string[]; custom: FeatureQuestion[]; slotsLeft: number };
  notes: string[];
  playbook: string;
  versions: Array<{ version: number; reason: string; experimentId: string | null; createdBy: string | null; createdAt: string | null; playbook: string }>;
  changes: GrowthChange[];
  experiments: GrowthExperiment[];
  jevConfigured: boolean;
  canDecide: boolean;
}
