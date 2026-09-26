/**
 * Lead score levels shared by the worker and the UI (no Node imports here).
 * Jev scores each dimension on a 4-level rubric numbered 0-3; the stored
 * value is Jev's probability-weighted level, so it can sit between levels.
 */

export const LEAD_DIMENSIONS = ["fit", "intent", "urgency"] as const;
export type LeadDimension = (typeof LEAD_DIMENSIONS)[number];

export const LEAD_LEVEL_LABELS: Record<LeadDimension, [string, string, string, string]> = {
  fit: ["Poor", "Weak", "Good", "Ideal"],
  intent: ["None", "Aware", "Considering", "Ready"],
  urgency: ["None", "Later", "Soon", "Now"],
};

export const LEAD_DIMENSION_LABELS: Record<LeadDimension, string> = {
  fit: "Fit",
  intent: "Intent",
  urgency: "Urgency",
};

export interface LeadScore {
  fit: number;
  intent: number;
  urgency: number;
  /** Lowest confidence of the three answers, 0-1. */
  confidence: number;
  scoredAt: string;
}

/** Level index 0-3 for a stored score (rounded, clamped). */
export function leadLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(3, Math.round(value)));
}

export function leadLevelLabel(dimension: LeadDimension, value: number): string {
  return LEAD_LEVEL_LABELS[dimension][leadLevel(value)]!;
}

/** Hot when fit and intent are both at least "good"/"considering"; warm when either is. */
export function leadBand(score: Pick<LeadScore, "fit" | "intent">): "cold" | "warm" | "hot" {
  const fit = leadLevel(score.fit);
  const intent = leadLevel(score.intent);
  if (fit >= 2 && intent >= 2) return "hot";
  if (fit >= 2 || intent >= 2) return "warm";
  return "cold";
}
