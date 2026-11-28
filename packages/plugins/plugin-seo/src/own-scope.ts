/**
 * SEO for a limited person (stage B2-4, PAR-15211): he works only on the sprints of his own companies (the CRM
 * companies he owns or is on "Managed by" for, read from the CRM copy). The guard hands a `linked` decision only
 * under `enforce`, and only for a key marked `scoped` in the access table; every such key has a rule here
 * (`tests/own-scope.pg.spec.ts` holds the lists equal). A key or handler with no rule is refused (fail closed).
 *
 * One check runs before a handler: every record id the call sends (a sprint, or a child such as a task, preview,
 * keyword, backlink, content item, finding, optimization, playbook change or experiment) is looked up to its client
 * (the sprint's, or the playbook's / growth program's own link), and every one must be his; a client the call names
 * must be his too. A guessed id and another company's record get the same answer (`NOT_AMONG_YOUR_COMPANIES`).
 *
 * The rules per key are in `own-rules.ts`. `load` opens his first company by name when none is named and leaves out
 * the company's settings, hire and setup; `limitedTo` lists his companies for a picker. `sprint` leaves out the
 * company's project list. `call` checks the handler a `seo.call*` action carries, on its params.
 */
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, formatClientParam, isOwnClient, parseScopeKey, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "./namespace.js";
import { PAGE_ONLY_HANDLERS } from "./access-table.js";
import { HANDLER_RULES, PAGE_RULES, type HandlerRule, type OwnRule } from "./own-rules.js";
import type { Env, Params } from "./service/common.js";
import { scopeParam } from "./service/scope.js";

/** Every guard key a limited person may reach in SEO, by rule: the page keys and the agent tools of the handlers. */
export const OWN_SCOPE_RULES: Readonly<Record<string, OwnRule>> = Object.freeze({
  ...PAGE_RULES,
  ...Object.fromEntries(Object.entries(HANDLER_RULES).filter(([name]) => !PAGE_ONLY_HANDLERS.includes(name)).map(([name, rule]) => [`tool:${name}`, rule])),
});

/**
 * Record id params and how each finds its client. A child hangs off its sprint, a playbook change off its playbook,
 * an experiment off its growth program. `prefix`: cancel-previews also takes the first characters of an id.
 */
const SPRINT_CHILD = (table: string) => `SELECT x.id, s.client_kind, s.client_ref FROM ${NAMESPACE}.${table} x JOIN ${NAMESPACE}.sprints s ON s.id = x.sprint_id AND s.company_id = x.company_id WHERE x.company_id = $1`;
const LOOKUPS: ReadonlyArray<{ params: readonly string[]; sql: string; prefix?: boolean }> = [
  { params: ["sprintId", "sprintIds"], sql: `SELECT id, client_kind, client_ref FROM ${NAMESPACE}.sprints x WHERE company_id = $1` },
  { params: ["taskId", "taskIds"], sql: SPRINT_CHILD("sprint_tasks") },
  { params: ["previewId", "previewIds"], sql: SPRINT_CHILD("previews"), prefix: true },
  { params: ["keywordId", "targetKeywordId"], sql: SPRINT_CHILD("keywords") },
  { params: ["backlinkId"], sql: SPRINT_CHILD("backlinks") },
  { params: ["contentId", "linksToPillarIds"], sql: SPRINT_CHILD("content") },
  { params: ["findingId"], sql: SPRINT_CHILD("audits") },
  { params: ["optimizationId"], sql: SPRINT_CHILD("optimizations") },
  { params: ["changeId"], sql: `SELECT x.id, p.client_kind, p.client_ref FROM ${NAMESPACE}.playbook_changes x JOIN ${NAMESPACE}.playbooks p ON p.id = x.playbook_id AND p.company_id = x.company_id WHERE x.company_id = $1` },
  { params: ["experimentId"], sql: `SELECT x.id, g.client_kind, g.client_ref FROM ${NAMESPACE}.growth_experiments x JOIN ${NAMESPACE}.growth_programs g ON g.id = x.program_id AND g.company_id = x.company_id WHERE x.company_id = $1` },
];

export type OwnScopeAnswer = { refused: string } | { params: Params; after?: (result: unknown) => unknown };
type ClientRow = { id: string; client_kind: string | null; client_ref: string | null };

const named = (v: unknown) => v !== undefined && v !== null && v !== "";
const rowClient = (r: ClientRow): ClientScope => (r.client_ref ? { kind: r.client_kind === "contact" ? "contact" : "company", id: r.client_ref } : null);

/** The ids a param sends: null when it is sent in a form no handler reads as an id (refused, never skipped). */
function idsOf(value: unknown): string[] | null {
  const list = Array.isArray(value) ? value : [value];
  const ids = list.map((v) => (typeof v === "string" ? v.trim() : ""));
  return ids.length > 0 && ids.every(Boolean) ? ids : null;
}

/** Whether every record the params name is his; `count` is how many were named. */
async function recordsAreHis(env: Env, companyId: string, own: ReadonlySet<string>, params: Params): Promise<{ ok: boolean; count: number }> {
  let count = 0;
  for (const lookup of LOOKUPS) {
    for (const param of lookup.params) {
      if (!named(params[param])) continue;
      const ids = idsOf(params[param]);
      if (!ids) return { ok: false, count };
      count += ids.length;
      const rows = await env.ctx.db.query<ClientRow>(
        lookup.prefix ? `${lookup.sql} AND (x.id = ANY($2::text[]) OR x.id LIKE ANY($3::text[]))` : `${lookup.sql} AND x.id = ANY($2::text[])`,
        lookup.prefix ? [companyId, ids, ids.map((id) => `${id.replace(/[\\%_]/g, "\\$&")}%`)] : [companyId, ids],
      );
      const found = new Set(rows.map((r) => r.id));
      // Every id sent must be found (a prefix by one of its rows), and every row found must be his.
      if (!ids.every((id) => found.has(id) || (lookup.prefix && rows.some((r) => r.id.startsWith(id))))) return { ok: false, count };
      for (const row of rows) if (!(await isOwnClient(env.ctx, NAMESPACE, companyId, own, rowClient(row)))) return { ok: false, count };
    }
  }
  return { ok: true, count };
}

/**
 * The clients a call names: `client` / `clientRef` (SEO) and `scope` (kit Growth tools, `client:<kind>:<id>`).
 * Null in a list is own work; undefined when a form is malformed.
 */
function namedClients(params: Params): ClientScope[] | undefined {
  const out: ClientScope[] = [];
  try {
    const client = scopeParam(params);
    if (client !== undefined) out.push(client);
    if (named(params.scope)) {
      const key = parseScopeKey(String(params.scope));
      out.push(key.type === "client" ? { kind: key.kind, id: key.ref } : null);
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Checks one handler's params: the client it names and every record it names are his, and it names enough. */
async function limitHandler(env: Env, companyId: string, own: ReadonlySet<string>, rule: HandlerRule, params: Params): Promise<OwnScopeAnswer> {
  const clients = namedClients(params);
  if (!clients) return { refused: NOT_AMONG_YOUR_COMPANIES };
  if (clients.includes(null) || params.client === "all") return { refused: NAME_YOUR_COMPANY };
  for (const c of clients) if (!(await isOwnClient(env.ctx, NAMESPACE, companyId, own, c))) return { refused: NOT_AMONG_YOUR_COMPANIES };
  const client = clients.length > 0;
  const records = await recordsAreHis(env, companyId, own, params);
  if (!records.ok) return { refused: NOT_AMONG_YOUR_COMPANIES };
  const enough = rule === "record" ? records.count > 0 : rule === "client" ? client : records.count > 0 || client;
  return enough ? { params } : { refused: NAME_YOUR_COMPANY };
}

/** His companies in the CRM copy, by name. */
async function ownCompanies(env: Env, companyId: string, own: ReadonlySet<string>): Promise<Array<{ client: string; name: string }>> {
  if (own.size === 0) return [];
  const rows = await env.ctx.db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${NAMESPACE}.crm_companies WHERE company_id = $1 AND deleted = false AND id = ANY($2::text[]) ORDER BY lower(name), id`,
    [companyId, [...own]],
  );
  return rows.map((r) => ({ client: `company:${r.id}`, name: r.name }));
}

/** The page load of one of his clients, without the company's settings and other clients. */
function limitLoad(result: unknown, client: string, clients: Array<{ client: string; name: string }>): unknown {
  const o = result as Record<string, unknown> & { settings?: Record<string, unknown> };
  const settings = o.settings ? { ...o.settings, publicBaseUrl: null, redirectUri: null, serviceAccountEmail: null, serviceAccountError: null } : o.settings;
  return { ...o, settings, hire: null, setup: [], routines: [], limitedTo: { client, clients } };
}

/**
 * Checks one call of a limited person against his companies. `key` is the guard's key (`seo.<action>`,
 * `tool:<name>` or `api:<routeKey>`). Returns the params to run with, or the refusal.
 */
export async function limitToOwnClients(env: Env, companyId: string, own: ReadonlySet<string>, key: string, params: Params): Promise<OwnScopeAnswer> {
  const rule = Object.hasOwn(OWN_SCOPE_RULES, key) ? OWN_SCOPE_RULES[key] : undefined;
  switch (rule) {
    case "record":
    case "client":
    case "either":
      return limitHandler(env, companyId, own, rule, params);
    case "sprint": {
      const answer = await limitHandler(env, companyId, own, "record", params);
      return "refused" in answer ? answer : { params, after: (r) => (r && typeof r === "object" && "projects" in r ? { ...r, projects: [] } : r) };
    }
    case "call": {
      const tool = typeof params.tool === "string" ? params.tool : "";
      const handlerRule = Object.hasOwn(HANDLER_RULES, tool) ? HANDLER_RULES[tool] : undefined;
      if (!handlerRule) return { refused: NOT_AMONG_YOUR_COMPANIES };
      const inner = params.params && typeof params.params === "object" && !Array.isArray(params.params) ? (params.params as Params) : {};
      const answer = await limitHandler(env, companyId, own, handlerRule, inner);
      return "refused" in answer ? answer : { params: { ...params, params: answer.params } };
    }
    case "load": {
      const clients = await ownCompanies(env, companyId, own);
      const asked = namedClients(params);
      if (asked && asked.length > 0) {
        const answer = await limitHandler(env, companyId, own, "client", params);
        if ("refused" in answer) return answer;
        const client = formatClientParam(asked[0]!);
        return { params, after: (r) => limitLoad(r, client, clients) };
      }
      const first = clients[0]?.client;
      if (!asked || !first) return { refused: NOT_AMONG_YOUR_COMPANIES };
      return { params: { ...params, client: first }, after: (r) => limitLoad(r, first, clients) };
    }
    default:
      return { refused: NOT_AMONG_YOUR_COMPANIES };
  }
}
