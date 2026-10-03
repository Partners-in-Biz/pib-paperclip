/**
 * The improvements ledger, pure part (no node imports) (Q2-3, Q2-12).
 *
 * A change to how the system or an agent works (a skill rewritten, a routine
 * moved, an instruction tightened) is written down with the number it should
 * move: where that number stands now (the baseline), where it should get to
 * (the target), who owns the change and when to look again. At the re-check
 * date the Cockpit measures the number again and says improved, no change or
 * worse, with both numbers. Before this the Weekly retro proposed changes and
 * nobody could say whether the last ones worked.
 */
import { METRIC_KEY_HELP, parseMetricKey, type Better } from "./metrics-keys.js";

export const IMPROVEMENT_KINDS = ["skill", "instruction", "routine", "plugin", "agent", "system"] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];
export type ImprovementStatus = "open" | "resolved" | "dropped";
export type Outcome = "improved" | "no_change" | "worse" | "inconclusive";

export class ImprovementError extends Error {}

export const IMPROVEMENT_LIMITS = { title: 160, summary: 600, note: 400, targetRef: 120, recheckMinDays: 1, recheckMaxDays: 120, recheckDefaultDays: 14 } as const;

/** A second look is due when its date has passed; after this many days a still-open one is overdue and shown in red. */
export const OVERDUE_GRACE_DAYS = 3;

export interface ImprovementRow {
  id: string;
  companyId: string;
  title: string;
  kind: ImprovementKind;
  targetRef: string | null;
  summary: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  metricKey: string;
  metricLabel: string | null;
  direction: Better;
  baselineValue: number | null;
  baselineAt: string | null;
  targetValue: number | null;
  recheckAt: string;
  status: ImprovementStatus;
  outcome: Outcome | null;
  resultValue: number | null;
  measuredAt: string | null;
  resultNote: string | null;
  sourceRef: string | null;
  sourceIssueId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ImprovementInput {
  title: string;
  kind: ImprovementKind;
  targetRef: string | null;
  summary: string | null;
  ownerAgentId: string | null;
  metricKey: string;
  metricLabel: string | null;
  direction: Better | null;
  baselineValue: number | null;
  targetValue: number | null;
  recheckAt: string;
  sourceRef: string | null;
  sourceIssueId: string | null;
  /** A fact to archive once the improvement is verified (a pinned tool-behaviour fact folded into its skill). */
  sourceFactId: string | null;
}

function text(value: unknown, max: number): string | null {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
}

function finite(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) throw new ImprovementError(`${field} must be a number.`);
  return x;
}

/** Validates what an agent sent to `improvement-propose`. Throws ImprovementError with a message the agent can act on. */
export function parseImprovementInput(raw: Record<string, unknown>, now: Date): ImprovementInput {
  const title = text(raw.title, IMPROVEMENT_LIMITS.title);
  if (!title) throw new ImprovementError("title is required: one line saying what changes (for example: \"Developer skill: run the build before closing\").");
  const kind = raw.kind === undefined || raw.kind === "" ? "system" : raw.kind;
  if (typeof kind !== "string" || !(IMPROVEMENT_KINDS as readonly string[]).includes(kind)) throw new ImprovementError(`kind must be one of ${IMPROVEMENT_KINDS.join(", ")}.`);
  const metricKey = text(raw.metricKey, 120);
  if (!metricKey) throw new ImprovementError(`metricKey is required: the number this should move. ${METRIC_KEY_HELP}`);
  const parsed = parseMetricKey(metricKey);
  if (!parsed) throw new ImprovementError(`"${metricKey}" is not a metric key. ${METRIC_KEY_HELP}`);
  const direction = raw.direction === undefined || raw.direction === "" ? null : raw.direction;
  if (direction !== null && direction !== "lower" && direction !== "higher") throw new ImprovementError("direction must be lower or higher: which way is better for this number.");
  const baselineValue = finite(raw.baselineValue, "baselineValue");
  const targetValue = finite(raw.targetValue, "targetValue");
  let recheckAt: string;
  if (raw.recheckAt !== undefined && raw.recheckAt !== null && raw.recheckAt !== "") {
    const t = Date.parse(String(raw.recheckAt));
    if (!Number.isFinite(t)) throw new ImprovementError("recheckAt must be a date (YYYY-MM-DD).");
    recheckAt = new Date(t).toISOString();
  } else {
    const days = finite(raw.recheckInDays, "recheckInDays") ?? IMPROVEMENT_LIMITS.recheckDefaultDays;
    if (days < IMPROVEMENT_LIMITS.recheckMinDays || days > IMPROVEMENT_LIMITS.recheckMaxDays) throw new ImprovementError(`recheckInDays must be between ${IMPROVEMENT_LIMITS.recheckMinDays} and ${IMPROVEMENT_LIMITS.recheckMaxDays}.`);
    recheckAt = new Date(now.getTime() + days * 86_400_000).toISOString();
  }
  if (Date.parse(recheckAt) <= now.getTime()) throw new ImprovementError("The re-check date must be in the future: give the change time to show in the numbers.");
  if (Date.parse(recheckAt) > now.getTime() + IMPROVEMENT_LIMITS.recheckMaxDays * 86_400_000) throw new ImprovementError(`The re-check date is more than ${IMPROVEMENT_LIMITS.recheckMaxDays} days away: look sooner.`);
  if (parsed.kind === "manual" && baselineValue === null) throw new ImprovementError("A manual metric needs baselineValue: nothing reads it for you, so say where it stands now.");
  return {
    title,
    kind: kind as ImprovementKind,
    targetRef: text(raw.targetRef, IMPROVEMENT_LIMITS.targetRef),
    summary: text(raw.summary, IMPROVEMENT_LIMITS.summary),
    ownerAgentId: text(raw.ownerAgentId, 64),
    metricKey,
    metricLabel: text(raw.metricLabel, 160),
    direction: direction as Better | null,
    baselineValue,
    targetValue,
    recheckAt,
    sourceRef: text(raw.sourceRef, 120),
    sourceIssueId: text(raw.sourceIssueId, 100),
    sourceFactId: text(raw.sourceFactId, 40),
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** A move smaller than this share of the baseline (and 0.01) is noise, not a change. */
export const NO_CHANGE_TOLERANCE = 0.05;

const fmt = (x: number): string => (Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100));

export interface Verdict {
  outcome: Outcome;
  detail: string;
}

/**
 * improved / no_change / worse / inconclusive from the baseline, the target and
 * the number measured again. Reaching the target is improved whatever the size
 * of the move; otherwise a move under 5% of the baseline is no change.
 */
export function improvementVerdict(input: { direction: Better; baseline: number | null; target: number | null; result: number | null; label?: string | null }): Verdict {
  const name = input.label?.trim() || "the number";
  if (input.result === null) return { outcome: "inconclusive", detail: `${name} could not be measured at the re-check, so nothing can be said.` };
  if (input.baseline === null) return { outcome: "inconclusive", detail: `${name} is ${fmt(input.result)} now, but no baseline was recorded to compare it with.` };
  const reached = input.target !== null && (input.direction === "lower" ? input.result <= input.target : input.result >= input.target);
  const move = input.result - input.baseline;
  const tolerance = Math.max(Math.abs(input.baseline) * NO_CHANGE_TOLERANCE, 0.01);
  const better = input.direction === "lower" ? move <= -tolerance : move >= tolerance;
  const worse = input.direction === "lower" ? move >= tolerance : move <= -tolerance;
  const goal = input.target !== null ? ` (target ${fmt(input.target)}${reached ? ", reached" : ""})` : "";
  const numbers = `${name} went from ${fmt(input.baseline)} to ${fmt(input.result)}${goal}`;
  if (reached || better) return { outcome: "improved", detail: `${numbers}: improved.` };
  if (worse) return { outcome: "worse", detail: `${numbers}: worse.` };
  return { outcome: "no_change", detail: `${numbers}: no change.` };
}

// ---------------------------------------------------------------------------
// Open, due and overdue
// ---------------------------------------------------------------------------

export function isDue(row: Pick<ImprovementRow, "status" | "recheckAt">, now: Date): boolean {
  return row.status === "open" && Date.parse(row.recheckAt) <= now.getTime();
}

/** Still open `OVERDUE_GRACE_DAYS` days after its re-check date: the re-check could not be measured or nobody recorded it. */
export function isOverdue(row: Pick<ImprovementRow, "status" | "recheckAt">, now: Date): boolean {
  return row.status === "open" && Date.parse(row.recheckAt) + OVERDUE_GRACE_DAYS * 86_400_000 < now.getTime();
}

/** One improvement as the brief and the retro print it. */
export function improvementBrief(row: ImprovementRow, now: Date): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    target: row.targetRef,
    metric: row.metricKey,
    metricLabel: row.metricLabel,
    better: row.direction,
    baseline: row.baselineValue,
    goal: row.targetValue,
    recheckAt: row.recheckAt.slice(0, 10),
    status: row.status,
    ...(isOverdue(row, now) ? { overdueDays: Math.floor((now.getTime() - Date.parse(row.recheckAt)) / 86_400_000) } : isDue(row, now) ? { due: true } : {}),
    ...(row.outcome ? { outcome: row.outcome, result: row.resultValue, note: row.resultNote, measuredAt: row.measuredAt?.slice(0, 10) } : {}),
    owner: row.ownerAgentId ?? row.ownerUserId,
  };
}

// ---------------------------------------------------------------------------
// Pinned facts that describe a tool (Q2-12)
// ---------------------------------------------------------------------------

const TOOL_WORDS = /\b(partnersinbiz\.[a-z]+|mcp|tools?|skills?|endpoints?|api|cli|adapter|routine|webhook|workspace|worktree|git|run|runs)\b|`[^`]+`/i;
const BEHAVIOUR_WORDS = /\b(use|call|never|always|must|do not|don't|returns?|fails?|failing|requires?|needs?|only works|instead of|rather than|avoid|ignores?|refuses?|breaks?)\b/i;
/** A client or person named by the fact is a client fact, not a skill rule. */
const CLIENT_HINT = /\b(prefers?|likes?|wants?|hates?|dislikes?|their|client'?s)\b/i;

/**
 * True when a company-wide fact reads like an instruction for a tool or skill
 * ("call partnersinbiz.* tools as MCP tools, never over curl"), not a fact about
 * a client. Such facts ride in every brief; the right place is the owning skill.
 */
export function isToolBehaviourFact(factText: string): boolean {
  return TOOL_WORDS.test(factText) && BEHAVIOUR_WORDS.test(factText) && !CLIENT_HINT.test(factText);
}

/** The module a tool-behaviour fact is about, from a `partnersinbiz.<module>` mention; null when it names none. */
export function owningModule(factText: string): string | null {
  return /\bpartnersinbiz\.([a-z]+)/i.exec(factText)?.[1]?.toLowerCase() ?? null;
}

export interface FactLike {
  id: string;
  text: string;
  kind: string;
  pinned: boolean;
  useCount: number;
  clientRef: string | null;
  status: string;
}

/** Facts used in a brief this many times count as "highly used" even when not pinned. */
export const HIGHLY_USED = 15;

/** Active company-wide facts, pinned or highly used, that describe how a tool or skill behaves. */
export function skillCandidates(facts: FactLike[]): FactLike[] {
  return facts.filter((f) => f.status === "active" && f.clientRef === null && ["rule", "warning", "lesson", "fact"].includes(f.kind) && (f.pinned || f.useCount >= HIGHLY_USED) && isToolBehaviourFact(f.text));
}

export function skillCandidateTitle(fact: Pick<FactLike, "text">): string {
  const module = owningModule(fact.text);
  const short = fact.text.length > 90 ? `${fact.text.slice(0, 89)}…` : fact.text;
  return `Fold into the ${module ? `${module} skill` : "owning skill"}: ${short}`;
}
