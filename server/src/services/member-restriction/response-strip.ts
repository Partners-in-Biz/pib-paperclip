import type { Response } from "express";
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
  // Project and execution workspace host fields.
  "cwd", "repoUrl", "setupCommand", "cleanupCommand", "runtimeConfig", "remoteWorkspaceRef", "sharedWorkspaceKey",
  // The host folders of a project's `codebase`.
  "localFolder", "managedFolder", "effectiveLocalFolder",
]);

/** The only `adapterConfig` keys a bound caller sees: the four he may set (C4i-b). */
const ALLOWED_ADAPTER_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.keys(TASK_KEPT_OBJECTS.assigneeAdapterOverrides.adapterConfig),
);

function stripReplacer(this: unknown, key: string, value: unknown): unknown {
  // Array indexes are not names; only an object's own keys are stripped.
  if (Array.isArray(this)) return value;
  if (MEMBER_RESTRICTION_STRIPPED_KEYS.has(key)) return undefined;
  if (key === "adapterConfig" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).filter(([name]) => ALLOWED_ADAPTER_CONFIG_KEYS.has(name)));
  }
  return value;
}

/** Whether a strip-set key sits at any depth: a cheap walk, so a frame without one needs no restriction read. */
export function hasHostKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHostKeys);
  if (!value || typeof value !== "object") return false;
  for (const [key, inner] of Object.entries(value)) {
    if (MEMBER_RESTRICTION_STRIPPED_KEYS.has(key)) return true;
    if (key === "adapterConfig" && inner && typeof inner === "object" && !Array.isArray(inner)
      && Object.keys(inner).some((name) => !ALLOWED_ADAPTER_CONFIG_KEYS.has(name))) return true;
    if (hasHostKeys(inner)) return true;
  }
  return false;
}

/** The value as JSON would send it, without the strip-set keys at any depth. */
export function withoutHostKeys<T>(value: T): T {
  if (value === undefined) return value;
  const text = JSON.stringify(value, stripReplacer);
  return text === undefined ? value : JSON.parse(text);
}

/** Every `res.json` (and `res.send` of an object) of this response goes out without the strip-set keys. */
export function stripHostKeysFromResponses(res: Response): void {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => json(withoutHostKeys(body));
}
