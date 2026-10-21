/**
 * Growth Lab lifecycle service: programs, experiments and the playbook.
 * Re-export by each plugin, with its own specifics (config, paths, copy).
 */
import { randomUUID } from "node:crypto";
import type { ClientScope } from "../client-ref.js";
import * as E from "./engine.js";
import type { ApprovalIssuePort, GrowthStore, ScopeResolver } from "./ports.js";

// Type definitions used across the service
export interface GrowthActor {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  isAgent: boolean;
  isReviewer?: boolean;
}

type Params = Record<string, unknown>;

// Shared pure helpers that can move to kit
export function published(p: any): boolean {
  return p.status === "published" || p.status === "partially_published";
}

export const OPEN_EXPERIMENTS: any[] = ["proposed", "running"];

function actorId(a: GrowthActor): string {
  return a.isAgent ? `agent:${a.agentId ?? "unknown"}` : `user:${a.userId ?? "unknown"}`;
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

export interface ProgramTarget {
  scope: ClientScope;
  name: string | null;
}

export const EXPERIMENT_STATUS_VALUES: any[] = ["proposed", "running", "measured", "rejected", "abandoned"];

/** `status` as a list of statuses, or the older comma-separated text. Unknown values are refused. */
export function experimentStatuses(value: unknown): any[] | undefined {
  if (value == null || value === "") return undefined;
  const list = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",") : null;
  if (!list) throw new E.GrowthError(`status must be a list of: ${EXPERIMENT_STATUS_VALUES.join(", ")}`);
  const out = list.map((s) => s.trim()).filter(Boolean);
  const bad = out.find((s) => !(EXPERIMENT_STATUS_VALUES as string[]).includes(s));
  if (bad) throw new E.GrowthError(`Unknown experiment status "${bad}" (use ${EXPERIMENT_STATUS_VALUES.join(", ")})`);
  return out.length ? (out as any[]) : undefined;
}

// The 12 moved functions - these are the core lifecycle functions
// They take `env` which is expected to have store, now, issues, scopes, ctx, etc.
// The plugin (Social) provides all specifics like configs, copy functions, etc.

export async function ensureProgram(env: any, companyId: string, target: ProgramTarget): Promise<any> {
  const found = await env.store.findProgram(companyId, E.GROWTH_CHANNEL, target.scope);
  if (found) {
    if (target.scope && target.name && found.clientName !== target.name) await env.store.updateProgram(companyId, found.id, { clientName: target.name });
    return found;
  }
  const id = randomUUID();
  const playbook = env.starterPlaybook(target);
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

export async function programForParams(env: any, actor: GrowthActor, params: Params): Promise<any> {
  const resolved = await (env.scopes ?? env.socialScopes(env.ctx)).fromParams(actor.companyId, params);
  return ensureProgram(env, actor.companyId, { scope: resolved.scope, name: resolved.client?.name ?? null });
}

function programScope(program: Pick<any, "clientKind" | "clientRef">): ClientScope {
  return program.clientRef ? { kind: program.clientKind ?? "company", id: program.clientRef } : null;
}

async function comment(env: any, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await env.issuePort(companyId).comment(companyId, issueId, body);
  } catch (error) {
    env.ctx.logger.info("Growth issue comment failed", { issueId, error: errorMessage(error) });
  }
}

async function issueOpen(env: any, companyId: string, issueId: string): Promise<boolean> {
  return env.issuePort(companyId).isOpen(companyId, issueId);
}

async function announce(env: any, program: any, lines: string[]): Promise<string | null> {
  const companyId = program.companyId;
  const tz = typeof env.timezone === "function" ? env.timezone(companyId) : env.timezone;
  const week = E.isoWeek(env.now(), tz);
  if (program.approvalIssueId && program.approvalWeek === week && (await issueOpen(env, companyId, program.approvalIssueId))) {
    await comment(env, companyId, program.approvalIssueId, ["New items to decide:", "", ...lines].join("\n"));
    return program.approvalIssueId;
  }
  const scope = programScope(program);
  try {
    const issue = await env.issuePort(companyId).createApproval(await env.buildApprovalInput(program, week, lines, scope));
    await env.store.updateProgram(companyId, program.id, { approvalIssueId: issue.id, approvalWeek: week });
    program.approvalIssueId = issue.id;
    program.approvalWeek = week;
    return issue.id;
  } catch (error) {
    env.ctx.logger.info("Growth approval issue not created", { programId: program.id, error: errorMessage(error) });
    return null;
  }
}

async function closeIfDecided(env: any, companyId: string, programId: string, issueId: string | null): Promise<void> {
  if (!issueId) return;
  const [proposals, changes] = await Promise.all([
    env.store.listExperiments(companyId, programId, ["proposed"]),
    env.store.listChanges(companyId, programId, "pending"),
  ]);
  if (proposals.some((e: any) => e.approvalIssueId === issueId) || changes.some((c: any) => c.approvalIssueId === issueId)) return;
  if (!(await issueOpen(env, companyId, issueId))) return;
  await comment(env, companyId, issueId, "Everything on this issue has been decided.");
  try {
    await env.issuePort(companyId).setStatus(companyId, issueId, "done");
  } catch (error) {
    env.ctx.logger.info("Growth approval issue not closed", { issueId, error: errorMessage(error) });
  }
}

async function armCounts(env: any, e: any) {
  const posts = await env.store.experimentPosts(e.companyId, e.id, E.SCORE_WINDOW);
  const count = (arm: string) => {
    const list = posts.filter((p: any) => p.arm === arm);
    return { posts: list.length, published: list.filter(published).length, scored: list.filter((p: any) => E.postLift(p.lifts) !== null).length };
  };
  return { control: count("control"), variant: count("variant") };
}

async function startExperiment(env: any, e: any, actor: GrowthActor, note: string | undefined): Promise<boolean> {
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

export async function proposeExperiment(env: any, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const input = E.normalizeProposal(params);
  const open = await env.store.listExperiments(actor.companyId, program.id, OPEN_EXPERIMENTS);
  const blocker = E.proposalBlocker({
    autopilot: actor.isAgent ? program.autopilot : program.autopilot === "off" ? "safe" : program.autopilot,
    running: open.filter((e: any) => e.status === "running").length,
    proposed: open.filter((e: any) => e.status === "proposed").length,
    openTypes: open.map((e: any) => e.hypothesisType),
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
    const issueId = await announce(env, program, env.experimentLines(e));
    if (issueId) await env.store.updateExperiment(actor.companyId, id, null, { approvalIssueId: issueId });
    message = "Waiting for a person to approve it (it is on this week's approval issue). You can already tag draft posts with experimentId and arm; they count once it is approved.";
  }
  e = (await env.store.getExperiment(actor.companyId, id))!;
  return { ...env.experimentOut(e), message };
}

async function requireExperiment(env: any, companyId: string, id: string): Promise<{ experiment: any; program: any }> {
  const experiment = await env.store.getExperiment(companyId, id);
  if (!experiment) throw new E.GrowthError(`Experiment ${id} was not found`);
  const program = await env.store.getProgram(companyId, experiment.programId);
  if (!program) throw new E.GrowthError("The experiment's program was not found");
  return { experiment, program };
}

export async function approveExperiment(env: any, actor: GrowthActor, params: Params) {
  const { experiment, program } = await requireExperiment(env, actor.companyId, reqString(params, "experimentId"));
  if (experiment.status !== "proposed") throw new E.GrowthError(`This experiment is already ${experiment.status}`);
  if (!E.mayDecide(program.autopilot, actor, "experiment")) {
    throw new E.GrowthError("Only a person approves experiments unless the program's autopilot is full. Leave it on the approval issue.");
  }
  const running = await env.store.listExperiments(actor.companyId, program.id, ["running"]);
  if (running.length >= E.MAX_RUNNING) throw new E.GrowthError(`${E.MAX_RUNNING} experiments are already running for ${program.clientName ?? "own work"}. Wait for one to be measured, or abandon one.`);
  const note = optString(params, "note", 1000);
  if (!(await startExperiment(env, experiment, actor, note))) throw new E.GrowthError("The experiment changed while you were deciding. Reload and try again.");
  await comment(env, actor.companyId, experiment.approvalIssueId, `Approved by ${env.actorLabel(actor)}: ${experiment.hypothesis}${note ? ` — ${note}` : ""}`);
  await closeIfDecided(env, actor.companyId, program.id, experiment.approvalIssueId);
  return { ...env.experimentOut((await env.store.getExperiment(actor.companyId, experiment.id))!), message: "Running. Tag posts with experimentId and arm; it is measured once each arm has its 7-day scores (or after 21 days)." };
}

async function clearTags(env: any, e: any): Promise<number> {
  const posts = await env.store.experimentPosts(e.companyId, e.id, E.SCORE_WINDOW);
  for (const p of posts) {
    await env.store.setPostExperiment(e.companyId, p.postId, null, null);
    await env.store.deleteItem(e.id, p.postId);
  }
  return posts.length;
}

export async function rejectExperiment(env: any, actor: GrowthActor, params: Params) {
  const { experiment, program } = await requireExperiment(env, actor.companyId, reqString(params, "experimentId"));
  if (experiment.status !== "proposed") throw new E.GrowthError(`This experiment is already ${experiment.status}`);
  if (!E.mayDecide(program.autopilot, actor, "experiment")) throw new E.GrowthError("Only a person rejects experiments unless the program's autopilot is full.");
  const reason = reqString(params, "reason", 1000);
  if (!(await env.store.updateExperiment(actor.companyId, experiment.id, ["proposed"], { status: "rejected", decisionNote: reason }))) {
    throw new E.GrowthError("The experiment changed while you were deciding. Reload and try again.");
  }
  const untagged = await clearTags(env, experiment);
  await comment(env, actor.companyId, experiment.approvalIssueId, `Rejected by ${env.actorLabel(actor)}: ${experiment.hypothesis} — ${reason}`);
  await closeIfDecided(env, actor.companyId, program.id, experiment.approvalIssueId);
  return { experimentId: experiment.id, status: "rejected", untaggedPosts: untagged };
}

/** A person stops a proposed or running experiment. Tagged posts keep their tag as history. */
export async function abandonExperiment(env: any, actor: GrowthActor, params: Params) {
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

export async function listExperimentsRecord(env: any, actor: GrowthActor, params: Params) {
  const program = await programForParams(env, actor, params);
  const statuses = experimentStatuses(params.status);
  const list = await env.store.listExperiments(actor.companyId, program.id, statuses);
  const out = [];
  for (const e of list.slice(0, 50)) out.push(env.experimentOut(e, OPEN_EXPERIMENTS.includes(e.status) ? await armCounts(env, e) : undefined));
  return { programId: program.id, client: env.programOut(program).client, scoreboard: program.scoreboard, experiments: out };
}

function changeSpec(c: any): E.ChangeSpec {
  return { op: c.op, section: E.isSection(c.section) ? c.section : null, body: c.body };
}

async function writePlaybook(env: any, companyId: string, programId: string, edit: (playbook: string) => string, meta: { reason: string; experimentId: string | null; createdBy: string }): Promise<number> {
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

async function keepChange(env: any, actor: GrowthActor, change: any, note: string | undefined, by?: string): Promise<number> {
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

export async function decidePlaybookChange(env: any, actor: GrowthActor, params: Params) {
  const change = await env.store.getChange(actor.companyId, reqString(params, "changeId"));
  if (!change) throw new E.GrowthError("That playbook change was not found");
  if (change.status !== "pending") throw new E.GrowthError(`This change was already ${change.status}`);
  const program = await env.store.getProgram(actor.companyId, change.programId);
  if (!program) throw new E.GrowthError("The growth program was not found");
  if (!E.mayDecide(program.autopilot, actor, "playbookChange")) {
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
  await comment(env, actor.companyId, change.approvalIssueId, `${decision === "keep" ? `Kept (playbook v${version})` : "Discarded"} by ${env.actorLabel(actor)}: ${change.diff}${note ? ` — ${note}` : ""}`);
  await closeIfDecided(env, actor.companyId, program.id, change.approvalIssueId);
  return { changeId: change.id, status: decision === "keep" ? "kept" : "discarded", playbookVersion: version ?? program.playbookVersion };
}

export async function proposePlaybookChange(env: any, actor: GrowthActor, params: Params) {
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
    const issueId = await announce(env, program, env.changeLines(change));
    if (issueId) await env.store.updateChange(actor.companyId, id, { approvalIssueId: issueId }, false);
    message = "Waiting for a person to keep or discard it (it is on this week's approval issue).";
  }
  return { ...env.changeOut(change), message };
}

/** A person edits the playbook directly: a new version at once. */
export async function savePlaybookRecord(env: any, actor: GrowthActor, params: Params) {
  const userId = requirePerson(actor, "edit the playbook");
  const program = await programForParams(env, actor, params);
  const playbook = reqString(params, "playbook", 20_000);
  const reason = optString(params, "reason", 500) ?? "Edited by a person";
  const version = await writePlaybook(env, actor.companyId, program.id, () => `${playbook.trim()}\n`, { reason, experimentId: null, createdBy: `user:${userId}` });
  return { programId: program.id, playbookVersion: version };
}

export async function getPlaybookRecord(env: any, actor: GrowthActor, params: Params, options: { versionText?: boolean } = {}) {
  const program = await programForParams(env, actor, params);
  const [versions, pending] = await Promise.all([
    env.store.listPlaybookVersions(program.id, 10),
    env.store.listChanges(actor.companyId, program.id, "pending"),
  ]);
  return {
    ...env.programOut(program),
    playbook: program.playbook,
    versions: versions.map((v: any) => ({ version: v.version, reason: v.reason, experimentId: v.experimentId, createdBy: v.createdBy, createdAt: v.createdAt, ...(options.versionText ? { playbook: v.playbook } : {}) })),
    pendingChanges: pending.map(env.changeOut),
  };
}

export async function updateProgramRecord(env: any, actor: GrowthActor, params: Params) {
  const userId = requirePerson(actor, "change the growth program");
  const program = await programForParams(env, actor, params);
  const autopilot = params.autopilot;
  if (autopilot !== undefined && !E.AUTOPILOT_MODES.includes(autopilot as E.Autopilot)) throw new E.GrowthError("autopilot must be off, safe, reviewed or full");
  const topics = (() => {
    if (params.topics === undefined) return undefined;
    const raw = Array.isArray(params.topics) ? params.topics : typeof params.topics === "string" ? params.topics.split(/[,\n]/) : null;
    if (!raw) throw new E.GrowthError("topics must be a list (or comma-separated text)");
    const topics = Array.from(new Set(raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)));
    if (topics.length > 30 || topics.some((t) => t.length > 60)) throw new E.GrowthError("Up to 30 topics, 60 characters each");
    return topics;
  })();
  const constraints: any = { ...program.constraints };
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
  return env.programOut((await env.store.getProgram(actor.companyId, program.id))!);
}
