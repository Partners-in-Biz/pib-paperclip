import { isDeepStrictEqual } from "node:util";
import type { Request } from "express";
import type { z } from "zod";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import {
  MEMBER_RESTRICTED_CODE, createChildIssueSchema, createIssueSchema, createProjectSchema, issueExecutionPolicySchema,
  issueExecutionWorkspaceSettingsSchema, updateIssueSchema, updateProjectSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionForActor } from "./actor-memberships.js";
import { memberRestrictionOrUnavailable, memberRestrictionResolver, memberRestrictionUnavailable } from "./resolver.js";
import { strictReadCondition } from "./strict-read.js";

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

/**
 * Task bodies (PAR-12950, C4i-b). Classes beyond the project ones:
 * - `checked`: allowed; a later check in the handler answers for R (strict read, agent list, H2).
 * - `self-only`: absent, `null`, the bound person or the stored value.
 * - `off-only`: absent or `false`.
 * - `keep-stored`: an object whose host keys R can neither set nor clear (`TASK_KEPT_OBJECTS`).
 * - `reference`: another object's id; R must be able to read its target (`unreadableReference`, C4i-b2).
 */
export type TaskBodyFieldClass = BodyFieldClass | "checked" | "self-only" | "off-only" | "keep-stored" | "reference";
type KeptMap = { [key: string]: "allowed" | "keep-stored" | KeptMap };
type KeysOf<T> = T extends unknown ? keyof T : never;
type CreateTask = z.output<typeof createIssueSchema>;
type WorkspaceSettings = z.output<typeof issueExecutionWorkspaceSettingsSchema>;

const TASK_COMMON = {
  title: "allowed", description: "allowed", status: "allowed", priority: "allowed", workMode: "allowed",
  visibility: "allowed", labelIds: "allowed", goalId: "allowed", requestDepth: "allowed", billingCode: "allowed",
  unblockDescriptor: "allowed", executionWorkspacePreference: "allowed",
  projectId: "checked", parentId: "checked", assigneeAgentId: "checked",
  // No read check on a blocker id and no agent-list check on a watchdog at this base: clear only.
  blockedByIssueIds: "empty-only", assigneeUserId: "self-only",
  executionWorkspaceSettings: "keep-stored", assigneeAdapterOverrides: "keep-stored", executionPolicy: "keep-stored",
  inheritExecutionWorkspaceFromIssueId: "reference", executionWorkspaceId: "reference", projectWorkspaceId: "reference",
  harnessKind: "off-only", reviewPolicy: "off-only",
} as const;
const TASK_CREATE_BASE = {
  watchdog: "empty-only", createdByUserId: "checked", responsibleUserId: "checked", workspaceSelection: "reference",
} as const;

/** Task create (`POST /api/companies/:companyId/issues`). */
export const CREATE_TASK_BODY_ALLOWLIST = {
  ...TASK_COMMON, ...TASK_CREATE_BASE, watchdogDiscovery: "allowed", initialPlan: "allowed", idempotencyKey: "allowed",
  allowDuplicate: "allowed", deferInitialWakeup: "allowed", onboardingFirstTask: "off-only",
} as const satisfies Record<keyof CreateTask, TaskBodyFieldClass>;
/** Child create (`POST /api/issues/:id/children`). */
const { parentId: _parent, inheritExecutionWorkspaceFromIssueId: _inherit, ...TASK_CHILD_COMMON } = TASK_COMMON;
export const CREATE_CHILD_TASK_BODY_ALLOWLIST = {
  ...TASK_CHILD_COMMON, ...TASK_CREATE_BASE, acceptanceCriteria: "allowed", blockParentUntilDone: "checked",
} as const satisfies Record<keyof z.output<typeof createChildIssueSchema>, TaskBodyFieldClass>;
/** Task patch (`PATCH /api/issues/:id`); `interrupt` is the route schema's own key. */
export const UPDATE_TASK_BODY_ALLOWLIST = {
  ...TASK_COMMON, watchdogDiscovery: "allowed", expectedStatusVersion: "allowed", expectedExecutionPolicy: "allowed",
  comment: "allowed", commentClientRequestId: "allowed", reopen: "allowed", deferWakeForGoal: "allowed", hiddenAt: "allowed",
  // The service binds only this task's attachments; the patch ignores a board caller's acting person.
  attachmentIds: "checked", onBehalfOfUserId: "checked",
  // `resume` asks for follow-up on his own task (CLI `--resume`, MCP patch; PAR-13135 tests it for R).
  resume: "allowed",
  reviewInteractionId: "off-only", reviewRequest: "off-only", interrupt: "off-only",
} as const satisfies Record<keyof z.output<typeof updateIssueSchema> | "interrupt", TaskBodyFieldClass>;

/** One level into the objects: `allowed` keys any value; every other key (any `adapterConfig` key not named) is kept. */
export const TASK_KEPT_OBJECTS = {
  executionWorkspaceSettings: {
    mode: "allowed", sharedWorkspaceConcurrency: "keep-stored", environmentId: "keep-stored",
    workspaceRuntime: "keep-stored", networkEgress: "keep-stored",
    workspaceStrategy: {
      type: "allowed", baseRef: "allowed", branchTemplate: "keep-stored", existingBranch: "keep-stored",
      worktreeParentDir: "keep-stored", provisionCommand: "keep-stored", runtimeProvisionCommand: "keep-stored",
      teardownCommand: "keep-stored",
    } satisfies Record<keyof NonNullable<WorkspaceSettings["workspaceStrategy"]>, "allowed" | "keep-stored">,
  } satisfies Record<keyof WorkspaceSettings, KeptMap[string]>,
  assigneeAdapterOverrides: {
    useProjectWorkspace: "keep-stored",
    adapterConfig: { model: "allowed", effort: "allowed", modelReasoningEffort: "allowed", variant: "allowed" },
  } satisfies Record<keyof NonNullable<CreateTask["assigneeAdapterOverrides"]>, KeptMap[string]>,
  executionPolicy: {
    requiredQualityReview: "allowed", mode: "allowed", commentRequired: "allowed", stages: "allowed", monitor: "allowed",
    reviewPreset: "allowed", maxReviewRounds: "allowed", authorizationPolicy: "keep-stored",
  } satisfies Record<keyof z.output<typeof issueExecutionPolicySchema>, KeptMap[string]>,
} as const;
/** `workspaceSelection` per kind: the ids are references (C4i-b2). */
export const TASK_WORKSPACE_SELECTION_KEYS = {
  kind: "allowed", mode: "allowed", workspaceId: "reference", projectWorkspaceId: "reference",
} as const satisfies Record<KeysOf<NonNullable<CreateTask["workspaceSelection"]>>, "allowed" | "reference">;

export const MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS = {
  createIssue: { schema: createIssueSchema, fields: CREATE_TASK_BODY_ALLOWLIST },
  createChildIssue: { schema: createChildIssueSchema, fields: CREATE_CHILD_TASK_BODY_ALLOWLIST },
  updateIssue: { schema: updateIssueSchema, fields: UPDATE_TASK_BODY_ALLOWLIST },
} as const;
export type MemberRestrictionTaskBodyKey = keyof typeof MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS;

/** What the guard compares against: the task as stored (patch), or nothing (create). */
export type StoredTaskBody = {
  assigneeUserId?: string | null; executionWorkspaceId?: string | null; executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown; executionPolicy?: unknown;
} | null;

const isNil = (value: unknown) => value === undefined || value === null;
const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keptClass = (map: KeptMap, key: string) => (Object.hasOwn(map, key) ? map[key]! : "keep-stored");
function hasKept(map: KeptMap, stored: Record<string, unknown>): boolean {
  return Object.entries(stored).some(([key, value]) => {
    const kind = keptClass(map, key);
    return kind === "allowed" ? false : typeof kind === "object" ? hasKept(kind, recordOf(value)) : !isNil(value);
  });
}
/**
 * Absent or null: the stored value goes back in. Equal: kept. Anything else: refused.
 * A stored strategy is read only with its `type` (`parseExecutionWorkspaceStrategy`), so
 * when kept keys go back the stored `type` goes with them unless the body names one.
 */
function mergeKept(path: string, map: KeptMap, value: Record<string, unknown>, stored: Record<string, unknown>,
  refused: string[]): Record<string, unknown> {
  const out = { ...value };
  if (map.type === "allowed" && isNil(value.type) && !isNil(stored.type) && hasKept(map, stored)) out.type = stored.type;
  for (const key of new Set([...Object.keys(value), ...Object.keys(stored)])) {
    const kind = keptClass(map, key);
    if (kind === "allowed") continue;
    if (typeof kind === "object") {
      if (value[key] === undefined) {
        if (hasKept(kind, recordOf(stored[key]))) out[key] = stored[key];
        continue;
      }
      const inner = mergeKept(`${path}.${key}`, kind, recordOf(value[key]), recordOf(stored[key]), refused);
      out[key] = value[key] === null && Object.keys(inner).length === 0 ? null : inner;
    } else if (isNil(value[key])) {
      if (!isNil(stored[key])) out[key] = stored[key];
    } else if (!isDeepStrictEqual(value[key], stored[key])) refused.push(`${path}.${key}`);
  }
  return out;
}

/** A user named on a review stage is R himself or already on the stored stages: no person check exists there yet. */
function stageUsers(policy: unknown): string[] {
  const stages = recordOf(policy).stages;
  return (Array.isArray(stages) ? stages : []).flatMap((stage) => {
    const participants = recordOf(stage).participants;
    return (Array.isArray(participants) ? participants : []).map((item) => recordOf(item).userId)
      .filter((id): id is string => typeof id === "string");
  });
}

/** The keys R may not send, and the body with the stored host keys put back. */
export function restrictedTaskBodyKeys(schemaKey: MemberRestrictionTaskBodyKey, body: Record<string, unknown>,
  stored: StoredTaskBody, personId: string): { refused: string[]; merged: Record<string, unknown> } {
  const fields: Record<string, TaskBodyFieldClass | undefined> = MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS[schemaKey].fields;
  const kept: Record<string, KeptMap> = TASK_KEPT_OBJECTS;
  const refused: string[] = [];
  const merged = { ...body };
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    const kind = Object.hasOwn(fields, key) ? fields[key] : undefined;
    // A reference is read-checked by `unreadableReference`, not refused by key.
    if (kind === "allowed" || kind === "checked" || kind === "reference") continue;
    if (kind === "empty-only" && isEmpty(value)) continue;
    if (kind === "off-only" && value === false) continue;
    if (kind === "self-only" && (value === null || value === personId || value === stored?.assigneeUserId)) continue;
    if (kind === "keep-stored") {
      const storedValue = recordOf(stored?.[key as keyof NonNullable<StoredTaskBody>]);
      if (value === null) {
        if (hasKept(kept[key]!, storedValue)) refused.push(key);
        continue;
      }
      merged[key] = mergeKept(key, kept[key]!, recordOf(value), storedValue, refused);
      continue;
    }
    refused.push(key);
  }
  const allowedUsers = new Set([personId, ...stageUsers(stored?.executionPolicy)]);
  if (stageUsers(body.executionPolicy).some((id) => !allowedUsers.has(id))) refused.push("executionPolicy.stages");
  // A save after a read without the kept keys (C4i-c) compares against the stored policy whole.
  const storedAuthorization = recordOf(stored?.executionPolicy).authorizationPolicy;
  const expected = body.expectedExecutionPolicy;
  if (expected && typeof expected === "object" && !isNil(storedAuthorization) && recordOf(expected).authorizationPolicy === undefined) {
    merged.expectedExecutionPolicy = { ...recordOf(expected), authorizationPolicy: storedAuthorization };
  }
  return { refused: [...new Set(refused)].sort(), merged };
}

type UnreadableReference = { key: string; message: string };

/**
 * The first `reference` key whose target R cannot read, with today's
 * not-found message; null when all pass. A target that is not there (or in
 * another company) passes: today's code answers for it.
 * - `inheritExecutionWorkspaceFromIssueId`: the task passes R's strict `issue:read`.
 * - `executionWorkspaceId`, `workspaceSelection.workspaceId` (`existing`): the
 *   stored one, or the workspace's `sourceIssueId` is a task R can read.
 * - `projectWorkspaceId`, `workspaceSelection.projectWorkspaceId`
 *   (`configured_source`): the workspace's project passes R's strict `project:read`.
 */
export async function unreadableReference(db: Db, companyId: string, body: Record<string, unknown>, stored: StoredTaskBody,
  personId: string): Promise<UnreadableReference | null> {
  // The condition goes in WHERE: a single-table select list drops the table
  // names its correlated subqueries rely on (as `strictReadableIds`).
  const readable = async (resource: "issue" | "project", id: string) => {
    const table = resource === "issue" ? issues : projects;
    const target = and(eq(table.id, id), eq(table.companyId, companyId));
    const [row] = await db.select({ id: table.id }).from(table).where(and(target, strictReadCondition(resource, personId)));
    if (row) return true;
    return (await db.select({ id: table.id }).from(table).where(target)).length > 0 ? false : null;
  };
  const selection = recordOf(body.workspaceSelection);
  const source = body.inheritExecutionWorkspaceFromIssueId;
  if (typeof source === "string" && (await readable("issue", source)) === false) {
    return { key: "inheritExecutionWorkspaceFromIssueId", message: "Workspace inheritance issue not found" };
  }
  const executionIds: [string, unknown][] = [["executionWorkspaceId", body.executionWorkspaceId],
    ["workspaceSelection.workspaceId", selection.kind === "existing" ? selection.workspaceId : null]];
  for (const [key, id] of executionIds) {
    if (typeof id !== "string" || id === stored?.executionWorkspaceId) continue;
    const [workspace] = await db.select({ sourceIssueId: executionWorkspaces.sourceIssueId }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.id, id), eq(executionWorkspaces.companyId, companyId)));
    if (workspace && !(workspace.sourceIssueId && (await readable("issue", workspace.sourceIssueId)))) {
      return { key, message: "Execution workspace not found" };
    }
  }
  const projectIds: [string, unknown][] = [["projectWorkspaceId", body.projectWorkspaceId],
    ["workspaceSelection.projectWorkspaceId", selection.kind === "configured_source" ? selection.projectWorkspaceId : null]];
  for (const [key, id] of projectIds) {
    if (typeof id !== "string") continue;
    const [workspace] = await db.select({ projectId: projectWorkspaces.projectId }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.id, id), eq(projectWorkspaces.companyId, companyId)));
    if (workspace && !(await readable("project", workspace.projectId))) return { key, message: "Project workspace not found" };
  }
  return null;
}

type TaskBodyBinding = { personId: string; mode: "report" | "enforce" };

/**
 * The guard both entry points share. `enforce`: 403 `MEMBER_RESTRICTED` naming
 * the refused keys, then 404 with today's not-found body for an unreadable
 * reference, else the body with the stored host keys put back. `report`: one
 * would-refuse record per finding and the body unchanged. A failed read is 503.
 */
async function applyTaskBodyRestriction(db: Db, binding: TaskBodyBinding | null, companyId: string,
  schemaKey: MemberRestrictionTaskBodyKey, body: Record<string, unknown>, stored: StoredTaskBody, target: string,
  objectId?: string | null): Promise<Record<string, unknown>> {
  if (!binding || !body || typeof body !== "object") return body;
  const { refused, merged } = restrictedTaskBodyKeys(schemaKey, body, stored, binding.personId);
  const record = (what: string) => recordMemberRestrictionDenial(db, {
    companyId, personId: binding.personId, ruleId: MEMBER_RESTRICTION_BODY_RULE_ID, objectId: objectId ?? null,
    mode: binding.mode, target: `${target} ${what}`,
  });
  if (refused.length > 0) {
    await record(refused.join(","));
    if (binding.mode === "enforce") {
      throw forbidden(`Not available for your access level: ${refused.join(", ")}`, { code: MEMBER_RESTRICTED_CODE, refusedKeys: refused });
    }
  }
  let unreadable: UnreadableReference | null;
  try {
    unreadable = await unreadableReference(db, companyId, body, stored, binding.personId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (unreadable) {
    await record(unreadable.key);
    if (binding.mode === "enforce") throw notFound(unreadable.message);
  }
  return binding.mode === "enforce" ? merged : body;
}

/**
 * Task create, child create and patch for a caller bound by a restricted
 * person. Call it before the handler's first write and pass the returned body
 * on. Not bound: the body unchanged.
 */
export async function restrictedTaskBody(db: Db, req: Request, companyId: string, schemaKey: MemberRestrictionTaskBodyKey,
  body: Record<string, unknown>, stored: StoredTaskBody, objectId?: string | null): Promise<Record<string, unknown>> {
  const binding = await bodyRestrictionBinding(db, req.actor, companyId);
  const target = `${req.method.toUpperCase()} ${(req.originalUrl ?? req.url).split("?")[0]}`;
  return applyTaskBodyRestriction(db, binding, companyId, schemaKey, body, stored, target, objectId);
}

/**
 * The same guard for a plugin task write made for an acting person (H3,
 * `invocationScope.actingPersonId`). No acting person, kill switch, mode `off`
 * or not restricted: the body unchanged. A failed read throws 503.
 */
export async function restrictedPluginTaskBody(db: Db, personId: string | null, companyId: string,
  schemaKey: "createIssue" | "updateIssue", body: Record<string, unknown>, stored: StoredTaskBody, target: string,
  objectId?: string | null): Promise<Record<string, unknown>> {
  if (!personId) return body;
  const answer = await memberRestrictionOrUnavailable(memberRestrictionResolver(db), personId, companyId);
  const binding = answer.restricted && answer.mode !== "off" ? { personId, mode: answer.mode } : null;
  return applyTaskBodyRestriction(db, binding, companyId, schemaKey, body, stored, target, objectId);
}
