/**
 * Social channel adapter: configuration for the Growth Lab channel.
 * Defines defaults for experiments, feature extraction, and metric collection.
 */
import {
  GROWTH_CHANNEL,
  DEFAULT_OBJECTIVE,
  DEFAULT_METRIC,
  hypothesisCandidates as kitHypothesisCandidates,
  type ChannelAdapter,
  type MetricSource,
  type ProgramFeatureContext,
} from "@partnersinbiz/pib-plugin-kit";

/** Stub metric source: Social's scoring loop uses store.metricRows directly.
 * A real source would fetch from social platform APIs, but the current
 * implementation keeps metrics in the database.
 * TODO: Integrate with a live metric source if external platform polling is added.
 */
const socialMetricSource: MetricSource = {
  channel: GROWTH_CHANNEL,
  async fetchMetrics() {
    return [];
  },
};

/** Helper: true if any finished hypothesis is a media type. */
function hasFinishedMediaHypothesis(finishedTypes?: string[]): boolean {
  return (finishedTypes ?? []).some((t) => t.startsWith("media:"));
}

/**
 * Social hypothesis candidates: the kit's list plus a media hypothesis first
 * if no media experiment has been measured, rejected, or abandoned for this scope.
 * The media hypothesis uses arms keyed "media" (variant) and "no_media" (control),
 * matching the names in noMediaExempt's post.arm check (kit/src/media-rule.ts).
 */
export function socialHypothesisCandidates(program: ProgramFeatureContext & { finishedHypothesisTypes?: string[] }): string[] {
  const candidates = kitHypothesisCandidates({ scoreboard: {}, ...program });
  if (!hasFinishedMediaHypothesis(program.finishedHypothesisTypes)) {
    // Remove any existing media entry to avoid duplication
    const filtered = candidates.filter((c) => !c.startsWith("media:"));
    // Prepend the media hypothesis
    return ["media:with_media", ...filtered];
  }
  return candidates;
}

/**
 * Social Growth Lab adapter: channel defaults and hypothesis generation.
 * Experiment defaults (minPerArm: 3, windowDays: 7) come from normalizeProposal.
 */
export const socialAdapter: ChannelAdapter = {
  channel: GROWTH_CHANNEL,
  defaultObjective: DEFAULT_OBJECTIVE,
  defaultMetric: DEFAULT_METRIC,
  // Defaults from kit's normalizeProposal: minPerArm defaults to 3, windowDays to 7.
  minPerArm: 3,
  windowDays: 7,
  hypothesisCandidates: (program: ProgramFeatureContext) =>
    socialHypothesisCandidates({ scoreboard: {}, ...program } as ProgramFeatureContext & { finishedHypothesisTypes?: string[] }),
  source: socialMetricSource,
};
