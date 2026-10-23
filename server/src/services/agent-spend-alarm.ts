import { deriveAgentUrlKey } from "@paperclipai/shared";
import { and, desc, eq, gte, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { resolveCacheAdjustedCostUsd } from "./run-list-cost.js";

/**
 * Per-agent spend alarm (PAR-1963, plan section 3.3 on PAR-1964). Pauses an
 * agent whose run rate or list cost over the last 60 minutes runs away.
 * Reads `heartbeat_runs`, not `cost_events`: subscription runs record 0 billed
 * cents there, and their list cost only lives in `usage_json`.
 */

/** Defaults are Peet's call (PAR-1964 section 8, values on PAR-1999). */
export const SPEND_ALARM_DEFAULTS = {
  maxRunsPerHour: 60,
  maxListCentsPerHour: 5000,
} as const;
export const SPEND_ALARM_MAX_RUNS_ENV = "PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR";
export const SPEND_ALARM_MAX_LIST_CENTS_ENV = "PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR";
export const SPEND_ALARM_WINDOW_MINUTES = 60;
export const SPEND_ALARM_TRIPPED_ACTION = "agent.spend_alarm_tripped";
export const SPEND_ALARM_ACTOR_ID = "spend_alarm";

// Same env key and parsing as the T1 ops-alert helper (`readOpsAlertIssueId`
// in ops-alerts.ts). Replace with that import once T1 has merged.
const OPS_ALERT_ISSUE_ID_ENV = "PAPERCLIP_OPS_ALERT_ISSUE_ID";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readOpsAlertIssueId(env: NodeJS.ProcessEnv): string | null {
  const raw = env[OPS_ALERT_ISSUE_ID_ENV]?.trim();
  return raw && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

export type SpendAlarmConfig = {
  /** 0 disables the run cap. */
  maxRunsPerHour: number;
  /** 0 disables the list cost cap. */
  maxListCentsPerHour: number;
};

function readCap(raw: string | undefined, fallback: number) {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : fallback;
}

/** Read per evaluation so an env change applies on the next cost event. Invalid means default. */
export function readSpendAlarmConfig(env: NodeJS.ProcessEnv = process.env): SpendAlarmConfig {
  return {
    maxRunsPerHour: readCap(env[SPEND_ALARM_MAX_RUNS_ENV], SPEND_ALARM_DEFAULTS.maxRunsPerHour),
    maxListCentsPerHour: readCap(
      env[SPEND_ALARM_MAX_LIST_CENTS_ENV],
      SPEND_ALARM_DEFAULTS.maxListCentsPerHour,
    ),
  };
}

const SAST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** One line: what, since when (SAST), impact, link, what Peet must do (PAR-1844 rule). */
export function buildSpendAlarmAlertBody(input: {
  agentName: string;
  agentLink: string;
  runsStarted: number;
  listCents: number;
  config: SpendAlarmConfig;
  windowStart: Date;
}) {
  const runCap = input.config.maxRunsPerHour > 0 ? `${input.config.maxRunsPerHour}` : "off";
  const costCap =
    input.config.maxListCentsPerHour > 0 ? formatUsd(input.config.maxListCentsPerHour) : "off";
  return (
    `Spend alarm: ${input.agentName} started ${input.runsStarted} runs and used ` +
    `${formatUsd(input.listCents)} list since ${SAST_TIME.format(input.windowStart)} SAST ` +
    `(caps per hour: ${runCap} runs, ${costCap}). The agent is paused (reason: system) and its queued ` +
    `wakes are cancelled; a running run finishes. ${input.agentLink}. ` +
    `Need: check its recent runs, then resume it on ${input.agentLink} when it is safe.`
  );
}

export type SpendAlarmOpsAlertInput = { companyId: string; key: string; body: string };

export type SpendAlarmHooks = {
  /**
   * Cancels the agent's queued runs and queued wake requests, leaving a running
   * run alone. Wired to `heartbeat.cancelQueuedWorkForAgent`.
   */
  cancelQueuedWorkForAgent?: (agentId: string, reason: string) => Promise<unknown>;
  /** T1's `opsAlertService(...).postOpsAlert`. Unset: the alert is only logged. */
  postOpsAlert?: (input: SpendAlarmOpsAlertInput) => Promise<unknown>;
};

export type SpendAlarmCounters = {
  windowStart: Date;
  runsStarted: number;
  listCents: number;
};

export type SpendAlarmResult =
  | { kind: "disabled" }
  | { kind: "skipped"; reason: "agent_not_found" | "agent_not_running" }
  | ({ kind: "pass" } & SpendAlarmCounters)
  | ({ kind: "already_paused" } & SpendAlarmCounters)
  | ({ kind: "tripped"; activityId: string } & SpendAlarmCounters);

const NOT_PAUSABLE_STATUSES = ["paused", "terminated", "pending_approval"];

export function agentSpendAlarmService(
  db: Db,
  hooks: SpendAlarmHooks = {},
  options: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
) {
  const readEnv = () => options.env ?? process.env;
  const readNow = () => options.now?.() ?? new Date();

  async function readCounters(
    companyId: string,
    agentId: string,
    now: Date,
    opsAlertIssueId: string | null,
  ): Promise<SpendAlarmCounters> {
    // Window anchor: a resume must not re-trip on the runs that caused the trip.
    const lastTrip = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "agent"),
          eq(activityLog.entityId, agentId),
          eq(activityLog.action, SPEND_ALARM_TRIPPED_ACTION),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null);
    const hourAgo = new Date(now.getTime() - SPEND_ALARM_WINDOW_MINUTES * 60_000);
    const windowStart = lastTrip && lastTrip > hourAgo ? lastTrip : hourAgo;

    const [runRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          gte(heartbeatRuns.createdAt, windowStart),
          isNull(heartbeatRuns.retryOfRunId),
          // Alert-issue runs never count, so a noisy night cannot pause the relay.
          opsAlertIssueId
            ? sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') is distinct from ${opsAlertIssueId}`
            : undefined,
        ),
      );

    const costRows = await db
      .select({
        costUsd: sql<unknown>`${heartbeatRuns.usageJson} -> 'costUsd'`,
        cacheAdjustedCostUsd: sql<unknown>`${heartbeatRuns.usageJson} -> 'cacheAdjustedCostUsd'`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          isNotNull(heartbeatRuns.finishedAt),
          gte(heartbeatRuns.finishedAt, windowStart),
          isNotNull(heartbeatRuns.usageJson),
        ),
      );
    const listUsd = costRows.reduce(
      (sum, row) => sum + (resolveCacheAdjustedCostUsd(row) ?? 0),
      0,
    );

    return {
      windowStart,
      runsStarted: Number(runRow?.count ?? 0),
      listCents: Math.round(listUsd * 100),
    };
  }

  /**
   * One evaluation point: `costService.createEvent`, after the budget check,
   * for events with an agent. Trips at most once per breach: the pause is a
   * conditional update, so concurrent evaluations cannot both alert.
   */
  async function evaluateAgent(companyId: string, agentId: string): Promise<SpendAlarmResult> {
    const env = readEnv();
    const config = readSpendAlarmConfig(env);
    if (config.maxRunsPerHour === 0 && config.maxListCentsPerHour === 0) {
      return { kind: "disabled" };
    }

    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        issuePrefix: companies.issuePrefix,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) return { kind: "skipped", reason: "agent_not_found" };
    // Already paused (budget, manual or an earlier trip): nothing to do.
    if (NOT_PAUSABLE_STATUSES.includes(agent.status)) {
      return { kind: "skipped", reason: "agent_not_running" };
    }

    const now = readNow();
    const counters = await readCounters(companyId, agentId, now, readOpsAlertIssueId(env));
    const runsTripped = config.maxRunsPerHour > 0 && counters.runsStarted >= config.maxRunsPerHour;
    const costTripped =
      config.maxListCentsPerHour > 0 && counters.listCents >= config.maxListCentsPerHour;
    if (!runsTripped && !costTripped) return { kind: "pass", ...counters };

    // Not `agentService.pause`: that is read-then-write, so two cost events
    // finishing together would both pause and both alert. Same columns it sets.
    const publications: ActivityPublication[] = [];
    const tripped = await db.transaction(async (tx) => {
      const paused = await tx
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "system",
          pausedAt: now,
          errorReason: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agentId), notInArray(agents.status, NOT_PAUSABLE_STATUSES)))
        .returning({ id: agents.id })
        .then((rows) => rows[0] ?? null);
      if (!paused) return null;
      // Same transaction as the pause: the window anchor must exist whenever
      // the pause does, or a resume would re-trip on the same runs.
      return logActivity(tx as unknown as Db, {
        companyId,
        actorType: "system",
        actorId: SPEND_ALARM_ACTOR_ID,
        agentId,
        action: SPEND_ALARM_TRIPPED_ACTION,
        entityType: "agent",
        entityId: agentId,
        details: {
          runsStarted: counters.runsStarted,
          listCents: counters.listCents,
          maxRunsPerHour: config.maxRunsPerHour,
          maxListCentsPerHour: config.maxListCentsPerHour,
          trippedBy: [runsTripped ? "runs" : null, costTripped ? "list_cost" : null].filter(Boolean),
          windowStart: counters.windowStart.toISOString(),
          pauseReason: "system",
        },
      }, publications);
    });
    if (!tripped) return { kind: "already_paused", ...counters };
    for (const publication of publications) publishActivity(publication);

    logger.warn(
      { companyId, agentId, ...counters, config, activityId: tripped.id },
      "agent_spend_alarm.tripped",
    );

    // Leaves the in-flight run alone: cancelling mid-run risks a half-written PR.
    try {
      await hooks.cancelQueuedWorkForAgent?.(agentId, "Cancelled by the spend alarm");
    } catch (err) {
      logger.error({ err, companyId, agentId }, "agent_spend_alarm.cancel_queued_failed");
    }

    const agentUrlKey = deriveAgentUrlKey(agent.name, agent.id);
    const agentLink = `[${agent.name}](/${agent.issuePrefix}/agents/${agentUrlKey})`;
    const alert = {
      companyId,
      key: `spend_alarm:${agentId}:${tripped.id}`,
      body: buildSpendAlarmAlertBody({
        agentName: agent.name,
        agentLink,
        runsStarted: counters.runsStarted,
        listCents: counters.listCents,
        config,
        windowStart: counters.windowStart,
      }),
    };
    try {
      if (hooks.postOpsAlert) {
        await hooks.postOpsAlert(alert);
      } else {
        logger.warn(alert, "ops_alert.log_only");
      }
    } catch (err) {
      logger.error({ err, key: alert.key }, "agent_spend_alarm.alert_failed");
    }

    return { kind: "tripped", activityId: tripped.id, ...counters };
  }

  return { evaluateAgent };
}
