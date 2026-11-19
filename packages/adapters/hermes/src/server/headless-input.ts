/**
 * Headless-safety helpers for hermes_local (PAR-13559).
 *
 * Hermes detaches a finite (`chat -Q`) run with exit 3 and the stderr line
 * "Input required; detached without cancelling. Resume this session
 * interactively." when an interactive control (a `clarify` question or an
 * approval prompt) is pending. Paperclip runs have no human to answer, so such
 * a run only burns retries.
 */

/** Toolsets that ask the human a question; useless without a TTY. */
const INTERACTIVE_TOOLSETS = new Set(["clarify"]);

const INPUT_REQUIRED_REGEX = /Input required; detached without cancelling/i;

/** Drop interactive toolsets from an explicit comma-separated toolset list. */
export function stripInteractiveToolsets(toolsets: string | undefined): string | undefined {
  if (!toolsets) return toolsets;
  const kept = toolsets
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !INTERACTIVE_TOOLSETS.has(s.toLowerCase()));
  return kept.length > 0 ? kept.join(",") : undefined;
}

/**
 * Marks the Hermes process as single-query so approval gates deny instantly
 * instead of waiting for a human (approvals.single_query_mode), and never
 * overrides an operator's explicit value.
 */
export function applyHeadlessEnv(env: Record<string, string>): void {
  if (env.HERMES_SINGLE_QUERY_SESSION === undefined) env.HERMES_SINGLE_QUERY_SESSION = "1";
}

/** Actionable error when Hermes detached waiting for input, else null. */
export function detectInputRequired(stdout: string, stderr: string): string | null {
  if (!INPUT_REQUIRED_REGEX.test(`${stderr}\n${stdout}`)) return null;
  return (
    "Hermes needs interactive input in a headless run (a clarify question or approval prompt) " +
    "and detached. Remove the `clarify` toolset from the agent's Hermes profile/adapterConfig.toolsets, " +
    "or set approvals.single_query_mode: approve (or deny) in the profile config; " +
    "resume the session interactively to see the pending prompt."
  );
}
