/**
 * Text for the Paperclip issues and comments the plugin writes. Pure, so the
 * wording is testable and identical from jobs, tools and actions.
 */
import { PHASE_NAMES, type SprintPhase, type TaskOwner } from "../templates/outrank-90.js";
import { playbookFor, qualifiedTool } from "../templates/playbooks.js";
import type { Assignment, AutopilotMode } from "./sprint.js";

export interface SprintCopy {
  id: string;
  siteName: string;
  siteUrl: string;
  clientName: string | null;
  autopilotMode: AutopilotMode;
  notes?: string | null;
}

export interface TaskCopy {
  id: string;
  title: string;
  week: number;
  phase: number;
  focus: string;
  taskType: string;
  owner: TaskOwner;
  autopilotEligible: boolean;
  playbookKey: string | null;
  source: string;
  description?: string | null;
}

export function sprintLabel(sprint: Pick<SprintCopy, "siteName" | "clientName">): string {
  return sprint.clientName && sprint.clientName.trim() && sprint.clientName.trim() !== sprint.siteName
    ? `${sprint.siteName} (${sprint.clientName.trim()})`
    : sprint.siteName;
}

/**
 * Client work is recognisable in every issue list: `[<client>] ` goes in
 * front unless the title already names the client (e.g. the root issue's
 * "SEO sprint: <site> (<client>)"). Own sprints have no client name.
 */
export function withClientPrefix(title: string, clientName: string | null | undefined): string {
  const name = clientName?.trim();
  if (!name || title.toLowerCase().includes(name.toLowerCase())) return title;
  return `[${name}] ${title}`;
}

function capTitle(title: string): string {
  return title.length > 240 ? `${title.slice(0, 237)}…` : title;
}

export function rootIssueTitle(sprint: Pick<SprintCopy, "siteName" | "clientName">): string {
  return capTitle(withClientPrefix(`SEO sprint: ${sprintLabel(sprint)}`, sprint.clientName));
}

export function rootIssueDescription(sprint: SprintCopy, input: { startDate: string; cockpitPath: string | null }): string {
  return [
    `90-day SEO sprint for **${sprint.siteName}** (${sprint.siteUrl})${sprint.clientName ? ` — client: ${sprint.clientName}` : ""}.`,
    "",
    `- Start (day 0): ${input.startDate}`,
    `- Autopilot: ${sprint.autopilotMode}`,
    input.cockpitPath ? `- Cockpit: [SEO → this sprint](${input.cockpitPath})` : null,
    "",
    "Each task of the Outrank-90 plan becomes a sub-issue of this issue on the day it is due and is worked by the SEO Specialist. Code and content tasks open in the site's repo project. The few things only a person can do (one-time grants, out-of-scope PRs, messages from personal accounts) are batched in one weekly **Needs you** issue. Closing a sub-issue closes the task in the sprint.",
    "",
    "The SEO Specialist posts a short digest here after each daily run.",
    "",
    `sprintId: \`${sprint.id}\``,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function taskIssueTitle(task: Pick<TaskCopy, "title" | "week" | "source">, sprint: Pick<SprintCopy, "siteName" | "clientName">): string {
  const prefix = task.source === "optimization" ? "SEO opt" : `SEO W${task.week}`;
  return capTitle(withClientPrefix(`${prefix} · ${task.title} — ${sprint.siteName}`, sprint.clientName));
}

function toolLine(name: string): string {
  return `- \`${qualifiedTool(name)}\``;
}

export interface SiteCopy {
  access: string;
  repoUrl: string | null;
  defaultBranch: string;
  branch: string;
  changePolicy: string;
  hosting: string | null;
}

const POLICY_LINE: Record<string, string> = {
  merge_seo_scope: "merge it yourself when every changed file is SEO scope and the checks pass; anything else stays an open PR in the Needs you digest",
  pr_only: "open the PR and leave it for a person to merge (add it to the Needs you digest)",
  full: "merge it yourself when the checks pass",
};

export function siteSection(site: SiteCopy): string[] {
  if (site.access !== "repo") {
    return [
      "## Site changes",
      "This site has no repo link (CMS or client-managed). Prepare the exact change set (page, field, old value, new value) and add it to the Needs you digest with `partnersinbiz.seo:needs-you-add` (kind task, the change set in `copy`), then `block-task`.",
      "",
    ];
  }
  return [
    "## Site repo",
    `You run in this project's workspace: ${site.repoUrl ?? "the linked repo"} (default branch \`${site.defaultBranch}\`${site.hosting ? `, hosted on ${site.hosting}` : ""}).`,
    `Branch \`${site.branch}\` → commit → push → open a PR → wait for CI${site.hosting === "vercel" ? " and the Vercel preview" : ""} → verify on the preview URL with the check tools → \`partnersinbiz.seo:check-change-scope\` → ${POLICY_LINE[site.changePolicy] ?? POLICY_LINE.pr_only} → after deploy re-check production and \`complete-task\` with the PR, commit and check output. Details: skill reference \`references/site-changes.md\`.`,
    "",
  ];
}

export function taskIssueDescription(
  task: TaskCopy,
  sprint: SprintCopy,
  input: { assignment: Assignment; context?: string | null; cockpitPath?: string | null; site?: SiteCopy | null },
): string {
  const playbook = playbookFor(task.playbookKey);
  const phase = PHASE_NAMES[(Math.min(Math.max(task.phase, 0), 4) as SprintPhase)];
  const lines: Array<string | null> = [
    `**Sprint:** ${sprintLabel(sprint)} — ${sprint.siteUrl}`,
    `**Week ${task.week} · ${phase}${task.focus ? ` · ${task.focus}` : ""}** · owner: ${task.owner === "human" ? "a person" : "SEO Specialist"}`,
    "",
  ];
  const a = input.assignment;
  if (a.kind === "agent" && a.reviewGate) {
    lines.push(
      "> **Needs sign-off (safe mode).** Prepare the work, then call `partnersinbiz.seo:block-task` with `review: true` and a clear `humanAsk`. The sprint owner approves by marking this issue done. Do not publish, send or deploy on your own.",
      "",
    );
  } else if (a.kind === "user" && a.reason === "autopilot_off") {
    lines.push("> Autopilot is **off** for this sprint, so this agent task is assigned to the sprint owner. Assign it to the SEO Specialist to have it done for you.", "");
  } else if (a.kind === "unassigned") {
    lines.push("> The SEO Specialist is not linked yet. This issue is assigned to it as soon as it is (SEO page → Activate SEO agent).", "");
  }
  if (task.description && task.description.trim()) lines.push(task.description.trim(), "");
  if (input.context && input.context.trim()) lines.push("## Why this task exists", input.context.trim(), "");
  lines.push("## Goal", playbook.goal, "", "## Steps");
  playbook.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("", "## Tools");
  for (const tool of playbook.tools) lines.push(toolLine(tool));
  lines.push("", "## Definition of done", playbook.done, "", "## Evidence to record", playbook.evidence, "");
  if (input.site) lines.push(...siteSection(input.site));
  if (sprint.notes && sprint.notes.trim()) lines.push("## Sprint notes (site access, constraints)", sprint.notes.trim(), "");
  lines.push("## Close it");
  if (task.owner === "human" || a.kind === "user") {
    lines.push("Mark this issue **done** when finished and add links in a comment (the sprint task closes with it). If it does not apply, cancel the issue.");
  } else {
    lines.push(
      `Call \`partnersinbiz.seo:complete-task\` with \`{"taskId": "${task.id}", "summary": "…", "links": ["…"]}\` — it records the evidence and closes this issue.`,
      `Truly blocked on a person (a one-time grant or judgement)? Call \`partnersinbiz.seo:block-task\` with \`{"taskId": "${task.id}", "reason": "…", "humanAsk": "…"}\` — it goes on the sprint's weekly Needs you digest and comes back to you when done.`,
    );
  }
  lines.push("", `sprintId: \`${sprint.id}\` · taskId: \`${task.id}\``);
  if (input.cockpitPath) lines.push(`Cockpit: [SEO → this sprint](${input.cockpitPath})`);
  return lines.filter((line) => line !== null).join("\n");
}

export function blockComment(input: { reason: string; humanAsk: string; review: boolean; links?: string[] }): string {
  const lines = [
    input.review ? "**Ready for your sign-off.**" : "**Blocked — needs a person.** (Also listed in this week's Needs you issue.)",
    "",
    `**What happened:** ${input.reason}`,
    "",
    `**What I need from you:** ${input.humanAsk}`,
  ];
  if (input.links && input.links.length > 0) {
    lines.push("", "**Links:**", ...input.links.map((link) => `- ${link}`));
  }
  lines.push(
    "",
    input.review
      ? "Mark this issue done to approve (the task completes), or reassign it to the SEO Specialist with your changes."
      : "Mark the item done in the Needs you issue (or on the SEO page → Integrations); this task goes back to the SEO Specialist automatically.",
  );
  return lines.join("\n");
}

export interface EvidenceArtifact {
  label: string;
  url?: string | null;
  value?: string | null;
}

export function completionComment(input: { summary: string; links: string[]; artifacts: EvidenceArtifact[]; by: string }): string {
  const lines = [`**Done** (${input.by})`, "", input.summary.trim()];
  if (input.links.length > 0) lines.push("", "**Links:**", ...input.links.map((link) => `- ${link}`));
  if (input.artifacts.length > 0) {
    lines.push("", "**Artifacts:**");
    for (const artifact of input.artifacts) {
      const tail = artifact.url ? ` — ${artifact.url}` : artifact.value ? ` — ${artifact.value}` : "";
      lines.push(`- ${artifact.label}${tail}`);
    }
  }
  return lines.join("\n");
}

export interface ProposalCopy {
  id: string;
  signalType: string;
  severity: string;
  hypothesis: string;
  proposedAction: string;
  evidence: Record<string, unknown>;
  taskTitles: string[];
}

export function approvalIssueTitle(sprint: Pick<SprintCopy, "siteName" | "clientName">, weekLabel: string): string {
  return capTitle(withClientPrefix(`Approve SEO optimizations: ${sprintLabel(sprint)} (${weekLabel})`, sprint.clientName));
}

export function approvalIssueDescription(sprint: SprintCopy, proposals: ProposalCopy[], cockpitPath: string | null): string {
  const lines = [
    `The weekly SEO review found ${proposals.length} optimization${proposals.length === 1 ? "" : "s"} worth testing on **${sprint.siteName}**. Each one becomes tasks for this week once approved; the result is measured 14 days later (win: position +2 or impressions +20%).`,
    "",
  ];
  for (const p of proposals) {
    lines.push(
      `### ${p.hypothesis}`,
      `- Signal: \`${p.signalType}\` (${p.severity})`,
      `- Action: ${p.proposedAction}`,
      `- Evidence: \`${JSON.stringify(p.evidence)}\``,
      `- Tasks: ${p.taskTitles.join("; ")}`,
      `- optimizationId: \`${p.id}\``,
      "",
    );
  }
  lines.push(
    cockpitPath
      ? `Approve or reject each one on the [SEO page → Optimizations](${cockpitPath}&tab=optimizations), or ask the SEO Specialist (tools \`approve-optimization\` / \`reject-optimization\`). Closing this issue does not approve anything.`
      : "Approve or reject each one on the SEO page → Optimizations tab. Closing this issue does not approve anything.",
  );
  return lines.join("\n");
}

export function reconnectIssueTitle(sprint: Pick<SprintCopy, "siteName" | "clientName">): string {
  return capTitle(withClientPrefix(`Reconnect Google Search Console: ${sprintLabel(sprint)}`, sprint.clientName));
}

export function reconnectIssueDescription(sprint: SprintCopy, error: string, cockpitPath: string | null): string {
  return [
    `Google rejected the stored Search Console access for **${sprint.siteName}**, so daily rankings stopped updating.`,
    "",
    `Error: ${error}`,
    "",
    cockpitPath
      ? `Open [SEO → this sprint → Integrations](${cockpitPath}&tab=integrations) and click **Connect Google Search Console** with the Google account that owns the property. This issue closes itself when the connection works.`
      : "Open the SEO page → this sprint → Integrations and click Connect Google Search Console. This issue closes itself when the connection works.",
  ].join("\n");
}

export function digestComment(input: {
  summary: string;
  day: number;
  week: number;
  phase: number;
  doneToday: string[];
  blocked: Array<{ title: string; humanAsk: string | null }>;
  dueOpen: number;
}): string {
  const phase = PHASE_NAMES[(Math.min(Math.max(input.phase, 0), 4) as SprintPhase)];
  const lines = [`**SEO digest — day ${input.day}, week ${input.week} (${phase})**`, "", input.summary.trim(), ""];
  if (input.doneToday.length > 0) lines.push("**Completed today:**", ...input.doneToday.map((t) => `- ${t}`), "");
  if (input.blocked.length > 0) {
    lines.push("**Waiting on a person (see the Needs you issue):**", ...input.blocked.map((b) => `- ${b.title}${b.humanAsk ? ` — ${b.humanAsk}` : ""}`), "");
  }
  lines.push(`Open due tasks: ${input.dueOpen}`);
  return lines.join("\n");
}
