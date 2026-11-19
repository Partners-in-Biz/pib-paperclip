/**
 * Headless-safety helpers for hermes_local (PAR-13559).
 *
 * Hermes detaches a finite (`chat -Q`) run with exit 3 and the stderr line
 * "Input required; detached without cancelling. Resume this session
 * interactively." when any prompt is pending. In the sampled failures the
 * prompt is the protected-instruction-file approval gate
 * (`tools/file_tools_write_guards.py`): a `patch`/`write_file` on AGENTS.md,
 * CLAUDE.md, SOUL.md or .cursorrules always asks a human, ignores --yolo and
 * approvals.single_query_mode, and so can never be answered in a Paperclip run.
 * We cannot (and must not) bypass it here: it is a security setting.
 * Instead we tell the agent not to try, and name the blocked write on failure.
 */

export const HEADLESS_PROTECTED_FILE_NOTE =
  "Headless run: do not patch or write AGENTS.md, CLAUDE.md, SOUL.md or .cursorrules " +
  "(including an agent's instructions/AGENTS.md). Hermes asks a human to approve those " +
  "writes and the run is killed. Report the wanted change in your task comment instead.";

const INPUT_REQUIRED_REGEX = /Input required; detached without cancelling/i;
const WRITE_TOOLS = new Set(["patch", "write_file"]);
const PROTECTED_BASENAMES = new Set(["agents.md", "claude.md", "soul.md", ".cursorrules"]);

/** Target path of the last patch/write_file tool_use in stream-json stdout. */
function lastWriteTarget(stdout: string): { tool: string; path?: string } | null {
  let last: { tool: string; path?: string } | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "tool_use" || typeof rec.name !== "string") continue;
    if (!WRITE_TOOLS.has(rec.name)) {
      last = null; // a later non-write tool means the prompt did not come from a write
      continue;
    }
    const input = rec.input && typeof rec.input === "object" ? (rec.input as Record<string, unknown>) : {};
    const p = [input.path, input.file_path].find((v) => typeof v === "string") as string | undefined;
    last = { tool: rec.name, ...(p ? { path: p } : {}) };
  }
  return last;
}

/** Actionable error when Hermes detached waiting for input, else null. */
export function detectInputRequired(stdout: string, stderr: string): string | null {
  if (!INPUT_REQUIRED_REGEX.test(`${stderr}\n${stdout}`)) return null;
  const target = lastWriteTarget(stdout);
  if (target) {
    const base = target.path?.split("/").pop()?.toLowerCase() ?? "";
    const where = target.path ? `: ${target.path}` : "";
    const kind = PROTECTED_BASENAMES.has(base) || !target.path ? "protected instruction file write" : "write";
    return (
      `Hermes detached waiting for approval in a headless run (${kind} needs approval via ${target.tool}${where}). ` +
      "Protected instruction files (AGENTS.md, CLAUDE.md, SOUL.md, .cursorrules) always need a human; " +
      "route the edit through the platform's instruction-edit path or have a person apply it."
    );
  }
  return (
    "Hermes detached waiting for interactive input in a headless run (an approval or clarify prompt; " +
    "the requesting tool could not be identified from the stream). Resume the session interactively to see the pending prompt."
  );
}
