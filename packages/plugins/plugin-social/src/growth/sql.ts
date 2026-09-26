/**
 * GrowthStore on the plugin namespace. Host SQL guard rules apply (see
 * db.ts): qualified tables, one statement per call, JSON params for lists,
 * and every write a single statement (upserts instead of read-then-write).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, isClientKind, textArrayParam, type ClientScope, type Scoreboard } from "@partnersinbiz/pib-plugin-kit";
import { iso, postMedia, setPostExperiment, table } from "../db.js";
import { AUTOPILOT_MODES, type ArmSpec, type Autopilot, type FeatureQuestion, type ScoredPostRow } from "./engine.js";
import type {
  ChangePatch,
  Experiment,
  ExperimentPatch,
  ExperimentStatus,
  ExistingScore,
  GrowthStore,
  MetricRow,
  NewChange,
  NewExperiment,
  NewProgram,
  PlaybookChange,
  Program,
  ProgramPatch,
} from "./store.js";

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

type Row = Record<string, unknown>;

const PROGRAM_COLS = "id, company_id, client_kind, client_ref, client_name, channel, objective, metric, constraints, playbook, playbook_version, autopilot, scoreboard, feature_questions, status, owner_user_id, approval_issue_id, approval_week, created_at, updated_at";

function programOf(row: Row): Program {
  const autopilot = AUTOPILOT_MODES.includes(row.autopilot as Autopilot) ? (row.autopilot as Autopilot) : "safe";
  const questions = json<FeatureQuestion[]>(row.feature_questions, []);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    clientKind: row.client_ref ? (isClientKind(row.client_kind) ? row.client_kind : "company") : null,
    clientRef: str(row.client_ref),
    clientName: str(row.client_name),
    channel: String(row.channel),
    objective: String(row.objective ?? ""),
    metric: String(row.metric ?? ""),
    constraints: json<Program["constraints"]>(row.constraints, {}) ?? {},
    playbook: String(row.playbook ?? ""),
    playbookVersion: num(row.playbook_version) ?? 1,
    autopilot,
    scoreboard: json<Scoreboard>(row.scoreboard, {}) ?? {},
    featureQuestions: Array.isArray(questions) ? questions : [],
    status: String(row.status ?? "active"),
    ownerUserId: str(row.owner_user_id),
    approvalIssueId: str(row.approval_issue_id),
    approvalWeek: str(row.approval_week),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const EXPERIMENT_COLS = "id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, window_days, status, proposed_by, approval_issue_id, approved_at, approved_by, started_at, measure_after, measured_at, verdict, outcome, playbook_diff, playbook_decision, decision_note, created_at, updated_at";

function experimentOf(row: Row): Experiment {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    programId: String(row.program_id),
    hypothesis: String(row.hypothesis),
    hypothesisType: String(row.hypothesis_type),
    variable: String(row.variable),
    arms: json<ArmSpec[]>(row.arms, []),
    metric: String(row.metric),
    minPerArm: num(row.min_per_arm) ?? 3,
    windowDays: num(row.window_days) ?? 7,
    status: String(row.status) as ExperimentStatus,
    proposedBy: str(row.proposed_by),
    approvalIssueId: str(row.approval_issue_id),
    approvedAt: iso(row.approved_at),
    approvedBy: str(row.approved_by),
    startedAt: iso(row.started_at),
    measureAfter: iso(row.measure_after),
    measuredAt: iso(row.measured_at),
    verdict: str(row.verdict),
    outcome: json<Record<string, unknown> | null>(row.outcome, null),
    playbookDiff: str(row.playbook_diff),
    playbookDecision: (str(row.playbook_decision) as Experiment["playbookDecision"]) ?? null,
    decisionNote: str(row.decision_note),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const CHANGE_COLS = "id, company_id, program_id, experiment_id, op, section, body, diff, reason, status, base_version, result_version, proposed_by, decided_by, decided_at, decision_note, approval_issue_id, created_at";

function changeOf(row: Row): PlaybookChange {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    programId: String(row.program_id),
    experimentId: str(row.experiment_id),
    op: String(row.op) as PlaybookChange["op"],
    section: str(row.section),
    body: String(row.body),
    diff: String(row.diff),
    reason: String(row.reason),
    status: String(row.status) as PlaybookChange["status"],
    baseVersion: num(row.base_version) ?? 1,
    resultVersion: num(row.result_version),
    proposedBy: str(row.proposed_by),
    decidedBy: str(row.decided_by),
    decidedAt: iso(row.decided_at),
    decisionNote: str(row.decision_note),
    approvalIssueId: str(row.approval_issue_id),
    createdAt: iso(row.created_at),
  };
}

function scopeFilter(scope: ClientScope, params: unknown[], alias = ""): string {
  const w = clientWhere(scope, params.length + 1, alias);
  params.push(...w.params);
  return w.sql;
}

export function sqlGrowthStore(ctx: PluginContext): GrowthStore {
  const T = (name: string) => table(ctx, name);
  return {
    async findProgram(companyId, channel, scope) {
      const params: unknown[] = [companyId, channel];
      const where = scopeFilter(scope, params);
      const rows = await ctx.db.query<Row>(`SELECT ${PROGRAM_COLS} FROM ${T("growth_programs")} WHERE company_id = $1 AND channel = $2 AND ${where} LIMIT 1`, params);
      return rows[0] ? programOf(rows[0]) : null;
    },
    async getProgram(companyId, id) {
      const rows = await ctx.db.query<Row>(`SELECT ${PROGRAM_COLS} FROM ${T("growth_programs")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? programOf(rows[0]) : null;
    },
    async insertProgram(p: NewProgram) {
      await ctx.db.execute(
        `INSERT INTO ${T("growth_programs")}
          (id, company_id, client_kind, client_ref, client_name, channel, objective, metric, constraints, playbook, playbook_version, autopilot, scoreboard, feature_questions, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
         ON CONFLICT DO NOTHING`,
        [
          p.id, p.companyId, p.clientKind, p.clientRef, p.clientName, p.channel, p.objective, p.metric, JSON.stringify(p.constraints), p.playbook,
          p.playbookVersion, p.autopilot, JSON.stringify(p.scoreboard), JSON.stringify(p.featureQuestions), p.ownerUserId,
        ],
      );
    },
    async updateProgram(companyId, id, patch: ProgramPatch) {
      await ctx.db.execute(
        `UPDATE ${T("growth_programs")}
            SET objective = COALESCE($3, objective),
                autopilot = COALESCE($4, autopilot),
                constraints = COALESCE($5::jsonb, constraints),
                owner_user_id = COALESCE($6, owner_user_id),
                scoreboard = COALESCE($7::jsonb, scoreboard),
                feature_questions = COALESCE($8::jsonb, feature_questions),
                approval_issue_id = COALESCE($9, approval_issue_id),
                approval_week = COALESCE($10, approval_week),
                client_name = COALESCE($11, client_name),
                updated_at = now()
          WHERE id = $1 AND company_id = $2`,
        [
          id, companyId, patch.objective ?? null, patch.autopilot ?? null, patch.constraints ? JSON.stringify(patch.constraints) : null, patch.ownerUserId ?? null,
          patch.scoreboard ? JSON.stringify(patch.scoreboard) : null, patch.featureQuestions ? JSON.stringify(patch.featureQuestions) : null,
          patch.approvalIssueId ?? null, patch.approvalWeek ?? null, patch.clientName ?? null,
        ],
      );
    },
    async savePlaybook(companyId, id, expectedVersion, playbook) {
      const res = await ctx.db.execute(
        `UPDATE ${T("growth_programs")} SET playbook = $4, playbook_version = playbook_version + 1, updated_at = now()
          WHERE id = $1 AND company_id = $2 AND playbook_version = $3`,
        [id, companyId, expectedVersion, playbook],
      );
      return res.rowCount === 1;
    },
    async insertPlaybookVersion(v) {
      await ctx.db.execute(
        `INSERT INTO ${T("growth_playbook_versions")} (id, program_id, version, playbook, reason, experiment_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (program_id, version) DO NOTHING`,
        [randomUUID(), v.programId, v.version, v.playbook, v.reason, v.experimentId, v.createdBy],
      );
    },
    async listPlaybookVersions(programId, limit) {
      const rows = await ctx.db.query<Row>(
        `SELECT version, playbook, reason, experiment_id, created_by, created_at FROM ${T("growth_playbook_versions")}
          WHERE program_id = $1 ORDER BY version DESC LIMIT $2`,
        [programId, Math.min(Math.max(limit, 1), 100)],
      );
      return rows.map((r) => ({ version: num(r.version) ?? 1, playbook: String(r.playbook), reason: String(r.reason), experimentId: str(r.experiment_id), createdBy: str(r.created_by), createdAt: iso(r.created_at) }));
    },

    async insertExperiment(e: NewExperiment) {
      await ctx.db.execute(
        `INSERT INTO ${T("growth_experiments")}
          (id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, window_days, status, proposed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
        [e.id, e.companyId, e.programId, e.hypothesis, e.hypothesisType, e.variable, JSON.stringify(e.arms), e.metric, e.minPerArm, e.windowDays, e.status, e.proposedBy],
      );
    },
    async getExperiment(companyId, id) {
      const rows = await ctx.db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? experimentOf(rows[0]) : null;
    },
    async listExperiments(companyId, programId, statuses) {
      const params: unknown[] = [companyId, programId];
      let where = "company_id = $1 AND program_id = $2";
      if (statuses?.length) {
        params.push(JSON.stringify(statuses));
        where += ` AND status = ANY(${textArrayParam(params.length)})`;
      }
      const rows = await ctx.db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
      return rows.map(experimentOf);
    },
    async updateExperiment(companyId, id, from, patch: ExperimentPatch) {
      const res = await ctx.db.execute(
        `UPDATE ${T("growth_experiments")}
            SET status = COALESCE($3, status),
                approval_issue_id = COALESCE($4, approval_issue_id),
                approved_at = COALESCE($5::timestamptz, approved_at),
                approved_by = COALESCE($6, approved_by),
                started_at = COALESCE($7::timestamptz, started_at),
                measure_after = COALESCE($8::timestamptz, measure_after),
                measured_at = COALESCE($9::timestamptz, measured_at),
                verdict = COALESCE($10, verdict),
                outcome = COALESCE($11::jsonb, outcome),
                playbook_diff = COALESCE($12, playbook_diff),
                playbook_decision = COALESCE($13, playbook_decision),
                decision_note = COALESCE($14, decision_note),
                updated_at = now()
          WHERE id = $1 AND company_id = $2 AND ($15::jsonb IS NULL OR status = ANY(${textArrayParam(15)}))`,
        [
          id, companyId, patch.status ?? null, patch.approvalIssueId ?? null, patch.approvedAt ?? null, patch.approvedBy ?? null, patch.startedAt ?? null,
          patch.measureAfter ?? null, patch.measuredAt ?? null, patch.verdict ?? null, patch.outcome ? JSON.stringify(patch.outcome) : null,
          patch.playbookDiff ?? null, patch.playbookDecision ?? null, patch.decisionNote ?? null, from ? JSON.stringify(from) : null,
        ],
      );
      return res.rowCount === 1;
    },
    async companiesWithRunningExperiments() {
      const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${T("growth_experiments")} WHERE status = 'running'`);
      return rows.map((r) => r.company_id);
    },
    async runningExperiments(companyId) {
      const rows = await ctx.db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE company_id = $1 AND status = 'running' ORDER BY started_at`, [companyId]);
      return rows.map(experimentOf);
    },

    async upsertItem(experimentId, arm, postId, value) {
      await ctx.db.execute(
        `INSERT INTO ${T("growth_experiment_items")} (experiment_id, arm, subject_kind, subject_id, value, measured_at)
         VALUES ($1, $2, 'post', $3, $4, CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (experiment_id, subject_kind, subject_id) DO UPDATE
           SET arm = EXCLUDED.arm, value = EXCLUDED.value, measured_at = EXCLUDED.measured_at`,
        [experimentId, arm, postId, value],
      );
    },
    async deleteItem(experimentId, postId) {
      await ctx.db.execute(
        `DELETE FROM ${T("growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = 'post' AND subject_id = $2`,
        [experimentId, postId],
      );
    },
    async listItems(experimentId) {
      const rows = await ctx.db.query<Row>(
        `SELECT experiment_id, arm, subject_id, value, measured_at FROM ${T("growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = 'post' ORDER BY created_at`,
        [experimentId],
      );
      return rows.map((r) => ({ experimentId: String(r.experiment_id), arm: String(r.arm), postId: String(r.subject_id), value: num(r.value), measuredAt: iso(r.measured_at) }));
    },
    async experimentPosts(companyId, experimentId, window) {
      const rows = await ctx.db.query<Row>(
        `SELECT p.id, p.experiment_arm, p.status, p.published_at,
                COALESCE((SELECT jsonb_agg(s.lift) FROM ${T("post_scores")} s
                           WHERE s.post_id = p.id AND s.metric_window = $3 AND s.lift IS NOT NULL), '[]'::jsonb) AS lifts
           FROM ${T("posts")} p
          WHERE p.company_id = $1 AND p.experiment_id = $2
          ORDER BY p.created_at`,
        [companyId, experimentId, window],
      );
      return rows.map((r) => ({
        postId: String(r.id),
        arm: str(r.experiment_arm),
        status: String(r.status),
        publishedAt: iso(r.published_at),
        lifts: json<unknown[]>(r.lifts, []).map(num).filter((x): x is number => x !== null),
      }));
    },
    setPostExperiment(companyId, postId, experimentId, arm) {
      return setPostExperiment(ctx, companyId, postId, experimentId, arm);
    },

    async insertChange(c: NewChange) {
      await ctx.db.execute(
        `INSERT INTO ${T("growth_playbook_changes")} (id, company_id, program_id, experiment_id, op, section, body, diff, reason, status, base_version, proposed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
        [c.id, c.companyId, c.programId, c.experimentId, c.op, c.section, c.body, c.diff, c.reason, c.baseVersion, c.proposedBy],
      );
    },
    async getChange(companyId, id) {
      const rows = await ctx.db.query<Row>(`SELECT ${CHANGE_COLS} FROM ${T("growth_playbook_changes")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? changeOf(rows[0]) : null;
    },
    async listChanges(companyId, programId, status) {
      const params: unknown[] = [companyId, programId];
      let where = "company_id = $1 AND program_id = $2";
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      const rows = await ctx.db.query<Row>(`SELECT ${CHANGE_COLS} FROM ${T("growth_playbook_changes")} WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
      return rows.map(changeOf);
    },
    async updateChange(companyId, id, patch: ChangePatch, onlyPending) {
      const res = await ctx.db.execute(
        `UPDATE ${T("growth_playbook_changes")}
            SET status = COALESCE($3, status),
                result_version = COALESCE($4, result_version),
                decided_by = COALESCE($5, decided_by),
                decided_at = CASE WHEN $3::text IS NULL THEN decided_at ELSE now() END,
                decision_note = COALESCE($6, decision_note),
                approval_issue_id = COALESCE($7, approval_issue_id)
          WHERE id = $1 AND company_id = $2 AND ($8::boolean = false OR status = 'pending')`,
        [id, companyId, patch.status ?? null, patch.resultVersion ?? null, patch.decidedBy ?? null, patch.decisionNote ?? null, patch.approvalIssueId ?? null, onlyPending],
      );
      return res.rowCount === 1;
    },

    async companiesWithMetrics(window, sinceDays) {
      const rows = await ctx.db.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${T("post_metrics")} WHERE metric_window = $1 AND recorded_at >= now() - make_interval(days => $2)`,
        [window, sinceDays],
      );
      return rows.map((r) => r.company_id);
    },
    async metricRows(companyId, window, sinceDays) {
      const rows = await ctx.db.query<Row>(
        `SELECT m.destination_id, m.post_id, COALESCE(m.account_id, d.account_id) AS account_id, m.platform, d.published_at,
                m.likes, m.comments, m.shares, m.saves, m.clicks, m.reach, m.impressions, m.views,
                p.client_kind, p.client_ref, p.client_name
           FROM ${T("post_metrics")} m
           JOIN ${T("destinations")} d ON d.id = m.destination_id
           JOIN ${T("posts")} p ON p.id = m.post_id
          WHERE m.company_id = $1 AND m.metric_window = $2 AND d.published_at IS NOT NULL
            AND d.published_at >= now() - make_interval(days => $3)
          ORDER BY d.published_at
          LIMIT 5000`,
        [companyId, window, sinceDays],
      );
      return rows.map((r): MetricRow => ({
        destinationId: String(r.destination_id),
        postId: String(r.post_id),
        accountId: str(r.account_id),
        platform: str(r.platform),
        publishedAt: iso(r.published_at),
        likes: num(r.likes),
        comments: num(r.comments),
        shares: num(r.shares),
        saves: num(r.saves),
        clicks: num(r.clicks),
        reach: num(r.reach),
        impressions: num(r.impressions),
        views: num(r.views),
        clientKind: str(r.client_kind),
        clientRef: str(r.client_ref),
        clientName: str(r.client_name),
      }));
    },
    async existingScores(companyId, window, sinceDays) {
      const rows = await ctx.db.query<Row>(
        `SELECT destination_id, engagement_rate, baseline_median, baseline_n, lift, program_id FROM ${T("post_scores")}
          WHERE company_id = $1 AND metric_window = $2 AND published_at >= now() - make_interval(days => $3)`,
        [companyId, window, sinceDays],
      );
      const out = new Map<string, ExistingScore>();
      for (const r of rows) {
        out.set(String(r.destination_id), { engagementRate: num(r.engagement_rate) ?? 0, baselineMedian: num(r.baseline_median), baselineN: num(r.baseline_n) ?? 0, lift: num(r.lift), programId: str(r.program_id) });
      }
      return out;
    },
    async upsertScore(s) {
      await ctx.db.execute(
        `INSERT INTO ${T("post_scores")}
          (destination_id, metric_window, company_id, post_id, account_id, platform, program_id, client_kind, client_ref, engagement_rate, basis,
           baseline_median, baseline_n, lift, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
         ON CONFLICT (destination_id, metric_window) DO UPDATE
           SET engagement_rate = EXCLUDED.engagement_rate, basis = EXCLUDED.basis, baseline_median = EXCLUDED.baseline_median,
               baseline_n = EXCLUDED.baseline_n, lift = EXCLUDED.lift, program_id = EXCLUDED.program_id, scored_at = now()`,
        [
          s.destinationId, s.window, s.companyId, s.postId, s.accountId, s.platform, s.programId, s.clientKind, s.clientRef, s.engagementRate, s.basis,
          s.baselineMedian, s.baselineN, s.lift, s.publishedAt,
        ],
      );
    },

    async postsToTag(companyId, sinceDays, limit) {
      const rows = await ctx.db.query<Row>(
        `SELECT p.id, p.body, p.media, p.client_kind, p.client_ref, p.client_name,
                COALESCE((SELECT min(d.published_at) FROM ${T("destinations")} d WHERE d.post_id = p.id AND d.published_at IS NOT NULL), p.published_at) AS first_published_at,
                COALESCE((SELECT jsonb_agg(f.feature_key) FROM ${T("post_features")} f WHERE f.post_id = p.id), '[]'::jsonb) AS feature_keys
           FROM ${T("posts")} p
          WHERE p.company_id = $1 AND p.status IN ('published', 'partially_published')
            AND COALESCE(p.published_at, p.updated_at) >= now() - make_interval(days => $2)
          ORDER BY p.created_at DESC
          LIMIT $3`,
        [companyId, sinceDays, Math.min(Math.max(limit, 1), 1000)],
      );
      return rows.map((r) => ({
        id: String(r.id),
        body: String(r.body ?? ""),
        media: postMedia({ media: r.media }),
        publishedAt: iso(r.first_published_at),
        clientKind: str(r.client_kind),
        clientRef: str(r.client_ref),
        clientName: str(r.client_name),
        featureKeys: json<unknown[]>(r.feature_keys, []).filter((k): k is string => typeof k === "string"),
      }));
    },
    async upsertFeatures(companyId, programId, postId, values, model) {
      if (values.length === 0) return;
      await ctx.db.execute(
        `INSERT INTO ${T("post_features")} (post_id, feature_key, company_id, program_id, value, confidence, source, decision_id, model)
         SELECT $1, x.key, $2, $3, x.value, x.confidence, x.source, x.decision_id, $5
           FROM jsonb_to_recordset($4::jsonb) AS x(key text, value text, confidence numeric, source text, decision_id text)
         ON CONFLICT (post_id, feature_key) DO UPDATE
           SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, source = EXCLUDED.source, decision_id = EXCLUDED.decision_id,
               model = EXCLUDED.model, program_id = EXCLUDED.program_id, updated_at = now()`,
        [
          postId, companyId, programId,
          JSON.stringify(values.map((v) => ({ key: v.key, value: v.value, confidence: v.confidence, source: v.source, decision_id: v.decisionId ?? null }))),
          model,
        ],
      );
    },
    async postFeatures(companyId, postIds) {
      if (postIds.length === 0) return [];
      const rows = await ctx.db.query<Row>(
        `SELECT post_id, feature_key, value, confidence, source FROM ${T("post_features")}
          WHERE company_id = $1 AND post_id = ANY(${textArrayParam(2)})`,
        [companyId, JSON.stringify(postIds)],
      );
      return rows.map((r) => ({ postId: String(r.post_id), key: String(r.feature_key), value: str(r.value), confidence: num(r.confidence) ?? 0, source: String(r.source) }));
    },
    async scoredPosts(companyId, scope, window, sinceDays) {
      const params: unknown[] = [companyId, window, sinceDays];
      const where = scopeFilter(scope, params, "s");
      const rows = await ctx.db.query<Row>(
        `SELECT s.post_id, p.body, s.platform, s.account_id, s.published_at, s.engagement_rate, s.lift, p.experiment_id, p.experiment_arm
           FROM ${T("post_scores")} s
           JOIN ${T("posts")} p ON p.id = s.post_id
          WHERE s.company_id = $1 AND s.metric_window = $2 AND s.published_at >= now() - make_interval(days => $3) AND ${where}
          ORDER BY s.published_at DESC
          LIMIT 3000`,
        params,
      );
      return rows.map((r): ScoredPostRow => ({
        postId: String(r.post_id),
        body: String(r.body ?? ""),
        platform: str(r.platform),
        accountId: str(r.account_id),
        publishedAt: iso(r.published_at),
        engagementRate: num(r.engagement_rate) ?? 0,
        lift: num(r.lift),
        experimentId: str(r.experiment_id),
        experimentArm: str(r.experiment_arm),
      }));
    },
  };
}
