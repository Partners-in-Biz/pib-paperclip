import { and, eq } from "drizzle-orm";
import { assets, caseAttachments, companyLogos, heartbeatRuns, issues, issueAttachments, runnerApiResponseReservations, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { refusedOnlyByMemberRestriction } from "./member-restriction/action-list.js";
import { canActorReadHeartbeatRun } from "./heartbeat-run-privacy.js";
import { canActorReadCase } from "./case-access.js";

type Asset = Pick<typeof assets.$inferSelect, "id" | "companyId" | "objectKey" | "createdByAgentId" | "createdByUserId">;

function namespace(asset: Asset) {
  const parts = asset.objectKey.split("/");
  return parts[1] === "assets" ? parts[2] : parts[1];
}

export async function isRunnerApiResponseAsset(db: Pick<Db, "select">, asset: Asset): Promise<boolean> {
  if (namespace(asset) === "runner-api") return true;
  return !!(await db.select({ id: runnerApiResponseReservations.id }).from(runnerApiResponseReservations)
    .where(and(eq(runnerApiResponseReservations.assetId, asset.id), eq(runnerApiResponseReservations.companyId, asset.companyId))).limit(1))[0];
}

export async function canActorReadAssetContent(db: Db, actor: AuthorizationActor, asset: Asset): Promise<boolean> {
  const access = authorizationService(db);
  // An assistant connection (mcp_oauth) carries its person only to narrow it
  // (rule group H); it never owns that person's runs or drafts (PAR-14559).
  const actingPersonId = actor.type === "agent" && actor.source !== "mcp_oauth" ? actor.onBehalfOfUserId : undefined;
  // A restricted member is refused `company_scope:read` by the action list; he
  // still reads an asset tied to a task, a run or a draft of his (PAR-12608 4.6).
  let restrictedMember = false;
  if (actor.type === "agent") {
    if (actor.companyId !== asset.companyId) return false;
  } else if (actor.type !== "board") return false;
  else {
    const scope = await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: asset.companyId } });
    if (!scope.allowed && !refusedOnlyByMemberRestriction(scope)) return false;
    restrictedMember = !scope.allowed;
  }
  // The company logo stays readable to him (PAR-12608 4.6, "Assets by id").
  if (restrictedMember && (await db.select({ id: companyLogos.id }).from(companyLogos)
    .where(and(eq(companyLogos.assetId, asset.id), eq(companyLogos.companyId, asset.companyId))).limit(1)).length) return true;
  const parts = asset.objectKey.split("/");
  const isDraft = parts[1] === "assets" && parts[2] === "issues" && parts[3] === "drafts";
  const sourceIssueId = parts[1] === "assets" ? parts[3] : parts[2];
  if (namespace(asset) === "issues" && !isDraft) {
    if (!sourceIssueId || !isUuidLike(sourceIssueId)) return false;
    const [issue] = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, asset.companyId))).limit(1);
    if (!issue || !(await access.decide({ actor, action: "issue:read", resource: {
      type: "issue", companyId: asset.companyId, issueId: sourceIssueId,
    } })).allowed) return false;
  }
  const captures = await db.select({ run: heartbeatRuns }).from(runnerApiResponseReservations)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, runnerApiResponseReservations.runId))
    .where(and(eq(runnerApiResponseReservations.assetId, asset.id), eq(runnerApiResponseReservations.companyId, asset.companyId)));
  if (namespace(asset) === "runner-api" && !captures.length) return false;
  for (const { run } of captures) {
    const owns = run && (actor.type === "agent"
      ? actor.agentId === run.agentId && (!run.responsibleUserId || actingPersonId === run.responsibleUserId)
      : actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin
        || (Boolean(actor.userId) && actor.userId === run.responsibleUserId)));
    if (!owns || !run || !(await canActorReadHeartbeatRun(db, access, actor, run))) return false;
  }
  const attachments = await db.select({ issueId: issueAttachments.issueId }).from(issueAttachments)
    .where(and(eq(issueAttachments.assetId, asset.id), eq(issueAttachments.companyId, asset.companyId)));
  if (isDraft && !attachments.length && !(actor.type === "board"
    ? actor.source === "local_implicit" || actor.isInstanceAdmin || actor.userId === asset.createdByUserId
    : actor.type === "agent" && actor.agentId === asset.createdByAgentId
      && (!asset.createdByUserId || actingPersonId === asset.createdByUserId))) return false;
  if (restrictedMember && !(namespace(asset) === "issues" && !isDraft) && !captures.length && !attachments.length
    && !(isDraft && actor.type === "board" && actor.userId === asset.createdByUserId)) return false;
  for (const attachment of attachments) {
    if (!(await access.decide({ actor, action: "issue:read", resource: {
      type: "issue", companyId: asset.companyId, issueId: attachment.issueId,
    } })).allowed) return false;
  }
  const caseLinks = await db.select({ caseId: caseAttachments.caseId }).from(caseAttachments)
    .where(and(eq(caseAttachments.assetId, asset.id), eq(caseAttachments.companyId, asset.companyId)));
  // A retained asset must not become company-readable when a case link is removed.
  // The upload namespace independently retains its original case identity.
  if (namespace(asset) === "cases") {
    if (!sourceIssueId || !isUuidLike(sourceIssueId)
      || !(await canActorReadCase(db, actor, { id: sourceIssueId, companyId: asset.companyId }))) return false;
  }
  for (const link of caseLinks) {
    if (!(await canActorReadCase(db, actor, { id: link.caseId, companyId: asset.companyId }))) return false;
  }
  return true;
}
