/**
 * Growth Lab: an autoresearch-style improvement loop for marketing work.
 *
 * Karpathy's autoresearch runs propose → run (fixed budget) → measure one
 * metric → keep or revert, logging every result. Here:
 * - the *program* is the goal, metric and constraints for one scope (own
 *   work or a client) and channel;
 * - the *playbook* is the artefact the loop edits: versioned markdown rules
 *   the agents follow when they plan;
 * - an *experiment* changes one variable; its arms are tagged on real work
 *   (posts, emails); after the window the metric decides keep / discard.
 *
 * Marketing is slower and noisier than a training run, so verdicts need a
 * minimum sample, use medians, and can come back inconclusive. Hypothesis
 * types are chosen with UCB so untried ideas get tested instead of always
 * repeating the current best.
 *
 * Tables: `experimentsMigration(ns)`. The maths below is pure and tested.
 */

export function experimentsMigration(ns: string): string {
  return `CREATE TABLE ${ns}.growth_programs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  channel text NOT NULL,
  objective text NOT NULL,
  metric text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook text NOT NULL DEFAULT '',
  playbook_version integer NOT NULL DEFAULT 1,
  autopilot text NOT NULL DEFAULT 'safe',
  scoreboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_programs_autopilot CHECK (autopilot IN ('off', 'safe', 'full')),
  CONSTRAINT growth_programs_status CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE UNIQUE INDEX growth_programs_scope ON ${ns}.growth_programs (company_id, channel, coalesce(client_kind, ''), coalesce(client_ref, ''));

CREATE TABLE ${ns}.growth_playbook_versions (
  id text PRIMARY KEY,
  program_id text NOT NULL REFERENCES ${ns}.growth_programs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  playbook text NOT NULL,
  reason text NOT NULL,
  experiment_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version)
);

CREATE TABLE ${ns}.growth_experiments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  program_id text NOT NULL REFERENCES ${ns}.growth_programs(id) ON DELETE CASCADE,
  hypothesis text NOT NULL,
  hypothesis_type text NOT NULL,
  variable text NOT NULL,
  arms jsonb NOT NULL,
  metric text NOT NULL,
  min_per_arm integer NOT NULL DEFAULT 3,
  window_days integer NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'proposed',
  proposed_by text,
  approval_issue_id text,
  approved_at timestamptz,
  started_at timestamptz,
  measure_after timestamptz,
  measured_at timestamptz,
  verdict text,
  outcome jsonb,
  playbook_diff text,
  playbook_decision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_experiments_status CHECK (status IN ('proposed', 'running', 'measured', 'rejected', 'abandoned')),
  CONSTRAINT growth_experiments_verdict CHECK (verdict IS NULL OR verdict IN ('win', 'loss', 'no_change', 'inconclusive')),
  CONSTRAINT growth_experiments_decision CHECK (playbook_decision IS NULL OR playbook_decision IN ('kept', 'discarded', 'pending'))
);
CREATE INDEX growth_experiments_program ON ${ns}.growth_experiments (program_id, status);

CREATE TABLE ${ns}.growth_experiment_items (
  experiment_id text NOT NULL REFERENCES ${ns}.growth_experiments(id) ON DELETE CASCADE,
  arm text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  value numeric,
  measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_kind, subject_id)
);
`;
}

export interface ExperimentArm {
  key: string; // "control" | "variant" | ...
  description: string;
}

export type Verdict = "win" | "loss" | "no_change" | "inconclusive";

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function mean(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Relative lift of a value over a baseline: 0.2 = 20% better. Null when there is no baseline. */
export function lift(value: number, baseline: number | null): number | null {
  if (baseline === null || !Number.isFinite(baseline) || baseline <= 0) return null;
  return value / baseline - 1;
}

export interface VerdictInput {
  control: number[];
  variant: number[];
  minPerArm?: number;
  /** Relative improvement of the variant median over control needed for a win (default 15%). */
  winThreshold?: number;
  /** Share of variant items that must beat the control median (default 60%). */
  consistency?: number;
}

export interface VerdictResult {
  verdict: Verdict;
  controlMedian: number | null;
  variantMedian: number | null;
  relativeChange: number | null;
  beatShare: number | null;
  reason: string;
}

/**
 * Win when the variant median beats control by `winThreshold` and most
 * variant items beat the control median; loss is the mirror; too few items
 * is inconclusive; anything else is no change.
 */
export function experimentVerdict(input: VerdictInput): VerdictResult {
  const minPerArm = input.minPerArm ?? 3;
  const threshold = input.winThreshold ?? 0.15;
  const consistency = input.consistency ?? 0.6;
  const control = input.control.filter(Number.isFinite);
  const variant = input.variant.filter(Number.isFinite);
  const controlMedian = median(control);
  const variantMedian = median(variant);
  if (control.length < minPerArm || variant.length < minPerArm || controlMedian === null || variantMedian === null) {
    return { verdict: "inconclusive", controlMedian, variantMedian, relativeChange: null, beatShare: null, reason: `Needs at least ${minPerArm} measured items per arm (control ${control.length}, variant ${variant.length}).` };
  }
  const base = Math.abs(controlMedian) > 1e-9 ? Math.abs(controlMedian) : null;
  const relativeChange = base === null ? (variantMedian > controlMedian ? Infinity : variantMedian < controlMedian ? -Infinity : 0) : (variantMedian - controlMedian) / base;
  const beat = variant.filter((v) => v > controlMedian).length / variant.length;
  const lose = variant.filter((v) => v < controlMedian).length / variant.length;
  if (relativeChange >= threshold && beat >= consistency) {
    return { verdict: "win", controlMedian, variantMedian, relativeChange, beatShare: beat, reason: `Variant median ${fmt(relativeChange)} vs control; ${Math.round(beat * 100)}% of variant items beat the control median.` };
  }
  if (relativeChange <= -threshold && lose >= consistency) {
    return { verdict: "loss", controlMedian, variantMedian, relativeChange, beatShare: beat, reason: `Variant median ${fmt(relativeChange)} vs control; ${Math.round(lose * 100)}% of variant items fell below the control median.` };
  }
  return { verdict: "no_change", controlMedian, variantMedian, relativeChange, beatShare: beat, reason: `Change ${fmt(relativeChange)} is inside ±${Math.round(threshold * 100)}% or not consistent enough.` };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "up from zero" : "down to zero";
  return `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
}

export interface ScoreboardEntry {
  wins: number;
  losses: number;
  noChange: number;
  inconclusive: number;
}

export type Scoreboard = Record<string, ScoreboardEntry>;

export function recordVerdict(board: Scoreboard, hypothesisType: string, verdict: Verdict): Scoreboard {
  const entry = { ...(board[hypothesisType] ?? { wins: 0, losses: 0, noChange: 0, inconclusive: 0 }) };
  if (verdict === "win") entry.wins += 1;
  else if (verdict === "loss") entry.losses += 1;
  else if (verdict === "no_change") entry.noChange += 1;
  else entry.inconclusive += 1;
  return { ...board, [hypothesisType]: entry };
}

/**
 * UCB1 over hypothesis types: mean reward (win 1, no change 0.3, loss 0)
 * plus an exploration bonus. Untried types come first.
 */
export function rankHypothesisTypes(board: Scoreboard, candidates: string[], exploration = 1.2): Array<{ type: string; score: number; tries: number }> {
  const decided = (e: ScoreboardEntry | undefined) => (e ? e.wins + e.losses + e.noChange : 0);
  const total = candidates.reduce((sum, c) => sum + decided(board[c]), 0);
  return candidates
    .map((type) => {
      const e = board[type];
      const n = decided(e);
      if (!e || n === 0) return { type, score: Number.POSITIVE_INFINITY, tries: 0 };
      const reward = (e.wins + 0.3 * e.noChange) / n;
      return { type, score: reward + exploration * Math.sqrt(Math.log(Math.max(total, 1) + 1) / n), tries: n };
    })
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
}

/**
 * Weighted engagement per unit of reach. Uses reach, else impressions, else
 * views; returns null when none is known (the item is skipped, not zero).
 */
export function engagementRate(m: {
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  reach?: number | null;
  impressions?: number | null;
  views?: number | null;
}, weights = { likes: 1, comments: 3, shares: 4, saves: 3, clicks: 2 }): number | null {
  const denom = [m.reach, m.impressions, m.views].find((x) => typeof x === "number" && x > 0) ?? null;
  if (!denom) return null;
  const n = (x: number | null | undefined) => (typeof x === "number" && x > 0 ? x : 0);
  const engaged = n(m.likes) * weights.likes + n(m.comments) * weights.comments + n(m.shares) * weights.shares + n(m.saves) * weights.saves + n(m.clicks) * weights.clicks;
  return engaged / denom;
}

/** Aggregate lift per feature value (e.g. hook=question) to show what tends to work. */
export function featureLifts(rows: Array<{ lift: number | null; features: Record<string, string | number | boolean | null> }>, minCount = 3) {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (row.lift === null || !Number.isFinite(row.lift)) continue;
    for (const [feature, raw] of Object.entries(row.features)) {
      if (raw === null || raw === undefined) continue;
      const value = typeof raw === "number" ? (raw >= 0.5 ? "yes" : "no") : String(raw);
      const k = `${feature}=${value}`;
      const list = groups.get(k) ?? [];
      list.push(row.lift);
      groups.set(k, list);
    }
  }
  return [...groups.entries()]
    .filter(([, lifts]) => lifts.length >= minCount)
    .map(([key, lifts]) => ({ key, count: lifts.length, medianLift: median(lifts)! }))
    .sort((a, b) => b.medianLift - a.medianLift);
}

/** Default playbook skeleton a program starts with; agents fill it in and the loop edits it. */
export function starterPlaybook(title: string): string {
  return `# ${title} playbook

## Goal
(what we optimise, in one sentence)

## Rules we follow (kept from experiments)
- (none yet)

## Things that did not work (discarded)
- (none yet)

## Open questions to test
- Hook style: question vs bold claim vs story
- Format: carousel vs single image vs short video
- Posting time: morning vs evening

## Constraints
- Brand voice, platforms and cadence from the program settings.
`;
}
