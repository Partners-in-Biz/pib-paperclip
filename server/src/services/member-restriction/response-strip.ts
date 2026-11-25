import type { Response } from "express";
import type { ProjectExecutionWorkspaceDefaultMode } from "@paperclipai/shared";
import { TASK_KEPT_OBJECTS } from "./body-allowlist.js";

/**
 * PAR-12951 (C4i-c, spec PAR-12608 rev 3, 4.5 and 4.6: secrets "Never"):
 * host and secret fields never reach a caller bound by a restricted person
 * under `enforce`, at any depth of a JSON response or a live-event frame.
 * One strip, not one per route, so an embedded object (a task's `project`, a
 * project's `workspaces`) cannot carry them past it.
 *
 * Removed by leaf name, wherever it sits. A name that also means something
 * harmless elsewhere is removed too (fail closed).
 */
export const MEMBER_RESTRICTION_STRIPPED_KEYS: ReadonlySet<string> = new Set([
  // Every `refused` key of the project body maps (C4i-a).
  "env", "executionWorkspacePolicy", "workspace",
  // Every `keep-stored` key of the task kept objects (C4i-b).
  "sharedWorkspaceConcurrency", "environmentId", "workspaceRuntime", "networkEgress", "branchTemplate", "existingBranch",
  "worktreeParentDir", "provisionCommand", "runtimeProvisionCommand", "teardownCommand", "useProjectWorkspace",
  "authorizationPolicy",
  // Project and execution workspace host fields. `providerRef` of a local worktree is its host path (PAR-13327).
  "cwd", "repoUrl", "setupCommand", "cleanupCommand", "runtimeConfig", "remoteWorkspaceRef", "sharedWorkspaceKey",
  "providerRef",
  // The host folders of a project's `codebase`.
  "localFolder", "managedFolder", "effectiveLocalFolder",
  // A project's `workspaceProvider.effectivePolicy`: the same policy, resolved (projected below).
  "effectivePolicy",
]);

/**
 * PAR-14313 (AC-G10, spec 4.6): R still picks a workspace mode on his own task,
 * and the three mode pickers need to know the project allows one. These keys
 * are not dropped but cut to the named fields, each a boolean or a mode name;
 * no host path, command, environment, strategy or policy object passes.
 */
const WORKSPACE_MODES: ReadonlySet<string> = new Set([
  "shared_workspace", "isolated_workspace", "operator_branch", "adapter_default",
] satisfies ProjectExecutionWorkspaceDefaultMode[]);
const POLICY_PROJECTION: Record<string, (value: unknown) => boolean> = {
  enabled: (value) => typeof value === "boolean",
  allowIssueOverride: (value) => typeof value === "boolean",
  defaultMode: (value) => typeof value === "string" && WORKSPACE_MODES.has(value),
};
export const MEMBER_RESTRICTION_PROJECTED_KEYS: ReadonlySet<string> = new Set(["executionWorkspacePolicy", "effectivePolicy"]);
export const MEMBER_RESTRICTION_POLICY_FIELDS: readonly string[] = Object.keys(POLICY_PROJECTION);

/** The policy as a bound caller sees it: null stays null; anything but an object is dropped. */
function projectedPolicy(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([name, inner]) => Object.hasOwn(POLICY_PROJECTION, name) && POLICY_PROJECTION[name]!(inner)));
}

/**
 * The only `adapterConfig` keys a bound caller sees: the four he may set (C4i-b).
 * Built on first use: this module and `body-allowlist.ts` sit in one import cycle, so when
 * `body-allowlist.ts` is loaded first its map does not exist yet while this module loads.
 */
let allowedAdapterConfigKeys: ReadonlySet<string> | null = null;
const isAllowedAdapterConfigKey = (name: string) => (allowedAdapterConfigKeys ??= new Set(
  Object.keys(TASK_KEPT_OBJECTS.assigneeAdapterOverrides.adapterConfig),
)).has(name);

/*
 * PAR-13327 (C4i-f): keys that are host values only under a named parent. By
 * leaf name, `command` and `metadata` would also cut R's own run transcript
 * tool calls and comment payloads, so they are stripped only here. A cut
 * returns its input unchanged when it has nothing to drop; `hasHostKeys` uses
 * that to tell a frame that needs a restriction read.
 */
type Cut = (value: unknown) => unknown;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const pick = (value: Record<string, unknown>, keep: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => keep(key)));
const eachEntry = (cut: Cut): Cut => (value) => {
  if (!Array.isArray(value)) return cut(value);
  const out = value.map(cut);
  return out.some((entry, index) => entry !== value[index]) ? out : value;
};

/** A runtime service's host shell command and stop policy. */
const RUNTIME_SERVICE_HOST_KEYS: readonly string[] = ["command", "stopPolicy"];
const runtimeService: Cut = (value) => (isRecord(value) && RUNTIME_SERVICE_HOST_KEYS.some((key) => key in value)
  ? pick(value, (key) => !RUNTIME_SERVICE_HOST_KEYS.includes(key)) : value);

/** An execution workspace's `metadata` (it holds the `remoteWorkspace` authority) is dropped whole. */
const executionWorkspace: Cut = (value) => (isRecord(value) && "metadata" in value
  ? pick(value, (key) => key !== "metadata") : value);

/** A project workspace's `metadata` is cut to what the UI reads: an id, not a host value. */
const PROJECT_WORKSPACE_METADATA_KEYS: ReadonlySet<string> = new Set(["githubRepositoryId"]);
const projectWorkspace: Cut = (value) => {
  if (!isRecord(value) || value.metadata == null) return value;
  const metadata = value.metadata;
  if (isRecord(metadata) && Object.keys(metadata).every((key) => PROJECT_WORKSPACE_METADATA_KEYS.has(key))) return value;
  return { ...value, metadata: isRecord(metadata) ? pick(metadata, (key) => PROJECT_WORKSPACE_METADATA_KEYS.has(key)) : null };
};

/** The parent keys bound to a cut. A `command` or `metadata` anywhere else passes. */
const BOUND_PARENTS: ReadonlyMap<string, Cut> = new Map([
  ["runtimeServices", eachEntry(runtimeService)],
  ["executionWorkspace", executionWorkspace],
  ["currentExecutionWorkspace", executionWorkspace],
  ["workspaces", eachEntry(projectWorkspace)],
  ["primaryWorkspace", projectWorkspace],
]);

/** Routes whose whole body is one workspace or a list of them, as `METHOD path` of the route table. */
const BOUND_ROOTS: ReadonlyMap<string, Cut> = new Map([
  ["GET /api/execution-workspaces/:id", executionWorkspace],
  ["GET /api/projects/:id/workspaces", eachEntry(projectWorkspace)],
]);

function stripReplacer(this: unknown, key: string, value: unknown): unknown {
  // Array indexes are not names; only an object's own keys are stripped.
  if (Array.isArray(this)) return value;
  if (MEMBER_RESTRICTION_PROJECTED_KEYS.has(key)) return projectedPolicy(value);
  if (MEMBER_RESTRICTION_STRIPPED_KEYS.has(key)) return undefined;
  if (key === "adapterConfig" && isRecord(value)) return pick(value, (name) => isAllowedAdapterConfigKey(name));
  // JSON.stringify walks the cut value next, so the leaf strip still applies inside it.
  const cut = BOUND_PARENTS.get(key);
  return cut ? cut(value) : value;
}

/** Whether a strip-set key sits at any depth: a cheap walk, so a frame without one needs no restriction read. */
export function hasHostKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHostKeys);
  if (!value || typeof value !== "object") return false;
  for (const [key, inner] of Object.entries(value)) {
    if (MEMBER_RESTRICTION_STRIPPED_KEYS.has(key)) return true;
    if (key === "adapterConfig" && isRecord(inner)
      && Object.keys(inner).some((name) => !isAllowedAdapterConfigKey(name))) return true;
    const cut = BOUND_PARENTS.get(key);
    if (cut && cut(inner) !== inner) return true;
    if (hasHostKeys(inner)) return true;
  }
  return false;
}

/** The value as JSON would send it, without the strip-set keys at any depth. `route` binds the top-level body. */
export function withoutHostKeys<T>(value: T, route?: string): T {
  if (value === undefined) return value;
  const rootCut = route ? BOUND_ROOTS.get(route) : undefined;
  const text = JSON.stringify(rootCut ? rootCut(value) : value, stripReplacer);
  return text === undefined ? value : JSON.parse(text);
}

/** Every `res.json` (and `res.send` of an object) of this response goes out without the strip-set keys. */
export function stripHostKeysFromResponses(res: Response, route?: string): void {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => json(withoutHostKeys(body, route));
}
