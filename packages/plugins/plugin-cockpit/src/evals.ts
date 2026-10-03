/**
 * Golden-scenario evals for the Cockpit's own skills, worker part (Q5-3, Q2-11,
 * Q10-5). The scenarios, the grader and the gate rule are in `eval-model.ts`; this
 * stores graded runs per skill text and answers the deploy's question: may this
 * skill version ship?
 *
 * Why the plugin does not start the runs itself. The host's skill-test harness is a
 * REST API (`POST /api/companies/:id/skills/:skillId/test-runs`, needs the
 * `skills.test` policy action and `tasks:assign`); a plugin worker has no door to
 * it. So `plan` hands an agent (the Operator, who has both) the exact requests, and
 * `record` grades what the harness produced, reading the harness issue and its
 * `output` document ITSELF: the agent that made the calls does not get to say what
 * came back.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SKILLS } from "./skills.js";
import {
  evalMarker,
  evalPrompt,
  gateSkill,
  gradeAnswer,
  offlineGate,
  resultsEntry,
  scenarioHash,
  skillContentHash,
  skillState,
  EvalError,
  type Baseline,
  type GateVerdict,
  type ResultRow,
  type Scenario,
  type SkillState,
} from "./eval-model.js";
import { RESULTS_FILE, scenariosFor, scenarioSkills } from "./eval-scenarios.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.eval_results`;
type Raw = Record<string, unknown>;

export interface SkillInfo {
  slug: string;
  skillKey: string;
  markdown: string;
  files: Array<{ path: string; content: string }>;
  hash: string;
}

/** The Cockpit's own skills as the plugin ships them: the text agents read and its content hash. */
export function ownSkills(): SkillInfo[] {
  return SKILLS.map((s) => {
    const markdown = s.markdown ?? "";
    const files = (s.files ?? []).map((f) => ({ path: f.path, content: f.content }));
    return { slug: s.slug!, skillKey: s.skillKey, markdown, files, hash: skillContentHash({ markdown, files }) };
  });
}

export function skillBySlug(slug: string): SkillInfo {
  const found = ownSkills().find((s) => s.slug === slug);
  if (!found) throw new EvalError(`${slug} is not one of the Cockpit's skills (${ownSkills().map((s) => s.slug).join(", ")}).`);
  return found;
}

// ---------------------------------------------------------------------------
// Is the company's copy what the plugin ships?
// ---------------------------------------------------------------------------

/** The company's copy of a managed skill, as `ctx.skills.managed.get` resolves it (only the parts read here). */
export interface ManagedCopy {
  skill?: { markdown?: string | null } | null;
  /** The host's own verdict: the files whose stored content differs from what the plugin declares. null: nothing differs. */
  defaultDrift?: { changedFiles?: string[] | null } | null;
}

export interface SkillDrift {
  drifted: boolean;
  /** Paths inside the skill that differ (`SKILL.md`, `references/x.md`). */
  changedFiles: string[];
  /** Where the answer came from: the host's verdict, a text comparison (a host that reports none), or nowhere (no copy to look at). */
  source: "host" | "text" | "unknown";
}

/**
 * The host stores a managed skill with a `key: "plugin/<plugin>/<skill>"` line added
 * to its frontmatter (plugin-managed-skills.ts, withManagedSkillKey), so the stored
 * SKILL.md is never byte-for-byte the text the plugin ships. A plain string
 * comparison therefore called every installed, unedited skill "drifted" and made
 * `record` and `baseline` refuse on the live host. This takes that line out.
 */
export function withoutManagedKey(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!frontmatter) return normalized;
  const body = (frontmatter[1] ?? "").split("\n").filter((line) => !/^key\s*:/.test(line)).join("\n");
  return `---\n${body}\n---${normalized.slice(frontmatter[0].length)}`;
}

/**
 * Whether agents read exactly the text the plugin ships, which is the only text a
 * recorded result may be filed under. The host's `defaultDrift` is the signal (the
 * kit's skill sync uses the same one): it covers SKILL.md and the reference files,
 * and is computed against what the host itself would store. Only a host that does
 * not report it at all falls back to comparing SKILL.md with the managed key line
 * taken out of both sides.
 */
export function skillDrift(resolved: ManagedCopy | null | undefined, shippedMarkdown: string): SkillDrift {
  if (!resolved) return { drifted: false, changedFiles: [], source: "unknown" };
  if (resolved.defaultDrift !== undefined) {
    const changedFiles = [...(resolved.defaultDrift?.changedFiles ?? [])];
    return { drifted: changedFiles.length > 0, changedFiles, source: "host" };
  }
  const stored = resolved.skill?.markdown;
  if (typeof stored !== "string") return { drifted: false, changedFiles: [], source: "unknown" };
  const same = withoutManagedKey(stored) === withoutManagedKey(shippedMarkdown);
  return { drifted: !same, changedFiles: same ? [] : ["SKILL.md"], source: "text" };
}

const driftFiles = (drift: SkillDrift): string => (drift.changedFiles.length ? ` (${drift.changedFiles.slice(0, 5).join(", ")}${drift.changedFiles.length > 5 ? ", and more" : ""})` : "");

/** The company's copy of this plugin skill and whether it is what the plugin ships. A failed lookup is "no copy", never a pass. */
async function companyCopy(env: Env, companyId: string, info: SkillInfo): Promise<{ resolved: (ManagedCopy & { skillId?: string | null }) | null; drift: SkillDrift }> {
  const resolved = (await env.ctx.skills.managed.get(info.skillKey, companyId).catch(() => null)) as (ManagedCopy & { skillId?: string | null }) | null;
  return { resolved, drift: skillDrift(resolved, info.markdown) };
}

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};

export interface StoredResult extends ResultRow {
  id: string;
  harnessIssueId: string;
  harnessRunId: string | null;
  agentId: string | null;
  checks: Array<{ ok: boolean; detail: string }>;
  baseline: boolean;
  planExcerpt: string | null;
}

function rowFrom(r: Raw): StoredResult {
  const checks = typeof r.checks === "string" ? (JSON.parse(r.checks) as StoredResult["checks"]) : ((r.checks as StoredResult["checks"]) ?? []);
  return {
    id: String(r.id),
    skillSlug: String(r.skill_slug),
    skillHash: String(r.skill_hash),
    scenarioId: String(r.scenario_id),
    scenarioHash: String(r.scenario_hash),
    mode: String(r.mode),
    harnessIssueId: String(r.harness_issue_id),
    harnessRunId: r.harness_run_id == null ? null : String(r.harness_run_id),
    agentId: r.agent_id == null ? null : String(r.agent_id),
    passed: r.passed === true || r.passed === "true" || r.passed === "t",
    checks,
    baseline: r.baseline === true || r.baseline === "true" || r.baseline === "t",
    planExcerpt: r.plan_excerpt == null ? null : String(r.plan_excerpt),
    gradedAt: iso(r.graded_at),
  };
}

export async function listResults(ctx: PluginContext, companyId: string, skillSlug: string, limit = 600): Promise<StoredResult[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT id, skill_slug, skill_hash, scenario_id, scenario_hash, mode, harness_issue_id, harness_run_id, agent_id, passed, checks, plan_excerpt, baseline, graded_at FROM ${T} WHERE company_id = $1 AND skill_slug = $2 ORDER BY graded_at DESC LIMIT $3`,
    [companyId, skillSlug, limit],
  );
  return rows.map(rowFrom);
}

/** The baseline for a skill: the text whose results were marked as the one to beat, with how each scenario did. */
export function baselineOf(rows: StoredResult[], scenarios: Scenario[]): Baseline | null {
  const marked = rows.filter((r) => r.baseline);
  const hash = marked[0]?.skillHash;
  if (!hash) return null;
  const state = skillState(scenarios, hash, marked.filter((r) => r.skillHash === hash));
  return { hash, passRate: state.passRate, scenarios: Object.fromEntries(Object.entries(state.scenarios).map(([id, v]) => [id, v.passed])), measuredAt: marked[0]?.gradedAt ?? null };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export interface HarnessRequest {
  scenarioId: string;
  method: "POST";
  path: string;
  body: { agentId: string; content: string };
}

/** The name a candidate's test copy goes by: never the real skill's, and tied to the text's hash. */
export const candidateSlugFor = (slug: string, hash: string): string => `${slug}-candidate-${hash.slice(0, 6)}`;

/** The candidate's install text: the same skill, with its name and slug changed so it never collides with the real one. */
export function candidateInstallText(markdown: string, slug: string, hash: string): { slug: string; text: string } {
  const candidateSlug = candidateSlugFor(slug, hash);
  const text = markdown.replace(/^name: .*$/m, `name: ${candidateSlug}`).replace(/^slug: .*$/m, `slug: ${candidateSlug}`);
  return { slug: candidateSlug, text };
}

export interface PlanInput {
  skill: string;
  scenarioIds?: string[];
  mode: "live" | "candidate";
  agentId: string;
  candidateMarkdown?: string;
  candidateFiles?: Array<{ path: string; content: string }>;
}

export async function planEval(env: Env, companyId: string, input: PlanInput): Promise<Record<string, unknown>> {
  const info = skillBySlug(input.skill);
  const all = scenariosFor(info.slug);
  const picked = input.scenarioIds?.length ? all.filter((s) => input.scenarioIds!.includes(s.id)) : all;
  if (picked.length === 0) throw new EvalError(input.scenarioIds?.length ? `None of ${input.scenarioIds.join(", ")} is a scenario of ${info.slug} (${all.map((s) => s.id).join(", ")}).` : `${info.slug} has no scenarios.`);
  const agent = await env.ctx.agents.get(input.agentId, companyId).catch(() => null);
  if (!agent) throw new EvalError("That agent was not found in this company: pass agentId, an active agent (not paused) that has the skill attached.");
  const notes: string[] = [];
  if (String(agent.status) === "paused") notes.push(`${agent.name} is paused: the host refuses test runs for a paused agent. Pick another agent or resume it.`);
  const requests = (skillId: string): HarnessRequest[] =>
    picked.map((s) => ({ scenarioId: s.id, method: "POST", path: `/api/companies/${companyId}/skills/${skillId}/test-runs`, body: { agentId: input.agentId, content: evalPrompt(info.slug, s) } }));
  const rules = [
    "Make each request with the Paperclip API (your agent key), then wait until the harness task is done: GET /api/issues/<issueId from the response>. A run takes minutes.",
    `Then call skill-eval record with mode ${input.mode} and an item {scenarioId, issueId} for each finished task. The Cockpit reads the output itself.`,
    "The scenarios are made up and the answers are on paper: nothing real is touched. Never put a real client in a request.",
    "Starting another run for the same skill marks the earlier ones Superseded in Skills Studio. That is harmless: the Cockpit reads the harness tasks themselves, not those rows.",
  ];
  if (input.mode === "live") {
    const { resolved, drift } = await companyCopy(env, companyId, info);
    if (!resolved?.skillId) throw new EvalError(`${info.slug} is not installed in this company yet: open the Cockpit once (it syncs its skills), then plan again.`);
    if (drift.drifted) notes.push(`The company's copy of this skill differs from what the plugin ships${driftFiles(drift)} (it is behind, or was edited). Sync first (cockpit.load, or the plugin's sync-skills), then plan again: results would be filed under text agents are not reading.`);
    return { skill: info.slug, mode: "live", hash: info.hash, skillId: resolved.skillId, drift: drift.drifted, changedFiles: drift.changedFiles, scenarios: picked.map((s) => ({ id: s.id, title: s.title })), requests: requests(resolved.skillId), notes, rules };
  }
  const markdown = input.candidateMarkdown?.trim();
  if (!markdown) throw new EvalError("mode candidate needs candidateMarkdown: the full SKILL.md text of the change you want checked.");
  const files = input.candidateFiles ?? info.files;
  const hash = skillContentHash({ markdown, files });
  const install = candidateInstallText(markdown, info.slug, hash);
  return {
    skill: info.slug,
    mode: "candidate",
    hash,
    shippedHash: info.hash,
    scenarios: picked.map((s) => ({ id: s.id, title: s.title })),
    install: [
      { step: "Install the candidate as a test copy (the skill policy lets only the Operator do this).", method: "POST", path: `/api/companies/${companyId}/skills`, body: { name: install.slug, slug: install.slug, markdown: install.text } },
      ...files.map((f) => ({ step: `Add its file ${f.path} (use the skill id the first call returned).`, method: "PATCH", path: `/api/companies/${companyId}/skills/<candidateSkillId>/files`, body: { path: f.path, content: f.content } })),
    ],
    requests: requests("<candidateSkillId>"),
    cleanup: { step: "When every run is recorded, remove the test copy.", method: "DELETE", path: `/api/companies/${companyId}/skills/<candidateSkillId>` },
    notes,
    rules: [...rules, `Record with candidateHash ${hash}.`],
  };
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

export interface RecordItem {
  scenarioId: string;
  issueId: string;
}

export interface Recorded {
  scenarioId: string;
  issueId: string;
  state: "graded" | "already" | "not-done" | "refused";
  passed?: boolean;
  checks?: Array<{ ok: boolean; detail: string }>;
  detail?: string;
}

const newId = (): string => `ev${randomBytes(6).toString("hex")}`;

export async function recordEval(env: Env, companyId: string, input: { skill: string; mode: "live" | "candidate"; candidateHash?: string; items: RecordItem[] }): Promise<{ recorded: Recorded[]; state: SkillState; hash: string; entry: ReturnType<typeof resultsEntry> | null }> {
  const info = skillBySlug(input.skill);
  const scenarios = scenariosFor(info.slug);
  let hash = info.hash;
  if (input.mode === "candidate") {
    if (!input.candidateHash || !/^[0-9a-f]{16}$/.test(input.candidateHash)) throw new EvalError("mode candidate needs candidateHash: the hash skill-eval plan gave for the candidate text.");
    hash = input.candidateHash;
  } else {
    const { resolved, drift } = await companyCopy(env, companyId, info);
    if (!resolved?.skillId) throw new EvalError(`${info.slug} is not installed in this company (or could not be read), so these runs cannot have used this text. Open the Cockpit once (it syncs its skills), run the scenarios again and record those.`);
    if (drift.drifted) throw new EvalError(`The company's copy of this skill differs from what the plugin ships${driftFiles(drift)}, so these runs may not have used this text. Sync first (cockpit.load), run the scenarios again and record those.`);
  }
  const recorded: Recorded[] = [];
  for (const item of input.items.slice(0, 30)) {
    const scenario = scenarios.find((s) => s.id === item.scenarioId);
    if (!scenario) {
      recorded.push({ scenarioId: item.scenarioId, issueId: item.issueId, state: "refused", detail: `${item.scenarioId} is not a scenario of ${info.slug}.` });
      continue;
    }
    recorded.push(await recordOne(env, companyId, { info, scenario, mode: input.mode, hash, issueRef: item.issueId }));
  }
  const rows = await listResults(env.ctx, companyId, info.slug);
  const state = skillState(scenarios, hash, rows);
  const full = state.missing.length === 0;
  return { recorded, state, hash, entry: full ? resultsEntry(state, env.now().toISOString(), rows.filter((r) => r.skillHash === hash).map((r) => r.harnessRunId ?? r.harnessIssueId)) : null };
}

/** The skill a harness task tested: the host titles it `Skill test: <skill name>`. */
export function ranSkillName(title: string | null | undefined): string | null {
  const found = /^\s*skill test:\s*(.+?)\s*$/i.exec(String(title ?? ""));
  return found ? found[1]! : null;
}

/** Why a harness task did not test the text it is being recorded for, or null when it did. Live: the skill itself. Candidate: the test copy named after that text's hash. */
export function ranMismatch(ran: string | null, mode: "live" | "candidate", slug: string, hash: string): string | null {
  if (!ran) return "That harness task has no skill name in its title (expected \"Skill test: <skill>\"), so it cannot be tied to the skill it ran. Plan again and run it fresh.";
  const name = ran.toLowerCase();
  if (mode === "live") return name === slug.toLowerCase() ? null : `That harness run tested "${ran}", not ${slug}: it was not run on the live skill text. Run it on ${slug} and record that.`;
  const copy = candidateSlugFor(slug, hash);
  return name.includes(copy.toLowerCase()) ? null : `That harness run tested "${ran}", not the candidate's test copy ${copy}: it was not run on this text. Install the candidate as the plan says, run the scenarios on it and record those.`;
}

async function recordOne(env: Env, companyId: string, input: { info: SkillInfo; scenario: Scenario; mode: "live" | "candidate"; hash: string; issueRef: string }): Promise<Recorded> {
  const { scenario, info } = input;
  const base = { scenarioId: scenario.id, issueId: input.issueRef };
  const issue = await env.ctx.issues.get(input.issueRef, companyId).catch(() => null);
  if (!issue) return { ...base, state: "refused", detail: "That issue was not found in this company." };
  const record = issue as unknown as { id: string; title?: string | null; originKind?: string | null; originId?: string | null; description?: string | null; status: string; assigneeAgentId?: string | null };
  // Only a real harness run for THIS scenario text counts: the issue is a skill test, and its description is our prompt.
  if (record.originKind !== "skill_test") return { ...base, state: "refused", detail: "That issue is not a skill-test harness run (its origin is not skill_test)." };
  // And it ran THIS skill. The host titles the task "Skill test: <skill name>", so a run of the live skill and a run of a candidate's test copy (or of another skill) are told apart by the name.
  const ran = ranSkillName(record.title);
  const wrongSkill = ranMismatch(ran, input.mode, info.slug, input.hash);
  if (wrongSkill) return { ...base, state: "refused", detail: wrongSkill };
  if (!String(record.description ?? "").includes(evalMarker(info.slug, scenario))) return { ...base, state: "refused", detail: "That harness run was not made from this scenario's current text (its marker does not match): plan again and run it fresh." };
  const existing = await env.ctx.db.query<Raw>(`SELECT id FROM ${T} WHERE company_id = $1 AND harness_issue_id = $2`, [companyId, record.id]);
  if (existing.length) return { ...base, state: "already", detail: "That run was graded already." };
  if (record.status !== "done") return { ...base, state: "not-done", detail: `The harness task is ${record.status}: wait until it is done, then record it.` };
  let output = "";
  try {
    output = (await env.ctx.issues.documents.get(record.id, "output", companyId))?.body ?? "";
  } catch (error) {
    return { ...base, state: "refused", detail: `The output document could not be read: ${message(error)}` };
  }
  if (!output.trim()) return { ...base, state: "refused", detail: "The harness task has no `output` document: the agent did not write its answer there." };
  const graded = gradeAnswer(scenario, output);
  const first = output.indexOf("{");
  const excerpt = (first >= 0 ? output.slice(first) : output).replace(/\s+/g, " ").slice(0, 600);
  await env.ctx.db.execute(
    `INSERT INTO ${T} (id, company_id, skill_slug, skill_hash, scenario_id, scenario_hash, mode, harness_issue_id, harness_run_id, agent_id, passed, checks, plan_excerpt, graded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14) ON CONFLICT (company_id, harness_issue_id) DO NOTHING`,
    [newId(), companyId, info.slug, input.hash, scenario.id, scenarioHash(scenario), input.mode, record.id, record.originId ?? null, record.assigneeAgentId ?? null, graded.passed, JSON.stringify(graded.checks), excerpt, env.now().toISOString()],
  );
  return { ...base, state: "graded", passed: graded.passed, checks: graded.checks };
}

// ---------------------------------------------------------------------------
// report, baseline, gate
// ---------------------------------------------------------------------------

export interface SkillReport {
  skill: string;
  hash: string;
  scenarios: number;
  current: SkillState;
  baseline: { hash: string; passRate: number | null } | null;
  /** Every other text that has results, newest first. */
  history: Array<{ hash: string; passRate: number | null; measured: number; total: number; lastGradedAt: string; modes: string[] }>;
  failing: Array<{ scenarioId: string; checks: string[] }>;
  gate: GateVerdict;
  committed: ReturnType<typeof offlineGate>[number];
}

export async function reportEval(env: Env, companyId: string, skills?: string): Promise<SkillReport[]> {
  const out: SkillReport[] = [];
  for (const info of ownSkills().filter((s) => (skills ? s.slug === skills : scenariosFor(s.slug).length > 0))) {
    const scenarios = scenariosFor(info.slug);
    const rows = await listResults(env.ctx, companyId, info.slug);
    const baseline = baselineOf(rows, scenarios);
    const current = skillState(scenarios, info.hash, rows);
    const hashes = [...new Set(rows.map((r) => r.skillHash))];
    const failing = scenarios
      .filter((s) => current.scenarios[s.id]?.measured && !current.scenarios[s.id]!.passed)
      .map((s) => ({ scenarioId: s.id, checks: (rows.find((r) => r.skillHash === info.hash && r.scenarioId === s.id)?.checks ?? []).filter((c) => !c.ok).map((c) => c.detail) }));
    out.push({
      skill: info.slug,
      hash: info.hash,
      scenarios: scenarios.length,
      current,
      baseline: baseline ? { hash: baseline.hash, passRate: baseline.passRate } : null,
      history: hashes.map((h) => {
        const state = skillState(scenarios, h, rows);
        const mine = rows.filter((r) => r.skillHash === h);
        return { hash: h, passRate: state.passRate, measured: state.measured, total: state.total, lastGradedAt: mine[0]?.gradedAt ?? "", modes: [...new Set(mine.map((r) => r.mode ?? "live"))] };
      }),
      failing,
      gate: gateSkill({ skill: info.slug, hash: info.hash, scenarios, rows, baseline, minPassRate: RESULTS_FILE.minPassRate }),
      committed: offlineGate([{ slug: info.slug, hash: info.hash, scenarios }], RESULTS_FILE)[0]!,
    });
  }
  return out;
}

/**
 * Makes this text's live results the baseline and clears the old one, in ONE statement that
 * changes nothing when this text has no live results (the old baseline must never be dropped for
 * nothing). Returns how many rows were touched; 0 means nothing changed.
 */
export async function markBaseline(ctx: PluginContext, companyId: string, skillSlug: string, hash: string): Promise<number> {
  const done = await ctx.db.execute(
    `UPDATE ${T} SET baseline = (skill_hash = $3 AND mode = 'live') WHERE company_id = $1 AND skill_slug = $2 AND (baseline = true OR (skill_hash = $3 AND mode = 'live')) AND EXISTS (SELECT 1 FROM ${T} AS target WHERE target.company_id = $1 AND target.skill_slug = $2 AND target.skill_hash = $3 AND target.mode = 'live')`,
    [companyId, skillSlug, hash],
  );
  return done.rowCount ?? 0;
}

export async function baselineEval(env: Env, companyId: string, skill: string): Promise<{ hash: string; entry: ReturnType<typeof resultsEntry>; commit: string[]; warnings: string[] }> {
  const info = skillBySlug(skill);
  const scenarios = scenariosFor(info.slug);
  if (scenarios.length === 0) throw new EvalError(`${info.slug} has no scenarios to baseline.`);
  const rows = await listResults(env.ctx, companyId, info.slug);
  // Only runs of the live skill can be its baseline: a candidate's results for the same text were run on a test copy.
  const live = rows.filter((r) => r.mode === "live");
  const state = skillState(scenarios, info.hash, live);
  if (state.missing.length) throw new EvalError(`Run every scenario on the live skill first (${state.missing.length} are missing: ${state.missing.join(", ")}): skill-eval plan, make the runs, record them.`);
  const { resolved, drift } = await companyCopy(env, companyId, info);
  if (!resolved?.skillId) throw new EvalError(`${info.slug} is not installed in this company (or could not be read): a baseline would describe text nobody reads. Open the Cockpit once (it syncs its skills), run the scenarios again, then baseline.`);
  if (drift.drifted) throw new EvalError(`The company's copy of this skill differs from what the plugin ships${driftFiles(drift)}: a baseline would describe text agents are not reading. Sync first, run the scenarios again, then baseline.`);
  if ((await markBaseline(env.ctx, companyId, info.slug, info.hash)) === 0) throw new EvalError("No live results were found to mark as the baseline, so the existing baseline was left as it is. Run every scenario on the live skill and record it, then baseline.");
  const entry = resultsEntry(state, env.now().toISOString(), live.filter((r) => r.skillHash === info.hash).map((r) => r.harnessRunId ?? r.harnessIssueId));
  const warnings: string[] = [];
  if ((state.passRate ?? 0) < RESULTS_FILE.minPassRate) warnings.push(`Only ${state.passed} of ${state.total} scenarios pass on the live skill. The baseline records that truth, but the skill needs fixing: the minimum is ${Math.round(RESULTS_FILE.minPassRate * 100)}%.`);
  return {
    hash: info.hash,
    entry,
    warnings,
    commit: [
      `In packages/plugins/plugin-cockpit/evals/results.json put this under skills.${info.slug}.baseline:`,
      JSON.stringify(entry),
      "Set \"enforce\": true once every skill you want gated has a baseline there: from then on a skill whose text changed needs recorded results (or a waiver) or the tests fail.",
    ],
  };
}

export interface GateReport {
  ship: boolean;
  verdicts: Array<GateVerdict & { committed: ReturnType<typeof offlineGate>[number] }>;
  rule: string;
}

export const GATE_RULE = "No skill version ships if a golden scenario that passed at the baseline now fails, if fewer than 80% of its scenarios pass, or if its scenarios were not run on this text.";

/** `hash` gates a candidate text (from plan) instead of the skill as shipped, for the check before a change is merged. */
export async function gateEval(env: Env, companyId: string, skill?: string, hash?: string): Promise<GateReport> {
  const verdicts: GateReport["verdicts"] = [];
  for (const info of ownSkills().filter((s) => (skill ? s.slug === skill : scenariosFor(s.slug).length > 0))) {
    const scenarios = scenariosFor(info.slug);
    const rows = await listResults(env.ctx, companyId, info.slug);
    const gated = skill && hash ? hash : info.hash;
    const verdict = gateSkill({ skill: info.slug, hash: gated, scenarios, rows, baseline: baselineOf(rows, scenarios), minPassRate: RESULTS_FILE.minPassRate });
    verdicts.push({ ...verdict, committed: offlineGate([{ slug: info.slug, hash: gated, scenarios }], RESULTS_FILE)[0]! });
  }
  return { ship: verdicts.every((v) => v.ship), verdicts, rule: GATE_RULE };
}

/** The skills that have scenarios (the tool lists them). */
export function skillsWithScenarios(): string[] {
  return scenarioSkills();
}
