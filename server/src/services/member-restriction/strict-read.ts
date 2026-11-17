import { sql, type SQL } from "drizzle-orm";
import { companyMemberships, issueAccessGrants, issues, projectAccessMembers, projects, type Db } from "@paperclipai/db";
import { memberRestrictionEnforcedCompanyIds, memberRestrictionUnavailable } from "./resolver.js";

/**
 * The strict read condition for a restricted member (PAR-12608 4.3). The list
 * builders AND it onto the existing privacy condition and never rewrite it:
 *   existing condition for U AND (U is not restricted here OR strict condition for U)
 * When U is restricted nowhere under `enforce`, nothing is added and the SQL
 * text stays as it is today.
 */
export type StrictReadResource = "issue" | "project";

type RestrictionActor = {
  type: string;
  userId?: string | null;
  onBehalfOfUserId?: string | null;
  authorizingUserId?: string | null;
};

/** The people an actor carries a per-user condition for: the signed-in user, the person an agent works for, the authorizer. */
export function restrictionPersonIds(actor: RestrictionActor): string[] {
  const ids = [
    actor.type === "board" ? actor.userId : null,
    actor.type === "agent" ? actor.onBehalfOfUserId : null,
    actor.authorizingUserId,
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * The one function that builds the strict condition for person U.
 * - Project: U has a `project_access_members` row for it, any visibility.
 * - Task: on the task or any ancestor, any visibility, U is responsible person,
 *   creator or user assignee, holds an active grant, or is an access member of
 *   that node's project. Rights flow down only. The climb follows `parent_id`:
 *   `privacy_parent_issue_id` is not filled for every child task (PAR-12717).
 *   UNION stops a cycle in old data.
 * Both require U's membership in the row's company to be active (AC-X4).
 */
export function strictReadCondition(resource: StrictReadResource, personId: string): SQL<boolean> {
  const company = resource === "project" ? projects.companyId : issues.companyId;
  const activeMember = sql`exists (
    select 1 from ${companyMemberships} strict_member
    where strict_member.company_id = ${company} and strict_member.principal_type = 'user'
      and strict_member.principal_id = ${personId} and strict_member.status = 'active'
  )`;
  if (resource === "project") {
    return sql<boolean>`(${activeMember} and exists (
      select 1 from ${projectAccessMembers} strict_access
      where strict_access.company_id = ${projects.companyId} and strict_access.project_id = ${projects.id}
        and strict_access.subject_type = 'user' and strict_access.subject_id = ${personId}
    ))`;
  }
  return sql<boolean>`(${activeMember} and exists (
    with recursive strict_chain as (
      select s.id, s.company_id, s.parent_id, s.project_id, s.responsible_user_id, s.created_by_user_id, s.assignee_user_id
      from ${issues} s where s.id = ${issues.id} and s.company_id = ${issues.companyId}
      union
      select s.id, s.company_id, s.parent_id, s.project_id, s.responsible_user_id, s.created_by_user_id, s.assignee_user_id
      from strict_chain c join ${issues} s on s.id = c.parent_id and s.company_id = c.company_id
    )
    select 1 from strict_chain n
    where n.responsible_user_id = ${personId} or n.created_by_user_id = ${personId} or n.assignee_user_id = ${personId}
      or exists (
        select 1 from ${issueAccessGrants} strict_grant
        where strict_grant.issue_id = n.id and strict_grant.subject_type = 'user'
          and strict_grant.subject_id = ${personId} and strict_grant.revoked_at is null
      )
      or exists (
        select 1 from ${projectAccessMembers} strict_access
        where strict_access.company_id = n.company_id and strict_access.project_id = n.project_id
          and strict_access.subject_type = 'user' and strict_access.subject_id = ${personId}
      )
  ))`;
}

/**
 * The part the list builders add for an actor, or null when no person it
 * carries is restricted under `enforce`. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`, so the caller returns no data.
 */
export async function memberRestrictionReadCondition(
  db: Pick<Db, "select">,
  actor: RestrictionActor,
  resource: StrictReadResource,
): Promise<SQL<boolean> | null> {
  const company = resource === "project" ? projects.companyId : issues.companyId;
  const parts: SQL<boolean>[] = [];
  for (const personId of restrictionPersonIds(actor)) {
    let companyIds: string[];
    try {
      companyIds = await memberRestrictionEnforcedCompanyIds(db, personId);
    } catch (error) {
      throw memberRestrictionUnavailable(error);
    }
    if (companyIds.length === 0) continue;
    parts.push(sql<boolean>`(${company} not in (${sql.join(companyIds.map((id) => sql`${id}`), sql`, `)})
      or ${strictReadCondition(resource, personId)})`);
  }
  return parts.length === 0 ? null : sql<boolean>`(${sql.join(parts, sql` and `)})`;
}
