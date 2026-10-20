/**
 * Growth Lab ports: what the loop needs from its host plugin, kept apart from
 * how Social (or a later plugin) stores it. The entity shapes are type
 * parameters so a plugin keeps its own row types; the method names are the
 * contract. A plugin with no post-like subjects can use a different
 * `FeaturesPort` and still share the loop.
 */
import type { ClientScope } from "../client-ref.js";

/** One scope: own work (`null`) or one CRM client. */
export type ScopeKey = ClientScope;

/** The entity types a store trades in. Every field is a plugin-owned type. */
export interface GrowthStoreTypes {
  program: unknown;
  newProgram: unknown;
  programPatch: unknown;
  version: unknown;
  experiment: unknown;
  experimentStatus: string;
  newExperiment: unknown;
  experimentPatch: unknown;
  item: unknown;
  change: unknown;
  changeStatus: string;
  newChange: unknown;
  changePatch: unknown;
}

/** Programs, playbook versions, experiments, items and playbook changes. Every read and write is company-scoped. */
export interface GrowthStore<T extends GrowthStoreTypes = GrowthStoreTypes> {
  findProgram(companyId: string, channel: string, scope: ScopeKey): Promise<T["program"] | null>;
  getProgram(companyId: string, id: string): Promise<T["program"] | null>;
  insertProgram(program: T["newProgram"]): Promise<void>;
  updateProgram(companyId: string, id: string, patch: T["programPatch"]): Promise<void>;
  /** Replace the playbook when it is still at `expectedVersion`; bumps the version. */
  savePlaybook(companyId: string, id: string, expectedVersion: number, playbook: string): Promise<boolean>;
  insertPlaybookVersion(input: { programId: string; version: number; playbook: string; reason: string; experimentId: string | null; createdBy: string | null }): Promise<void>;
  listPlaybookVersions(programId: string, limit: number): Promise<T["version"][]>;

  insertExperiment(experiment: T["newExperiment"]): Promise<void>;
  getExperiment(companyId: string, id: string): Promise<T["experiment"] | null>;
  listExperiments(companyId: string, programId: string, statuses?: T["experimentStatus"][]): Promise<T["experiment"][]>;
  /** Applies only when the experiment is in one of `from` (null: any status). */
  updateExperiment(companyId: string, id: string, from: T["experimentStatus"][] | null, patch: T["experimentPatch"]): Promise<boolean>;
  companiesWithRunningExperiments(): Promise<string[]>;
  runningExperiments(companyId: string): Promise<T["experiment"][]>;

  upsertItem(experimentId: string, arm: string, postId: string, value: number | null): Promise<void>;
  deleteItem(experimentId: string, postId: string): Promise<void>;
  listItems(experimentId: string): Promise<T["item"][]>;

  insertChange(change: T["newChange"]): Promise<void>;
  getChange(companyId: string, id: string): Promise<T["change"] | null>;
  listChanges(companyId: string, programId: string, status?: T["changeStatus"]): Promise<T["change"][]>;
  /** With `onlyPending`, applies only while the change is still pending. */
  updateChange(companyId: string, id: string, patch: T["changePatch"], onlyPending: boolean): Promise<boolean>;
}

/** The approval issue a person decides on. Failures to comment or close must not break the loop: callers treat them as best effort. */
export interface ApprovalIssuePort<Create = unknown> {
  createApproval(input: Create): Promise<{ id: string }>;
  isOpen(companyId: string, issueId: string): Promise<boolean>;
  setStatus(companyId: string, issueId: string, status: "done"): Promise<void>;
  comment(companyId: string, issueId: string, body: string): Promise<void>;
}

/** Tool params to a scope and back. Unknown clients are refused by `fromParams`. */
export interface ScopeResolver<Params = Record<string, unknown>, Resolved extends { scope: ScopeKey } = { scope: ScopeKey }> {
  fromParams(companyId: string, params: Params): Promise<Resolved>;
  toParam(scope: ScopeKey): string;
}

/** Post-like subjects: features, scores, experiment tags and the metrics behind them. */
export interface FeaturesPort<
  Post = unknown,
  Feature = unknown,
  StoredFeature = unknown,
  Score = unknown,
  ScoreWrite = unknown,
  ScoredRow = unknown,
  Metric = unknown,
  ExperimentPost = unknown,
> {
  postsToTag(companyId: string, sinceDays: number, limit: number): Promise<Post[]>;
  upsertFeatures(companyId: string, programId: string | null, postId: string, values: Feature[], model: string | null): Promise<void>;
  postFeatures(companyId: string, postIds: string[]): Promise<StoredFeature[]>;
  scoredPosts(companyId: string, scope: ScopeKey, window: string, sinceDays: number): Promise<ScoredRow[]>;
  existingScores(companyId: string, window: string, sinceDays: number): Promise<Map<string, Score>>;
  upsertScore(score: ScoreWrite): Promise<void>;
  companiesWithMetrics(window: string, sinceDays: number): Promise<string[]>;
  metricRows(companyId: string, window: string, sinceDays: number): Promise<Metric[]>;
  /** Tag a post with an experiment arm (both null: untag). False when the post is not found for the company. */
  setPostExperiment(companyId: string, postId: string, experimentId: string | null, arm: string | null): Promise<boolean>;
  experimentPosts(companyId: string, experimentId: string, window: string): Promise<ExperimentPost[]>;
}
