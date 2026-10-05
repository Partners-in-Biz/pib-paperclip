/**
 * Turning a reviewed proposal to change a skill into a pull request, pure part
 * (Q10-4, Q2-4, Q2-10).
 *
 * The host ships a Reflection Coach (clusters failures, proposes the smallest
 * change as a diff, asks for approval) but it can only edit a company's COPY of a
 * skill, and every PiB skill is managed by a plugin that overwrites in-company
 * edits at the next sync (318 resets in 8 days). So a skill change that is meant to
 * last has to land in plugin source. This module is the careful middle step: it
 * applies the coach's diff to the skill's current text and refuses what does not
 * apply, goes over budget, drops a "never" rule or carries a secret, and writes the
 * branch, the PR text and the checklist an agent follows. Nothing here talks to
 * GitHub: the agent opens the PR with the tools it already has.
 */
import { createHash } from "node:crypto";
import { looksLikeSecret } from "./credentials-model.js";

export class SkillChangeError extends Error {}

export interface AppliedDiff {
  text: string;
  added: number;
  removed: number;
  hunks: number;
}

interface Hunk {
  /** 1-based line the old side starts at, when the diff says (null when it carries no numbers). */
  start: number | null;
  old: string[];
  next: string[];
}

function parseHunks(diff: string): Hunk[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of lines) {
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(line) && !current) continue;
    const head = /^@@(?: -(\d+)(?:,\d+)? \+\d+(?:,\d+)?)? @@/.exec(line);
    if (head) {
      current = { start: head[1] ? Number(head[1]) : null, old: [], next: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.next.push(line.slice(1));
    else if (line.startsWith("-")) current.old.push(line.slice(1));
    else if (line.startsWith(" ")) {
      current.old.push(line.slice(1));
      current.next.push(line.slice(1));
    } else if (line === "") {
      // A blank line inside a hunk is an empty context line that lost its leading space.
      current.old.push("");
      current.next.push("");
    }
  }
  // Trailing blank context lines the splitter added are not part of the diff.
  for (const h of hunks) {
    while (h.old.length && h.old[h.old.length - 1] === "" && h.next[h.next.length - 1] === "") {
      h.old.pop();
      h.next.pop();
    }
  }
  return hunks.filter((h) => h.old.length > 0 || h.next.length > 0);
}

const trimEnd = (s: string) => s.replace(/[ \t]+$/, "");

function matchesAt(lines: string[], at: number, old: string[]): boolean {
  if (at < 0 || at + old.length > lines.length) return false;
  for (let i = 0; i < old.length; i += 1) if (trimEnd(lines[at + i]!) !== trimEnd(old[i]!)) return false;
  return true;
}

/**
 * Applies a unified diff to a text. A hunk is applied where its line numbers say;
 * if the text there does not match (it moved a little, or the diff has no
 * numbers) it is applied at the one place its context matches, never at a guess.
 * Throws with the hunk that failed.
 */
export function applyUnifiedDiff(text: string, diff: string): AppliedDiff {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) throw new SkillChangeError("The diff has no hunks: it needs lines starting with @@, then context, - and + lines.");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const original = text.replace(/\r\n/g, "\n").split("\n");
  let lines = original;
  let offset = 0;
  hunks.forEach((hunk, index) => {
    if (hunk.old.length === 0 && hunk.start === null) throw new SkillChangeError(`Hunk ${index + 1} only adds lines and says nowhere: give it context lines or a line number.`);
    let at = -1;
    if (hunk.start !== null) {
      const guess = hunk.start - 1 + offset;
      // A pure insertion's number is the line before the new text.
      const probe = hunk.old.length === 0 ? guess + 1 : guess;
      if (hunk.old.length === 0 ? probe >= 0 && probe <= lines.length : matchesAt(lines, probe, hunk.old)) at = probe;
    }
    if (at < 0) {
      const found: number[] = [];
      for (let i = 0; i + hunk.old.length <= lines.length; i += 1) if (matchesAt(lines, i, hunk.old)) found.push(i);
      if (found.length === 0) throw new SkillChangeError(`Hunk ${index + 1} does not apply: the text it expects is not in the skill (it starts "${hunk.old[0]?.slice(0, 80) ?? ""}"). The skill may have changed since the proposal was written.`);
      if (found.length > 1) throw new SkillChangeError(`Hunk ${index + 1} is ambiguous: its context matches ${found.length} places. Add more context lines.`);
      at = found[0]!;
    }
    lines = [...lines.slice(0, at), ...hunk.next, ...lines.slice(at + hunk.old.length)];
    offset += hunk.next.length - hunk.old.length;
  });
  // Net numbers: lines that are only in the new text, and only in the old text.
  const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const l of list) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const before = count(original);
  const after = count(lines);
  let added = 0;
  let removed = 0;
  for (const [l, n] of after) added += Math.max(0, n - (before.get(l) ?? 0));
  for (const [l, n] of before) removed += Math.max(0, n - (after.get(l) ?? 0));
  return { text: lines.join(eol), added, removed, hunks: hunks.length };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Budgets (characters): a skill's SKILL.md, the operating manual, a reference file. The Operator's is the test's own, with its references kept apart. */
export const SKILL_BUDGETS = {
  skill: 19_000,
  operator: 18_950,
  reference: 8_000,
} as const;

/** One proposal may grow a file by at most this share (and always by 1,500 characters): four small changes beat one rewrite. */
export const GROWTH_SHARE = 0.15;
export const GROWTH_FLOOR = 1_500;
export const MAX_ADDED_LINES = 120;

export function budgetFor(slug: string, file: string): number {
  if (file !== "SKILL.md") return SKILL_BUDGETS.reference;
  return slug === "pib-operator" ? SKILL_BUDGETS.operator : SKILL_BUDGETS.skill;
}

const NEVER = /\b(never|do not|don't|must not|may not|only a person|only the owner)\b/i;

const words = (line: string): Set<string> => new Set(line.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));

/**
 * The rules a diff removes: a removed line that holds a "never" (or "only a person")
 * and has no added line that keeps the sense (most of its words, still a rule). Such a
 * removal needs the owner: the rules are what keep an agent from sending, paying or
 * publishing on its own.
 */
export function droppedRules(oldText: string, newText: string): string[] {
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  const inNew = new Set(newLines.map((l) => l.trim()));
  const dropped: string[] = [];
  for (const line of oldLines) {
    const t = line.trim();
    if (!t || !NEVER.test(t) || inNew.has(t)) continue;
    const w = words(t);
    const kept = newLines.some((n) => {
      if (!NEVER.test(n)) return false;
      const nw = words(n);
      let shared = 0;
      for (const x of w) if (nw.has(x)) shared += 1;
      return w.size > 0 && shared / w.size >= 0.6;
    });
    if (!kept) dropped.push(t.length > 140 ? `${t.slice(0, 139)}…` : t);
  }
  return dropped;
}

export interface ChangeCheck {
  ok: boolean;
  /** Blocks the pull request (the tool refuses) or only needs a person's eye. */
  severity: "blocks" | "needs-owner";
  detail: string;
}

export interface ProposalReview {
  newText: string;
  added: number;
  removed: number;
  hunks: number;
  before: number;
  after: number;
  budget: number;
  checks: ChangeCheck[];
  /** The proposal may be turned into a PR (nothing blocks). */
  allowed: boolean;
  /** A person must look at it before it is merged (a rule was dropped). */
  needsOwner: boolean;
}

/** Applies a diff to the skill's current file and checks the result against the budgets and the guardrails. Throws when the diff does not apply. */
export function reviewProposal(input: { slug: string; file: string; current: string; diff: string }): ProposalReview {
  const applied = applyUnifiedDiff(input.current, input.diff);
  const budget = budgetFor(input.slug, input.file);
  const before = input.current.length;
  const after = applied.text.length;
  const checks: ChangeCheck[] = [];
  const growth = after - before;
  const allowed = Math.max(GROWTH_FLOOR, Math.round(before * GROWTH_SHARE));
  checks.push({ ok: after <= budget, severity: "blocks", detail: after <= budget ? `${input.file} is ${after} characters, inside its ${budget} budget` : `${input.file} would be ${after} characters, over its ${budget} budget: move reference text into the skill's references or drop something` });
  checks.push({ ok: growth <= allowed, severity: "blocks", detail: growth <= allowed ? `It grows the file by ${Math.max(0, growth)} characters (at most ${allowed} in one change)` : `It grows the file by ${growth} characters; one change may add at most ${allowed}. Split it into smaller proposals` });
  checks.push({ ok: applied.added <= MAX_ADDED_LINES, severity: "blocks", detail: applied.added <= MAX_ADDED_LINES ? `${applied.added} lines added` : `${applied.added} lines added; more than ${MAX_ADDED_LINES} is a rewrite, not a change` });
  const addedText = diffAddedLines(input.diff).join("\n");
  const secret = addedText.split("\n").find((l) => looksLikeSecret(l));
  checks.push({ ok: !secret, severity: "blocks", detail: secret ? `An added line looks like it holds a secret (${secret.slice(0, 40)}…): skills never carry a value` : "No secret in the added text" });
  const dropped = droppedRules(input.current, applied.text);
  checks.push({ ok: dropped.length === 0, severity: "needs-owner", detail: dropped.length === 0 ? "No \"never\" rule is dropped" : `It drops ${dropped.length} \"never\" rule${dropped.length === 1 ? "" : "s"} nothing replaces: ${dropped.map((d) => `"${d}"`).join("; ")}. Rules that stop an agent sending, paying or publishing on its own change only with the owner's yes` });
  return {
    newText: applied.text,
    added: applied.added,
    removed: applied.removed,
    hunks: applied.hunks,
    before,
    after,
    budget,
    checks,
    allowed: checks.every((c) => c.ok || c.severity !== "blocks"),
    needsOwner: checks.some((c) => !c.ok && c.severity === "needs-owner"),
  };
}

/** The lines a diff adds (without the leading +). */
export function diffAddedLines(diff: string): string[] {
  return diff.replace(/\r\n/g, "\n").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

// ---------------------------------------------------------------------------
// The pull request package
// ---------------------------------------------------------------------------

/** Where each Cockpit-owned skill lives in plugin source. Another plugin's skill: find it in that plugin with grep. */
export const SKILL_SOURCES: Record<string, { pluginDir: string; files: string[]; note: string }> = {
  "pib-operator": { pluginDir: "packages/plugins/plugin-cockpit", files: ["src/skills.ts (OPERATOR_SKILL_BODY)", "src/skill-references.ts (the reference files)"], note: "The tests keep SKILL.md under 17,950 characters and each reference under 8,000: move text into references/, never drop a rule." },
  "pib-reviewer": { pluginDir: "packages/plugins/plugin-cockpit", files: ["src/skills.ts (REVIEWER_SKILL_BODY)"], note: "Keep one checklist per kind of work." },
  "pib-company-os": { pluginDir: "packages/plugins/plugin-cockpit", files: ["src/company-skill.ts"], note: "The manual is under 18,000 characters in all and its body under 16,000; every PiB role carries it, so each line costs tokens on every run." },
  "pib-acceptance": { pluginDir: "packages/plugins/plugin-cockpit", files: ["src/acceptance-skill.ts"], note: "The journeys themselves are data in journeys/*.json: change a journey there, not in the skill." },
};

export function sourceFor(slug: string): { pluginDir: string; files: string[]; note: string } {
  return SKILL_SOURCES[slug] ?? { pluginDir: "packages/plugins/<plugin that ships it>", files: [`find it: grep -rn "${slug}" packages/plugins/*/src`], note: "Apply the diff in the plugin that ships this skill and run that plugin's tests." };
}

export function diffHash(diff: string): string {
  return createHash("sha256").update(diff.replace(/\s+$/gm, "")).digest("hex").slice(0, 8);
}

export function branchName(slug: string, diff: string, date: string): string {
  return `skill/${slug}/${date.replace(/-/g, "")}-${diffHash(diff)}`;
}

export interface PackageInput {
  slug: string;
  file: string;
  reason: string;
  evidence: string[];
  diff: string;
  date: string;
  review: ProposalReview | null;
  /** Null when the Cockpit cannot read the skill (another plugin's). */
  hash: { before: string; after: string } | null;
  improvement: { id: string; metricKey: string; recheckAt: string } | null;
  sourceIssue: string | null;
}

export interface PullRequestPackage {
  branch: string;
  base: "development";
  title: string;
  body: string;
  steps: string[];
  files: string[];
}

export function pullRequestPackage(input: PackageInput): PullRequestPackage {
  const source = sourceFor(input.slug);
  const branch = branchName(input.slug, input.diff, input.date);
  const reason = input.reason.replace(/\s+/g, " ").trim();
  const title = `Skill ${input.slug}: ${reason.length > 60 ? `${reason.slice(0, 59)}…` : reason}`;
  const checks = input.review ? input.review.checks.map((c) => `- ${c.ok ? "ok" : c.severity === "blocks" ? "BLOCKS" : "OWNER"}: ${c.detail}`) : ["- Not checked here: the Cockpit does not ship this skill, so it could not apply the diff. The plugin's own tests are the check."];
  const body = [
    `## Why`,
    reason,
    "",
    "## Evidence",
    ...(input.evidence.length ? input.evidence.map((e) => `- ${e}`) : ["- (none given: a change with no evidence is a wish)"]),
    ...(input.sourceIssue ? ["", `Proposal: ${input.sourceIssue}`] : []),
    "",
    `## The change (\`${input.file}\`)`,
    "```diff",
    input.diff.trim(),
    "```",
    "",
    "## Checks the Cockpit ran",
    ...checks,
    ...(input.hash ? ["", `Skill version: \`${input.hash.before}\` to \`${input.hash.after}\` (content hash).`] : []),
    "",
    "## Before merge (the eval gate)",
    `1. \`partnersinbiz.cockpit:skill-eval\` plan with mode candidate, \`candidateMarkdown\` = the text this branch gives \`${input.file}\`; make the harness runs it lists; \`record\` them; \`gate\`.`,
    "2. Put the recorded results in `evals/results.json` under the skill's `candidates` (the record output prints the entry). No skill version ships if a scenario that passed at the baseline fails.",
    "3. `pnpm --filter @partnersinbiz/plugin-cockpit test` is green (it runs the offline gate and the skill budget tests).",
    "",
    "## Rules",
    "- Into `development`, never `main` (main changes only when the owner approves a release).",
    "- The Code Reviewer reviews this PR; the Delivery Lead merges it. Bump the plugin's version in `package.json` and its manifest, and note the change in its README.",
    "",
    "## After it ships",
    "- The Delivery Lead requests the deploy (`pib-deploy-request deploy <plugin> --issue PAR-n --sha <merge commit>`), then `skill-eval` gate and `baseline` on the live skill.",
    ...(input.improvement ? [`- The change is in the improvements ledger as \`${input.improvement.id}\`: the Cockpit measures \`${input.improvement.metricKey}\` again on ${input.improvement.recheckAt.slice(0, 10)} and records improved, no change or worse. A worse result is reverted, not left.`] : []),
    "",
    "## Rollback",
    "Revert this PR and have the Delivery Lead request the deploy again, or a person runs `deploy-plugins.sh --rollback` (agents cannot roll back): the skill is plugin source, so the previous version is one deploy away.",
  ].join("\n");
  const steps = [
    "git switch development && git pull --ff-only",
    `git switch -c ${branch}`,
    `Edit ${source.files.join("; ")} in ${source.pluginDir} so the skill reads as the diff says. ${source.note}`,
    "Add the recorded eval results to evals/results.json, bump the plugin version in package.json and the manifest, and add a line to the README.",
    "pnpm test and pnpm typecheck in the plugin, then commit.",
    `Push the branch and open a pull request into development with the title and body above (gh pr create --base development --head ${branch}).`,
    "Hand the PR to the Code Reviewer; the Delivery Lead merges it after the review.",
  ];
  return { branch, base: "development", title, body, steps, files: source.files.map((f) => `${source.pluginDir}/${f.split(" (")[0]}`) };
}
