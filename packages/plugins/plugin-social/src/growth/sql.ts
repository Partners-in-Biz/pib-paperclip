/**
 * GrowthStore on the plugin namespace (core tables here; the Social-only
 * post features, scores and metrics are in features-sql.ts). Host SQL guard rules apply (see
 * db.ts): qualified tables, one statement per call, JSON params for lists,
 * and every write a single statement (upserts instead of read-then-write).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isClientKind, textArrayParam, type Scoreboard } from "@partnersinbiz/pib-plugin-kit";
import { iso, table } from "../db.js";
import { AUTOPILOT_MODES, type ArmSpec, type Autopilot, type FeatureQuestion } from "./engine.js";
import { sqlFeatures } from "./features-sql.js";
import { json, num, scopeFilter, str, type Row } from "./sql-util.js";
import type {
  ChangePatch,
  Experiment,
  ExperimentPatch,
  ExperimentStatus,
  CoreGrowthStore,
  GrowthStore,
  NewChange,
  NewExperiment,
  NewProgram,
  PlaybookChange,
  Program,
  ProgramPatch,
} from "./store.js";

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

export function sqlCoreStore(ctx: PluginContext): CoreGrowthStore {
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
  };
}

/** Core store plus the Social-only features port, as the service sees it. */
export function sqlGrowthStore(ctx: PluginContext): GrowthStore {
  return { ...sqlCoreStore(ctx), ...sqlFeatures(ctx) };
}
