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
import { decide, decideMany, recordVerdict, starterPlaybook, type ClientScope, type DecisionClientConfig } from "@partnersinbiz/pib-plugin-kit";
import { formatClientParam, sameClient, scopeFromParams, scopeOfRow, type ResolvedScope } from "../clients.js";
import { loadSocialConfig, type SocialConfig } from "../config.js";
import { createIssueSafely, ORIGIN_KIND, socialProjectId } from "../issues.js";
import { socialOn } from "../modules.js";
import { socialPath } from "../oauth/flow.js";
import { jevConfigFor, jevKeySet } from "../triage.js";
import { approvalIssueDescription, approvalIssueTitle, changeLines, experimentLines, verdictComment } from "./copy.js";
import * as E from "./engine.js";
import { sqlGrowthStore } from "./sql.js";
import type { Experiment, ExperimentPost, GrowthStore, PlaybookChange, Program, ProgramConstraints } from "./store.js";

export interface GrowthEnv {
  ctx: PluginContext;
  store: GrowthStore;
  now: () => Date;
  fetchImpl?: typeof fetch;
}

export function growthEnv(ctx: PluginContext, store: GrowthStore = sqlGrowthStore(ctx)): GrowthEnv {
  return { ctx, store, now: () => new Date() };
}

/** Who acts (the plugin Viewer fits). */
export interface GrowthActor {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  isAgent: boolean;
}

type Params = Record<string, unknown>;

const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const OPEN_EXPERIMENTS: Experiment["status"][] = ["proposed", "running"];

function actorId(a: GrowthActor): string {
  return a.isAgent ? `agent:${a.agentId ?? "unknown"}` : `user:${a.userId ?? "unknown"}`;
}

function actorLabel(a: GrowthActor): string {
  return a.isAgent ? "the Social agent" : "a person";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reqString(params: Params, key: string, max = 2000): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new E.GrowthError(`${key} is required`);
  if (value.trim().length > max) throw new E.GrowthError(`${key} is longer than ${max} characters`);
  return value.trim();
}

function optString(params: Params, key: string, max = 2000): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new E.GrowthError(`${key} must be text`);
  return value.trim().slice(0, max) || undefined;
}

function requirePerson(actor: GrowthActor, what: string): string {
  if (actor.isAgent || !actor.userId) throw new E.GrowthError(`A person must ${what}`);
  return actor.userId;
}

// ── Programs ────────────────────────────────────────────────────────────────

export interface ProgramTarget {
  scope: ClientScope;
  name: string | null;
}

export function targetOfResolved(r: ResolvedScope): ProgramTarget {
  return { scope: r.scope, name: r.client?.name ?? null };
}

export function targetOfRow(row: { client_kind?: string | null; client_ref?: string | null; client_name?: string | null }): ProgramTarget {
  return { scope: scopeOfRow(row), name: row.client_ref ? row.client_name ?? null : null };
}

function starter(target: ProgramTarget): string {
  const title = target.scope ? `${target.name ?? target.scope.id} social` : "PiB social";
  return starterPlaybook(title).replace("(what we optimise, in one sentence)", E.DEFAULT_OBJECTIVE);
}

/** The program for a scope, created on first use with the kit starter playbook. */
export async function ensureProgram(env: GrowthEnv, companyId: string, target: ProgramTarget): Promise<Program> {
  const found = await env.store.findProgram(companyId, E.GROWTH_CHANNEL, target.scope);
  if (found) {
    if (target.scope && target.name && found.clientName !== target.name) await env.store.updateProgram(companyId, found.id, { clientName: target.name });
    return found;
  }
  const id = randomUUID();
  const playbook = starter(target);
  await env.store.insertProgram({
    id,
    companyId,
    clientKind: target.scope?.kind ?? null,
    clientRef: target.scope?.id ?? null,
    clientName: target.scope ? target.name : null,
    channel: E.GROWTH_CHANNEL,
    objective: E.DEFAULT_OBJECTIVE,
    metric: E.DEFAULT_METRIC,
    constraints: {},
    playbook,
    playbookVersion: 1,
    autopilot: "safe",
    scoreboard: {},
    featureQuestions: [],
    ownerUserId: null,
  });
  const created = await env.store.findProgram(companyId, E.GROWTH_CHANNEL, target.scope);
  if (!created) throw new E.GrowthError("The growth program could not be created");
  if (created.id === id) {
    await env.store.insertPlaybookVersion({ programId: id, version: 1, playbook, reason: "Starter playbook", experimentId: null, createdBy: null });
  }
  return created;
}

/** The program named by `client` / `clientKind` + `clientRef` (own work when left out). Unknown clients are refused. */
export async function programForParams(env: GrowthEnv, actor: GrowthActor, params: Params): Promise<Program> {
  const resolved = await scopeFromParams(env.ctx, actor.companyId, params);
  return ensureProgram(env, actor.companyId, targetOfResolved(resolved));
}

function programScope(program: Pick<Program, "clientKind" | "clientRef">): ClientScope {
  return program.clientRef ? { kind: program.clientKind ?? "company", id: program.clientRef } : null;
}

function programCtx(program: Program): E.ProgramFeatureContext {
  return { topics: Array.isArray(program.constraints.topics) ? program.constraints.topics : [], featureQuestions: program.featureQuestions };
}

export function programOut(program: Program) {
  const scope = programScope(program);
  return {
    programId: program.id,
    client: scope ? formatClientParam(scope) : null,
    clientName: program.clientRef ? program.clientName : null,
    objective: program.objective,
    metric: program.metric,
    autopilot: program.autopilot,
    topics: programCtx(program).topics,
    brandVoice: program.constraints.brandVoice ?? null,
    platforms: program.constraints.platforms ?? null,
    cadence: program.constraints.cadence ?? null,
    playbookVersion: program.playbookVersion,
    scoreboard: program.scoreboard,
    featureQuestions: E.activeQuestions(program.featureQuestions),
    ownerUserId: program.ownerUserId,
  };
}

// ── Issues ──────────────────────────────────────────────────────────────────

async function comment(env: GrowthEnv, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await env.ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    env.ctx.logger.info("Growth issue comment failed", { issueId, error: errorMessage(error) });
  }
}

async function issueOpen(env: GrowthEnv, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await env.ctx.issues.get(issueId, companyId);
    return Boolean(issue && OPEN_ISSUE.has(String(issue.status)));
  } catch {
    return false;
  }
}

async function defaultPerson(env: GrowthEnv, companyId: string): Promise<string | undefined> {
  try {
    return (await env.ctx.companies.get(companyId))?.defaultResponsibleUserId ?? undefined;
  } catch {
    return undefined;
  }
}

/** This week's approval issue for the program: comment on it, or open it. */
async function announce(env: GrowthEnv, config: SocialConfig, program: Program, lines: string[]): Promise<string | null> {
  const companyId = program.companyId;
  const week = E.isoWeek(env.now(), config.timezone);
  if (program.approvalIssueId && program.approvalWeek === week && (await issueOpen(env, companyId, program.approvalIssueId))) {
    await comment(env, companyId, program.approvalIssueId, ["New items to decide:", "", ...lines].join("\n"));
    return program.approvalIssueId;
  }
  const scope = programScope(program);
  try {
    const issue = await createIssueSafely(env.ctx, {
      companyId,
      projectId: await socialProjectId(env.ctx, companyId),
      title: approvalIssueTitle(program, week),
      description: approvalIssueDescription(program, lines, await socialPath(env.ctx, companyId, { tab: "growth" }, scope)),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `growth:${program.id}:${week}`,
      assigneeUserId: program.ownerUserId ?? (await defaultPerson(env, companyId)),
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
    await env.ctx.issues.update(issueId, { status: "done" }, companyId);
  } catch (error) {
    env.ctx.logger.info("Growth approval issue not closed", { issueId, error: errorMessage(error) });
  }
}

// ── Experiments ─────────────────────────────────────────────────────────────

async function armCounts(env: GrowthEnv, e: Experiment) {
  const posts = await env.store.experimentPosts(e.companyId, e.id, E.SCORE_WINDOW);
  const count = (arm: string) => {
    const list = posts.filter((p) => p.arm === arm);
    return { posts: list.length, published: list.filter(published).length, scored: list.filter((p) => E.postLift(p.lifts) !== null).length };
  };
  return { control: count("control"), variant: count("variant") };
}

function published(p: ExperimentPost): boolean {
  return p.status === "published" || p.status === "partially_published";
}

export function experimentOut(e: Experiment, counts?: Awaited<ReturnType<typeof armCounts>>) {
  const outcome = e.outcome ?? {};
  return {
    experimentId: e.id,
    status: e.status,
    hypothesis: e.hypothesis,
    hypothesisType: e.hypothesisType,
    variable: e.variable,
    arms: e.arms,
    minPerArm: e.minPerArm,
    windowDays: e.windowDays,
    proposedBy: e.proposedBy,
    approvalIssueId: e.approvalIssueId,
    approvedAt: e.approvedAt,
    startedAt: e.startedAt,
    measureBy: e.measureAfter,
    measuredAt: e.measuredAt,
    verdict: e.verdict,
    reason: typeof outcome.reason === "string" ? outcome.reason : null,
    relativeChange: typeof outcome.relativeChange === "number" ? outcome.relativeChange : null,
    controlMedian: typeof outcome.controlMedian === "number" ? outcome.controlMedian : null,
    variantMedian: typeof outcome.variantMedian === "number" ? outcome.variantMedian : null,
    playbookDiff: e.playbookDiff,
    playbookDecision: e.playbookDecision,
    note: e.decisionNote,
    counts: counts ?? null,
    createdAt: e.createdAt,
  };
}

async function startExperiment(env: GrowthEnv, e: Experiment, actor: GrowthActor, note: string | undefined): Promise<boolean> {
  const now = env.now();
  return env.store.updateExperiment(e.companyId, e.id, ["proposed"], {
    status: "running",
    approvedAt: now.toISOString(),
    approvedBy: actorId(actor),
    startedAt: now.toISOString(),
    measureAfter: E.addDaysIso(now, E.MEASURE_CUTOFF_DAYS),
    decisionNote: note,
  });
}

export async function proposeExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const input = E.normalizeProposal(params);
  const open = await env.store.listExperiments(actor.companyId, program.id, OPEN_EXPERIMENTS);
  const blocker = E.proposalBlocker({
    autopilot: actor.isAgent ? program.autopilot : program.autopilot === "off" ? "safe" : program.autopilot,
    running: open.filter((e) => e.status === "running").length,
    proposed: open.filter((e) => e.status === "proposed").length,
    openTypes: open.map((e) => e.hypothesisType),
    hypothesisType: input.hypothesisType,
  });
  if (blocker) throw new E.GrowthError(blocker);
  const id = randomUUID();
  await env.store.insertExperiment({
    id,
    companyId: actor.companyId,
    programId: program.id,
    hypothesis: input.hypothesis,
    hypothesisType: input.hypothesisType,
    variable: input.variable,
    arms: input.arms,
    metric: program.metric,
    minPerArm: input.minPerArm,
    windowDays: input.windowDays,
    status: "proposed",
    proposedBy: actorId(actor),
  });
  let e = (await env.store.getExperiment(actor.companyId, id))!;
  let message: string;
  if (program.autopilot === "full") {
    await startExperiment(env, e, actor, "Started on full autopilot");
    message = "Full autopilot: the experiment is running. Tag this week's posts with experimentId and arm (control/variant).";
  } else {
    const config = await loadSocialConfig(env.ctx, actor.companyId);
    const issueId = await announce(env, config, program, experimentLines(e));
    if (issueId) await env.store.updateExperiment(actor.companyId, id, null, { approvalIssueId: issueId });
    message = "Waiting for a person to approve it (it is on this week's approval issue). You can already tag draft posts with experimentId and arm; they count once it is approved.";
  }
  e = (await env.store.getExperiment(actor.companyId, id))!;
  return { ...experimentOut(e), message };
}

async function requireExperiment(env: GrowthEnv, companyId: string, id: string): Promise<{ experiment: Experiment; program: Program }> {
  const experiment = await env.store.getExperiment(companyId, id);
  if (!experiment) throw new E.GrowthError(`Experiment ${id} was not found`);
  const program = await env.store.getProgram(companyId, experiment.programId);
  if (!program) throw new E.GrowthError("The experiment's program was not found");
  return { experiment, program };
}

export async function approveExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const { experiment, program } = await requireExperiment(env, actor.companyId, reqString(params, "experimentId"));
  if (experiment.status !== "proposed") throw new E.GrowthError(`This experiment is already ${experiment.status}`);
  if (actor.isAgent && !E.agentMayDecide(program.autopilot)) {
    throw new E.GrowthError("Only a person approves experiments unless the program's autopilot is full. Leave it on the approval issue.");
  }
  const running = await env.store.listExperiments(actor.companyId, program.id, ["running"]);
  if (running.length >= E.MAX_RUNNING) throw new E.GrowthError(`${E.MAX_RUNNING} experiments are already running for ${program.clientName ?? "own work"}. Wait for one to be measured, or abandon one.`);
  const note = optString(params, "note", 1000);
  if (!(await startExperiment(env, experiment, actor, note))) throw new E.GrowthError("The experiment changed while you were deciding. Reload and try again.");
  await comment(env, actor.companyId, experiment.approvalIssueId, `Approved by ${actorLabel(actor)}: ${experiment.hypothesis}${note ? ` — ${note}` : ""}`);
  await closeIfDecided(env, actor.companyId, program.id, experiment.approvalIssueId);
  return { ...experimentOut((await env.store.getExperiment(actor.companyId, experiment.id))!), message: "Running. Tag posts with experimentId and arm; it is measured once each arm has its 7-day scores (or after 21 days)." };
}

async function clearTags(env: GrowthEnv, e: Experiment): Promise<number> {
  const posts = await env.store.experimentPosts(e.companyId, e.id, E.SCORE_WINDOW);
  for (const p of posts) {
    await env.store.setPostExperiment(e.companyId, p.postId, null, null);
    await env.store.deleteItem(e.id, p.postId);
  }
  return posts.length;
}

export async function rejectExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const { experiment, program } = await requireExperiment(env, actor.companyId, reqString(params, "experimentId"));
  if (experiment.status !== "proposed") throw new E.GrowthError(`This experiment is already ${experiment.status}`);
  if (actor.isAgent && !E.agentMayDecide(program.autopilot)) throw new E.GrowthError("Only a person rejects experiments unless the program's autopilot is full.");
  const reason = reqString(params, "reason", 1000);
  if (!(await env.store.updateExperiment(actor.companyId, experiment.id, ["proposed"], { status: "rejected", decisionNote: reason }))) {
    throw new E.GrowthError("The experiment changed while you were deciding. Reload and try again.");
  }
  const untagged = await clearTags(env, experiment);
  await comment(env, actor.companyId, experiment.approvalIssueId, `Rejected by ${actorLabel(actor)}: ${experiment.hypothesis} — ${reason}`);
  await closeIfDecided(env, actor.companyId, program.id, experiment.approvalIssueId);
  return { experimentId: experiment.id, status: "rejected", untaggedPosts: untagged };
}

/** A person stops a proposed or running experiment. Tagged posts keep their tag as history. */
export async function abandonExperiment(env: GrowthEnv, actor: GrowthActor, params: Params) {
  requirePerson(actor, "abandon an experiment");
  const { experiment, program } = await requireExperiment(env, actor.companyId, reqString(params, "experimentId"));
  if (!OPEN_EXPERIMENTS.includes(experiment.status)) throw new E.GrowthError(`This experiment is already ${experiment.status}`);
  const reason = optString(params, "reason", 1000) ?? "Abandoned by a person";
  if (!(await env.store.updateExperiment(actor.companyId, experiment.id, OPEN_EXPERIMENTS, { status: "abandoned", decisionNote: reason }))) {
    throw new E.GrowthError("The experiment changed while you were deciding. Reload and try again.");
  }
  await closeIfDecided(env, actor.companyId, program.id, experiment.approvalIssueId);
  return { experimentId: experiment.id, status: "abandoned" };
}

export async function listExperimentsRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const status = optString(params, "status");
  const statuses = status ? (status.split(",").map((s) => s.trim()) as Experiment["status"][]) : undefined;
  const list = await env.store.listExperiments(actor.companyId, program.id, statuses);
  const out = [];
  for (const e of list.slice(0, 50)) out.push(experimentOut(e, OPEN_EXPERIMENTS.includes(e.status) ? await armCounts(env, e) : undefined));
  return { programId: program.id, client: programOut(program).client, scoreboard: program.scoreboard, experiments: out };
}

/** Experiments a post in this scope can be tagged with (composer select). */
export async function experimentOptions(env: GrowthEnv, companyId: string, scope: ClientScope) {
  const program = await env.store.findProgram(companyId, E.GROWTH_CHANNEL, scope);
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
  if (typeof rawId !== "string") throw new E.GrowthError("experimentId must be text");
  const arm = input.arm === undefined ? post.experiment_arm : input.arm;
  if (arm !== "control" && arm !== "variant") throw new E.GrowthError('arm must be "control" or "variant" when a post is tagged with an experiment');
  const experiment = await env.store.getExperiment(companyId, rawId.trim());
  if (!experiment) throw new E.GrowthError(`Experiment ${rawId} was not found`);
  if (!OPEN_EXPERIMENTS.includes(experiment.status)) throw new E.GrowthError(`That experiment is ${experiment.status}; only proposed or running experiments take posts`);
  const program = await env.store.getProgram(companyId, experiment.programId);
  if (!program || !sameClient(programScope(program), scopeOfRow(post))) {
    const label = program ? (program.clientRef ? program.clientName ?? program.clientRef : "own work") : "another scope";
    throw new E.GrowthError(`That experiment belongs to ${label}; this post is for ${post.client_ref ? post.client_name ?? post.client_ref : "own work"}.`);
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

async function syncItems(env: GrowthEnv, e: Experiment, items: E.ItemState[]): Promise<void> {
  const stored = new Map((await env.store.listItems(e.id)).map((i) => [i.postId, i]));
  for (const item of items) {
    const prev = stored.get(item.postId);
    if (!prev || prev.arm !== item.arm || prev.value !== item.value) await env.store.upsertItem(e.id, item.arm, item.postId, item.value);
    stored.delete(item.postId);
  }
  for (const postId of stored.keys()) await env.store.deleteItem(e.id, postId);
}

export async function measureExperiment(env: GrowthEnv, config: SocialConfig, e: Experiment): Promise<"waiting" | "measured" | "skipped"> {
  const now = env.now();
  const posts = await env.store.experimentPosts(e.companyId, e.id, E.SCORE_WINDOW);
  const items: E.ItemState[] = posts
    .filter((p) => p.arm === "control" || p.arm === "variant")
    .map((p) => ({ postId: p.postId, arm: p.arm!, published: published(p), value: E.postLift(p.lifts) }));
  await syncItems(env, e, items);
  const ready = E.readiness(e, items, now);
  if (!ready.ready) return "waiting";
  const program = await env.store.getProgram(e.companyId, e.programId);
  if (!program) return "skipped";
  const outcome = E.measureArms(e, items, ready.reason);
  const change = E.playbookChangeFor(e, outcome, E.localDate(now, config.timezone));
  const diff = change ? E.changeDiff(change) : undefined;
  const ok = await env.store.updateExperiment(e.companyId, e.id, ["running"], {
    status: "measured",
    measuredAt: now.toISOString(),
    verdict: outcome.verdict,
    outcome: { ...outcome },
    playbookDiff: diff,
    playbookDecision: change ? "pending" : undefined,
  });
  if (!ok) return "skipped";
  await env.store.updateProgram(e.companyId, program.id, { scoreboard: recordVerdict(program.scoreboard, e.hypothesisType, outcome.verdict) });
  let kept = false;
  if (change) {
    const changeId = randomUUID();
    await env.store.insertChange({
      id: changeId,
      companyId: e.companyId,
      programId: program.id,
      experimentId: e.id,
      op: change.op,
      section: change.section,
      body: change.body,
      diff: diff!,
      reason: `Experiment ${outcome.verdict}: ${e.hypothesis}`,
      baseVersion: program.playbookVersion,
      proposedBy: "experiment",
    });
    const row = (await env.store.getChange(e.companyId, changeId))!;
    if (E.autoKeep(program.autopilot, outcome.verdict)) {
      await keepChange(env, { companyId: e.companyId, userId: null, agentId: null, isAgent: true }, row, "Kept automatically (full autopilot)", "autopilot");
      kept = true;
    } else if (program.autopilot !== "full") {
      const fresh = (await env.store.getProgram(e.companyId, program.id)) ?? program;
      const issueId = await announce(env, config, fresh, [verdictComment(e, outcome.verdict, outcome.reason, null, false), "", ...changeLines(row)]);
      if (issueId) await env.store.updateChange(e.companyId, changeId, { approvalIssueId: issueId }, false);
    }
  }
  if (!change || kept) {
    await comment(env, e.companyId, e.approvalIssueId, verdictComment(e, outcome.verdict, outcome.reason, diff ?? null, kept));
  }
  return "measured";
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

function changeSpec(c: PlaybookChange): E.ChangeSpec {
  return { op: c.op, section: E.isSection(c.section) ? c.section : null, body: c.body };
}

export function changeOut(c: PlaybookChange) {
  return {
    changeId: c.id,
    status: c.status,
    op: c.op,
    section: c.section,
    text: c.op === "replace" ? null : c.body,
    diff: c.diff,
    reason: c.reason,
    experimentId: c.experimentId,
    baseVersion: c.baseVersion,
    resultVersion: c.resultVersion,
    proposedBy: c.proposedBy,
    decidedBy: c.decidedBy,
    decidedAt: c.decidedAt,
    note: c.decisionNote,
    createdAt: c.createdAt,
  };
}

/** Write a new playbook version (guarded by the version it was based on). */
async function writePlaybook(env: GrowthEnv, companyId: string, programId: string, edit: (playbook: string) => string, meta: { reason: string; experimentId: string | null; createdBy: string }): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const program = await env.store.getProgram(companyId, programId);
    if (!program) throw new E.GrowthError("The growth program was not found");
    const next = edit(program.playbook);
    if (await env.store.savePlaybook(companyId, programId, program.playbookVersion, next)) {
      const version = program.playbookVersion + 1;
      await env.store.insertPlaybookVersion({ programId, version, playbook: next, reason: meta.reason, experimentId: meta.experimentId, createdBy: meta.createdBy });
      return version;
    }
  }
  throw new E.GrowthError("The playbook changed while saving. Reload and try again.");
}

async function keepChange(env: GrowthEnv, actor: GrowthActor, change: PlaybookChange, note: string | undefined, by?: string): Promise<number> {
  const current = await env.store.getProgram(change.companyId, change.programId);
  if (!current) throw new E.GrowthError("The growth program was not found");
  const spec = changeSpec(change);
  E.applyPlaybookChange(current.playbook, spec); // validate before claiming
  const decidedBy = by ?? actorId(actor);
  if (!(await env.store.updateChange(change.companyId, change.id, { status: "kept", decidedBy, decisionNote: note }, true))) {
    throw new E.GrowthError("This change was already decided");
  }
  const version = await writePlaybook(env, change.companyId, change.programId, (playbook) => E.applyPlaybookChange(playbook, spec), {
    reason: change.reason,
    experimentId: change.experimentId,
    createdBy: decidedBy,
  });
  await env.store.updateChange(change.companyId, change.id, { resultVersion: version }, false);
  if (change.experimentId) await env.store.updateExperiment(change.companyId, change.experimentId, null, { playbookDecision: "kept" });
  return version;
}

export async function decidePlaybookChange(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const change = await env.store.getChange(actor.companyId, reqString(params, "changeId"));
  if (!change) throw new E.GrowthError("That playbook change was not found");
  if (change.status !== "pending") throw new E.GrowthError(`This change was already ${change.status}`);
  const program = await env.store.getProgram(actor.companyId, change.programId);
  if (!program) throw new E.GrowthError("The growth program was not found");
  if (actor.isAgent && !E.agentMayDecide(program.autopilot)) {
    throw new E.GrowthError("Only a person keeps or discards playbook changes unless the program's autopilot is full. Leave it on the approval issue.");
  }
  const decision = params.decision;
  if (decision !== "keep" && decision !== "discard") throw new E.GrowthError("decision must be keep or discard");
  const note = optString(params, "note", 1000);
  let version: number | null = null;
  if (decision === "keep") {
    version = await keepChange(env, actor, change, note);
  } else {
    if (!(await env.store.updateChange(actor.companyId, change.id, { status: "discarded", decidedBy: actorId(actor), decisionNote: note }, true))) {
      throw new E.GrowthError("This change was already decided");
    }
    if (change.experimentId) await env.store.updateExperiment(actor.companyId, change.experimentId, null, { playbookDecision: "discarded" });
  }
  await comment(env, actor.companyId, change.approvalIssueId, `${decision === "keep" ? `Kept (playbook v${version})` : "Discarded"} by ${actorLabel(actor)}: ${change.diff}${note ? ` — ${note}` : ""}`);
  await closeIfDecided(env, actor.companyId, program.id, change.approvalIssueId);
  return { changeId: change.id, status: decision === "keep" ? "kept" : "discarded", playbookVersion: version ?? program.playbookVersion };
}

export async function proposePlaybookChange(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  if (actor.isAgent && program.autopilot === "off") throw new E.GrowthError("Growth autopilot is off for this program, so agents do not propose playbook changes.");
  const spec = E.normalizeChange(params);
  E.applyPlaybookChange(program.playbook, spec); // refuse a removal that does not match now
  const reason = reqString(params, "reason", 500);
  const pending = await env.store.listChanges(actor.companyId, program.id, "pending");
  if (pending.length >= 10) throw new E.GrowthError("10 playbook changes are already waiting. Wait until they are decided.");
  const id = randomUUID();
  const diff = E.changeDiff(spec, program.playbook);
  await env.store.insertChange({ id, companyId: actor.companyId, programId: program.id, experimentId: null, op: spec.op, section: spec.section, body: spec.body, diff, reason, baseVersion: program.playbookVersion, proposedBy: actorId(actor) });
  const change = (await env.store.getChange(actor.companyId, id))!;
  let message = "Full autopilot: decide it with decide-playbook-change.";
  if (program.autopilot !== "full") {
    const config = await loadSocialConfig(env.ctx, actor.companyId);
    const issueId = await announce(env, config, program, changeLines(change));
    if (issueId) await env.store.updateChange(actor.companyId, id, { approvalIssueId: issueId }, false);
    message = "Waiting for a person to keep or discard it (it is on this week's approval issue).";
  }
  return { ...changeOut((await env.store.getChange(actor.companyId, id))!), message };
}

/** A person edits the playbook directly: a new version at once. */
export async function savePlaybookRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const userId = requirePerson(actor, "edit the playbook");
  const program = await programForParams(env, actor, params);
  const playbook = reqString(params, "playbook", 20_000);
  const reason = optString(params, "reason", 500) ?? "Edited by a person";
  const version = await writePlaybook(env, actor.companyId, program.id, () => `${playbook.trim()}\n`, { reason, experimentId: null, createdBy: `user:${userId}` });
  return { programId: program.id, playbookVersion: version };
}

export async function getPlaybookRecord(env: GrowthEnv, actor: GrowthActor, params: Params, options: { versionText?: boolean } = {}) {
  const program = await programForParams(env, actor, params);
  const [versions, pending] = await Promise.all([
    env.store.listPlaybookVersions(program.id, 10),
    env.store.listChanges(actor.companyId, program.id, "pending"),
  ]);
  return {
    ...programOut(program),
    playbook: program.playbook,
    versions: versions.map((v) => ({ version: v.version, reason: v.reason, experimentId: v.experimentId, createdBy: v.createdBy, createdAt: v.createdAt, ...(options.versionText ? { playbook: v.playbook } : {}) })),
    pendingChanges: pending.map(changeOut),
  };
}

// ── Program settings and feature questions ─────────────────────────────────

function topicList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : null;
  if (!raw) throw new E.GrowthError("topics must be a list (or comma-separated text)");
  const topics = Array.from(new Set(raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)));
  if (topics.length > 30 || topics.some((t) => t.length > 60)) throw new E.GrowthError("Up to 30 topics, 60 characters each");
  return topics;
}

/** People change the program: objective, autopilot, topics and constraints. */
export async function updateProgramRecord(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const userId = requirePerson(actor, "change the growth program");
  const program = await programForParams(env, actor, params);
  const autopilot = params.autopilot;
  if (autopilot !== undefined && !E.AUTOPILOT_MODES.includes(autopilot as E.Autopilot)) throw new E.GrowthError("autopilot must be off, safe or full");
  const topics = topicList(params.topics);
  const constraints: ProgramConstraints = { ...program.constraints };
  if (topics) constraints.topics = topics;
  for (const key of ["brandVoice", "platforms", "cadence"] as const) {
    if (params[key] !== undefined) constraints[key] = optString(params, key, 1000) ?? "";
  }
  await env.store.updateProgram(actor.companyId, program.id, {
    objective: optString(params, "objective", 500),
    autopilot: autopilot as E.Autopilot | undefined,
    constraints,
    ownerUserId: userId,
  });
  return programOut((await env.store.getProgram(actor.companyId, program.id))!);
}

export async function proposeFeatureQuestion(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  if (actor.isAgent && program.autopilot === "off") throw new E.GrowthError("Growth autopilot is off for this program, so agents do not add feature questions.");
  const op = params.op ?? "add";
  if (op === "retire") {
    const key = reqString(params, "key", 40).toLowerCase();
    const question = program.featureQuestions.find((q) => q.key === key && q.status === "active");
    if (!question) throw new E.GrowthError(`The program has no active question ${key}`);
    const next = program.featureQuestions.map((q) => (q.key === key ? { ...q, status: "retired" as const, retiredAt: env.now().toISOString() } : q));
    await env.store.updateProgram(actor.companyId, program.id, { featureQuestions: next });
    return { key, status: "retired", active: E.activeQuestions(next).length };
  }
  if (op !== "add") throw new E.GrowthError("op must be add or retire");
  const question = E.normalizeFeatureQuestion(params, program.featureQuestions, actorId(actor), env.now());
  const next = [...program.featureQuestions, question];
  await env.store.updateProgram(actor.companyId, program.id, { featureQuestions: next });
  return {
    ...question,
    active: E.activeQuestions(next).length,
    max: E.MAX_ACTIVE_QUESTIONS,
    message: "Added. The daily score-posts job asks it for new posts and backfills posts from the last 90 days (one Jev call per post).",
  };
}

// ── Review ──────────────────────────────────────────────────────────────────

export async function performanceReview(env: GrowthEnv, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const periodDays = params.periodDays == null ? 28 : Number(params.periodDays);
  if (!Number.isInteger(periodDays) || periodDays < 7 || periodDays > 90) throw new E.GrowthError("periodDays must be a whole number from 7 to 90 (default 28)");
  return reviewFor(env, program, periodDays);
}

async function reviewFor(env: GrowthEnv, program: Program, periodDays: number) {
  const companyId = program.companyId;
  const rows = await env.store.scoredPosts(companyId, programScope(program), E.SCORE_WINDOW, periodDays);
  const postIds = Array.from(new Set(rows.map((r) => r.postId)));
  const stored = await env.store.postFeatures(companyId, postIds);
  const byPost = new Map<string, Array<{ key: string; value: string | null; confidence: number }>>();
  for (const f of stored) byPost.set(f.postId, [...(byPost.get(f.postId) ?? []), f]);
  const features = new Map([...byPost.entries()].map(([id, list]) => [id, E.usableFeatures(list)]));
  const posts = E.reviewPosts(rows, features);
  const { top, bottom } = E.topAndBottom(posts, 5);
  const lifts = E.liftsByFeature(posts, 3);
  const [open, pending] = await Promise.all([
    env.store.listExperiments(companyId, program.id, OPEN_EXPERIMENTS),
    env.store.listChanges(companyId, program.id, "pending"),
  ]);
  const experiments = [];
  for (const e of open) experiments.push(experimentOut(e, await armCounts(env, e)));
  const withLift = posts.filter((p) => p.lift !== null);
  const notes: string[] = [];
  if (rows.length === 0) notes.push("No 7-day scores yet. Posts are scored once they are 7 days old on platforms that report reach, impressions or views.");
  else if (withLift.length < rows.length / 2) notes.push(`Only ${withLift.length} of ${posts.length} posts have a lift: an account needs ${E.BASELINE_MIN}+ earlier scored posts in 30 days for a baseline.`);
  return {
    program: programOut(program),
    periodDays,
    summary: {
      postsScored: posts.length,
      postsWithLift: withLift.length,
      medianLift: E.postLift(withLift.map((p) => p.lift)),
    },
    top,
    bottom,
    featureLifts: lifts,
    runningExperiments: experiments.filter((e) => e.status === "running"),
    proposedExperiments: experiments.filter((e) => e.status === "proposed"),
    pendingChanges: pending.map(changeOut),
    rankedHypothesisTypes: E.rankedHypotheses({ ...programCtx(program), scoreboard: program.scoreboard }, { running: open.map((e) => e.hypothesisType), lifts }, 12),
    featureQuestions: {
      builtIn: [...E.CODE_FEATURES, ...E.jevFeatureKeys({ topics: programCtx(program).topics, featureQuestions: [] })],
      custom: E.activeQuestions(program.featureQuestions),
      slotsLeft: E.MAX_ACTIVE_QUESTIONS - E.activeQuestions(program.featureQuestions).length,
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
  const rows = await env.store.metricRows(companyId, E.SCORE_WINDOW, 75);
  const byDestination = new Map(rows.map((r) => [r.destinationId, r]));
  const scores = E.scoreDestinations(rows, { now: env.now(), sinceDays: 45 });
  const existing = await env.store.existingScores(companyId, E.SCORE_WINDOW, 75);
  const programs = new Map<string, Program>();
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
      window: E.SCORE_WINDOW,
      companyId,
      postId: s.postId,
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
    const codeValues = E.codeFeatures(post, config.timezone).filter((f) => !have.has(f.key));
    if (codeValues.length) {
      await env.store.upsertFeatures(companyId, program.id, post.id, codeValues, null);
      code += 1;
    }
    const missing = E.jevFeatureKeys(programCtx(program)).filter((k) => !have.has(k));
    if (jev && missing.length && post.body.trim()) queue.push({ postId: post.id, body: post.body, program, missing });
  }
  const batch = queue.slice(0, options.maxCalls ?? 100);
  const results = await decideMany(batch, 4, (job) =>
    decide(env.ctx, companyId, {
      config: jev,
      purpose: E.FEATURE_PURPOSE,
      subject: { kind: "post", id: job.postId },
      state: E.captionState(job.body),
      questions: E.featureQuestionsFor(programCtx(job.program), job.missing),
      fetchImpl: env.fetchImpl,
    }),
  );
  let tagged = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const job = batch[i]!;
    await env.store.upsertFeatures(companyId, job.program.id, job.postId, E.featureValuesFrom(programCtx(job.program), result.answers, result.ids), result.model);
    tagged += 1;
  }
  return { posts: posts.length, codeTagged: code, jevTagged: tagged, jevWaiting: queue.length - tagged, jev: Boolean(jev) };
}

export async function scorePostsJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>, env: GrowthEnv = growthEnv(ctx)) {
  const summary = { companies: 0, written: 0, jevTagged: 0, codeTagged: 0, errors: 0 };
  for (const companyId of await env.store.companiesWithMetrics(E.SCORE_WINDOW, 75)) {
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
