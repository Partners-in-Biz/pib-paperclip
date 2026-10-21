import type { MetricInput } from "./engine.js";
import type { ProgramFeatureContext } from "./engine.js";

/** A metric source that can fetch performance data for a channel. */
export interface MetricSource {
  channel: string;
  fetchMetrics(args: {
    scopeKey: string;
    sinceIso: string;
    untilIso: string;
  }): Promise<readonly MetricInput[]>;
}

/** Configuration for a growth channel (e.g., Social, Email). */
export interface ChannelAdapter {
  channel: string;
  defaultObjective: string;
  defaultMetric: string;
  windowDays: number;
  minPerArm: number;
  hypothesisCandidates(program: ProgramFeatureContext): string[];
  source: MetricSource;
}
