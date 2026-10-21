/**
 * Generic SQL half of the Growth Lab store: programs, playbook versions,
 * experiments, items and playbook changes, on the tables of
 * `experimentsMigration` (fresh v2 schema) or Social's 012 plus
 * `experimentsScopeAlterMigration`. Host SQL guard rules apply: qualified
 * tables, one statement per call, JSON params for lists, every write a
 * single statement.
 *
 * Programs are keyed by scope. Writes put `scope_key` and the legacy
 * `client_kind` / `client_ref` side by side so old and new readers agree;
 * reads match `scope_key`, and fall back to the legacy columns for a row
 * written before `scope_key` was backfilled.
 */
import { randomUUID } from "node:crypto";
import { clientWhere, isClientKind, scopeOfRow, type ClientScope } from "../client-ref.js";
import { textArrayParam } from "../crm-projection.js";
import type { Scoreboard } from "../experiments.js";
import { formatScopeKey } from "../growth-scope.js";
import type { GrowthStore, GrowthStoreTypes } from "./ports.js";

/** The host database, as `ctx.db` offers it. */
export interface GrowthDb {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export interface GrowthStoreOptions<T extends GrowthStoreTypes> {
  db: GrowthDb;
  /** Qualified, validated table name in the plugin namespace. */
  table: (name: string) => string;
  /**
   * The programs table has `approval_issue_id` and `approval_week` (Social's
   * 012 does; the v2 helper keeps them on playbook changes only). Default false.
   */
  programApproval?: boolean;
  /** `growth_experiment_items.subject_kind` this store reads and writes. Default "post". */
  subjectKind?: string;
  /** Shape a base program row into the plugin's own type (default: as is). */
  mapProgram?: (program: KitProgram) => T["program"];
  mapExperiment?: (experiment: KitExperiment) => T["experiment"];
  mapChange?: (change: KitChange) => T["change"];
}

type Row = Record<string, unknown>;

export interface KitProgram {
  id: string;
  companyId: string;
  scopeKey: string;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
  projectId: string | null;
  channel: string;
  objective: string;
  metric: string;
  constraints: Record<string, unknown>;
  playbook: string;
  playbookVersion: number;
  autopilot: string;
  scoreboard: Scoreboard;
  featureQuestions: unknown[];
  status: string;
  ownerUserId: string | null;
  approvalIssueId: string | null;
  approvalWeek: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface KitExperiment {
  id: string;
  companyId: string;
  programId: string;
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: Array<{ key: string; description: string }>;
  metric: string;
  minPerArm: number;
  windowDays: number;
  status: string;
  proposedBy: string | null;
  approvalIssueId: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  measureAfter: string | null;
  measuredAt: string | null;
  verdict: string | null;
  outcome: Record<string, unknown> | null;
  playbookDiff: string | null;
  playbookDecision: string | null;
  decisionNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface KitChange {
  id: string;
  companyId: string;
  programId: string;
  experimentId: string | null;
  op: string;
  section: string | null;
  body: string;
  diff: string;
  reason: string;
  status: string;
  baseVersion: number;
  resultVersion: number | null;
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalIssueId: string | null;
  createdAt: string | null;
}

export interface KitPlaybookVersion {
  version: number;
  playbook: string;
  reason: string;
  experimentId: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface KitExperimentItem {
  experimentId: string;
  arm: string;
  postId: string;
  value: number | null;
  measuredAt: string | null;
}

function json<V>(value: unknown, fallback: V): V {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as V;
    } catch {
      return fallback;
    }
  }
  return value as V;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** The scope key a program of this scope is stored under. */
export function scopeKeyOf(scope: ClientScope): string {
  return scope ? formatScopeKey({ type: "client", kind: scope.kind, ref: scope.id }) : formatScopeKey({ type: "own" });
}

const EXPERIMENT_COLS = "id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, window_days, status, proposed_by, approval_issue_id, approved_at, approved_by, started_at, measure_after, measured_at, verdict, outcome, playbook_diff, playbook_decision, decision_note, created_at, updated_at";
const CHANGE_COLS = "id, company_id, program_id, experiment_id, op, section, body, diff, reason, status, base_version, result_version, proposed_by, decided_by, decided_at, decision_note, approval_issue_id, created_at";

function experimentOf(row: Row): KitExperiment {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    programId: String(row.program_id),
    hypothesis: String(row.hypothesis),
    hypothesisType: String(row.hypothesis_type),
    variable: String(row.variable),
    arms: json<KitExperiment["arms"]>(row.arms, []),
    metric: String(row.metric),
    minPerArm: num(row.min_per_arm) ?? 3,
    windowDays: num(row.window_days) ?? 7,
    status: String(row.status),
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
    playbookDecision: str(row.playbook_decision),
    decisionNote: str(row.decision_note),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function changeOf(row: Row): KitChange {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    programId: String(row.program_id),
    experimentId: str(row.experiment_id),
    op: String(row.op),
    section: str(row.section),
    body: String(row.body),
    diff: String(row.diff),
    reason: String(row.reason),
    status: String(row.status),
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

/**
 * The store over the generic tables. `T` is the plugin's own entity types;
 * rows are built as the Kit* shapes above and handed to the `map*` hooks
 * (default: used as is, so `T` must then be structurally the Kit* shape).
 */
export function createGrowthStore<T extends GrowthStoreTypes>(opts: GrowthStoreOptions<T>): GrowthStore<T> {
  const { db } = opts;
  const T = opts.table;
  const subjectKind = opts.subjectKind ?? "post";
  const programCols = `id, company_id, scope_key, client_kind, client_ref, client_name, project_id, channel, objective, metric, constraints, playbook, playbook_version, autopilot, scoreboard, feature_questions, status, owner_user_id, ${
    opts.programApproval ? "approval_issue_id, approval_week" : "NULL AS approval_issue_id, NULL AS approval_week"
  }, created_at, updated_at`;

  const programOf = (row: Row): T["program"] => {
    const questions = json<unknown[]>(row.feature_questions, []);
    const scope = scopeOfRow({ client_kind: str(row.client_kind), client_ref: str(row.client_ref) });
    const program: KitProgram = {
      id: String(row.id),
      companyId: String(row.company_id),
      scopeKey: str(row.scope_key) ?? scopeKeyOf(scope),
      clientKind: scope ? scope.kind : null,
      clientRef: scope ? scope.id : null,
      clientName: str(row.client_name),
      projectId: str(row.project_id),
      channel: String(row.channel),
      objective: String(row.objective ?? ""),
      metric: String(row.metric ?? ""),
      constraints: json<Record<string, unknown>>(row.constraints, {}) ?? {},
      playbook: String(row.playbook ?? ""),
      playbookVersion: num(row.playbook_version) ?? 1,
      autopilot: String(row.autopilot ?? "reviewed"),
      scoreboard: json<Scoreboard>(row.scoreboard, {}) ?? {},
      featureQuestions: Array.isArray(questions) ? questions : [],
      status: String(row.status ?? "active"),
      ownerUserId: str(row.owner_user_id),
      approvalIssueId: str(row.approval_issue_id),
      approvalWeek: str(row.approval_week),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
    return opts.mapProgram ? opts.mapProgram(program) : (program as unknown as T["program"]);
  };
  const experimentMapped = (row: Row): T["experiment"] => (opts.mapExperiment ? opts.mapExperiment(experimentOf(row)) : (experimentOf(row) as unknown as T["experiment"]));
  const changeMapped = (row: Row): T["change"] => (opts.mapChange ? opts.mapChange(changeOf(row)) : (changeOf(row) as unknown as T["change"]));

  return {
    async findProgram(companyId, channel, scope) {
      const params: unknown[] = [companyId, channel, scopeKeyOf(scope)];
      const legacy = clientWhere(scope, params.length + 1);
      params.push(...legacy.params);
      const rows = await db.query<Row>(
        `SELECT ${programCols} FROM ${T("growth_programs")}
          WHERE company_id = $1 AND channel = $2 AND (scope_key = $3 OR (scope_key IS NULL AND ${legacy.sql})) LIMIT 1`,
        params,
      );
      return rows[0] ? programOf(rows[0]) : null;
    },
    async getProgram(companyId, id) {
      const rows = await db.query<Row>(`SELECT ${programCols} FROM ${T("growth_programs")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? programOf(rows[0]) : null;
    },
    async insertProgram(input) {
      const p = input as Partial<KitProgram> & Pick<KitProgram, "id" | "companyId" | "channel" | "objective" | "metric" | "playbook" | "playbookVersion" | "autopilot">;
      const clientRef = p.clientRef ?? null;
      const clientKind = clientRef ? (isClientKind(p.clientKind) ? p.clientKind : "company") : null;
      const scopeKey = scopeKeyOf(clientRef ? { kind: clientKind ?? "company", id: clientRef } : null);
      await db.execute(
        `INSERT INTO ${T("growth_programs")}
          (id, company_id, scope_key, client_kind, client_ref, client_name, project_id, channel, objective, metric, constraints, playbook, playbook_version, autopilot, scoreboard, feature_questions, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15::jsonb, $16::jsonb, $17)
         ON CONFLICT DO NOTHING`,
        [
          p.id, p.companyId, scopeKey, clientKind, clientRef, p.clientName ?? null, p.projectId ?? null, p.channel, p.objective, p.metric,
          JSON.stringify(p.constraints ?? {}), p.playbook, p.playbookVersion, p.autopilot, JSON.stringify(p.scoreboard ?? {}),
          JSON.stringify(p.featureQuestions ?? []), p.ownerUserId ?? null,
        ],
      );
    },
    async updateProgram(companyId, id, input) {
      const patch = input as Partial<KitProgram>;
      const approval = opts.programApproval
        ? `, approval_issue_id = COALESCE($9, approval_issue_id), approval_week = COALESCE($10, approval_week)`
        : "";
      const params: unknown[] = [
        id, companyId, patch.objective ?? null, patch.autopilot ?? null, patch.constraints ? JSON.stringify(patch.constraints) : null, patch.ownerUserId ?? null,
        patch.scoreboard ? JSON.stringify(patch.scoreboard) : null, patch.featureQuestions ? JSON.stringify(patch.featureQuestions) : null,
      ];
      if (opts.programApproval) params.push(patch.approvalIssueId ?? null, patch.approvalWeek ?? null);
      params.push(patch.clientName ?? null);
      const nameIndex = params.length;
      await db.execute(
        `UPDATE ${T("growth_programs")}
            SET objective = COALESCE($3, objective),
                autopilot = COALESCE($4, autopilot),
                constraints = COALESCE($5::jsonb, constraints),
                owner_user_id = COALESCE($6, owner_user_id),
                scoreboard = COALESCE($7::jsonb, scoreboard),
                feature_questions = COALESCE($8::jsonb, feature_questions)${approval},
                client_name = COALESCE($${nameIndex}, client_name),
                updated_at = now()
          WHERE id = $1 AND company_id = $2`,
        params,
      );
    },
    async savePlaybook(companyId, id, expectedVersion, playbook) {
      const res = await db.execute(
        `UPDATE ${T("growth_programs")} SET playbook = $4, playbook_version = playbook_version + 1, updated_at = now()
          WHERE id = $1 AND company_id = $2 AND playbook_version = $3`,
        [id, companyId, expectedVersion, playbook],
      );
      return res.rowCount === 1;
    },
    async insertPlaybookVersion(v) {
      await db.execute(
        `INSERT INTO ${T("growth_playbook_versions")} (id, program_id, version, playbook, reason, experiment_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (program_id, version) DO NOTHING`,
        [randomUUID(), v.programId, v.version, v.playbook, v.reason, v.experimentId, v.createdBy],
      );
    },
    async listPlaybookVersions(programId, limit) {
      const rows = await db.query<Row>(
        `SELECT version, playbook, reason, experiment_id, created_by, created_at FROM ${T("growth_playbook_versions")}
          WHERE program_id = $1 ORDER BY version DESC LIMIT $2`,
        [programId, Math.min(Math.max(limit, 1), 100)],
      );
      return rows.map((r): KitPlaybookVersion => ({ version: num(r.version) ?? 1, playbook: String(r.playbook), reason: String(r.reason), experimentId: str(r.experiment_id), createdBy: str(r.created_by), createdAt: iso(r.created_at) })) as T["version"][];
    },

    async insertExperiment(input) {
      const e = input as Pick<KitExperiment, "id" | "companyId" | "programId" | "hypothesis" | "hypothesisType" | "variable" | "arms" | "metric" | "minPerArm" | "windowDays" | "status" | "proposedBy">;
      await db.execute(
        `INSERT INTO ${T("growth_experiments")}
          (id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, window_days, status, proposed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
        [e.id, e.companyId, e.programId, e.hypothesis, e.hypothesisType, e.variable, JSON.stringify(e.arms), e.metric, e.minPerArm, e.windowDays, e.status, e.proposedBy],
      );
    },
    async getExperiment(companyId, id) {
      const rows = await db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? experimentMapped(rows[0]) : null;
    },
    async listExperiments(companyId, programId, statuses) {
      const params: unknown[] = [companyId, programId];
      let where = "company_id = $1 AND program_id = $2";
      if (statuses?.length) {
        params.push(JSON.stringify(statuses));
        where += ` AND status = ANY(${textArrayParam(params.length)})`;
      }
      const rows = await db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
      return rows.map(experimentMapped);
    },
    async updateExperiment(companyId, id, from, input) {
      const patch = input as Partial<KitExperiment>;
      const res = await db.execute(
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
      const rows = await db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${T("growth_experiments")} WHERE status = 'running'`);
      return rows.map((r) => r.company_id);
    },
    async runningExperiments(companyId) {
      const rows = await db.query<Row>(`SELECT ${EXPERIMENT_COLS} FROM ${T("growth_experiments")} WHERE company_id = $1 AND status = 'running' ORDER BY started_at`, [companyId]);
      return rows.map(experimentMapped);
    },

    async upsertItem(experimentId, arm, subjectId, value) {
      await db.execute(
        `INSERT INTO ${T("growth_experiment_items")} (experiment_id, arm, subject_kind, subject_id, value, measured_at)
         VALUES ($1, $2, $5, $3, $4, CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (experiment_id, subject_kind, subject_id) DO UPDATE
           SET arm = EXCLUDED.arm, value = EXCLUDED.value, measured_at = EXCLUDED.measured_at`,
        [experimentId, arm, subjectId, value, subjectKind],
      );
    },
    async deleteItem(experimentId, subjectId) {
      await db.execute(
        `DELETE FROM ${T("growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = $3 AND subject_id = $2`,
        [experimentId, subjectId, subjectKind],
      );
    },
    async listItems(experimentId) {
      const rows = await db.query<Row>(
        `SELECT experiment_id, arm, subject_id, value, measured_at FROM ${T("growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = $2 ORDER BY created_at`,
        [experimentId, subjectKind],
      );
      return rows.map((r): KitExperimentItem => ({ experimentId: String(r.experiment_id), arm: String(r.arm), postId: String(r.subject_id), value: num(r.value), measuredAt: iso(r.measured_at) })) as T["item"][];
    },

    async insertChange(input) {
      const c = input as Pick<KitChange, "id" | "companyId" | "programId" | "experimentId" | "op" | "section" | "body" | "diff" | "reason" | "baseVersion" | "proposedBy">;
      await db.execute(
        `INSERT INTO ${T("growth_playbook_changes")} (id, company_id, program_id, experiment_id, op, section, body, diff, reason, status, base_version, proposed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
        [c.id, c.companyId, c.programId, c.experimentId, c.op, c.section, c.body, c.diff, c.reason, c.baseVersion, c.proposedBy],
      );
    },
    async getChange(companyId, id) {
      const rows = await db.query<Row>(`SELECT ${CHANGE_COLS} FROM ${T("growth_playbook_changes")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
      return rows[0] ? changeMapped(rows[0]) : null;
    },
    async listChanges(companyId, programId, status) {
      const params: unknown[] = [companyId, programId];
      let where = "company_id = $1 AND program_id = $2";
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      const rows = await db.query<Row>(`SELECT ${CHANGE_COLS} FROM ${T("growth_playbook_changes")} WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
      return rows.map(changeMapped);
    },
    async updateChange(companyId, id, input, onlyPending) {
      const patch = input as Partial<KitChange>;
      const res = await db.execute(
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
