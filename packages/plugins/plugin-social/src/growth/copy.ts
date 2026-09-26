/**
 * Text for the Growth Lab issues and comments. Pure, so the wording is the
 * same from jobs, tools and actions.
 */
import type { Experiment, PlaybookChange, Program } from "./store.js";

export function programLabel(program: Pick<Program, "clientName" | "clientRef">): string {
  return program.clientRef ? program.clientName ?? program.clientRef : "PiB's own social";
}

export function programPrefix(program: Pick<Program, "clientName" | "clientRef">): string {
  return program.clientRef ? `[${program.clientName ?? program.clientRef}] ` : "";
}

export function approvalIssueTitle(program: Pick<Program, "clientName" | "clientRef">, week: string): string {
  return `${programPrefix(program)}Approve social experiments and playbook changes (${week})`.slice(0, 250);
}

function armsLine(e: Pick<Experiment, "arms">): string {
  return e.arms.map((a) => `${a.key}: ${a.description}`).join(" · ");
}

export function experimentLines(e: Pick<Experiment, "id" | "hypothesis" | "hypothesisType" | "variable" | "arms" | "minPerArm">): string[] {
  return [
    `### Experiment: ${e.hypothesis}`,
    `- Tests \`${e.hypothesisType}\` (${e.variable}) · ${armsLine(e)}`,
    `- Needs ${e.minPerArm}+ posts per arm; each post is scored on its 7-day numbers against the account's usual level.`,
    `- experimentId: \`${e.id}\``,
    "",
  ];
}

export function changeLines(c: Pick<PlaybookChange, "id" | "diff" | "reason">): string[] {
  return [`### Playbook change: ${c.diff}`, `- Why: ${c.reason}`, `- changeId: \`${c.id}\``, ""];
}

export function approvalIssueDescription(program: Program, lines: string[], growthPath: string | null): string {
  return [
    `The Social agent's weekly review for **${programLabel(program)}** has items for you. Experiments change one thing at a time on real posts; playbook changes edit the rules the agent follows when it plans.`,
    "",
    ...lines,
    growthPath
      ? `Approve or reject each one on the [Social → Growth tab](${growthPath}). Closing this issue does not approve anything. This issue closes itself once everything on it is decided.`
      : "Approve or reject each one on the Social page → Growth tab. Closing this issue does not approve anything.",
    "",
    `Autopilot: **${program.autopilot}** (off: agents only read; safe: a person approves; full: the agent approves and wins are kept automatically).`,
  ].join("\n");
}

export function verdictComment(e: Pick<Experiment, "hypothesis">, verdict: string, reason: string, diff: string | null, kept: boolean): string {
  const lines = [`**Experiment measured: ${verdict.replace("_", " ")}** — ${e.hypothesis}`, "", reason];
  if (diff) lines.push("", kept ? `Kept automatically (full autopilot): ${diff}` : `Proposed playbook change: ${diff}`);
  return lines.join("\n");
}
