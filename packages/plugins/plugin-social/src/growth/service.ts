/**
 * Growth Lab for Social: programs, scoring, feature tags, experiments and
 * the playbook. Tools, UI actions and the two daily jobs call in here.
 *
 * One program per scope (own work, or one CRM client) and channel `social`,
 * created on first use. Autopilot:
 * - off: agents only read (reviews, playbook); scoring and measuring go on.
 * - safe (default): agents propose; a person approves experiments and keeps
 *   or discards playbook changes, from one approval issue per program per week.
 * - full: agent proposals start right away, the agent may decide playbook
 *   changes, and wins are kept automatically.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  decide, decideMany, recordVerdict, type ClientScope, type DecisionClientConfig,
  approveExperiment as kitApproveExperiment, abandonExperiment as kitAbandonExperiment, decidePlaybookChange as kitDecidePlaybookChange,
  measureExperiment as kitMeasureExperiment, proposeExperiment as kitProposeExperiment, rejectExperiment as kitRejectExperiment, listExperimentsRecord as kitListExperimentsRecord,
  proposePlaybookChange as kitProposePlaybookChange, getPlaybookRecord as kitGetPlaybookRecord, savePlaybookRecord as kitSavePlaybookRecord,
  ensureProgram as kitEnsureProgram, programForParams as kitProgramForParams, updateProgramRecord as kitUpdateProgramRecord,
  experimentStatuses as kitExperimentStatuses, OPEN_EXPERIMENTS, published, EXPERIMENT_STATUS_VALUES, isoWeek,
} from "@partnersinbiz/pib-plugin-kit";
import { formatClientParam, sameClient, scopeFromParams, scopeOfRow, type ResolvedScope } from "../clients.js";
import { loadSocialConfig, type SocialConfig } from "../config.js";
import { ORIGIN_KIND, personAssignee, projectIdFor, SOCIAL_ORIGINS } from "../issues.js";
import { socialOn } from "../modules.js";
import { socialPath } from "../oauth/flow.js";
import { jevConfigFor, jevKeySet } from "../triage.js";
import { approvalIssueDescription, approvalIssueTitle, changeLines, experimentLines, verdictComment } from "./copy.js";
import { sqlGrowthStore } from "./sql.js";
import type { Experiment, ExperimentPost, GrowthStore, PlaybookChange, Program, ProgramConstraints } from "./store.js";
import {
  type GrowthEnv, type GrowthActor, growthEnv, programOut, experimentOut, changeOut,
  wrapKitEnvWithConfig, wrapKitEnvForMeasure, socialKitEnv, issuePort,
} from "./host.js";
// Import engine functions and types used locally (E.* references in old code)
import {
  activeQuestions, SCORE_WINDOW, postLift, GrowthError,
  type ItemState, type ChangeSpec, type ProgramFeatureContext, type ReviewPost,
  isSection, applyPlaybookChange, rankedHypotheses, jevFeatureKeys, topAndBottom,
  liftsByFeature, codeFeatures, CODE_FEATURES, reviewPosts, usableFeatures, BASELINE_MIN,
  featureValuesFrom, featureQuestionsFor, captionState, FEATURE_PURPOSE, normalizeFeatureQuestion,
  scoreDestinations, GROWTH_CHANNEL, MAX_ACTIVE_QUESTIONS,
} from "@partnersinbiz/pib-plugin-kit";

// Re-export types from host for backward compatibility
export type { GrowthEnv, GrowthActor } from "./host.js";
export { growthEnv, programOut, experimentOut, changeOut } from "./host.js";

type Params = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reqString(params: Params, key: string, max = 2000): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new GrowthError(`${key} is required`);
  if (value.trim().length > max) throw new GrowthError(`${key} is longer than ${max} characters`);
  return value.trim();
}

function optString(params: Params, key: string, max = 2000): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new GrowthError(`${key} must be text`);
  return value.trim().slice(0, max) || undefined;
}

function requirePerson(actor: GrowthActor, what: string): string {
  if (actor.isAgent || !actor.userId) throw new GrowthError(`A person must ${what}`);
  return actor.userId;
}

function actorId(a: GrowthActor): string {
  return a.isAgent ? `agent:${a.agentId ?? "unknown"}` : `user:${a.userId ?? "unknown"}`;
}

// ── Programs ────────────────────────────────────────────────────────────────

export function targetOfResolved(r: ResolvedScope): { scope: ClientScope; name: string | null } {
  return { scope: r.scope, name: r.client?.name ?? null };
}

export function targetOfRow(row: { client_kind?: string | null; client_ref?: string | null; client_name?: string | null }): { scope: ClientScope; name: string | null } {
  return { scope: scopeOfRow(row), name: row.client_ref ? row.client_name ?? null : null };
}

/** The program for a scope, created on first use with the kit starter playbook. */
export async function ensureProgram(env: GrowthEnv, companyId: string, target: { scope: ClientScope; name: string | null }): Promise<Program> {
  return kitEnsureProgram(socialKitEnv(env), companyId, target);
}

/** The program named by `client` / `clientKind` + `clientRef` (own work when left out). Unknown clients are refused. */
export async function programForParams(env: GrowthEnv, actor: GrowthActor, params: Params): Promise<Program> {
  return kitProgramForParams(socialKitEnv(env), actor, params);
}

// Local helpers for programScope and programCtx (used by service functions)
function programScope(program: Pick<Program, "clientKind" | "clientRef">): ClientScope {
  return program.clientRef ? { kind: program.clientKind ?? "company", id: program.clientRef } : null;
}

function programCtx(program: Program): ProgramFeatureContext {
  return { topics: Array.isArray(program.constraints.topics) ? program.constraints.topics : [], featureQuestions: program.featureQuestions };
}

// ── Issues ──────────────────────────────────────────────────────────────────

async function comment(env: GrowthEnv, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await issuePort(env).comment(companyId, issueId, body);
  } catch (error) {
    env.ctx.logger.info("Growth issue comment failed", { issueId, error: errorMessage(error) });
  }
}

async function issueOpen(env: GrowthEnv, companyId: string, issueId: string): Promise<boolean> {
  return issuePort(env).isOpen(companyId, issueId);
}

/** This week's approval issue for the program: comment on it, or open it. */
async function announce(env: GrowthEnv, config: SocialConfig, program: Program, lines: string[]): Promise<string | null> {
  const companyId = program.companyId;
  const week = isoWeek(env.now(), config.timezone);
  if (program.approvalIssueId && program.approvalWeek === week && (await issueOpen(env, companyId, program.approvalIssueId))) {
    await comment(env, companyId, program.approvalIssueId, ["New items to decide:", "", ...lines].join("\n"));
    return program.approvalIssueId;
  }
  const scope = programScope(program);
  try {
    const issue = await issuePort(env).createApproval({
      companyId,
      projectId: await projectIdFor(env.ctx, companyId, scope),
      title: approvalIssueTitle(program, week),
      description: approvalIssueDescription(program, lines, await socialPath(env.ctx, companyId, { tab: "growth" }, scope)),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `${SOCIAL_ORIGINS.growth}${program.id}:${week}`,
      // A person decides experiments and playbook changes: the program owner, else the default person or the Cockpit owner.
      assigneeUserId: await personAssignee(env.ctx, companyId, program.ownerUserId),
      wake: false,
    });
    await env.store.updateProgram(companyId, program.id, { approvalIssueId: issue.id, approvalWeek: week });
    program.approvalIssueId = issue.id;
    program.approvalWeek = week;
    return issue.id;
  } catch (error) {
    env.ctx.logger.info("Growth approval issue not created", { programId: program.id, error: errorMessage(error) });
    return null;
  }
}

/** Close the approval issue once nothing on it waits for a decision. */
async function closeIfDecided(env: GrowthEnv, companyId: string, programId: string, issueId: string | null): Promise<void> {
  if (!issueId) return;
  const [proposals, changes] = await Promise.all([
    env.store.listExperiments(companyId, programId, ["proposed"]),
    env.store.listChanges(companyId, programId, "pending"),
  ]);
  if (proposals.some((e) => e.approvalIssueId === issueId) || changes.some((c) => c.approvalIssueId === issueId)) return;
  if (!(await issueOpen(env, companyId, issueId))) return;
  await comment(env, companyId, issueId, "Everything on this issue has been decided.");
  try {
    await issuePort(env).setStatus(companyId, issueId, "done");
  } catch (error) {
    env.ctx.logger.info("Growth approval issue not closed", { issueId, error: errorMessage(error) });
  }
}

async function armCounts(env: GrowthEnv, e: Experiment) {
  const posts = await env.store.experimentPosts(e.companyId, e.id, SCORE_WINDOW);
  const count = (arm: string) => {
    const list = posts.filter((p) => p.arm === arm);
    return { posts: list.length, published: list.filter(published).length, scored: list.filter((p) => postLift(p.lifts) !== null).length };
  };
  return { control: count("control"), variant: count("variant") };
}

async function syncItems(env: GrowthEnv, e: Experiment, items: ItemState[]): Promise<void> {
  const stored = new Map((await env.store.listItems(e.id)).map((i) => [i.postId, i]));
  for (const item of items) {
    const prev = stored.get(item.subjectId);
    if (!prev || prev.arm !== item.arm || prev.value !== item.value) await env.store.upsertItem(e.id, item.arm, item.subjectId, item.value);
    stored.delete(item.subjectId);
  }
  for (const postId of stored.keys()) await env.store.deleteItem(e.id, postId);
}

async function keepChange(env: GrowthEnv, actor: GrowthActor, change: PlaybookChange, note: string | undefined, by?: string): Promise<number> {
  const current = await env.store.getProgram(change.companyId, change.programId);
  if (!current) throw new GrowthError("The growth program was not found");
  const spec: ChangeSpec = { op: change.op, section: isSection(change.section) ? change.section : null, body: change.body };
  applyPlaybookChange(current.playbook, spec); // validate before claiming
  const decidedBy = by ?? actorId(actor);
  if (!(await env.store.updateChange(change.companyId, change.id, { status: "kept", decidedBy, decisionNote: note }, true))) {
    throw new GrowthError("This change was already decided");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const program = await env.store.getProgram(change.companyId, change.programId);
    if (!program) throw new GrowthError("The growth program was not found");
    const next = applyPlaybookChange(program.playbook, spec);
    if (await env.store.savePlaybook(change.companyId, change.programId, program.playbookVersion, next)) {
      const version = program.playbookVersion + 1;
      await env.store.insertPlaybookVersion({ programId: change.programId, version, playbook: next, reason: change.reason, experimentId: change.experimentId, createdBy: decidedBy });
      await env.store.updateChange(change.companyId, change.id, { resultVersion: version }, false);
      if (change.experimentId) await env.store.updateExperiment(change.companyId, change.experimentId, null, { playbookDecision: "kept" });
      return version;
    }
  }
  throw new GrowthError("The playbook changed while saving. Reload and try again.");
}

// ── Experiments ─────────────────────────────────────────────────────────────

export async function proposeExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitProposeExperiment(wrappedEnv, actor, params);
}

export async function approveExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitApproveExperiment(wrappedEnv, actor, params);
}

export async function rejectExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitRejectExperiment(wrappedEnv, actor, params);
}

/** A person stops a proposed or running experiment. Tagged posts keep their tag as history. */
export async function abandonExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitAbandonExperiment(wrappedEnv, actor, params);
}

export async function listExperimentsRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitListExperimentsRecord(wrappedEnv, actor, params);
}

/** Experiments a post in this scope can be tagged with (composer select). */
export async function experimentOptions(env: GrowthEnv, companyId: string, scope: ClientScope) {
  const program = await env.store.findProgram(companyId, GROWTH_CHANNEL, scope);
  if (!program) return [];
  return (await env.store.listExperiments(companyId, program.id, OPEN_EXPERIMENTS)).map((e) => ({
    experimentId: e.id,
    hypothesis: e.hypothesis,
    hypothesisType: e.hypothesisType,
    status: e.status,
    arms: e.arms,
  }));
}

export interface TaggablePostRow {
  id: string;
  client_kind?: string | null;
  client_ref?: string | null;
  client_name?: string | null;
  experiment_id?: string | null;
  experiment_arm?: string | null;
}

export interface TagPlan {
  experimentId: string | null;
  arm: "control" | "variant" | null;
  /** The experiment the post leaves (its item row is removed). */
  previous: string | null;
  changed: boolean;
}

// Re-export from kit for backward compatibility
export const experimentStatuses = kitExperimentStatuses;

/**
 * Check a tag before anything is written: the experiment must be proposed or
 * running and belong to the post's scope. `experimentId` null/"" clears it;
 * leaving `experimentId` out keeps the post's experiment (e.g. to switch arm).
 */
export async function planExperimentTag(env: GrowthEnv, companyId: string, post: TaggablePostRow, input: { experimentId?: unknown; arm?: unknown }): Promise<TagPlan | null> {
  if (input.experimentId === undefined && input.arm === undefined) return null;
  const current = post.experiment_id ?? null;
  const rawId = input.experimentId === undefined ? current : input.experimentId;
  if (rawId === null || rawId === "") return { experimentId: null, arm: null, previous: current, changed: current !== null };
  if (typeof rawId !== "string") throw new GrowthError("experimentId must be text");
  const arm = input.arm === undefined ? post.experiment_arm : input.arm;
  if (arm !== "control" && arm !== "variant") throw new GrowthError('arm must be "control" or "variant" when a post is tagged with an experiment');
  const experiment = await env.store.getExperiment(companyId, rawId.trim());
  if (!experiment) throw new GrowthError(`Experiment ${rawId} was not found`);
  if (!OPEN_EXPERIMENTS.includes(experiment.status)) throw new GrowthError(`That experiment is ${experiment.status}; only proposed or running experiments take posts`);
  const program = await env.store.getProgram(companyId, experiment.programId);
  if (!program || !sameClient(programScope(program), scopeOfRow(post))) {
    const label = program ? (program.clientRef ? program.clientName ?? program.clientRef : "own work") : "another scope";
    throw new GrowthError(`That experiment belongs to ${label}; this post is for ${post.client_ref ? post.client_name ?? post.client_ref : "own work"}.`);
  }
  return {
    experimentId: experiment.id,
    arm,
    previous: current && current !== experiment.id ? current : null,
    changed: current !== experiment.id || post.experiment_arm !== arm,
  };
}

export async function writeExperimentTag(env: GrowthEnv, companyId: string, postId: string, plan: TagPlan | null): Promise<void> {
  if (!plan || !plan.changed) return;
  if (plan.previous) await env.store.deleteItem(plan.previous, postId);
  await env.store.setPostExperiment(companyId, postId, plan.experimentId, plan.arm);
  if (plan.experimentId && plan.arm) await env.store.upsertItem(plan.experimentId, plan.arm, postId, null);
}

/** Check and write in one go (tests and callers that already hold the post). */
export async function applyExperimentTag(env: GrowthEnv, companyId: string, post: TaggablePostRow, input: { experimentId?: unknown; arm?: unknown }) {
  const plan = await planExperimentTag(env, companyId, post, input);
  await writeExperimentTag(env, companyId, post.id, plan);
  return { experimentId: plan ? plan.experimentId : post.experiment_id ?? null, arm: plan ? plan.arm : post.experiment_arm ?? null };
}

// ── Measuring (daily job) ───────────────────────────────────────────────────

export async function measureExperiment(env: GrowthEnv, config: SocialConfig, e: Experiment): Promise<"waiting" | "measured" | "skipped"> {
  const wrappedEnv = socialKitEnv(env, config);
  const wrappedWithVerdict = wrapKitEnvForMeasure(wrappedEnv, verdictComment);
  return kitMeasureExperiment(wrappedWithVerdict, e);
}

export async function measureExperimentsJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>, env: GrowthEnv = growthEnv(ctx)) {
  const summary = { experiments: 0, measured: 0, waiting: 0, errors: 0 };
  for (const companyId of await env.store.companiesWithRunningExperiments()) {
    if (!(await socialOn(ctx, companyId))) continue;
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    for (const e of await env.store.runningExperiments(companyId)) {
      summary.experiments += 1;
      try {
        const result = await measureExperiment(env, config, e);
        if (result === "measured") summary.measured += 1;
        else if (result === "waiting") summary.waiting += 1;
      } catch (error) {
        summary.errors += 1;
        ctx.logger.info("Growth measurement failed", { experimentId: e.id, error: errorMessage(error) });
      }
    }
  }
  return summary;
}

// ── Playbook ────────────────────────────────────────────────────────────────

export async function decidePlaybookChange(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitDecidePlaybookChange(wrappedEnv, actor, params);
}

export async function proposePlaybookChange(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitProposePlaybookChange(wrappedEnv, actor, params);
}

/** A person edits the playbook directly: a new version at once. */
export async function savePlaybookRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitSavePlaybookRecord(wrappedEnv, actor, params);
}

/**
 * Load the effective media rule for a scope (own work or client): stored block from playbook text if present, else default.
 * Used by both get-playbook and record-review-verdict to ensure consistent rule resolution.
 * Returns loadError if the playbook could not be loaded (caller decides whether to treat as warning or failure).
 */
export async function effectiveMediaRule(
  env: GrowthEnv,
  companyId: string,
  scope: ClientScope,
): Promise<{ rule: ReturnType<typeof import("@partnersinbiz/pib-plugin-kit").parseMediaRule>; source: "default" | "stored"; loadError?: string }> {
  const { parseMediaRule, DEFAULT_MEDIA_RULE } = await import("@partnersinbiz/pib-plugin-kit");
  try {
    const program = await env.store.findProgram(companyId, GROWTH_CHANNEL, scope);
    if (!program) return { rule: DEFAULT_MEDIA_RULE, source: "default" };
    const mediaRule = parseMediaRule(program.playbook);
    const hasMediaBlock = /```media-rule[^\S\n]*\n([\s\S]*?)```/i.test(program.playbook);
    return { rule: mediaRule, source: hasMediaBlock ? "stored" : "default" };
  } catch (err) {
    return { rule: DEFAULT_MEDIA_RULE, source: "default", loadError: "Playbook could not be loaded, default media rule used" };
  }
}

export async function getPlaybookRecord(env: GrowthEnv, actor: GrowthActor, params: Params, options: { versionText?: boolean } = {}) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  const result = await kitGetPlaybookRecord(wrappedEnv, actor, params, options);
  const resolved = await scopeFromParams(env.ctx, actor.companyId, params);
  const { rule: mediaRule, source: mediaRuleSource } = await effectiveMediaRule(env, actor.companyId, resolved.scope);
  // loadError is ignored here; get-playbook always returns the effective rule, not a verdict
  return { ...result, mediaRule, mediaRuleSource };
}

// ── Program settings and feature questions ─────────────────────────────────

/** People change the program: objective, autopilot, topics and constraints. */
export async function updateProgramRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const wrappedEnv = await wrapKitEnvWithConfig(env, actor.companyId);
  return kitUpdateProgramRecord(wrappedEnv, actor, params);
}

export async function proposeFeatureQuestion(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  if (actor.isAgent && program.autopilot === "off") throw new GrowthError("Growth autopilot is off for this program, so agents do not add feature questions.");
  const op = params.op ?? "add";
  if (op === "retire") {
    const key = reqString(params, "key", 40).toLowerCase();
    const question = program.featureQuestions.find((q) => q.key === key && q.status === "active");
    if (!question) throw new GrowthError(`The program has no active question ${key}`);
    const next = program.featureQuestions.map((q) => (q.key === key ? { ...q, status: "retired" as const, retiredAt: env.now().toISOString() } : q));
    await env.store.updateProgram(actor.companyId, program.id, { featureQuestions: next });
    return { key, status: "retired", active: activeQuestions(next).length };
  }
  if (op !== "add") throw new GrowthError("op must be add or retire");
  const question = normalizeFeatureQuestion(params, program.featureQuestions, actorId(actor), env.now());
  const next = [...program.featureQuestions, question];
  await env.store.updateProgram(actor.companyId, program.id, { featureQuestions: next });
  return {
    ...question,
    active: activeQuestions(next).length,
    max: MAX_ACTIVE_QUESTIONS,
    message: "Added. The daily score-posts job asks it for new posts and backfills posts from the last 90 days (one Jev call per post).",
  };
}

// ── Review ──────────────────────────────────────────────────────────────────

export async function performanceReview(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const periodDays = params.periodDays == null ? 28 : Number(params.periodDays);
  if (!Number.isInteger(periodDays) || periodDays < 7 || periodDays > 90) throw new GrowthError("periodDays must be a whole number from 7 to 90 (default 28)");
  return reviewFor(env, program, periodDays);
}

async function reviewFor(env: GrowthEnv, program: Program, periodDays: number) {
  const companyId = program.companyId;
  const rows = await env.store.scoredPosts(companyId, programScope(program), SCORE_WINDOW, periodDays);
  const postIds = Array.from(new Set(rows.map((r) => r.subjectId)));
  const stored = await env.store.postFeatures(companyId, postIds);
  const byPost = new Map<string, Array<{ key: string; value: string | null; confidence: number }>>();
  for (const f of stored) byPost.set(f.postId, [...(byPost.get(f.postId) ?? []), f]);
  const features = new Map([...byPost.entries()].map(([id, list]) => [id, usableFeatures(list)]));
  // Keep engine posts typed (ReviewPost with subjectId) for topAndBottom, liftsByFeature, withLift and summary counts
  const enginePosts = reviewPosts(rows, features);
  const toOut = ({ subjectId, ...rest }: ReviewPost) => ({ ...rest, postId: subjectId });
  const { top, bottom } = topAndBottom(enginePosts, 5);
  const lifts = liftsByFeature(enginePosts, 3);
  const [open, pending] = await Promise.all([
    env.store.listExperiments(companyId, program.id, OPEN_EXPERIMENTS),
    env.store.listChanges(companyId, program.id, "pending"),
  ]);
  const experiments = [];
  for (const e of open) experiments.push(experimentOut(e, await armCounts(env, e)));
  const withLift = enginePosts.filter((p) => p.lift !== null);
  const notes: string[] = [];
  if (rows.length === 0) notes.push("No 7-day scores yet. Posts are scored once they are 7 days old on platforms that report reach, impressions or views.");
  else if (withLift.length < rows.length / 2) notes.push(`Only ${withLift.length} of ${enginePosts.length} posts have a lift: an account needs ${BASELINE_MIN}+ earlier scored posts in 30 days for a baseline.`);
  return {
    program: programOut(program),
    periodDays,
    summary: {
      postsScored: enginePosts.length,
      postsWithLift: withLift.length,
      medianLift: postLift(withLift.map((p) => p.lift)),
    },
    top: top.map(toOut),
    bottom: bottom.map(toOut),
    featureLifts: lifts,
    runningExperiments: experiments.filter((e) => e.status === "running"),
    proposedExperiments: experiments.filter((e) => e.status === "proposed"),
    pendingChanges: pending.map(changeOut),
    rankedHypothesisTypes: rankedHypotheses({ ...programCtx(program), scoreboard: program.scoreboard }, { running: open.map((e) => e.hypothesisType), lifts }, 12),
    featureQuestions: {
      builtIn: [...CODE_FEATURES, ...jevFeatureKeys({ topics: programCtx(program).topics, featureQuestions: [] })],
      custom: activeQuestions(program.featureQuestions),
      slotsLeft: MAX_ACTIVE_QUESTIONS - activeQuestions(program.featureQuestions).length,
    },
    notes,
  };
}

/** Everything the Growth tab shows for one scope. */
export async function growthSnapshot(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const periodDays = params.periodDays == null ? 28 : Math.min(90, Math.max(7, Number(params.periodDays) || 28));
  const [review, versions, changes, experiments, config] = await Promise.all([
    reviewFor(env, program, periodDays),
    env.store.listPlaybookVersions(program.id, 10),
    env.store.listChanges(actor.companyId, program.id),
    env.store.listExperiments(actor.companyId, program.id),
    loadSocialConfig(env.ctx, actor.companyId),
  ]);
  const experimentRows = [];
  for (const e of experiments.slice(0, 50)) experimentRows.push(experimentOut(e, OPEN_EXPERIMENTS.includes(e.status) ? await armCounts(env, e) : undefined));
  return {
    ...review,
    playbook: program.playbook,
    versions: versions.map((v) => ({ version: v.version, reason: v.reason, experimentId: v.experimentId, createdBy: v.createdBy, createdAt: v.createdAt, playbook: v.playbook })),
    changes: changes.slice(0, 30).map(changeOut),
    experiments: experimentRows,
    jevConfigured: jevKeySet(config.raw),
    canDecide: !actor.isAgent,
  };
}

// ── Scoring and feature tags (daily job) ────────────────────────────────────

interface ScoreValues {
  engagementRate: number;
  baselineMedian: number | null;
  baselineN: number;
  lift: number | null;
  programId: string | null;
}

function sameScore(a: ScoreValues, b: ScoreValues): boolean {
  const close = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) < 1e-9);
  return close(a.engagementRate, b.engagementRate) && close(a.baselineMedian, b.baselineMedian) && a.baselineN === b.baselineN && close(a.lift, b.lift) && a.programId === b.programId;
}

function scopeKey(scope: ClientScope): string {
  return scope ? formatClientParam(scope) : "own";
}

export async function scoreCompany(env: GrowthEnv, config: SocialConfig) {
  const companyId = config.companyId;
  const rows = await env.store.metricRows(companyId, SCORE_WINDOW, 75);
  // Build engine rows with a typed map: convert postId (database) to subjectId (engine)
  const engineRows = rows.map(({ postId, ...rest }) => ({ ...rest, subjectId: postId }));
  const scores = scoreDestinations(engineRows, { now: env.now(), sinceDays: 45 });
  const existing = await env.store.existingScores(companyId, SCORE_WINDOW, 75);
  const programs = new Map<string, Program>();
  const byDestination = new Map(rows.map((r) => [r.destinationId, r]));
  let written = 0;
  for (const s of scores) {
    const row = byDestination.get(s.destinationId)!;
    const target = targetOfRow({ client_kind: row.clientKind, client_ref: row.clientRef, client_name: row.clientName });
    const key = scopeKey(target.scope);
    if (!programs.has(key)) programs.set(key, await ensureProgram(env, companyId, target));
    const programId = programs.get(key)!.id;
    const prev = existing.get(s.destinationId);
    if (prev && sameScore(prev, { engagementRate: s.engagementRate, baselineMedian: s.baselineMedian, baselineN: s.baselineN, lift: s.lift, programId })) continue;
    await env.store.upsertScore({
      destinationId: s.destinationId,
      window: SCORE_WINDOW,
      companyId,
      postId: s.subjectId,
      accountId: s.accountId,
      platform: s.platform,
      programId,
      clientKind: target.scope?.kind ?? null,
      clientRef: target.scope?.id ?? null,
      engagementRate: s.engagementRate,
      basis: s.basis,
      baselineMedian: s.baselineMedian,
      baselineN: s.baselineN,
      lift: s.lift,
      publishedAt: s.publishedAt,
    });
    written += 1;
  }
  return { snapshots: rows.length, scored: scores.length, written };
}

/** Tag published posts: code features for free, the rest with one Jev call per post (only the questions it lacks). */
export async function tagCompany(env: GrowthEnv, config: SocialConfig, options: { maxCalls?: number; jev?: DecisionClientConfig | null } = {}) {
  const companyId = config.companyId;
  const jev = options.jev !== undefined ? options.jev : jevKeySet(config.raw) ? await jevConfigFor(env.ctx, config) : null;
  const posts = await env.store.postsToTag(companyId, 90, 300);
  const programs = new Map<string, Program>();
  const queue: Array<{ postId: string; body: string; program: Program; missing: string[] }> = [];
  let code = 0;
  for (const post of posts) {
    const target = targetOfRow({ client_kind: post.clientKind, client_ref: post.clientRef, client_name: post.clientName });
    const key = scopeKey(target.scope);
    if (!programs.has(key)) programs.set(key, await ensureProgram(env, companyId, target));
    const program = programs.get(key)!;
    const have = new Set(post.featureKeys);
    const codeValues = codeFeatures(post, config.timezone).filter((f) => !have.has(f.key));
    if (codeValues.length) {
      await env.store.upsertFeatures(companyId, program.id, post.id, codeValues, null);
      code += 1;
    }
    const missing = jevFeatureKeys(programCtx(program)).filter((k) => !have.has(k));
    if (jev && missing.length && post.body.trim()) queue.push({ postId: post.id, body: post.body, program, missing });
  }
  const batch = queue.slice(0, options.maxCalls ?? 100);
  const results = await decideMany(batch, 4, (job) =>
    decide(env.ctx, companyId, {
      config: jev,
      purpose: FEATURE_PURPOSE,
      subject: { kind: "post", id: job.postId },
      state: captionState(job.body),
      questions: featureQuestionsFor(programCtx(job.program), job.missing),
      fetchImpl: env.fetchImpl,
    }),
  );
  let tagged = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const job = batch[i]!;
    await env.store.upsertFeatures(companyId, job.program.id, job.postId, featureValuesFrom(programCtx(job.program), result.answers, result.ids), result.model);
    tagged += 1;
  }
  return { posts: posts.length, codeTagged: code, jevTagged: tagged, jevWaiting: queue.length - tagged, jev: Boolean(jev) };
}

export async function scorePostsJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>, env: GrowthEnv = growthEnv(ctx)) {
  const summary = { companies: 0, written: 0, jevTagged: 0, codeTagged: 0, errors: 0 };
  for (const companyId of await env.store.companiesWithMetrics(SCORE_WINDOW, 75)) {
    if (!(await socialOn(ctx, companyId))) continue;
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    summary.companies += 1;
    try {
      summary.written += (await scoreCompany(env, config)).written;
      const tags = await tagCompany(env, config);
      summary.jevTagged += tags.jevTagged;
      summary.codeTagged += tags.codeTagged;
    } catch (error) {
      summary.errors += 1;
      ctx.logger.info("Growth scoring failed", { companyId, error: errorMessage(error) });
    }
  }
  return summary;
}
