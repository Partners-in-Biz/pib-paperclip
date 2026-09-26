/**
 * Growth Lab data. The service talks to this interface; `sqlGrowthStore`
 * (sql.ts) implements it on the plugin namespace, and the tests use an
 * in-memory copy with the same semantics.
 */
import type { ClientKind, ClientScope, Scoreboard } from "@partnersinbiz/pib-plugin-kit";
import type { ArmSpec, Autopilot, ChangeSpec, FeatureQuestion, FeatureValue, ScoredPostRow } from "./engine.js";

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

export interface GrowthStore {
  findProgram(companyId: string, channel: string, scope: ClientScope): Promise<Program | null>;
  getProgram(companyId: string, id: string): Promise<Program | null>;
  insertProgram(program: NewProgram): Promise<void>;
  updateProgram(companyId: string, id: string, patch: ProgramPatch): Promise<void>;
  /** Replace the playbook when it is still at `expectedVersion`; bumps the version. */
  savePlaybook(companyId: string, id: string, expectedVersion: number, playbook: string): Promise<boolean>;
  insertPlaybookVersion(input: { programId: string; version: number; playbook: string; reason: string; experimentId: string | null; createdBy: string | null }): Promise<void>;
  listPlaybookVersions(programId: string, limit: number): Promise<PlaybookVersion[]>;

  insertExperiment(experiment: NewExperiment): Promise<void>;
  getExperiment(companyId: string, id: string): Promise<Experiment | null>;
  listExperiments(companyId: string, programId: string, statuses?: ExperimentStatus[]): Promise<Experiment[]>;
  /** Applies only when the experiment is in one of `from` (null: any status). */
  updateExperiment(companyId: string, id: string, from: ExperimentStatus[] | null, patch: ExperimentPatch): Promise<boolean>;
  companiesWithRunningExperiments(): Promise<string[]>;
  runningExperiments(companyId: string): Promise<Experiment[]>;

  upsertItem(experimentId: string, arm: string, postId: string, value: number | null): Promise<void>;
  deleteItem(experimentId: string, postId: string): Promise<void>;
  listItems(experimentId: string): Promise<ExperimentItem[]>;
  experimentPosts(companyId: string, experimentId: string, window: string): Promise<ExperimentPost[]>;
  setPostExperiment(companyId: string, postId: string, experimentId: string | null, arm: string | null): Promise<boolean>;

  insertChange(change: NewChange): Promise<void>;
  getChange(companyId: string, id: string): Promise<PlaybookChange | null>;
  listChanges(companyId: string, programId: string, status?: PlaybookChange["status"]): Promise<PlaybookChange[]>;
  /** With `onlyPending`, applies only while the change is still pending. */
  updateChange(companyId: string, id: string, patch: ChangePatch, onlyPending: boolean): Promise<boolean>;

  companiesWithMetrics(window: string, sinceDays: number): Promise<string[]>;
  metricRows(companyId: string, window: string, sinceDays: number): Promise<MetricRow[]>;
  existingScores(companyId: string, window: string, sinceDays: number): Promise<Map<string, ExistingScore>>;
  upsertScore(score: ScoreWrite): Promise<void>;

  postsToTag(companyId: string, sinceDays: number, limit: number): Promise<TaggablePost[]>;
  upsertFeatures(companyId: string, programId: string | null, postId: string, values: FeatureValue[], model: string | null): Promise<void>;
  postFeatures(companyId: string, postIds: string[]): Promise<StoredFeature[]>;
  scoredPosts(companyId: string, scope: ClientScope, window: string, sinceDays: number): Promise<ScoredPostRow[]>;
}
