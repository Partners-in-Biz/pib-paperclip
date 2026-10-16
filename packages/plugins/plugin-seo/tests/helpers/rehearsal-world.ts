/**
 * A fake plugin host for the rehearsal tests (tests/rehearsal.spec.ts): the sprint table with its updates applied, the task and
 * page-group tables in memory, a CRM projection that knows the canary and one real client, an issues API that reports each issue's
 * status from a table and records what the plugin creates, updates and wakes. The same fixtures run a real client's sprint (the
 * control), so a test that finds nothing opened for a rehearsal sprint is also shown to find something for a real one.
 */
import { vi } from "vitest";
import { SPRINT_OFF, seoHost, taskRow, integrationRow, type Route, type Row } from "./seo-host.js";
import { memTables } from "./mem-db.js";
import { site } from "./geo-site.js";

/** The CRM's canary company id has this shape (plugin-crm/src/canary-flag.ts): `canary-` and 8 hex. Built here, not typed as a fixture. */
export const CANARY_ID = ["canary", "daf7b7d3"].join("-");
/** A real client's CRM id is a UUID. */
export const REAL_ID = "6f1c2b9e-3a4d-4c1e-9b7a-2d5e8f0a1c33";

export const CRM_COMPANIES: Row[] = [
  { id: CANARY_ID, name: "PiB Canary Co", domain: "canary.invalid", lifecycle: "customer" },
  { id: REAL_ID, name: "Agri Studies", domain: "agristudies.co.za", lifecycle: "customer" },
];

/** A running sprint on day 32 with its plan seeded and no issue opened yet: the canary's (rehearsal) or a real client's. */
export function sprintFor(kind: "rehearsal" | "real", extra: Row = {}): Row {
  const rehearsal = kind === "rehearsal";
  return {
    ...SPRINT_OFF,
    id: rehearsal ? "sp-rehearsal" : "sp-real",
    name: rehearsal ? "PiB Canary Co" : "Agri Studies",
    site_url: rehearsal ? "https://canary.invalid" : "https://agristudies.co.za",
    site_name: rehearsal ? "PiB Canary Co" : "Agri Studies",
    client_kind: "company",
    client_ref: rehearsal ? CANARY_ID : REAL_ID,
    client_name: rehearsal ? "PiB Canary Co" : "Agri Studies",
    template_version: 5,
    root_issue_id: null,
    root_issue_identifier: null,
    project_id: null,
    client_project_id: null,
    // The canary has no repo; a real client's sprint has its site repo linked, so its code tasks open as issues too.
    ...(rehearsal ? { site_project_id: null, site_access: "unlinked", repo_url: null } : { site_project_id: "proj-site", site_access: "repo", repo_url: "https://github.com/pib/agristudies", default_branch: "main" }),
    change_policy: "merge_seo_scope",
    ...extra,
  };
}

/** The tasks a sprint starts with: some for the agent, one for a person and one site-code task that waits for the repo link. */
export function planTasks(sprintId: string): Row[] {
  return [
    taskRow({ id: `${sprintId}-meta`, sprint_id: sprintId, template_key: "w0-meta-tags", title: "Set up the title and description on every page", task_type: "meta-tag-audit", due_day: null }),
    taskRow({ id: `${sprintId}-gbp`, sprint_id: sprintId, template_key: "w0-gbp", title: "Claim the Google Business Profile", task_type: "gbp-claim", owner: "human", autopilot_eligible: false, due_day: null }),
    taskRow({ id: `${sprintId}-code`, sprint_id: sprintId, template_key: "w0-schema", title: "Add structured data to the home page", task_type: "schema-add", due_day: null }),
    taskRow({ id: `${sprintId}-later`, sprint_id: sprintId, template_key: "w12-cluster-pick", title: "Pick the next content cluster", task_type: "page-write", week: 12, due_day: 80 }),
  ];
}

export interface WorldInput {
  sprints?: Row[];
  tasks?: Row[];
  chunks?: Row[];
  /** Issue id -> status the issues API reports (anything else is `todo`). */
  issues?: Record<string, string>;
  /** Rows of the sprint's Needs you digests as they are before the test (the plugin's own writes are applied on top). */
  needsYouRecent?: Row[];
  /** The sprint's optimizations, as the table holds them. */
  optimizations?: Row[];
  /** `review_issue_id` of the sprint's previews. */
  previewReviews?: string[];
  routes?: Route[];
  /** A person-or-agent mix: the SEO agent linked to the company. */
  agent?: { id: string; status: string } | null;
}

export function world(input: WorldInput = {}) {
  const sprints = (input.sprints ?? []).map((r) => ({ ...r }));
  const store = memTables({ sprint_tasks: input.tasks ?? [], task_chunks: input.chunks ?? [] }, (sprintId) => sprints.find((s) => s.id === sprintId)?.pacing as string | undefined);
  const web = site();
  const issueStatus = new Map<string, string>(Object.entries(input.issues ?? {}));
  // The Needs you digests, applied as the plugin writes them, so one weekly digest and one issue come out of many lines.
  const needsYou: Row[] = (input.needsYouRecent ?? []).map((r) => ({ ...r }));
  const byWeek = (p: unknown[]) => needsYou.filter((r) => r.sprint_id === p[1] && String(r.week_start).slice(0, 10) === String(p[2]).slice(0, 10)).slice(0, 1);
  const routes: Route[] = [
    ...(input.routes ?? []),
    ...store.routes,
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 ORDER BY week_start DESC LIMIT \$3/, (p) => needsYou.filter((r) => r.sprint_id === p[1]).sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)))],
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start < /, () => []],
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start = /, byWeek],
    [/FROM plugin_seo_8099f8879a\.needs_you n JOIN/, () => []],
    [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND issue_id = \$2/, (p) => needsYou.filter((r) => r.issue_id === p[1]).slice(0, 1)],
    [/FROM plugin_seo_8099f8879a\.crm_companies WHERE company_id = \$1 AND id = \$2/, (p) => CRM_COMPANIES.filter((c) => c.id === p[1])],
    [/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 AND provider = \$3/, (p) => (p[2] === "ga4" ? [] : [integrationRow(String(p[2]), { sprint_id: p[1] })])],
    [/FROM plugin_seo_8099f8879a\.optimizations WHERE company_id = \$1 AND sprint_id = \$2/, () => input.optimizations ?? []],
    [/FROM plugin_seo_8099f8879a\.previews WHERE company_id = \$1 AND sprint_id = \$2 AND review_issue_id IS NOT NULL/, () => (input.previewReviews ?? []).map((review_issue_id) => ({ review_issue_id }))],
    [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1 AND company_id = \$2/, (p) => sprints.filter((s) => s.id === p[0] && s.company_id === p[1])],
    [/FROM plugin_seo_8099f8879a\.company_switches/, () => []],
  ];
  const host = seoHost({
    routes,
    site: web.fetcher,
    agent: input.agent,
    google: (url) => {
      if (url.includes("searchconsole") || url.includes("webmasters")) return new Response(JSON.stringify({ siteEntry: [] }), { status: 200 });
      return undefined;
    },
  });
  store.attach(host);
  // The managed project the plugin reconciles (a rehearsal sprint must not ask for it), and no client projects.
  const reconcile = vi.fn(async () => ({ projectId: "proj-seo" }));
  const projectsList = vi.fn(async () => []);
  (host.ctx as unknown as { projects: unknown }).projects = { list: projectsList, managed: { reconcile } };
  host.ctx.issues.get = (async (id: string) => ({ id, status: issueStatus.get(id) ?? "todo", identifier: `PIB-${id.replace(/\D/g, "") || "0"}` })) as never;
  // Updates of the sprint row take effect, and a sprint the plugin creates can be read back.
  const execute = host.ctx.db.execute.bind(host.ctx.db);
  host.ctx.db.execute = async (sql: string, params: unknown[] = []) => {
    if (/^INSERT INTO plugin_seo_8099f8879a\.sprints /.test(sql)) {
      const [id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes, geo_enabled, ga4_enabled, chunks_enabled] = params;
      sprints.push({ ...SPRINT_OFF, id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes, geo_enabled, ga4_enabled, chunks_enabled, seeded_at: null, root_issue_id: null, root_issue_identifier: null, project_id: null, site_project_id: null, client_project_id: null, site_access: "unlinked", repo_url: null });
    }
    if (/^INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(sql)) {
      const [id, company_id, sprint_id, week_start, items, status] = params;
      const row = needsYou.find((r) => r.sprint_id === sprint_id && String(r.week_start).slice(0, 10) === String(week_start).slice(0, 10));
      if (row) Object.assign(row, { items: JSON.parse(String(items)), status });
      else needsYou.push({ id, company_id, sprint_id, week_start, issue_id: null, issue_identifier: null, items: JSON.parse(String(items)), status });
    }
    const ny = /^UPDATE plugin_seo_8099f8879a\.needs_you SET issue_id = \$1, issue_identifier = \$2, updated_at = now\(\) WHERE id = \$3 AND company_id = \$4/.exec(sql);
    if (ny) {
      const row = needsYou.find((r) => r.id === params[2]);
      if (row) Object.assign(row, { issue_id: params[0], issue_identifier: params[1] });
    }
    const m = /^UPDATE plugin_seo_8099f8879a\.sprints SET (.+?) WHERE id = \$(\d+) AND company_id = \$(\d+)/s.exec(sql);
    if (m) {
      const row = sprints.find((s) => s.id === params[Number(m[2]) - 1] && s.company_id === params[Number(m[3]) - 1]);
      if (row) for (const a of m[1]!.matchAll(/([a-z_]+) = \$(\d+)(?!\d)/g)) row[a[1]!] = params[Number(a[2]) - 1];
    }
    return execute(sql, params);
  };
  const sprintRow = (id: string) => sprints.find((s) => s.id === id)!;
  return { ...host, sprints, sprintRow, store, issueStatus, needsYou, siteCalls: web.calls, reconcile, projectsList };
}
export type World = ReturnType<typeof world>;

/** What the plugin created, reduced to what a person or an agent would see (ids from the host are deterministic). */
export function createdIssues(w: Pick<World, "created">): Array<Record<string, unknown>> {
  return w.created.map((c) => {
    const i = c.input;
    return { title: i.title, originKind: i.originKind, assigneeAgentId: i.assigneeAgentId ?? null, assigneeUserId: i.assigneeUserId ?? null, parentId: i.parentId ?? null, projectId: i.projectId ?? null, status: i.status, priority: i.priority ?? null };
  });
}
