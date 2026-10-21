/**
 * Growth Lab data. The service talks to this interface (the kit ports with
 * Social's row types); `sqlGrowthStore` (sql.ts, features-sql.ts) implements
 * it on the plugin namespace, and the tests use an in-memory copy with the
 * same semantics.
 */
import type { ClientKind, FeaturesPort, GrowthStore as KitGrowthStore, Scoreboard, ArmSpec, Autopilot, ChangeSpec, FeatureQuestion, FeatureValue, ScoredPostRow } from "@partnersinbiz/pib-plugin-kit";

export interface ProgramConstraints {
  /** Topics Jev picks from when tagging posts (none: no topic feature). */
  topics?: string[];
  brandVoice?: string;
  platforms?: string;
  cadence?: string;
}

export interface Program {
  id: string;
  companyId: string;
  clientKind: ClientKind | null;
  clientRef: string | null;
  clientName: string | null;
  channel: string;
  objective: string;
  metric: string;
  constraints: ProgramConstraints;
  playbook: string;
  playbookVersion: number;
  autopilot: Autopilot;
  scoreboard: Scoreboard;
  featureQuestions: FeatureQuestion[];
  status: string;
  ownerUserId: string | null;
  approvalIssueId: string | null;
  approvalWeek: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type NewProgram = Omit<Program, "createdAt" | "updatedAt" | "approvalIssueId" | "approvalWeek" | "status">;

export interface ProgramPatch {
  objective?: string;
  autopilot?: Autopilot;
  constraints?: ProgramConstraints;
  ownerUserId?: string;
  scoreboard?: Scoreboard;
  featureQuestions?: FeatureQuestion[];
  approvalIssueId?: string;
  approvalWeek?: string;
  clientName?: string;
}

export interface PlaybookVersion {
  version: number;
  playbook: string;
  reason: string;
  experimentId: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export type ExperimentStatus = "proposed" | "running" | "measured" | "rejected" | "abandoned";

export interface Experiment {
  id: string;
  companyId: string;
  programId: string;
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: ArmSpec[];
  metric: string;
  minPerArm: number;
  windowDays: number;
  status: ExperimentStatus;
  proposedBy: string | null;
  approvalIssueId: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  measureAfter: string | null;
  measuredAt: string | null;
  verdict: string | null;
  outcome: Record<string, unknown> | null;
  playbookDiff: string | null;
  playbookDecision: "pending" | "kept" | "discarded" | null;
  decisionNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type NewExperiment = Pick<Experiment, "id" | "companyId" | "programId" | "hypothesis" | "hypothesisType" | "variable" | "arms" | "metric" | "minPerArm" | "windowDays" | "status" | "proposedBy">;

export interface ExperimentPatch {
  status?: ExperimentStatus;
  approvalIssueId?: string;
  approvedAt?: string;
  approvedBy?: string;
  startedAt?: string;
  measureAfter?: string;
  measuredAt?: string;
  verdict?: string;
  outcome?: Record<string, unknown>;
  playbookDiff?: string;
  playbookDecision?: "pending" | "kept" | "discarded";
  decisionNote?: string;
}

export interface ExperimentItem {
  experimentId: string;
  arm: string;
  postId: string;
  value: number | null;
  measuredAt: string | null;
}

/** A post tagged with an experiment, with its 7-day lifts. */
export interface ExperimentPost {
  postId: string;
  arm: string | null;
  status: string;
  publishedAt: string | null;
  lifts: number[];
}

export interface PlaybookChange {
  id: string;
  companyId: string;
  programId: string;
  experimentId: string | null;
  op: ChangeSpec["op"];
  section: string | null;
  body: string;
  diff: string;
  reason: string;
  status: "pending" | "kept" | "discarded";
  baseVersion: number;
  resultVersion: number | null;
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalIssueId: string | null;
  createdAt: string | null;
}

export type NewChange = Pick<PlaybookChange, "id" | "companyId" | "programId" | "experimentId" | "op" | "section" | "body" | "diff" | "reason" | "baseVersion" | "proposedBy">;

export interface ChangePatch {
  status?: "kept" | "discarded";
  resultVersion?: number;
  decidedBy?: string;
  decisionNote?: string;
  approvalIssueId?: string;
}

/** One 7-day metric snapshot with what scoring needs. */
export interface MetricRow {
  destinationId: string;
  postId: string;
  accountId: string | null;
  platform: string | null;
  publishedAt: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  reach: number | null;
  impressions: number | null;
  views: number | null;
  clientKind: string | null;
  clientRef: string | null;
  clientName: string | null;
}

export interface ScoreWrite {
  destinationId: string;
  window: string;
  companyId: string;
  postId: string;
  accountId: string | null;
  platform: string | null;
  programId: string | null;
  clientKind: string | null;
  clientRef: string | null;
  engagementRate: number;
  basis: string;
  baselineMedian: number | null;
  baselineN: number;
  lift: number | null;
  publishedAt: string | null;
}

export interface ExistingScore {
  engagementRate: number;
  baselineMedian: number | null;
  baselineN: number;
  lift: number | null;
  programId: string | null;
}

export interface TaggablePost {
  id: string;
  body: string;
  media: Array<{ kind: string }>;
  publishedAt: string | null;
  clientKind: string | null;
  clientRef: string | null;
  clientName: string | null;
  featureKeys: string[];
}

export interface StoredFeature {
  postId: string;
  key: string;
  value: string | null;
  confidence: number;
  source: string;
}

/** The Social-only half: post features, scores, metrics and experiment tags on posts. */
export type SocialFeaturesPort = FeaturesPort<TaggablePost, FeatureValue, StoredFeature, ExistingScore, ScoreWrite, ScoredPostRow, MetricRow, ExperimentPost>;

/** Programs, playbook versions, experiments, items and changes. */
export interface CoreGrowthTypes {
  program: Program;
  newProgram: NewProgram;
  programPatch: ProgramPatch;
  version: PlaybookVersion;
  experiment: Experiment;
  experimentStatus: ExperimentStatus;
  newExperiment: NewExperiment;
  experimentPatch: ExperimentPatch;
  item: ExperimentItem;
  change: PlaybookChange;
  changeStatus: PlaybookChange["status"];
  newChange: NewChange;
  changePatch: ChangePatch;
}

export type CoreGrowthStore = KitGrowthStore<CoreGrowthTypes>;

export type GrowthStore = CoreGrowthStore & SocialFeaturesPort;
