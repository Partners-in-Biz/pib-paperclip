/**
 * A small in-memory copy of the two tables the page-group flows read back after writing (sprint_tasks and task_chunks), for
 * the fake plugin host. Reads answer by SQL pattern; INSERT and UPDATE statements the plugin runs are applied to the rows, so
 * a flow that closes one group and opens the next sees its own writes. Only the statement shapes src/db.ts produces are
 * understood; anything else is left to the host's own routes.
 */
import { taskRow, type Route, type Row } from "./seo-host.js";

type Host = { ctx: { db: { execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> } } };

function assignments(clause: string): Array<{ column: string; param: number | null; literal: unknown }> {
  const out: Array<{ column: string; param: number | null; literal: unknown }> = [];
  for (const part of clause.split(/,\s*(?=[a-z_]+ = )/)) {
    const m = /^\s*([a-z_]+) = (.+?)\s*$/s.exec(part);
    if (!m) continue;
    const value = m[2]!;
    const param = /^\$(\d+)(?:::\w+)?$/.exec(value);
    if (param) out.push({ column: m[1]!, param: Number(param[1]), literal: undefined });
    else if (/^NULL$/i.test(value)) out.push({ column: m[1]!, param: null, literal: null });
    else if (/^now\(\)$/i.test(value)) out.push({ column: m[1]!, param: null, literal: new Date().toISOString() });
    else if (/^'.*'$/s.test(value)) out.push({ column: m[1]!, param: null, literal: value.slice(1, -1) });
  }
  return out;
}

export function memTables(initial: { sprint_tasks?: Row[]; task_chunks?: Row[] }) {
  const tasks = (initial.sprint_tasks ?? []).map((r) => ({ ...r }));
  const chunks = (initial.task_chunks ?? []).map((r) => ({ ...r }));
  const tables: Record<string, Row[]> = { sprint_tasks: tasks, task_chunks: chunks };

  const routes: Route[] = [
    [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/, (p) => tasks.filter((t) => t.id === p[0])],
    [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE issue_id = \$1/, (p) => tasks.filter((t) => t.issue_id === p[0])],
    [/FROM plugin_seo_8099f8879a\.task_chunks WHERE company_id = \$1 AND task_id = \$2/, (p) => chunks.filter((c) => c.task_id === p[1])],
    [/FROM plugin_seo_8099f8879a\.task_chunks WHERE company_id = \$1 AND sprint_id = \$2 AND status IN/, (p) => chunks.filter((c) => c.sprint_id === p[1] && ["queued", "open"].includes(String(c.status)))],
    [/FROM plugin_seo_8099f8879a\.task_chunks WHERE company_id = \$1 AND issue_id = \$2/, (p) => chunks.filter((c) => c.issue_id === p[1]).slice(0, 1)],
    [/FROM plugin_seo_8099f8879a\.task_chunks WHERE company_id = \$1 AND id = \$2/, (p) => chunks.filter((c) => c.id === p[1]).slice(0, 1)],
    [/FROM plugin_seo_8099f8879a\.task_chunks WHERE company_id = \$1 AND status = 'open'/, () => chunks.filter((c) => c.status === "open")],
    // listTasks: a sprint's tasks, narrowed by the status list when it has one (the other filters are not used by these flows).
    [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE company_id = \$1 AND sprint_id = \$2/, (p, sql) => {
      const statuses = /status IN/.test(sql) ? (JSON.parse(String(p[2])) as string[]) : null;
      return tasks.filter((t) => t.company_id === p[0] && t.sprint_id === p[1] && (!statuses || statuses.includes(String(t.status))));
    }],
    [/SELECT DISTINCT q\.task_id/, () => [...new Set(chunks.filter((q) => q.status === "queued" && !chunks.some((o) => o.task_id === q.task_id && o.parent_issue_id === q.parent_issue_id && o.status === "open")).map((q) => q.task_id))].map((task_id) => ({ task_id }))],
  ];

  /** Make the host's execute apply what the plugin writes to these tables (the call is still recorded and guarded). */
  function attach(host: Host): void {
    const original = host.ctx.db.execute.bind(host.ctx.db);
    host.ctx.db.execute = async (sql: string, params: unknown[] = []) => {
      const result = await original(sql, params);
      // db.insertTasks: 17 parameters per row, idempotent on (sprint_id, template_key).
      if (/^INSERT INTO plugin_seo_8099f8879a\.sprint_tasks \(id, company_id, sprint_id, template_key,/.test(sql)) {
        let added = 0;
        for (let i = 0; i < params.length; i += 17) {
          const [id, company_id, sprint_id, template_key, week, phase, due_day, focus, title, description, task_type, owner, autopilot_eligible, playbook_key, source, parent_optimization_id, context] = params.slice(i, i + 17);
          if (template_key != null && tasks.some((t) => t.sprint_id === sprint_id && t.template_key === template_key)) continue;
          tasks.push(taskRow({ id, company_id, sprint_id, template_key, week, phase, due_day, focus, title, description, task_type, owner, autopilot_eligible, playbook_key, source, parent_optimization_id, context }));
          added += 1;
        }
        return { rowCount: added };
      }
      const insert = /^INSERT INTO plugin_seo_8099f8879a\.task_chunks \(id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls\)/.exec(sql);
      if (insert) {
        let added = 0;
        for (let i = 0; i < params.length; i += 9) {
          const [id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls] = params.slice(i, i + 9);
          if (chunks.some((c) => c.parent_issue_id === parent_issue_id && c.seq === seq)) continue;
          chunks.push({ id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls: JSON.parse(String(urls)), status: "queued", issue_id: null, issue_identifier: null, opened_at: null, done_at: null });
          added += 1;
        }
        return { rowCount: added };
      }
      const update = /^UPDATE plugin_seo_8099f8879a\.(sprint_tasks|task_chunks) SET (.+?) WHERE id = \$(\d+) AND company_id = \$(\d+)(.*)$/s.exec(sql);
      if (update) {
        const row = tables[update[1]!]!.find((r) => r.id === params[Number(update[3]) - 1]);
        if (!row) return { rowCount: 0 };
        const tail = update[5] ?? "";
        if (/AND status = 'queued'/.test(tail) && row.status !== "queued") return { rowCount: 0 };
        if (/AND status = 'open' AND issue_id IS NULL/.test(tail) && !(row.status === "open" && row.issue_id == null)) return { rowCount: 0 };
        for (const a of assignments(update[2]!)) {
          const value = a.param ? params[a.param - 1] : a.literal;
          // jsonb parameters travel as JSON text; the table keeps them parsed, as the database would return them.
          row[a.column] = a.column === "evidence" && typeof value === "string" ? JSON.parse(value) : value;
        }
        return { rowCount: 1 };
      }
      return result;
    };
  }

  return { tasks, chunks, routes, attach };
}
