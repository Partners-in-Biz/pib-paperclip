/**
 * The learned SEO playbook: versioned markdown rules per scope (one client,
 * or Partners in Biz's own sites) that the SEO agent reads before it works a
 * sprint. The optimization loop measures a change 14 days after approval; a
 * win or a loss drafts one playbook line, and a person (or the agent on full
 * autopilot) keeps or discards it. Same sections and edit rules as the Social
 * Growth Lab playbook. Pure.
 */
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import type { AutopilotMode } from "./sprint.js";
import type { MeasureResult } from "./measure.js";

export class PlaybookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybookError";
  }
}

export type PlaybookSection = "goal" | "rules" | "avoid" | "open" | "constraints";

export const SECTION_HEADINGS: Record<PlaybookSection, string> = {
  goal: "Goal",
  rules: "Rules we follow",
  avoid: "Things that did not work",
  open: "Open questions to test",
  constraints: "Constraints",
};

export const PLAYBOOK_SECTIONS = Object.keys(SECTION_HEADINGS) as PlaybookSection[];

export type ChangeOp = "add" | "remove" | "replace";

export interface ChangeSpec {
  op: ChangeOp;
  section: PlaybookSection | null;
  body: string;
}

/** Pending changes a scope may hold at once. */
export const MAX_PENDING_CHANGES = 10;
/** Longest single rule line. */
export const MAX_LINE = 400;

/** `own`, `company:<id>` or `contact:<id>`: one playbook per scope. */
export function scopeKey(scope: ClientScope): string {
  return scope ? `${scope.kind}:${scope.id}` : "own";
}

/** The playbook a scope starts with (same headings as the kit starter). */
export function seoStarterPlaybook(title: string): string {
  return `# ${title} SEO playbook

## Goal
More qualified organic search traffic: better positions, impressions and clicks on the tracked keywords, measured 14 days after each change.

## Rules we follow (kept from experiments)
- (none yet)

## Things that did not work (discarded)
- (none yet)

## Open questions to test
- Stuck pages (positions 8–20): deeper content + FAQ vs more internal links
- Low CTR: rewrite the title and meta description vs retarget the page to a better-matching keyword
- New content: pillar + cluster pages vs standalone posts
- Directories and citations: which listings go live and bring impressions

## Constraints
- Never invent numbers: positions come from Search Console or a rank observed yourself.
- Site changes go through the site repo within the sprint's change policy.
- Keep each client's keywords, copy, accounts and evidence inside its own sprints.
`;
}

export function playbookTitle(scope: ClientScope, clientName: string | null): string {
  return scope ? clientName ?? `${scope.kind} ${scope.id}` : "Partners in Biz";
}

/** Agents keep or discard playbook changes only on full autopilot (as for approving optimizations). */
export function agentMayDecide(mode: AutopilotMode): boolean {
  return mode === "full";
}

/** Agents do not propose changes when a sprint's autopilot is off. */
export function agentMayPropose(mode: AutopilotMode): boolean {
  return mode !== "off";
}

/** On full autopilot a measured win is kept at once; a loss still waits for the agent to decide. */
export function autoKeep(mode: AutopilotMode, result: MeasureResult): boolean {
  return mode === "full" && result === "win";
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The draft line a measured optimization adds: a win becomes a rule, a loss
 * goes under "did not work"; no change and inconclusive add nothing.
 */
export function measuredChange(
  o: { id: string; hypothesisType: string; proposedAction: string },
  outcome: { result: MeasureResult; reasons: string[] },
  on: string,
): ChangeSpec | null {
  if (outcome.result !== "win" && outcome.result !== "loss") return null;
  const evidence = ` (${outcome.result} on ${on}: ${outcome.reasons.join(" ").replace(/\.$/, "")}; ${o.hypothesisType})`;
  const action = clip(o.proposedAction, Math.max(80, MAX_LINE - evidence.length));
  return { op: "add", section: outcome.result === "win" ? "rules" : "avoid", body: clip(`${action}${evidence}`, MAX_LINE) };
}

// ── Edits ───────────────────────────────────────────────────────────────────

const NONE_YET = /^-\s*\(none yet\)\s*$/i;

export function isSection(value: unknown): value is PlaybookSection {
  return typeof value === "string" && value in SECTION_HEADINGS;
}

function headingIndex(lines: string[], heading: string): number {
  const want = heading.toLowerCase();
  return lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, "").trim().toLowerCase().startsWith(want));
}

function sectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) if (/^#{1,2}\s+/.test(lines[i]!)) return i;
  return lines.length;
}

function bullet(text: string): string {
  return `- ${text.replace(/^\s*-\s*/, "").replace(/\s+/g, " ").trim()}`;
}

/** Apply a change to the playbook markdown. Throws when a removal does not match. Adding a line that is already there changes nothing. */
export function applyPlaybookChange(playbook: string, change: ChangeSpec): string {
  if (change.op === "replace") {
    const next = change.body.trim();
    if (!next) throw new PlaybookError("The new playbook is empty");
    return `${next}\n`;
  }
  const lines = playbook.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const line = bullet(change.body);
  if (change.op === "add") {
    const heading = SECTION_HEADINGS[change.section ?? "rules"];
    let at = headingIndex(lines, heading);
    if (at < 0) {
      lines.push("", `## ${heading}`);
      at = lines.length - 1;
    }
    const end = sectionEnd(lines, at);
    const body = lines.slice(at + 1, end).filter((l) => !NONE_YET.test(l.trim()));
    if (body.some((l) => l.trim().toLowerCase() === line.toLowerCase())) return `${lines.join("\n")}\n`;
    while (body.length && !body[body.length - 1]!.trim()) body.pop();
    const next = [...lines.slice(0, at + 1), ...body, line, ...(end < lines.length ? [""] : []), ...lines.slice(end)];
    return `${next.join("\n")}\n`;
  }
  const target = line.toLowerCase().replace(/\.$/, "");
  const index = lines.findIndex((l) => /^\s*-\s+/.test(l) && bullet(l).toLowerCase().replace(/\.$/, "") === target);
  if (index < 0) throw new PlaybookError(`The playbook has no line "${line}". Call get-playbook and copy the line exactly.`);
  lines.splice(index, 1);
  // Keep an emptied section readable.
  let head = index - 1;
  while (head >= 0 && !/^##\s+/.test(lines[head]!)) head -= 1;
  if (head >= 0) {
    const end = sectionEnd(lines, head);
    if (!lines.slice(head + 1, end).some((l) => /^\s*-\s+/.test(l))) lines.splice(head + 1, 0, "- (none yet)");
  }
  return `${lines.join("\n")}\n`;
}

/** One line a person reads to decide: `+ Rules we follow: - …`, `− playbook: - …` or a replace summary. */
export function changeDiff(change: ChangeSpec, playbook?: string): string {
  if (change.op === "replace") {
    const before = playbook ? playbook.trim().split("\n").length : 0;
    return `Replace the whole playbook (${before} → ${change.body.trim().split("\n").length} lines)`;
  }
  const heading = change.op === "add" ? SECTION_HEADINGS[change.section ?? "rules"] : "playbook";
  return `${change.op === "add" ? "+" : "−"} ${heading}: ${bullet(change.body)}`;
}

function text(value: unknown, key: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min) throw new PlaybookError(`${key} is required (at least ${min} characters)`);
  if (value.trim().length > max) throw new PlaybookError(`${key} is longer than ${max} characters`);
  return value.trim();
}

/** Tool parameters → a change: op add (section + text), remove (text = the exact line) or replace (playbook = the whole markdown). */
export function normalizeChange(input: Record<string, unknown>): ChangeSpec {
  const op = input.op ?? "add";
  if (op !== "add" && op !== "remove" && op !== "replace") throw new PlaybookError("op must be add, remove or replace");
  if (op === "replace") return { op, section: null, body: text(input.playbook ?? input.text, "playbook", 20, 20_000) };
  const section = input.section == null || input.section === "" ? (op === "add" ? "rules" : null) : input.section;
  if (op === "add" && !isSection(section)) throw new PlaybookError(`section must be one of ${PLAYBOOK_SECTIONS.join(", ")}`);
  return { op, section: op === "add" ? (section as PlaybookSection) : null, body: text(input.text, "text", 3, MAX_LINE) };
}
