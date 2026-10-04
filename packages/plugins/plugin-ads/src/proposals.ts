/**
 * Governed changes. Every campaign or budget change is a proposal with the numbers, and an issue that goes to the Reviewer first and then to
 * a person (and, where the scope asks for it, to the client through the CRM's client-action path). The plugin records each person's yes
 * against a hash of exactly those numbers; nothing changes in an ad platform here: running an approved change is `execute.ts`.
 *
 * Statuses: needs_changes (a platform would refuse the copy, or the Reviewer asked for changes) -> in_review -> approved (every sign-off in,
 * review standing) -> executing -> executed | failed. `creative_check` ends at cleared. rejected, cancelled and expired end a proposal.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { approvalReviewerBrief, openApprovalIssue, readCompanyRoles, reopenApprovalForPerson, resolveApprover, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { capImpact } from "./budgets.js";
import { checkCreative } from "./creative.js";
import {
  audit,
  clientName,
  ensureScope,
  getProposal,
  getScope,
  insertApproval,
  insertProposal,
  listApprovals,
  listProposals,
  proposalByIssue,
  transitionProposal,
  updateProposal,
  type ProposalRow,
  type ScopeRow,
} from "./db.js";
import { AdsError, actorText, canonicalJson, clip, errorMessage, scopeLabelOf, sha256, validScopeKey } from "./domain.js";
import { accountManagerAssignee, adsAssignee, closeIssue, closeRunIssue, note, openIssueOnce, ORIGIN_KIND, projectForScope } from "./issues.js";
import { scopePace } from "./pacing.js";
import { ADS_ORIGINS, OPEN_PROPOSAL_STATUSES, PROPOSAL_KIND_LABELS, SPEND_KINDS, type ProposalKind } from "./platforms.js";
import { normalizeProposal, type Normalized } from "./proposal-input.js";
import { approvalIssueText, clientMessage, reviewerChecks } from "./proposal-text.js";
import type { AdsRuntime } from "./runtime.js";
import { APPROVAL_TTL_MS, PROPOSAL_TTL_MS, reviewStands, signoffState, type Role } from "./signoffs.js";

export interface ProposalActor {
  userId?: string | null;
  agentId?: string | null;
}

const hashOf = (kind: string, scopeKey: string, accountId: string | null, payload: Record<string, unknown>) => sha256(canonicalJson({ kind, scopeKey, accountId, payload })).slice(0, 40);

/** Who must say yes: PiB's owner always; the client too when the scope asks for it and the change adds spend or is the client's copy. A pause needs only the owner. */
export function signoffsFor(scope: Pick<ScopeRow, "signoffs">, kind: ProposalKind): Role[] {
  if (kind === "pause_campaign") return ["owner"];
  return scope.signoffs === "owner_client" ? ["owner", "client"] : ["owner"];
}

async function computeImpact(rt: AdsRuntime, scope: ScopeRow, kind: ProposalKind, addition: Normalized["addition"]) {
  const sp = await scopePace(rt, scope);
  const impact = capImpact(sp.pace, sp.today, addition ?? {}, sp.spentTodayMinor);
  const state = SPEND_KINDS.includes(kind) ? impact.state : sp.pace.capMinor === null ? ("no_cap" as const) : ("within" as const);
  return {
    capState: state,
    snapshot: {
      month: sp.month,
      currency: sp.currency,
      capMinor: impact.capMinor,
      spentMinor: sp.pace.spentMinor,
      committedDailyMinor: sp.committedDailyMinor,
      projectedBeforeMinor: impact.projectedBeforeMinor,
      projectedAfterMinor: impact.projectedAfterMinor,
      addedThisMonthMinor: impact.addedThisMonthMinor,
      headroomAfterMinor: impact.headroomAfterMinor,
      state,
    },
  };
}

function precheckOf(scope: ScopeRow, n: Normalized): Record<string, unknown> {
  if (!n.creative) return {};
  // The rehearsal platform is checked against Meta's rules.
  const result = checkCreative({ platform: n.platform === "google" ? "google" : "meta", ...n.creative, specialAdCategories: n.specialAdCategories }, { bannedWords: scope.banned_words });
  return { ...result, bannedWordsChecked: scope.banned_words.length };
}

const writesNote = (scope: ScopeRow, kind: ProposalKind, writesEnabled: boolean): string => {
  if (kind === "creative_check") return "Clearing the copy changes nothing in any ad platform.";
  if (!writesEnabled) return "Changes to ads are switched off for this company in the plugin settings: after approval someone makes the change in the ad platform and marks it done on the Ads page.";
  if (!scope.allow_writes) return "Changes to ads are switched off for this scope: after approval someone makes the change in the ad platform and marks it done on the Ads page, or a person switches changes on for this scope first.";
  return "Changes are on for this scope: after approval the ads agent runs it with the approval id.";
};

export interface ProposalResult {
  proposalId: string;
  status: ProposalRow["status"];
  issueId: string | null;
  needsChanges: Array<{ level: string; where: string; text: string }>;
  capState: ProposalRow["cap_state"];
  requiresSignoffs: Role[];
  next: string;
}

async function openApproval(rt: AdsRuntime, p: ProposalRow, scope: ScopeRow, actor: ProposalActor): Promise<{ id: string; assignedTo: string }> {
  const name = await clientName(rt.ctx, rt.companyId, scope.scope_key);
  const label = scopeLabelOf(scope.scope_key, name);
  const projectId = await projectForScope(rt.ctx, rt.companyId, scope.scope_key);
  const result = await openApprovalIssue(rt.ctx, {
    companyId: rt.companyId,
    title: clip(`Approve ${PROPOSAL_KIND_LABELS[p.kind].toLowerCase()}: ${p.title} (${label})`, 200),
    description: approvalIssueText(p, { scopeLabel: label, currency: scope.currency, signoffs: p.requires_signoffs, writesNote: writesNote(scope, p.kind, rt.config.writesEnabled) }),
    originKind: ORIGIN_KIND,
    originId: `${ADS_ORIGINS.approval}${p.id}`,
    ...(projectId ? { projectId } : {}),
    priority: SPEND_KINDS.includes(p.kind) ? "high" : "medium",
    outward: true,
    actorUserId: actor.userId ?? null,
    wakeReason: "An ad change needs checking",
    reviewerBrief: (route) =>
      approvalReviewerBrief(route, `an ad change for ${label} (${PROPOSAL_KIND_LABELS[p.kind]})`, [
        ...reviewerChecks(p.kind),
        `Record your verdict on the proposal with \`partnersinbiz.ads:record-ad-review\` (proposalId \`${p.id}\`, verdict pass or changes, with notes): the plugin then hands the issue on.`,
      ]),
  });
  return { id: result.id, assignedTo: result.assignedTo };
}

/** The agent or person asks for a change. Returns what happens next; refuses what cannot be a proposal. */
export async function createProposal(rt: AdsRuntime, actor: ProposalActor, input: Record<string, unknown>): Promise<ProposalResult> {
  const scopeKey = typeof input.scopeKey === "string" ? input.scopeKey : "";
  if (!validScopeKey(scopeKey)) throw new AdsError('scopeKey must be "own" or a CRM client like "company:<id>" or "contact:<id>".');
  const scope = (await getScope(rt.ctx, rt.companyId, scopeKey)) ?? (input.kind === "creative_check" ? await ensureScope(rt.ctx, rt.companyId, scopeKey, "ZAR") : null);
  if (!scope) throw new AdsError(`${scopeLabelOf(scopeKey)} has no ad account registered yet, so there is nothing to change. Register one (register-ad-account) first.`);
  const n = await normalizeProposal(rt, scope, input);
  const id = randomUUID();
  const impact = await computeImpact(rt, scope, n.kind, n.addition);
  const precheck = precheckOf(scope, n);
  const blockers = (precheck as { blockers?: number }).blockers ?? 0;
  const origin = typeof input.origin === "string" && ["agent", "budget_90", "budget_100", "alert", "human"].includes(input.origin) ? input.origin : actor.userId ? "human" : "agent";
  await insertProposal(rt.ctx, {
    id,
    companyId: rt.companyId,
    scopeKey,
    accountId: n.accountId,
    kind: n.kind,
    status: blockers > 0 ? "needs_changes" : "in_review",
    title: clip(n.title, 200),
    summary: n.summary,
    payload: n.payload,
    impact: impact.snapshot,
    contentHash: hashOf(n.kind, scopeKey, n.accountId, n.payload),
    precheck,
    reviewState: "not_required",
    requiresSignoffs: signoffsFor(scope, n.kind),
    capState: impact.capState,
    origin,
    originRef: typeof input.originRef === "string" ? input.originRef.slice(0, 200) : null,
    expiresAt: new Date(rt.now().getTime() + PROPOSAL_TTL_MS).toISOString(),
    createdBy: actorText(actor),
  });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "proposal.created", scopeKey, subject: id, detail: { kind: n.kind, title: n.title, capState: impact.capState, blockers } });
  return startReview(rt, actor, id);
}

/** Opens (or reopens) the approval issue for a proposal that has no blockers. */
async function startReview(rt: AdsRuntime, actor: ProposalActor, proposalId: string): Promise<ProposalResult> {
  const p = (await getProposal(rt.ctx, rt.companyId, proposalId))!;
  const scope = (await getScope(rt.ctx, rt.companyId, p.scope_key))!;
  const findings = ((p.precheck as { findings?: Array<{ level: string; where: string; text: string }> }).findings ?? []).filter((f) => f.level === "blocker");
  if (p.status === "needs_changes" && findings.length > 0) {
    return { proposalId, status: p.status, issueId: p.approval_issue_id, needsChanges: findings, capState: p.cap_state, requiresSignoffs: p.requires_signoffs, next: "Fix every blocker and call revise-ad-proposal. Nothing has gone to review yet." };
  }
  let issueId = p.approval_issue_id;
  let reviewState: ProposalRow["review_state"] = "not_required";
  if (!issueId) {
    const opened = await openApproval(rt, p, scope, actor);
    issueId = opened.id;
    if (opened.assignedTo === "reviewer") reviewState = "pending";
    await updateProposal(rt.ctx, rt.companyId, proposalId, { approvalIssueId: issueId, reviewState });
  }
  const fresh = (await getProposal(rt.ctx, rt.companyId, proposalId))!;
  if (reviewState === "not_required") await maybeOpenClientAsk(rt, fresh, scope);
  return {
    proposalId,
    status: fresh.status,
    issueId,
    needsChanges: [],
    capState: fresh.cap_state,
    requiresSignoffs: fresh.requires_signoffs,
    next: reviewState === "pending" ? "The Reviewer checks it first, then a person approves. Nothing runs until every sign-off is recorded." : "A person approves on the issue or the Ads page. Nothing runs until every sign-off is recorded.",
  };
}

/** The ask a client's yes needs: one task for the Account Manager, once the Reviewer's check (if any) stands. */
async function maybeOpenClientAsk(rt: AdsRuntime, p: ProposalRow, scope: ScopeRow): Promise<void> {
  if (!p.requires_signoffs.includes("client") || p.client_ask_issue_id || !reviewStands(p) || (p.status !== "in_review" && p.status !== "approved")) return;
  const approvals = await listApprovals(rt.ctx, rt.companyId, p.id);
  if (signoffState(p, approvals, rt.now()).valid.client) return;
  const name = await clientName(rt.ctx, rt.companyId, p.scope_key);
  const client = p.scope_key;
  const opened = await openIssueOnce(rt.ctx, {
    companyId: rt.companyId,
    originId: `${ADS_ORIGINS.clientAsk}${p.id}`,
    title: clip(`Ask ${name ?? "the client"} to approve an ad change: ${p.title}`, 200),
    description: [
      `${scopeLabelOf(p.scope_key, name)}'s ad change needs the client's own yes (this scope asks for it). Ask them through the CRM, not by a side email.`,
      "",
      `1. \`partnersinbiz.crm:create-client-action\` with \`client\` \`${client}\`, \`kind\` \`approval\`, \`title\` "Approve our ad change: ${clip(p.title, 80)}" and this as \`message\`:`,
      "",
      ...clientMessage(p, name, scope.currency).split("\n").map((l) => `> ${l}`),
      "",
      "2. Its email goes through the normal approval (the Reviewer checks it, a person approves it); the CRM then sends it and waits for the client.",
      `3. Tell the plugin which request it is: \`partnersinbiz.ads:record-client-request\` with \`proposalId\` \`${p.id}\` and the request's id. Then mark this issue done.`,
      "",
      "When the client answers yes, **a person records it** on the Ads page (Record the client's yes) with what the client wrote. You cannot record it, and nothing runs before it.",
      "If the numbers change, the old ask no longer counts: this issue is reopened with a note.",
    ].join("\n"),
    assignee: await accountManagerAssignee(rt.ctx, rt.companyId),
    projectId: await projectForScope(rt.ctx, rt.companyId, p.scope_key),
    wakeReason: "A client's yes is needed for an ad change",
  });
  await updateProposal(rt.ctx, rt.companyId, p.id, { clientAskIssueId: opened.id });
}

/** Everything after a sign-off, a review verdict or a revision: where does the proposal stand now? */
export async function refreshProposal(rt: AdsRuntime, proposalId: string): Promise<ProposalRow> {
  const p = (await getProposal(rt.ctx, rt.companyId, proposalId))!;
  if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) return p;
  const scope = (await getScope(rt.ctx, rt.companyId, p.scope_key))!;
  const state = signoffState(p, await listApprovals(rt.ctx, rt.companyId, p.id), rt.now());
  if (state.rejected) {
    await updateProposal(rt.ctx, rt.companyId, p.id, { status: "rejected" });
    await closeIssue(rt.ctx, rt.companyId, p.approval_issue_id, "cancelled", `Refused by ${state.rejected.decided_by}${state.rejected.note ? `: ${state.rejected.note}` : ""}. Nothing was changed.`);
    await closeIssue(rt.ctx, rt.companyId, p.client_ask_issue_id, "cancelled", "The change was refused; no need to ask the client.");
    return (await getProposal(rt.ctx, rt.companyId, p.id))!;
  }
  if (p.status === "needs_changes") return p;
  if (state.complete && reviewStands(p)) {
    const next = p.kind === "creative_check" ? "cleared" : "approved";
    if (p.status !== next) {
      await updateProposal(rt.ctx, rt.companyId, p.id, { status: next });
      const who = Object.values(state.valid).map((a) => `${a!.role} ${a!.decided_by}`).join(", ");
      await note(rt.ctx, rt.companyId, p.approval_issue_id, next === "cleared" ? `Copy cleared (${who}). Nothing changed in any ad platform.` : `Approved by ${who}. The numbers are locked: changing them cancels these approvals. ${writesNote(scope, p.kind, rt.config.writesEnabled)}`);
      await closeIssue(rt.ctx, rt.companyId, p.approval_issue_id, "done", "Decision recorded.");
      if (next === "approved") await openRunIssue(rt, (await getProposal(rt.ctx, rt.companyId, p.id))!, scope);
    }
  } else if (p.status === "approved") {
    // An approval lapsed (72 hours) or the review no longer stands: back to waiting for a yes.
    await updateProposal(rt.ctx, rt.companyId, p.id, { status: "in_review" });
    await note(rt.ctx, rt.companyId, p.approval_issue_id, `An approval lapsed${state.missing.length ? ` (still needed: ${state.missing.join(", ")})` : ""}. The numbers need a fresh yes before anything runs.`);
  } else {
    await maybeOpenClientAsk(rt, p, scope);
  }
  return (await getProposal(rt.ctx, rt.companyId, p.id))!;
}

/** A task for the ads agent: run the approved change with the approval id (or, with writes off, hand it to a person). */
async function openRunIssue(rt: AdsRuntime, p: ProposalRow, scope: ScopeRow): Promise<void> {
  const approvals = await listApprovals(rt.ctx, rt.companyId, p.id);
  const owner = signoffState(p, approvals, rt.now()).valid.owner;
  const canRun = rt.config.writesEnabled && scope.allow_writes;
  await openIssueOnce(rt.ctx, {
    companyId: rt.companyId,
    originId: `${ADS_ORIGINS.run}${p.id}`,
    title: clip(`Run the approved ad change: ${p.title}`, 200),
    description: [
      `Approved: ${p.summary}`,
      "",
      canRun
        ? `Call \`partnersinbiz.ads:execute-ad-change\` with \`proposalId\` \`${p.id}\` and \`approvalId\` \`${owner?.id ?? "(see get-ad-proposal)"}\`. The approval is single-use and expires 72 hours after it was given. The plugin re-checks the switches, the cap and the numbers; if it refuses, comment why and stop.`
        : "Changes to ads are **off** for this scope (or company), so the plugin will not run it. Do not try to get around that. Make the change in the ad platform only if a person asked you to, then ask a person to press **Mark done** on the Ads page; or leave it for the owner.",
      "",
      "After it runs, check the campaign in the next sync (`list-ad-campaigns`) and comment what changed.",
    ].join("\n"),
    assignee: await adsAssignee(rt.ctx, rt.companyId),
    projectId: await projectForScope(rt.ctx, rt.companyId, p.scope_key),
    wakeReason: "An ad change was approved",
  });
}

export interface SignoffInput {
  proposalId: string;
  userId: string | null;
  role: Role;
  decision: "approved" | "rejected";
  note?: string | null;
  evidenceRef?: string | null;
  overCapAck?: boolean;
  via: "issue" | "page";
}

/** A person's yes or no. Only a person can give one: an agent has no way to call this. */
export async function recordSignoff(rt: AdsRuntime, input: SignoffInput): Promise<{ proposal: ProposalRow; approvalId: string }> {
  if (!input.userId) throw new AdsError("Only a signed-in person can approve or refuse a change.");
  const p = await getProposal(rt.ctx, rt.companyId, input.proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (p.status === "needs_changes") throw new AdsError("This proposal needs changes first (see the Reviewer's notes or the checks). Ask the ads agent to revise it.");
  if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) throw new AdsError(`This proposal is ${p.status}; it can no longer be approved or refused.`);
  if (!p.requires_signoffs.includes(input.role)) throw new AdsError(`This proposal does not need a ${input.role} sign-off.`);
  if (rt.now() > new Date(p.expires_at ?? 0)) throw new AdsError("This proposal expired. Ask for it again.");
  const note_ = input.note?.trim() || null;
  if (input.role === "client" && input.decision === "approved" && (!note_ || note_.length < 8)) {
    throw new AdsError("Say what the client wrote and when (at least a short sentence): the client's yes is recorded as evidence, not as a click.");
  }
  if (input.decision === "approved" && input.role === "owner" && p.cap_state === "exceeds" && !input.overCapAck) {
    throw new AdsError("This goes over the month's cap. Approve it on the Ads page with \"over the cap\" ticked, or refuse it.", "over_cap");
  }
  if (input.decision === "approved" && p.review_state === "changes") throw new AdsError("The Reviewer asked for changes. Ask the ads agent to revise it first.");
  if (input.decision === "approved" && input.role === "owner" && p.review_state === "pending") {
    await updateProposal(rt.ctx, rt.companyId, p.id, { reviewState: "waived", reviewBy: `user:${input.userId}`, reviewNotes: "Approved by a person before the Reviewer's check finished." });
  }
  const approvalId = await insertApproval(rt.ctx, {
    companyId: rt.companyId,
    proposalId: p.id,
    role: input.role,
    decision: input.decision,
    decidedBy: `user:${input.userId}`,
    contentHash: p.content_hash,
    overCapAck: input.overCapAck === true,
    note: note_,
    evidenceRef: input.evidenceRef?.trim() || null,
    expiresAt: new Date(rt.now().getTime() + APPROVAL_TTL_MS).toISOString(),
  });
  await audit(rt.ctx, rt.companyId, { actor: `user:${input.userId}`, action: `proposal.${input.decision === "approved" ? "approved" : "rejected"}`, scopeKey: p.scope_key, subject: p.id, detail: { role: input.role, via: input.via, overCapAck: input.overCapAck === true, approvalId } });
  return { proposal: await refreshProposal(rt, p.id), approvalId };
}

/**
 * The agent in the company's Reviewer role (the roles copy the Cockpit sends), whether or not it can run right now: who may record a verdict is a
 * question of identity, not of whether the Reviewer is awake. Null when the company has none.
 */
export async function reviewerAgentOf(rt: AdsRuntime): Promise<string | null> {
  const { roles } = await readCompanyRoles(rt.ctx, rt.companyId, rt.now().getTime());
  return roles?.reviewerAgentId ?? null;
}

/**
 * The Reviewer's verdict on the current numbers. A pass hands the issue to the approver; changes hand it back to the ads agent.
 * Only the company's Reviewer agent can record one, and never on a proposal it asked for itself: a verdict from anybody else (the ads agent
 * that made the proposal, any agent that can call the tool) would let a proposal pass its own check, and the approver would be shown a pass
 * the Reviewer never gave.
 */
export async function recordReview(rt: AdsRuntime, actor: ProposalActor, input: { proposalId: string; verdict: "pass" | "changes"; notes?: string | null }): Promise<ProposalRow> {
  const p = await getProposal(rt.ctx, rt.companyId, input.proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  const refuseReview = async (code: string, message: string): Promise<never> => {
    await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "review.refused", scopeKey: p.scope_key, subject: p.id, detail: { code, verdict: input.verdict } });
    throw new AdsError(message, code);
  };
  if (actor.userId || !actor.agentId) {
    return refuseReview("not_reviewer", "Only the Reviewer agent records a review. A person approves or refuses the change on its issue or on the Ads page.");
  }
  const reviewer = await reviewerAgentOf(rt);
  if (!reviewer) {
    return refuseReview("no_reviewer", "This company has no Reviewer in its team, so there is no review to record: a person approves or refuses the change. (Setup -> Team sets the Reviewer.)");
  }
  if (actor.agentId !== reviewer) {
    return refuseReview("not_reviewer", "Only the company's Reviewer can record a review. If you asked for this change you cannot review it: leave it for the Reviewer, then revise what it asks for.");
  }
  if (p.created_by === actorText(actor)) {
    return refuseReview("own_proposal", "The Reviewer cannot review a change it asked for itself. A person approves or refuses it.");
  }
  if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) throw new AdsError(`This proposal is ${p.status}; there is nothing left to review.`);
  const notes = input.notes?.trim() || null;
  if (input.verdict === "changes" && !notes) throw new AdsError("Say what has to change: one line per problem.");
  await updateProposal(rt.ctx, rt.companyId, p.id, {
    reviewState: input.verdict === "pass" ? "pass" : "changes",
    reviewNotes: notes,
    reviewBy: actorText(actor),
    reviewHash: p.content_hash,
    // The Reviewer can change its mind about these numbers (changes, then pass): that brings the proposal back, unless copy blockers keep it out.
    ...(input.verdict === "changes" ? { status: "needs_changes" as const } : p.status === "needs_changes" && ((p.precheck as { blockers?: number }).blockers ?? 0) === 0 ? { status: "in_review" as const } : {}),
  });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: `proposal.review_${input.verdict}`, scopeKey: p.scope_key, subject: p.id, detail: { notes: notes?.slice(0, 300) ?? null } });
  if (input.verdict === "pass") {
    await note(rt.ctx, rt.companyId, p.approval_issue_id, `**Reviewer: PASS.**${notes ? ` ${notes}` : ""} Over to the approver.`);
    await handTo(rt, p, "approver");
    return refreshProposal(rt, p.id);
  }
  await note(rt.ctx, rt.companyId, p.approval_issue_id, `**Reviewer: CHANGES NEEDED.** ${notes}\n\nThe ads agent revises the proposal (\`revise-ad-proposal\`); it comes back for review.`);
  await handTo(rt, p, "agent");
  return (await getProposal(rt.ctx, rt.companyId, p.id))!;
}

/** Hands the approval issue to the approver (a person) or back to the ads agent. Best effort: the proposal's state is the record. */
async function handTo(rt: AdsRuntime, p: ProposalRow, to: "approver" | "agent"): Promise<void> {
  if (!p.approval_issue_id) return;
  try {
    if (to === "approver") {
      const route = await resolveApprover(rt.ctx, rt.companyId, { outward: false });
      if (route.approverUserId) await rt.ctx.issues.update(p.approval_issue_id, { status: "todo", assigneeAgentId: null, assigneeUserId: route.approverUserId }, rt.companyId);
    } else {
      const who = await adsAssignee(rt.ctx, rt.companyId);
      await rt.ctx.issues.update(p.approval_issue_id, { status: "todo", assigneeAgentId: who.assigneeAgentId ?? null, assigneeUserId: who.assigneeUserId ?? null }, rt.companyId);
      if (who.assigneeAgentId) await wakeIssue(rt.ctx, p.approval_issue_id, rt.companyId, "The Reviewer asked for changes to an ad proposal");
    }
  } catch (error) {
    rt.ctx.logger.info("Ads issue hand-off skipped", { issueId: p.approval_issue_id, error: errorMessage(error) });
  }
}

/** The payload as the input that made it, so a revision can change only what it names. */
export function inputFromPayload(p: ProposalRow): Record<string, unknown> {
  const x = p.payload;
  if (p.kind === "create_campaign") {
    return { kind: p.kind, accountId: x.accountId, name: x.name, objective: x.objective, dailyBudgetMinor: x.dailyBudgetMinor, startDate: x.startDate, endDate: x.endDate, specialAdCategories: x.specialAdCategories, audience: x.audience, creative: x.creative, notes: x.notes, reason: x.reason };
  }
  if (p.kind === "change_budget") return { kind: p.kind, accountId: x.accountId, campaignExternalId: x.campaignExternalId, newDailyBudgetMinor: x.newDailyBudgetMinor, reason: x.reason };
  if (p.kind === "creative_check") return { kind: p.kind, platform: x.platform, name: x.name, creative: x.creative, specialAdCategories: x.specialAdCategories, notes: x.notes, reason: x.reason };
  return { kind: p.kind, targets: ((x.targets as Array<{ accountId: string; campaignExternalId: string }>) ?? []).map((t) => ({ accountId: t.accountId, campaignExternalId: t.campaignExternalId })), reason: x.reason, trigger: x.trigger };
}

/** The ads agent changes what a proposal asks for (after the Reviewer's changes, or a blocker). Every earlier yes stops counting. */
export async function reviseProposal(rt: AdsRuntime, actor: ProposalActor, proposalId: string, changes: Record<string, unknown>): Promise<ProposalResult> {
  const p = await getProposal(rt.ctx, rt.companyId, proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (!["needs_changes", "in_review", "approved"].includes(p.status)) throw new AdsError(`This proposal is ${p.status}; it cannot be revised. Make a new one.`);
  const scope = (await getScope(rt.ctx, rt.companyId, p.scope_key))!;
  const base = inputFromPayload(p);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (["proposalId", "scopeKey", "kind"].includes(key) || value === undefined) continue;
    merged[key] = key === "creative" && value && typeof value === "object" && base.creative && typeof base.creative === "object" ? { ...(base.creative as object), ...(value as object) } : value;
  }
  merged.kind = p.kind;
  const n = await normalizeProposal(rt, scope, merged);
  const impact = await computeImpact(rt, scope, n.kind, n.addition);
  const precheck = precheckOf(scope, n);
  const blockers = (precheck as { blockers?: number }).blockers ?? 0;
  const contentHash = hashOf(n.kind, scope.scope_key, n.accountId, n.payload);
  const unchanged = contentHash === p.content_hash;
  // The Reviewer's "changes" is about these numbers. Only different numbers (a new look by the Reviewer) or the Reviewer's own pass clears it: a
  // revision that changes nothing leaves the proposal where the Reviewer put it.
  const reviewerHolds = unchanged && p.review_state === "changes";
  await updateProposal(rt.ctx, rt.companyId, p.id, {
    status: blockers > 0 || reviewerHolds ? "needs_changes" : "in_review",
    title: clip(n.title, 200),
    summary: n.summary,
    payload: n.payload,
    impact: impact.snapshot,
    contentHash,
    precheck,
    capState: impact.capState,
    requiresSignoffs: signoffsFor(scope, n.kind),
    expiresAt: new Date(rt.now().getTime() + PROPOSAL_TTL_MS).toISOString(),
    // The Reviewer looks again at changed numbers.
    ...(unchanged ? {} : { reviewState: "not_required" as const, reviewNotes: null, reviewBy: null, reviewHash: null }),
    error: null,
  });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "proposal.revised", scopeKey: p.scope_key, subject: p.id, detail: { unchanged, blockers, reviewerHolds } });
  const fresh = (await getProposal(rt.ctx, rt.companyId, p.id))!;
  if (reviewerHolds && blockers === 0) {
    await note(rt.ctx, rt.companyId, fresh.approval_issue_id, "Revised, but the numbers are the same: the Reviewer's request for changes still stands. Change what the Reviewer asked for.");
    return {
      proposalId: p.id,
      status: fresh.status,
      issueId: fresh.approval_issue_id,
      needsChanges: [{ level: "reviewer", where: "review", text: fresh.review_notes ?? "The Reviewer asked for changes." }],
      capState: fresh.cap_state,
      requiresSignoffs: fresh.requires_signoffs,
      next: "The numbers did not change, so the Reviewer's request for changes still stands (get-ad-proposal has its notes). Change what it asks for and revise again.",
    };
  }
  if (fresh.approval_issue_id && blockers === 0 && unchanged) {
    await note(rt.ctx, rt.companyId, fresh.approval_issue_id, "Revised, but the numbers are the same; earlier approvals and the Reviewer's check still count.");
  } else if (fresh.approval_issue_id && blockers === 0) {
    const name = await clientName(rt.ctx, rt.companyId, p.scope_key);
    const reviewer = await resolveApprover(rt.ctx, rt.companyId, { outward: true, actorUserId: actor.userId ?? null });
    try {
      await rt.ctx.issues.update(
        fresh.approval_issue_id,
        {
          description: approvalIssueText(fresh, { scopeLabel: scopeLabelOf(p.scope_key, name), currency: scope.currency, signoffs: fresh.requires_signoffs, writesNote: writesNote(scope, fresh.kind, rt.config.writesEnabled) }),
          status: "todo",
          assigneeAgentId: reviewer.reviewerAgentId,
          assigneeUserId: reviewer.reviewerAgentId ? null : reviewer.approverUserId,
        },
        rt.companyId,
      );
      if (reviewer.reviewerAgentId) {
        await updateProposal(rt.ctx, rt.companyId, p.id, { reviewState: "pending" });
        await wakeIssue(rt.ctx, fresh.approval_issue_id, rt.companyId, "An ad proposal was revised");
      }
    } catch (error) {
      rt.ctx.logger.info("Ads approval issue could not be refreshed", { issueId: fresh.approval_issue_id, error: errorMessage(error) });
    }
    await note(rt.ctx, rt.companyId, fresh.approval_issue_id, "**Revised.** The numbers changed, so every earlier yes no longer counts and the Reviewer looks again.");
    if (fresh.client_ask_issue_id) {
      await rt.ctx.issues.update(fresh.client_ask_issue_id, { status: "todo" }, rt.companyId).catch(() => undefined);
      await note(rt.ctx, rt.companyId, fresh.client_ask_issue_id, "The numbers changed: ask the client again with the new message (`get-ad-proposal` has it).");
    }
  }
  const result = await startReview(rt, actor, p.id);
  // A revision that changed nothing leaves the yes standing: say so (an approved proposal stays approved).
  const settled = await refreshProposal(rt, p.id);
  return { ...result, status: settled.status };
}

export async function cancelProposal(rt: AdsRuntime, actor: ProposalActor, proposalId: string, reason: string | null): Promise<ProposalRow> {
  const p = await getProposal(rt.ctx, rt.companyId, proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) throw new AdsError(`This proposal is ${p.status}; it cannot be cancelled.`);
  await updateProposal(rt.ctx, rt.companyId, p.id, { status: "cancelled", error: reason?.slice(0, 400) ?? null });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "proposal.cancelled", scopeKey: p.scope_key, subject: p.id, detail: { reason: reason?.slice(0, 200) ?? null } });
  const why = `Cancelled${reason ? `: ${reason}` : ""}. Nothing was changed.`;
  await closeIssue(rt.ctx, rt.companyId, p.approval_issue_id, "cancelled", why);
  await closeIssue(rt.ctx, rt.companyId, p.client_ask_issue_id, "cancelled", why);
  return (await getProposal(rt.ctx, rt.companyId, p.id))!;
}

/** The Account Manager says which CRM request asked the client. */
export async function recordClientRequest(rt: AdsRuntime, actor: ProposalActor, proposalId: string, clientActionId: string): Promise<ProposalRow> {
  const p = await getProposal(rt.ctx, rt.companyId, proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (!p.requires_signoffs.includes("client")) throw new AdsError("This proposal does not need the client's yes.");
  await updateProposal(rt.ctx, rt.companyId, p.id, { clientActionRef: clientActionId.slice(0, 120) });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "proposal.client_asked", scopeKey: p.scope_key, subject: p.id, detail: { clientActionId } });
  await note(rt.ctx, rt.companyId, p.approval_issue_id, `The client was asked through the CRM (request \`${clientActionId}\`). When they answer, a person records it on the Ads page.`);
  return (await getProposal(rt.ctx, rt.companyId, p.id))!;
}

/** A person did the change in the ad platform themselves (writes are off, or it was quicker): the loop closes with their word. */
export async function markDoneManually(rt: AdsRuntime, input: { proposalId: string; userId: string | null; note?: string | null }): Promise<ProposalRow> {
  if (!input.userId) throw new AdsError("Only a signed-in person can say a change was made by hand.");
  const p = await getProposal(rt.ctx, rt.companyId, input.proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (p.status !== "approved") throw new AdsError("Only an approved change can be marked done. Approve it first.");
  await updateProposal(rt.ctx, rt.companyId, p.id, { status: "executed", executedNow: true, execution: { manual: true, by: `user:${input.userId}`, note: input.note?.slice(0, 400) ?? null } });
  await audit(rt.ctx, rt.companyId, { actor: `user:${input.userId}`, action: "proposal.done_manually", scopeKey: p.scope_key, subject: p.id, detail: { note: input.note?.slice(0, 200) ?? null } });
  await closeRunIssue(rt.ctx, rt.companyId, p.id, "A person made the change in the ad platform and marked it done.");
  return (await getProposal(rt.ctx, rt.companyId, p.id))!;
}

/**
 * The approval issue changed. Done by a person: they approve exactly these numbers. Cancelled by a person: they refuse. Closed by an agent
 * (the Reviewer, or the agent that asked): only a person decides, so it is reopened and handed back. Returns true when the issue is one of ours.
 */
export async function onApprovalIssue(rt: AdsRuntime, event: PluginEvent, issueStatus: string): Promise<boolean> {
  if (!event.entityId) return false;
  const p = await proposalByIssue(rt.ctx, rt.companyId, event.entityId);
  if (!p) return false;
  if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) return true;
  if (issueStatus !== "done" && issueStatus !== "cancelled") return true;
  // The plugin's own writes come back as events too: the host logs every plugin update as `issue.updated` by actor `plugin` and delivers it to the
  // plugin that made it. Closing the approval issue after a decision is one of them. It is never a decision, and must not be mistaken for an agent
  // closing the issue (which would reopen an approved change's issue and ask the owner again).
  if (event.actorType === "plugin") return true;
  if (event.actorType !== "user") {
    const reopened = await reopenApprovalForPerson(rt.ctx, { issueId: event.entityId, companyId: rt.companyId, what: `an ad change: ${p.title}` });
    if (!reopened) rt.ctx.logger.info("An ads approval closed by an agent could not be reopened", { proposalId: p.id, actorType: event.actorType ?? null });
    return true;
  }
  const userId = event.actorId ?? null;
  if (!userId) return true;
  // A pass already waiting for the other sign-off: the person who closes the issue is the owner's yes.
  try {
    await recordSignoff(rt, { proposalId: p.id, userId, role: "owner", decision: issueStatus === "done" ? "approved" : "rejected", via: "issue" });
  } catch (error) {
    // The yes cannot be recorded (over the cap, the Reviewer wants changes): the issue stays open with the reason.
    await rt.ctx.issues.update(event.entityId, { status: "todo" }, rt.companyId).catch(() => undefined);
    await note(rt.ctx, rt.companyId, event.entityId, `Not approved yet: ${errorMessage(error)}`);
  }
  return true;
}

/**
 * A run that has been "executing" this long was cut off (the worker stopped between claiming the change and writing its result). A call to a platform
 * takes seconds and a long list of campaigns a few minutes, so two hours is never a run still going.
 */
export const EXECUTING_STALE_MS = 2 * 3_600_000;

/**
 * Hourly: proposals nobody decided in 7 days expire; an approval that lapsed sends its proposal back to waiting; a run that was cut off is closed
 * as failed, loudly, so it does not read "Running" for ever. Nothing is retried: the approval was used up when the run was claimed, and the
 * platform may or may not have done the change, so a person looks before anything is asked again.
 */
export async function sweepProposals(rt: AdsRuntime): Promise<{ expired: number; lapsed: number; interrupted: number }> {
  let expired = 0;
  let lapsed = 0;
  let interrupted = 0;
  for (const p of await listProposals(rt.ctx, rt.companyId, { limit: 300 })) {
    if (p.status === "executing") {
      const since = p.updated_at ? Date.parse(p.updated_at) : Number.NaN;
      if (Number.isFinite(since) && rt.now().getTime() - since > EXECUTING_STALE_MS && (await transitionProposal(rt.ctx, rt.companyId, p.id, ["executing"], "failed"))) {
        const why = "The run was cut off before it recorded a result. The approval was used up when the run started and nothing is retried by itself. The change may or may not have happened in the ad platform: check the campaign there (and the next sync), then ask again with a new proposal if it is still wanted.";
        await updateProposal(rt.ctx, rt.companyId, p.id, { status: "failed", executedNow: true, execution: { ...(p.execution ?? {}), interrupted: true }, error: why.slice(0, 400) });
        await audit(rt.ctx, rt.companyId, { actor: "system", action: "write.interrupted", scopeKey: p.scope_key, subject: p.id, detail: { kind: p.kind, since: p.updated_at } });
        await note(rt.ctx, rt.companyId, p.approval_issue_id, `**Run cut off.** ${why}`);
        await closeRunIssue(rt.ctx, rt.companyId, p.id, `Closed: ${why}`);
        interrupted += 1;
      }
      continue;
    }
    if (!OPEN_PROPOSAL_STATUSES.includes(p.status)) continue;
    if (p.expires_at && Date.parse(p.expires_at) < rt.now().getTime()) {
      await updateProposal(rt.ctx, rt.companyId, p.id, { status: "expired" });
      await closeIssue(rt.ctx, rt.companyId, p.approval_issue_id, "cancelled", "Nobody decided this in 7 days, so it expired. Nothing was changed. Ask again if it is still wanted.");
      await closeIssue(rt.ctx, rt.companyId, p.client_ask_issue_id, "cancelled", "The change expired; no need to ask the client.");
      await audit(rt.ctx, rt.companyId, { actor: "system", action: "proposal.expired", scopeKey: p.scope_key, subject: p.id });
      expired += 1;
    } else if (p.status === "approved") {
      const before = p.status;
      const after = await refreshProposal(rt, p.id);
      if (after.status !== before) lapsed += 1;
    }
  }
  return { expired, lapsed, interrupted };
}

