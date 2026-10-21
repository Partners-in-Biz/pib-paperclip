/**
 * Campaigns channel adapter for the Growth Lab: reply rate per step and variant
 * from `campaign_step_events`, judged with the kit `experimentVerdict`, and the
 * `winner_variant` it sets. Variant A is the control, B the variant.
 */
import {
  experimentVerdict,
  hypothesisCandidates as kitHypothesisCandidates,
  type ChannelAdapter,
  type MetricSource,
  type ProgramFeatureContext,
  type Verdict,
} from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCampaign, saveCampaign, table } from "./db.js";
import { assertCanDeclareWinner } from "./domain.js";

export const CAMPAIGNS_CHANNEL = "campaigns";
/** Sends per variant a step needs before it is judged. G9 (PAR-4144): own send volume is unverified, so this stays at the plan's 30; lower it, never under 10, once measured. */
export const MIN_SENDS_PER_ARM = 30;
export const WINDOW_DAYS = 7;
/** Sends are grouped in batches of 5 and each batch's reply rate is one item for the verdict (a 0/1 per send has no useful median). */
export const BATCH = 5;
/** Row cap of one read; a campaign that reaches it is judged on the oldest rows of the window and flagged `truncated`. */
export const MAX_EVENTS = 20_000;
const DAY_MS = 86_400_000;

export interface StepEvent {
  enrollmentId: string;
  stepPosition: number;
  eventType: string;
  variant: string | null;
  occurredAt: string;
}

export interface StepVerdict {
  step: number;
  verdict: Verdict;
  sends: { a: number; b: number };
  replyRate: { a: number | null; b: number | null };
  relativeChange: number | null;
  beatShare: number | null;
  reason: string;
}

export interface CampaignGrowthResult {
  winner: "a" | "b" | null;
  steps: StepVerdict[];
  reason: string;
}

function batchRates(sends: boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + BATCH <= sends.length; i += BATCH) out.push(sends.slice(i, i + BATCH).filter(Boolean).length / BATCH);
  return out;
}

/**
 * Reply rate per step: a send counts when any reply exists on the same
 * enrollment and step (the order in time is not checked). Only sends inside the window count. A step is judged once
 * both variants have `minPerArm` sends. The winner is the variant that wins
 * at least one step while no step goes the other way; otherwise none.
 */
export function judgeCampaign(events: StepEvent[], opts: { now?: Date; minPerArm?: number; windowDays?: number } = {}): CampaignGrowthResult {
  const now = (opts.now ?? new Date()).getTime();
  const minPerArm = opts.minPerArm ?? MIN_SENDS_PER_ARM;
  const since = now - (opts.windowDays ?? WINDOW_DAYS) * DAY_MS;
  const replied = new Set(events.filter((e) => e.eventType === "reply").map((e) => `${e.enrollmentId}:${e.stepPosition}`));
  const byStep = new Map<number, { a: boolean[]; b: boolean[] }>();
  const sent = events.filter((e) => e.eventType === "sent" && Date.parse(e.occurredAt) >= since && Date.parse(e.occurredAt) <= now);
  for (const e of sent.sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt))) {
    const arms = byStep.get(e.stepPosition) ?? { a: [], b: [] };
    arms[e.variant === "b" ? "b" : "a"].push(replied.has(`${e.enrollmentId}:${e.stepPosition}`));
    byStep.set(e.stepPosition, arms);
  }
  const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
  const steps: StepVerdict[] = [...byStep.entries()]
    .sort(([x], [y]) => x - y)
    .map(([step, arms]) => {
      const base = { step, sends: { a: arms.a.length, b: arms.b.length }, replyRate: { a: rate(arms.a), b: rate(arms.b) } };
      if (arms.a.length < minPerArm || arms.b.length < minPerArm) {
        return { ...base, verdict: "inconclusive" as Verdict, relativeChange: null, beatShare: null, reason: `Needs ${minPerArm} sends per variant (A ${arms.a.length}, B ${arms.b.length}).` };
      }
      const v = experimentVerdict({ control: batchRates(arms.a), variant: batchRates(arms.b), minPerArm: Math.max(1, Math.floor(minPerArm / BATCH)) });
      return { ...base, verdict: v.verdict, relativeChange: v.relativeChange, beatShare: v.beatShare, reason: v.reason };
    });
  const bWins = steps.some((s) => s.verdict === "win");
  const aWins = steps.some((s) => s.verdict === "loss");
  if (bWins && !aWins) return { winner: "b", steps, reason: "B won at least one step and no step went to A." };
  if (aWins && !bWins) return { winner: "a", steps, reason: "A won at least one step and no step went to B." };
  return { winner: null, steps, reason: bWins && aWins ? "Steps disagree: no winner." : "No step has a clear winner yet." };
}

/** Sent and reply events of one campaign in its company, oldest first, capped at MAX_EVENTS. Reads the company's rows only. */
export async function readStepEvents(ctx: PluginContext, companyId: string, campaignId: string, sinceIso: string): Promise<StepEvent[]> {
  const rows = await ctx.db.query<{ enrollment_id: string; step_position: number; event_type: string; variant: string | null; occurred_at: unknown }>(
    `SELECT enrollment_id, step_position, event_type, variant, occurred_at
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1 AND campaign_id = $2 AND event_type IN ('sent', 'reply') AND occurred_at >= $3::timestamptz
      ORDER BY occurred_at
      LIMIT ${MAX_EVENTS}`,
    [companyId, campaignId, sinceIso],
  );
  return rows.map((r) => ({
    enrollmentId: r.enrollment_id,
    stepPosition: Number(r.step_position),
    eventType: r.event_type,
    variant: r.variant,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  }));
}

/** Judge one campaign. With `apply`, set `winner_variant` when there is a winner and none is declared yet; a declared winner is never overwritten. */
export async function measureCampaign(
  ctx: PluginContext,
  companyId: string,
  campaignId: string,
  opts: { apply?: boolean; now?: Date; minPerArm?: number } = {},
): Promise<CampaignGrowthResult & { applied: boolean; truncated: boolean }> {
  const campaign = await getCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== companyId) throw new Error("Campaign was not found");
  const now = opts.now ?? new Date();
  // A reply may land after the window closes, so the read starts at the window and runs to now.
  const events = await readStepEvents(ctx, companyId, campaignId, new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString());
  const truncated = events.length >= MAX_EVENTS;
  const result = judgeCampaign(events, { now, minPerArm: opts.minPerArm });
  if (!opts.apply || !result.winner || campaign.winnerVariant) return { ...result, applied: false, truncated };
  assertCanDeclareWinner(campaign.status);
  campaign.winnerVariant = result.winner;
  await saveCampaign(ctx, campaign);
  return { ...result, applied: true, truncated };
}

/** The metric rows come from `campaign_step_events` through `measureCampaign`, so the generic source has nothing to fetch. */
const campaignsMetricSource: MetricSource = {
  channel: CAMPAIGNS_CHANNEL,
  async fetchMetrics() {
    return [];
  },
};

export const campaignsAdapter: ChannelAdapter = {
  channel: CAMPAIGNS_CHANNEL,
  defaultObjective: "Raise the reply rate of each campaign step, over the 7 days after it is sent.",
  defaultMetric: "reply rate lift at 7d",
  minPerArm: MIN_SENDS_PER_ARM,
  windowDays: WINDOW_DAYS,
  hypothesisCandidates: (program: ProgramFeatureContext) => kitHypothesisCandidates({ scoreboard: {}, ...program }),
  source: campaignsMetricSource,
};
