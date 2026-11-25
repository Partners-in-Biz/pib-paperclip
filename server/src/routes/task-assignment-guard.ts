import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  actorMayInstructAgent,
  MEMBER_AGENT_NOT_LISTED_DETAILS,
  MEMBER_AGENT_NOT_LISTED_ROUTE_MESSAGE,
} from "../services/member-restriction/agent-read.js";
import { assertCompanyAccess } from "./authz.js";

export type TaskAssignmentAuthorizationScope = {
  issueId?: string | null;
  projectId?: string | null;
  parentIssueId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

/**
 * The assignment checks of `POST /companies/:companyId/issues`, for every
 * path that creates or assigns work for a person (task routes, canvas
 * mentions). `restrictedTaskBody` leaves `assigneeAgentId` and `projectId`
 * (class `checked`) to this: the `tasks:assign` decision (with the strict
 * project read for a restricted member) and, PAR-12608 4.7 (AC-A2, AC-A4),
 * naming an agent needs it on his list; naming a person, or nobody, stays
 * allowed.
 */
export async function assertCanAssignTasks(
  db: Db,
  req: Request,
  companyId: string,
  assignmentScope?: TaskAssignmentAuthorizationScope,
  access: Pick<ReturnType<typeof accessService>, "decide"> = accessService(db),
) {
  assertCompanyAccess(req, companyId);
  const decision = await access.decide({
    actor: req.actor,
    action: "tasks:assign",
    resource: {
      type: "issue",
      companyId,
      issueId: assignmentScope?.issueId ?? null,
      projectId: assignmentScope?.projectId ?? null,
      parentIssueId: assignmentScope?.parentIssueId ?? null,
      assigneeAgentId: assignmentScope?.assigneeAgentId ?? null,
      assigneeUserId: assignmentScope?.assigneeUserId ?? null,
    },
    scope: assignmentScope ?? null,
  });
  if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  const agentId = assignmentScope?.assigneeAgentId;
  if (agentId && !(await actorMayInstructAgent(db, req.actor, { companyId, agentId, target: "tasks:assign" }))) {
    throw forbidden(MEMBER_AGENT_NOT_LISTED_ROUTE_MESSAGE, MEMBER_AGENT_NOT_LISTED_DETAILS);
  }
}
