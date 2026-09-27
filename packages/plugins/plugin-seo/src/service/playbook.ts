/**
 * The learned SEO playbook per scope (one CRM client, or Partners in Biz's
 * own sites), shared by every sprint in that scope so what the loop learns
 * carries across sprints for the same client.
 *
 * - The agent reads it (`get-playbook`) before working a sprint's tasks.
 * - A measured win or loss drafts one change (`draftFromMeasurement`); the
 *   agent and people propose more (`propose-playbook-change`).
 * - Who decides (`decide-playbook-change`) follows the sprint's autopilot:
 *   off / safe → a person, batched as one Needs you item per sprint (plus the
 *   Playbook tab); full → the agent may decide, and measured wins are kept
 *   at once.
 */
import { randomUUID } from "node:crypto";
import { sameClient, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import * as db from "../db.js";
import { PLAYBOOK_ITEM_KEY, playbookChangesItem } from "../engine/items.js";
import type { Outcome } from "../engine/measure.js";
import {
  agentMayDecide,
  agentMayPropose,
  applyPlaybookChange,
  autoKeep,
  changeDiff,
  isSection,
  MAX_PENDING_CHANGES,
  measuredChange,
  normalizeChange,
  PlaybookError,
  playbookTitle,
  scopeKey,
  seoStarterPlaybook,
  type ChangeSpec,
} from "../engine/playbook.js";
import { scopeParamValue, sprintPagePath, sprintScope } from "../engine/scope.js";
import { actorId, actorLabel, bool, companyInfo, reqStr, SeoError, str, type Actor, type CompanyInfo, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";
import { requireClient, scopeParam } from "./scope.js";

function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PlaybookError) throw new SeoError(error.message);
    throw error;
  }
}

// ── Scope ───────────────────────────────────────────────────────────────────

interface Target {
  scope: ClientScope;
  clientName: string | null;
  /** The sprint named (or, for a client, its newest sprint that is not archived). */
  sprint: db.Sprint | null;
}

/** From `sprintId` (or `optimizationId`), else `client` ("own" for Partners in Biz's own sites). */
async function targetFor(env: Env, companyId: string, params: Params, opts: { fromOptimization?: boolean } = {}): Promise<Target> {
  const requested = scopeParam(params);
  let sprint: db.Sprint | null = null;
  const sprintId = str(params, "sprintId");
  const optimizationId = opts.fromOptimization ? str(params, "optimizationId") : undefined;
  if (sprintId) sprint = await requireSprint(env, companyId, sprintId);
  else if (optimizationId) {
    const o = await db.getOptimization(env.ctx.db, companyId, optimizationId);
    if (!o) throw new SeoError(`Optimization ${optimizationId} was not found`);
    sprint = await requireSprint(env, companyId, o.sprintId);
  }
  if (sprint) {
    const scope = sprintScope(sprint);
    if (requested !== undefined && !sameClient(requested, scope)) {
      throw new SeoError(`Sprint ${sprint.id} belongs to ${scopeParamValue(scope) ?? "Partners in Biz's own sites"}, not ${scopeParamValue(requested) ?? "own"}.`);
    }
    return { scope, clientName: sprint.clientName, sprint };
  }
  if (requested === undefined) throw new SeoError('Pass sprintId, or client ("own" for Partners in Biz\'s own sites, "company:<id>" or "contact:<id>").');
  const clientName = requested ? (await requireClient(env, companyId, requested)).name : null;
  const sprints = (await db.listSprints(env.ctx.db, companyId, { scope: requested })).filter((s) => s.status !== "archived");
  return { scope: requested, clientName, sprint: sprints[0] ?? null };
}

/** The scope's playbook, created on first use with the SEO starter. */
export async function ensurePlaybook(env: Env, companyId: string, scope: ClientScope, clientName: string | null): Promise<db.Playbook> {
  const key = scopeKey(scope);
  const found = await env.playbooks.findPlaybook(companyId, key);
  if (found) {
    if (scope && clientName && found.clientName !== clientName) await env.playbooks.setClientName(companyId, found.id, clientName);
    return found;
  }
  const id = randomUUID();
  const playbook = seoStarterPlaybook(playbookTitle(scope, clientName));
  const inserted = await env.playbooks.insertPlaybook({ id, companyId, scopeKey: key, clientKind: scope?.kind ?? null, clientRef: scope?.id ?? null, clientName: scope ? clientName : null, playbook });
  const created = await env.playbooks.findPlaybook(companyId, key);
  if (!created) throw new SeoError("The playbook could not be created");
  if (inserted && created.id === id) {
    await env.playbooks.insertVersion({ id: randomUUID(), companyId, playbookId: id, version: 1, playbook, reason: "Starter playbook", optimizationId: null, changeId: null, decidedBy: null });
  }
  return created;
}

function scopeLabel(scope: ClientScope, clientName: string | null): string {
  return scope ? clientName ?? "client" : "Partners in Biz";
}

/** The sprint's Playbook tab. */
export function playbookPath(info: Pick<CompanyInfo, "prefix">, sprint: db.Sprint): string | null {
  return info.prefix ? sprintPagePath(`/${info.prefix}/seo`, sprint.id, sprintScope(sprint), { tab: "playbook" }) : null;
}

// ── Views ───────────────────────────────────────────────────────────────────

export function changeOut(c: db.PlaybookChange) {
  return {
    changeId: c.id,
    status: c.status,
    source: c.source,
    op: c.op,
    section: c.section,
    text: c.op === "replace" ? null : c.body,
    diff: c.diff,
    reason: c.reason,
    optimizationId: c.optimizationId,
    sprintId: c.sprintId,
    baseVersion: c.baseVersion,
    resultVersion: c.resultVersion,
    proposedBy: c.proposedBy,
    decidedBy: c.decidedBy,
    decidedAt: c.decidedAt,
    note: c.decisionNote,
    createdAt: c.createdAt,
  };
}

/** Version and pending count for a sprint's scope, without creating anything (today, the sprint page). */
export async function playbookSummary(env: Env, sprint: db.Sprint): Promise<{ playbookId: string | null; version: number | null; pending: number }> {
  const pb = await env.playbooks.findPlaybook(sprint.companyId, scopeKey(sprintScope(sprint)));
  if (!pb) return { playbookId: null, version: null, pending: 0 };
  const pending = await env.playbooks.listChanges(sprint.companyId, pb.id, "pending");
  return { playbookId: pb.id, version: pb.version, pending: pending.length };
}

// ── Writing ─────────────────────────────────────────────────────────────────

function changeSpec(c: db.PlaybookChange): ChangeSpec {
  return { op: c.op, section: isSection(c.section) ? c.section : null, body: c.body };
}

/** A new version, guarded by the version it was read at (retries on a concurrent write). */
async function writePlaybook(env: Env, companyId: string, playbookId: string, edit: (playbook: string) => string, meta: { reason: string; optimizationId: string | null; changeId: string | null; decidedBy: string }): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await env.playbooks.getPlaybook(companyId, playbookId);
    if (!current) throw new SeoError("The playbook was not found");
    const next = guard(() => edit(current.playbook));
    if (await env.playbooks.savePlaybook(companyId, playbookId, current.version, next)) {
      const version = current.version + 1;
      await env.playbooks.insertVersion({ id: randomUUID(), companyId, playbookId, version, playbook: next, reason: meta.reason, optimizationId: meta.optimizationId, changeId: meta.changeId, decidedBy: meta.decidedBy });
      return version;
    }
  }
  throw new SeoError("The playbook changed while saving. Reload and try again.");
}

async function keepChange(env: Env, change: db.PlaybookChange, decidedBy: string, note: string | null): Promise<number> {
  const current = await env.playbooks.getPlaybook(change.companyId, change.playbookId);
  if (!current) throw new SeoError("The playbook was not found");
  const spec = changeSpec(change);
  guard(() => applyPlaybookChange(current.playbook, spec)); // validate before claiming
  if (!(await env.playbooks.updateChange(change.companyId, change.id, { status: "kept", decidedBy, decisionNote: note }, true))) {
    throw new SeoError("This change was already decided");
  }
  try {
    const version = await writePlaybook(env, change.companyId, change.playbookId, (playbook) => applyPlaybookChange(playbook, spec), {
      reason: change.reason,
      optimizationId: change.optimizationId,
      changeId: change.id,
      decidedBy,
    });
    await env.playbooks.updateChange(change.companyId, change.id, { resultVersion: version }, false);
    return version;
  } catch (error) {
    // The playbook moved on and the change no longer applies: record that instead of a kept change without a version.
    const message = error instanceof Error ? error.message : String(error);
    await env.playbooks.updateChange(change.companyId, change.id, { status: "discarded", decisionNote: `Could not apply: ${message}`.slice(0, 1000) }, false);
    throw error;
  }
}

/**
 * Keep the sprint's one Needs you item in step with its pending changes:
 * list them (off / safe autopilot), or close it once nothing is pending.
 */
export async function refreshPlaybookItem(env: Env, info: CompanyInfo, sprint: db.Sprint, by = "the SEO plugin"): Promise<void> {
  const pending = await env.playbooks.pendingForSprint(sprint.companyId, sprint.id);
  if (pending.length === 0) {
    await resolveNeedsYou(env, info, sprint, PLAYBOOK_ITEM_KEY, by);
    return;
  }
  if (sprint.autopilotMode === "full") return; // the agent decides them
  const item = playbookChangesItem({
    playbookPath: playbookPath(info, sprint),
    scopeLabel: scopeLabel(sprintScope(sprint), sprint.clientName),
    diffs: pending.map((c) => c.diff),
  });
  await addNeedsYou(env, info, sprint, item, { reopen: true });
}

// ── Loop hook ───────────────────────────────────────────────────────────────

export interface DraftResult {
  changeId: string;
  diff: string;
  kept: boolean;
  version: number | null;
}

/**
 * A measured optimization drafts one playbook line: a win under "Rules we
 * follow", a loss under "Things that did not work". Full autopilot keeps a
 * win at once; everything else waits for a decision.
 */
export async function draftFromMeasurement(env: Env, info: CompanyInfo, sprint: db.Sprint, o: db.Optimization, outcome: Pick<Outcome, "result" | "reasons">): Promise<DraftResult | null> {
  const spec = measuredChange(o, outcome, info.today);
  if (!spec) return null;
  const scope = sprintScope(sprint);
  const pb = await ensurePlaybook(env, sprint.companyId, scope, sprint.clientName);
  const id = randomUUID();
  const diff = changeDiff(spec, pb.playbook);
  const inserted = await env.playbooks.insertChange({
    id,
    companyId: sprint.companyId,
    playbookId: pb.id,
    sprintId: sprint.id,
    optimizationId: o.id,
    source: "measured",
    op: spec.op,
    section: spec.section,
    body: spec.body,
    diff,
    reason: `Optimization measured as a ${outcome.result}: ${o.hypothesis}`.slice(0, 500),
    baseVersion: pb.version,
    proposedBy: "system",
  });
  if (!inserted) return null;
  const change = await env.playbooks.getChange(sprint.companyId, id);
  if (!change) return null;
  if (autoKeep(sprint.autopilotMode, outcome.result)) {
    const version = await keepChange(env, change, "autopilot", "Kept automatically (full autopilot)");
    return { changeId: id, diff, kept: true, version };
  }
  await refreshPlaybookItem(env, info, sprint);
  return { changeId: id, diff, kept: false, version: null };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export async function getPlaybookTool(env: Env, companyId: string, _actor: Actor, params: Params) {
  const target = await targetFor(env, companyId, params);
  const pb = await ensurePlaybook(env, companyId, target.scope, target.clientName);
  const withText = bool(params, "includeVersionText") ?? false;
  const [versions, changes] = await Promise.all([env.playbooks.listVersions(companyId, pb.id, 30), env.playbooks.listChanges(companyId, pb.id)]);
  const mode = target.sprint?.autopilotMode ?? null;
  return {
    playbookId: pb.id,
    client: scopeParamValue(target.scope),
    clientName: target.scope ? pb.clientName ?? target.clientName : null,
    sprintId: target.sprint?.id ?? null,
    autopilotMode: mode,
    version: pb.version,
    playbook: pb.playbook,
    follow: "Follow “Rules we follow”, avoid “Things that did not work”, respect “Constraints”. Test “Open questions” through optimizations. Propose edits with propose-playbook-change.",
    whoDecides: mode && agentMayDecide(mode) ? "The agent may keep or discard (full autopilot)." : "A person keeps or discards (Needs you issue and SEO → Playbook).",
    pendingChanges: changes.filter((c) => c.status === "pending").map(changeOut),
    recentDecisions: changes.filter((c) => c.status !== "pending").slice(0, 20).map(changeOut),
    versions: versions.map((v) => ({
      version: v.version,
      reason: v.reason,
      optimizationId: v.optimizationId,
      changeId: v.changeId,
      decidedBy: v.decidedBy,
      createdAt: v.createdAt,
      ...(withText ? { playbook: v.playbook } : {}),
    })),
  };
}

export async function proposePlaybookChangeTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const target = await targetFor(env, companyId, params, { fromOptimization: true });
  const sprint = target.sprint;
  if (!sprint) throw new SeoError("This scope has no sprint yet. Propose playbook changes from a sprint (pass sprintId).");
  if (actor.kind !== "user" && !agentMayPropose(sprint.autopilotMode)) {
    throw new SeoError("Autopilot is off for this sprint, so agents do not propose playbook changes.");
  }
  const pb = await ensurePlaybook(env, companyId, target.scope, target.clientName);
  const spec = guard(() => normalizeChange(params));
  guard(() => applyPlaybookChange(pb.playbook, spec)); // refuse a removal that does not match now
  const reason = reqStr(params, "reason", { max: 500 });
  const optimizationId = str(params, "optimizationId", { max: 100 }) ?? null;
  if (optimizationId) {
    const o = await db.getOptimization(env.ctx.db, companyId, optimizationId);
    if (!o) throw new SeoError(`Optimization ${optimizationId} was not found`);
    const home = o.sprintId === sprint.id ? sprint : await db.getSprint(env.ctx.db, companyId, o.sprintId);
    if (!home || scopeKey(sprintScope(home)) !== pb.scopeKey) throw new SeoError("That optimization belongs to another client's sprint");
  }
  const pending = await env.playbooks.listChanges(companyId, pb.id, "pending");
  const diff = changeDiff(spec, pb.playbook);
  const same = pending.find((c) => c.op === spec.op && c.body.trim().toLowerCase() === spec.body.trim().toLowerCase() && (c.section ?? null) === spec.section);
  if (same) return { ...changeOut(same), message: "The same change is already pending." };
  if (pending.length >= MAX_PENDING_CHANGES) throw new SeoError(`${MAX_PENDING_CHANGES} playbook changes are already waiting. Wait until they are decided.`);
  const id = randomUUID();
  await env.playbooks.insertChange({
    id,
    companyId,
    playbookId: pb.id,
    sprintId: sprint.id,
    optimizationId,
    source: actor.kind === "user" ? "person" : "agent",
    op: spec.op,
    section: spec.section,
    body: spec.body,
    diff,
    reason,
    baseVersion: pb.version,
    proposedBy: actorId(actor),
  });
  const change = await env.playbooks.getChange(companyId, id);
  if (!change) throw new SeoError("The playbook change could not be saved");
  let message = "Full autopilot: decide it with decide-playbook-change.";
  if (sprint.autopilotMode !== "full") {
    await refreshPlaybookItem(env, await companyInfo(env, companyId), sprint);
    message = "Waiting for a person to keep or discard it (on the sprint's Needs you issue and SEO → Playbook). Follow the current version meanwhile.";
  }
  return { ...changeOut(change), message };
}

export async function decidePlaybookChangeTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const change = await env.playbooks.getChange(companyId, reqStr(params, "changeId"));
  if (!change) throw new SeoError("That playbook change was not found");
  if (change.status !== "pending") throw new SeoError(`This change was already ${change.status}`);
  const sprint = change.sprintId ? await db.getSprint(env.ctx.db, companyId, change.sprintId) : null;
  if (actor.kind !== "user" && !(sprint && agentMayDecide(sprint.autopilotMode))) {
    throw new SeoError("Only a person keeps or discards playbook changes unless the sprint's autopilot is full. It is on the sprint's Needs you issue and SEO → Playbook; follow the current version meanwhile.");
  }
  const decision = params.decision;
  if (decision !== "keep" && decision !== "discard") throw new SeoError("decision must be keep or discard");
  const note = str(params, "note", { max: 1000 }) ?? null;
  const by = actorId(actor);
  let version: number | null = null;
  if (decision === "keep") {
    version = await keepChange(env, change, by, note);
  } else if (!(await env.playbooks.updateChange(companyId, change.id, { status: "discarded", decidedBy: by, decisionNote: note }, true))) {
    throw new SeoError("This change was already decided");
  }
  if (sprint) await refreshPlaybookItem(env, await companyInfo(env, companyId), sprint, actorLabel(actor));
  const pb = await env.playbooks.getPlaybook(companyId, change.playbookId);
  return { changeId: change.id, status: decision === "keep" ? "kept" : "discarded", playbookVersion: version ?? pb?.version ?? change.baseVersion };
}
