/**
 * Subagent policy parsing and rendering for pack v2.
 * No node imports: this module is browser-safe.
 */

export interface SubagentPolicy {
  allowed: string[];
  model: string;
  maxParallel: number;
}

/**
 * Parses and validates the subagents manifest field.
 * @param raw the manifest field value
 * @param where the context for error messages (e.g., "ceo")
 * @returns the policy, or undefined if raw is undefined
 * @throws Error with `where` in the message on bad shape
 */
export function parseSubagents(raw: unknown, where: string): SubagentPolicy | undefined {
  if (raw === undefined) return undefined;

  const value = raw as Record<string, unknown>;
  const allowed = value.allowed;
  const model = value.model;
  const maxParallel = value.maxParallel;

  // Validate allowed is an array of non-empty strings with no duplicates
  if (!Array.isArray(allowed)) {
    throw new Error(`${where}: subagents.allowed must be an array`);
  }

  for (const item of allowed) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${where}: subagents.allowed must be an array of non-empty strings`);
    }
  }

  const allowedSet = new Set(allowed);
  if (allowedSet.size !== allowed.length) {
    throw new Error(`${where}: subagents.allowed has duplicates`);
  }

  // Validate model: non-empty string when allowed is non-empty, can be empty when allowed is empty
  if (typeof model !== "string") {
    throw new Error(`${where}: subagents.model must be a string`);
  }

  if (allowed.length > 0 && model.length === 0) {
    throw new Error(`${where}: subagents.model must be non-empty when subagents.allowed is non-empty`);
  }

  // Validate maxParallel: integer >= 0, and 0 only when allowed is empty
  if (!Number.isInteger(maxParallel)) {
    throw new Error(`${where}: subagents.maxParallel must be an integer`);
  }

  if ((maxParallel as number) < 0) {
    throw new Error(`${where}: subagents.maxParallel must be >= 0`);
  }

  if (allowed.length === 0 && (maxParallel as number) !== 0) {
    throw new Error(`${where}: subagents.maxParallel must be 0 when subagents.allowed is empty`);
  }

  return {
    allowed: allowed as string[],
    model: model as string,
    maxParallel: maxParallel as number,
  };
}

/**
 * Extra CLI arguments for running subagents with the given policy.
 * @param policy the subagent policy, or undefined for no policy
 * @returns an array of CLI arguments (--disallowedTools/--allowedTools flags)
 */
export function subagentExtraArgs(p: SubagentPolicy | undefined): string[] {
  if (!p) {
    return [];
  }

  if (p.allowed.length === 0) {
    return ["--disallowedTools", "Task,Agent"];
  }

  const toolsList = [
    ...p.allowed.map((name) => `Task(${name})`),
    ...p.allowed.map((name) => `Agent(${name})`),
  ].join(",");
  return ["--allowedTools", toolsList];
}

/**
 * Prose text for the `_subagents` shared block in the agent instructions.
 * @param p the subagent policy, or undefined
 * @returns the text to include in AGENTS.md
 */
export function subagentsText(p: SubagentPolicy | undefined): string {
  if (!p || p.allowed.length === 0) {
    return "You do not spawn subagents. Do the work yourself.";
  }

  const names = p.allowed.join(", ");
  return `You may spawn these subagents (model ${p.model}): ${names}. Run at most ${p.maxParallel} at once. Give each a precise, file-level brief and check its output before you rely on it.`;
}
