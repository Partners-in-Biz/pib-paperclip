/**
 * Is the memory feedback loop telling us anything? (Q2-7, pure, no node imports)
 *
 * Zero feedback rows existed after 199 briefs, and the Weekly retro counted "0
 * noise or wrong-fact reports" under "What worked" and the review said "No
 * missing-fact reports". Nobody reported anything; that says nothing about the
 * briefs. This turns the counts into a signal level so silence is never read
 * as good news, and so "does Jev beat the keyword baseline" is only answered
 * when there is something to answer it from.
 */

/** Briefs needed in 30 days before a share means anything. */
export const SIGNAL_MIN_BRIEFS = 10;
/** Below this share of briefs with any feedback the signal is thin. */
export const SIGNAL_THIN_BELOW = 0.2;

export type SignalLevel = "none" | "thin" | "ok";

export interface FeedbackSignal {
  briefs: number;
  withFeedback: number;
  /** withFeedback / briefs, 0..1; null with no briefs. */
  coverage: number | null;
  level: SignalLevel;
  /** One or two sentences for the retro and the review, saying what the numbers can and cannot support. */
  message: string;
}

export function feedbackSignal(briefs: number, withFeedback: number): FeedbackSignal {
  const coverage = briefs > 0 ? Math.min(1, withFeedback / briefs) : null;
  const pct = coverage === null ? 0 : Math.round(coverage * 100);
  if (briefs < SIGNAL_MIN_BRIEFS) {
    return { briefs, withFeedback, coverage, level: "thin", message: `Only ${briefs} ${briefs === 1 ? "brief" : "briefs"} in 30 days, too few to read anything into the feedback (${withFeedback} had any).` };
  }
  if (withFeedback === 0) {
    return {
      briefs,
      withFeedback,
      coverage,
      level: "none",
      message: `NO SIGNAL: none of the ${briefs} briefs in 30 days got any feedback. Zero reports means nobody reported, not that the briefs were good: do not count it under what worked, and do not say how Jev compares with the keyword baseline.`,
    };
  }
  if ((coverage ?? 0) < SIGNAL_THIN_BELOW) {
    return { briefs, withFeedback, coverage, level: "thin", message: `Thin signal: ${withFeedback} of ${briefs} briefs (${pct}%) got feedback in 30 days. What was reported is real, but most briefs went unreviewed, so absence of a report proves little.` };
  }
  return { briefs, withFeedback, coverage, level: "ok", message: `${withFeedback} of ${briefs} briefs (${pct}%) got feedback in 30 days: enough to read.` };
}
