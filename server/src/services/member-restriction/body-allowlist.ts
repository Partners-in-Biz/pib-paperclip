import type { Request } from "express";
import type { z } from "zod";
import type { Db } from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE, createProjectSchema, updateProjectSchema } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionForActor } from "./actor-memberships.js";
import { memberRestrictionOrUnavailable, memberRestrictionResolver } from "./resolver.js";

/**
 * The body allowlist of PAR-12608 4.6 (PAR-12934, C4i-a): which keys of a
 * write body a caller bound by a restricted person may send. Default closed:
 * each map is typed against its schema's input keys, so a key added to the
 * schema later does not compile until it is classified here.
 *
 * - `allowed`: any value.
 * - `empty-only`: absent, `null` or `[]`; anything else is refused.
 * - `refused`: refused when present with any value, `null` and `{}` included.
 *
 * Only a caller bound under `enforce` is refused (403 `MEMBER_RESTRICTED`,
 * before anything is written); `report` records a would-refuse and goes on.
 * Every other caller, mode `off` and the kill switch run today's code.
 */

export type BodyFieldClass = "allowed" | "empty-only" | "refused";
export const MEMBER_RESTRICTION_BODY_RULE_ID = "R-body";

/** Project create (`POST /api/companies/:companyId/projects`). */
export const CREATE_PROJECT_BODY_ALLOWLIST = {
  idempotencyKey: "allowed",
  goalId: "allowed",
  goalIds: "allowed",
  name: "allowed",
  description: "allowed",
  visibility: "allowed",
  status: "allowed",
  targetDate: "allowed",
  color: "allowed",
  icon: "allowed",
  archivedAt: "allowed",
  // Binding a repository is the company's tool access (as `PUT .../repositories`).
  repositoryIds: "empty-only",
  repositoryUrls: "empty-only",
  leadAgentId: "empty-only",
  // Host configuration: secrets, host paths and commands, runtime, environment,
  // trust boundary, storage plugin. Whole keys, so a partial object cannot
  // replace the stored one.
  env: "refused",
  executionWorkspacePolicy: "refused",
  workspace: "refused",
} as const satisfies Record<keyof z.input<typeof createProjectSchema>, BodyFieldClass>;

/** Project patch (`PATCH /api/projects/:id`). */
export const UPDATE_PROJECT_BODY_ALLOWLIST = {
  goalId: "allowed",
  goalIds: "allowed",
  name: "allowed",
  description: "allowed",
  visibility: "allowed",
  status: "allowed",
  targetDate: "allowed",
  color: "allowed",
  icon: "allowed",
  archivedAt: "allowed",
  leadAgentId: "empty-only",
  env: "refused",
  // `services/projects.ts` writes the policy whole: `{ enabled: false }` would erase O's.
  executionWorkspacePolicy: "refused",
} as const satisfies Record<keyof z.input<typeof updateProjectSchema>, BodyFieldClass>;

export const MEMBER_RESTRICTION_BODY_ALLOWLISTS = {
  createProject: { schema: createProjectSchema, fields: CREATE_PROJECT_BODY_ALLOWLIST },
  updateProject: { schema: updateProjectSchema, fields: UPDATE_PROJECT_BODY_ALLOWLIST },
} as const;

export type MemberRestrictionBodySchemaKey = keyof typeof MEMBER_RESTRICTION_BODY_ALLOWLISTS;

const isEmpty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);

/** The keys of `body` a bound caller may not send, sorted. A key with no class is refused. */
export function refusedBodyKeys(schemaKey: MemberRestrictionBodySchemaKey, body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const fields: Record<string, BodyFieldClass | undefined> = MEMBER_RESTRICTION_BODY_ALLOWLISTS[schemaKey].fields;
  const refused: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    const fieldClass = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (fieldClass === "allowed") continue;
    if (fieldClass === "empty-only" && isEmpty(value)) continue;
    refused.push(key);
  }
  return refused.sort();
}

/**
 * The person and mode that bind this caller in one company: a restricted
 * person's own session, a run or key working for him, or a run he authorized.
 * Null when nothing binds (local board, kill switch, mode `off`, not
 * restricted). A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
async function bodyRestrictionBinding(db: Db, actor: Request["actor"], companyId: string) {
  if (!actor || actor.type === "none" || actor.source === "local_implicit") return null;
  const resolve = memberRestrictionResolver(db);
  const carried = await memberRestrictionForActor(resolve, actor, companyId);
  if (carried?.restricted && carried.mode !== "off") return { personId: carried.personId, mode: carried.mode };
  const authorizer = actor.authorizingUserId;
  if (!authorizer || authorizer === carried?.personId) return null;
  const answer = await memberRestrictionOrUnavailable(resolve, authorizer, companyId);
  return answer.restricted && answer.mode !== "off" ? { personId: authorizer, mode: answer.mode } : null;
}

/**
 * Refuse a body key a caller bound by a restricted person may not send. Call
 * it before the handler's first write. `enforce`: 403 `MEMBER_RESTRICTED`
 * naming the keys. `report`: one would-refuse record, then today's path.
 */
export async function assertRestrictedBodyAllowed(
  db: Db,
  req: Request,
  companyId: string,
  schemaKey: MemberRestrictionBodySchemaKey,
  body: unknown,
  objectId?: string | null,
): Promise<void> {
  const binding = await bodyRestrictionBinding(db, req.actor, companyId);
  if (!binding) return;
  const refused = refusedBodyKeys(schemaKey, body);
  if (refused.length === 0) return;
  await recordMemberRestrictionDenial(db, {
    companyId,
    personId: binding.personId,
    ruleId: MEMBER_RESTRICTION_BODY_RULE_ID,
    target: `${req.method.toUpperCase()} ${(req.originalUrl ?? req.url).split("?")[0]} ${refused.join(",")}`,
    objectId: objectId ?? null,
    mode: binding.mode,
  });
  if (binding.mode !== "enforce") return;
  throw forbidden(`Not available for your access level: ${refused.join(", ")}`, {
    code: MEMBER_RESTRICTED_CODE,
    refusedKeys: refused,
  });
}
