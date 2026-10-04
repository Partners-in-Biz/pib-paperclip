/**
 * Golden scenarios for skills, pure part (Q5-3, Q2-11, Q10-5).
 *
 * Skills change often (318 managed-skill resets and 64 plugin upgrades in 8 days)
 * and nothing checked that a changed skill still made an agent do the right
 * thing: a skill edit that made behaviour worse was found when a client was
 * affected. A golden scenario is a real recurring situation (a blocked issue with
 * no way out, a failing routine, an approval that skipped the Reviewer, a grant
 * ask) with what the skill must make an agent do. It is run against the REAL
 * rendered skill, before and after a change, and a skill version does not ship if
 * a scenario that passed now fails.
 *
 * How a scenario runs. The host's skill-test harness runs an agent on a harness
 * issue with the skill pinned. The scenario asks for a paper answer: the agent
 * writes, as JSON, the actions it WOULD take (tool calls, API calls, comments),
 * changing nothing. The grader here reads that plan and checks it against what the
 * scenario expects. No model judges a model: every check is a plain rule.
 */
import { createHash } from "node:crypto";
import { writingFindings } from "@partnersinbiz/pib-plugin-kit";

export class EvalError extends Error {}

/** A scenario passes when at least this share of its runs passed (with one run, it must pass). */
export const SCENARIO_PASS_SHARE = 0.66;
/** A skill's pass rate below this blocks shipping, even with nothing to regress from. */
export const MIN_PASS_RATE = 0.8;

export type ArgMatcher = string | number | boolean | null | { matches?: string; exists?: boolean; oneOf?: unknown[]; contains?: string; notEmpty?: boolean };

export interface ToolExpect {
  /** `partnersinbiz.cockpit:ask-owner` */
  tool: string;
  args?: Record<string, ArgMatcher>;
  /** Not counted as a failure when absent. */
  optional?: boolean;
}

export interface ApiExpect {
  method: string;
  /** A pattern for the path, `^/api/issues/[^/]+$`. */
  path: string;
  args?: Record<string, ArgMatcher>;
  optional?: boolean;
}

export interface Forbid {
  tool?: string;
  /** A pattern for an API path. */
  apiPath?: string;
  method?: string;
  /** With a tool or a path, forbidden only when the call's arguments match these too; alone, a tool or API step with these arguments. */
  args?: Record<string, ArgMatcher>;
  /** A pattern for anything said (comments, questions, the summary). */
  text?: string;
  reason: string;
}

export interface ScenarioExpect {
  toolCalls?: ToolExpect[];
  apiCalls?: ApiExpect[];
  /** The tool calls (and, separately, the API calls) must come in the order listed. */
  ordered?: boolean;
  forbid?: Forbid[];
  mustSay?: string[];
  mustNotSay?: string[];
  /** Grade the plain-writing rules (kit `writingFindings`) on what the plan says to a person: comment text, the summary, and an ask-owner's question, why and steps. */
  plainWriting?: boolean;
  /** The plan may not be longer than this (a skill that makes an agent flail is a worse skill). */
  maxSteps?: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** The real situation it comes from (an audit finding, an issue id). */
  source: string;
  /** The facts the agent is given, with made-up names and numbers. */
  situation: string;
  task: string;
  expect: ScenarioExpect;
  /** Runs per check; the skill is graded on the share that passed. */
  repeats?: number;
  /** A right answer and a wrong one (the kind the audit found), in the paper format. Tests grade them, so a scenario is known to pass and to fail. Never sent to the agent. */
  examples?: { pass: { plan: PlanStep[]; summary?: string }; fail: { plan: PlanStep[]; summary?: string } };
}

export interface ScenarioFile {
  skill: string;
  version: number;
  scenarios: Scenario[];
}

const ID_RE = /^[a-z][a-z0-9-]{2,50}$/;
const TOOL_RE = /^partnersinbiz\.[a-z]+:[a-z0-9-]+$/;

/** The kinds of step in a plan, and what each carries. */
export const PLAN_KINDS = ["tool", "api", "comment", "escalate", "none"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export interface PlanStep {
  kind: PlanKind;
  tool?: string;
  method?: string;
  path?: string;
  args?: Record<string, unknown>;
  say?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function patternOk(source: unknown): boolean {
  if (typeof source !== "string") return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a scenario file. `slugs` are the skills a scenario may be about,
 * `knownTool` says whether a tool name exists (a scenario naming a tool that does
 * not exist could never pass, or would pass a wrong answer). Every problem in one error.
 */
export function parseScenarioFile(raw: unknown, slugs: readonly string[], knownTool: (name: string) => boolean): ScenarioFile {
  const problems: string[] = [];
  const bad = (text: string) => problems.push(text);
  if (!isRecord(raw)) throw new EvalError("A scenario file is an object.");
  const skill = typeof raw.skill === "string" ? raw.skill : "";
  if (!slugs.includes(skill)) bad(`skill must be one of ${slugs.join(", ")}`);
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) bad("version must be a whole number from 1");
  const list = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  if (list.length === 0) bad("scenarios lists at least one scenario");
  const seen = new Set<string>();
  list.forEach((s, i) => {
    const at = `scenario ${i + 1}`;
    if (!isRecord(s)) return bad(`${at} is not an object`);
    const id = typeof s.id === "string" ? s.id : "";
    if (!ID_RE.test(id)) bad(`${at}: id must be lowercase words with dashes`);
    if (seen.has(id)) bad(`${at}: id ${id} is used twice`);
    seen.add(id);
    const label = `${at} (${id || "?"})`;
    for (const field of ["title", "source", "situation", "task"] as const) if (typeof s[field] !== "string" || !(s[field] as string).trim()) bad(`${label}: ${field} is required`);
    if (typeof s.situation === "string" && s.situation.length > 4000) bad(`${label}: situation is over 4000 characters`);
    if (s.repeats !== undefined && (!Number.isInteger(s.repeats) || (s.repeats as number) < 1 || (s.repeats as number) > 5)) bad(`${label}: repeats is from 1 to 5`);
    const e = isRecord(s.expect) ? s.expect : null;
    if (!e) return bad(`${label}: expect is required`);
    const calls = [...((e.toolCalls as unknown[]) ?? []), ...((e.apiCalls as unknown[]) ?? [])];
    const hasRule = calls.length > 0 || ((e.forbid as unknown[]) ?? []).length > 0 || ((e.mustSay as unknown[]) ?? []).length > 0 || ((e.mustNotSay as unknown[]) ?? []).length > 0 || e.plainWriting === true;
    if (!hasRule) bad(`${label}: it expects nothing, so it could never fail`);
    for (const [i2, t] of ((e.toolCalls as unknown[]) ?? []).entries()) {
      if (!isRecord(t) || typeof t.tool !== "string" || !TOOL_RE.test(t.tool)) bad(`${label}: toolCalls ${i2 + 1} needs a tool as partnersinbiz.<plugin>:<tool>`);
      else if (!knownTool(t.tool)) bad(`${label}: toolCalls ${i2 + 1} names ${t.tool}, which is not a tool`);
    }
    for (const [i2, a] of ((e.apiCalls as unknown[]) ?? []).entries()) {
      if (!isRecord(a) || typeof a.method !== "string" || !patternOk(a.path)) bad(`${label}: apiCalls ${i2 + 1} needs a method and a valid path pattern`);
    }
    for (const [i2, f] of ((e.forbid as unknown[]) ?? []).entries()) {
      if (!isRecord(f) || typeof f.reason !== "string" || !f.reason.trim()) bad(`${label}: forbid ${i2 + 1} needs a reason`);
      else {
        if (!f.tool && !f.apiPath && !f.text && !isRecord(f.args)) bad(`${label}: forbid ${i2 + 1} forbids nothing`);
        if (typeof f.tool === "string" && !knownTool(f.tool)) bad(`${label}: forbid ${i2 + 1} names ${f.tool}, which is not a tool`);
        for (const p of [f.apiPath, f.text]) if (p !== undefined && !patternOk(p)) bad(`${label}: forbid ${i2 + 1} has an invalid pattern`);
      }
    }
    for (const field of ["mustSay", "mustNotSay"] as const) for (const p of (e[field] as unknown[]) ?? []) if (!patternOk(p)) bad(`${label}: ${field} has an invalid pattern`);
    if (e.maxSteps !== undefined && (!Number.isInteger(e.maxSteps) || (e.maxSteps as number) < 1)) bad(`${label}: maxSteps is a whole number from 1`);
  });
  if (problems.length) throw new EvalError(`Scenario file ${skill || "(no skill)"}: ${problems.join("; ")}.`);
  return raw as unknown as ScenarioFile;
}

// ---------------------------------------------------------------------------
// Hashes: which skill text, which scenario text
// ---------------------------------------------------------------------------

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A short hash of what an agent reads: the skill's markdown and its reference files. Same text, same hash, on any machine. */
export function skillContentHash(skill: { markdown?: string | null; files?: Array<{ path: string; content: string }> | null }): string {
  const files = [...(skill.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content]);
  return sha(JSON.stringify({ m: skill.markdown ?? "", f: files })).slice(0, 16);
}

export function scenarioHash(s: Scenario): string {
  return sha(JSON.stringify({ i: s.id, s: s.situation, t: s.task, e: s.expect })).slice(0, 12);
}

// ---------------------------------------------------------------------------
// The prompt and the answer
// ---------------------------------------------------------------------------

/** The marker the harness issue carries, so a result can be tied to the scenario text it ran. */
export function evalMarker(skill: string, s: Scenario): string {
  return `[eval:${skill}:${s.id}:${scenarioHash(s)}]`;
}

export const PAPER_ANSWER_FORMAT = `{"plan":[{"kind":"tool","tool":"partnersinbiz.<plugin>:<tool>","args":{"name":"value"},"say":"why, one line"},{"kind":"api","method":"PATCH","path":"/api/issues/<id>","args":{"field":"value"}},{"kind":"comment","say":"the comment you would post"},{"kind":"escalate","say":"the question you would put to the owner"}],"summary":"one line"}`;

/** What the agent is asked in the harness issue: the situation, the task, and the paper-answer contract. */
export function evalPrompt(skill: string, s: Scenario): string {
  return [
    evalMarker(skill, s),
    "",
    `This is a scenario test of the \`${skill}\` skill: do what the skill tells you for the situation below, but only on paper.`,
    "",
    "## The situation",
    s.situation.trim(),
    "",
    "## Your task",
    s.task.trim(),
    "",
    "## How to answer (paper mode)",
    "Do not call any plugin tool or Paperclip API that changes anything, do not comment on any issue except this one, and do not look anything up that the situation already tells you. Decide what you WOULD do, in the order you would do it, with the exact tool names and arguments the skill gives you.",
    "",
    "Write the answer as one JSON object in a ```json fence in the `output` document, then mark this task done:",
    "",
    "```json",
    PAPER_ANSWER_FORMAT,
    "```",
    "",
    "Kinds: `tool` (a plugin tool call: the exact name and its arguments), `api` (a Paperclip API call: method, path, body as args), `comment` (what you would write: put it in `say`), `escalate` (a question for the owner: put it in `say`). A step you would not take is not in the plan.",
  ].join("\n");
}

/** Every top-level `{...}` in a text (strings and escapes respected), in order. */
function objectsIn(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

/** Escapes raw control characters (line breaks, tabs) that sit inside JSON string literals, leaving everything else alone. */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/** The plan in an agent's answer: the first object with a "plan" list in a ```json fence, else anywhere in the text. An error says what is wrong. */
export function extractPlan(output: string): { plan: PlanStep[]; summary: string } | { error: string } {
  const text = String(output ?? "");
  const fenced = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]!);
  for (const source of [...fenced, text]) {
    for (const candidate of objectsIn(source)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        // Agents often write a multi-line comment as a literal line break inside a JSON string, which strict JSON refuses.
        // That is a formatting slip, not a wrong answer: read it as the intended text.
        try {
          parsed = JSON.parse(escapeControlCharsInStrings(candidate));
        } catch {
          continue;
        }
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.plan)) continue;
      const plan: PlanStep[] = [];
      for (const raw of parsed.plan) {
        if (!isRecord(raw) || !PLAN_KINDS.includes(raw.kind as PlanKind)) return { error: `A plan step has no valid kind (one of ${PLAN_KINDS.join(", ")}).` };
        plan.push({
          kind: raw.kind as PlanKind,
          ...(typeof raw.tool === "string" ? { tool: raw.tool } : {}),
          ...(typeof raw.method === "string" ? { method: raw.method.toUpperCase() } : {}),
          ...(typeof raw.path === "string" ? { path: raw.path } : {}),
          ...(isRecord(raw.args) ? { args: raw.args } : {}),
          ...(typeof raw.say === "string" ? { say: raw.say } : {}),
        });
      }
      return { plan: plan.slice(0, 60), summary: typeof parsed.summary === "string" ? parsed.summary : "" };
    }
  }
  return { error: 'The answer has no JSON plan in the required format (a ```json fence holding {"plan": [...]}).' };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface EvalCheck {
  ok: boolean;
  detail: string;
}

export interface Graded {
  passed: boolean;
  checks: EvalCheck[];
  steps: number;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function argOk(value: unknown, matcher: ArgMatcher): boolean {
  if (typeof matcher !== "object" || matcher === null) return same(value, matcher) || String(value) === String(matcher);
  if (matcher.exists === true && value === undefined) return false;
  if (matcher.exists === false && value !== undefined) return false;
  if (matcher.notEmpty && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))) return false;
  if (matcher.matches !== undefined && !new RegExp(matcher.matches, "i").test(String(value ?? ""))) return false;
  if (matcher.contains !== undefined && !(Array.isArray(value) ? value.some((v) => same(v, matcher.contains)) : String(value ?? "").includes(matcher.contains))) return false;
  if (matcher.oneOf !== undefined && !matcher.oneOf.some((x) => same(x, value) || String(x) === String(value))) return false;
  return true;
}

/** `effect.key` reads args.effect.key. */
function argAt(args: Record<string, unknown> | undefined, key: string): unknown {
  let cur: unknown = args;
  for (const part of key.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function argsOk(args: Record<string, unknown> | undefined, expected: Record<string, ArgMatcher> | undefined): string | null {
  for (const [key, matcher] of Object.entries(expected ?? {})) if (!argOk(argAt(args, key), matcher)) return `${key} should be ${JSON.stringify(matcher)}, it was ${JSON.stringify(argAt(args, key))}`;
  return null;
}

/** Every string value inside some arguments, nested ones too (a comment's body, a question, a reason). */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (isRecord(value)) Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

/** Everything the plan says: its summary, each step's note, and the words inside each step's arguments (what a comment or a question would read). */
const allText = (steps: PlanStep[], summary: string): string => [summary, ...steps.flatMap((s) => [s.say ?? "", ...stringsIn(s.args)])].join("\n");

/** One answer against one scenario. Pure: every check is a rule, none is a judgement. */
export function gradeAnswer(s: Scenario, output: string): Graded {
  const extracted = extractPlan(output);
  if ("error" in extracted) return { passed: false, checks: [{ ok: false, detail: extracted.error }], steps: 0 };
  const { plan, summary } = extracted;
  const checks: EvalCheck[] = [];
  const e = s.expect;

  const find = (list: ToolExpect[] | ApiExpect[] | undefined, kind: "tool" | "api") => {
    let cursor = -1;
    for (const want of list ?? []) {
      const label = kind === "tool" ? (want as ToolExpect).tool : `${(want as ApiExpect).method.toUpperCase()} ${(want as ApiExpect).path}`;
      let miss = "it is not in the plan";
      // The task text tells the agent to write a comment as a `comment` step (what it WOULD write), so an expected
      // POST .../comments is also satisfied by a comment step whose text carries the expected body.
      const commentExpected = kind === "api" && (want as ApiExpect).method.toUpperCase() === "POST" && /comments\$?$/.test((want as ApiExpect).path);
      const hits = plan
        .map((step, index) => ({ step, index }))
        .filter(({ step }) =>
          (commentExpected && step.kind === "comment" && !!step.say) ||
          (step.kind === kind && (kind === "tool" ? step.tool === (want as ToolExpect).tool : step.method === (want as ApiExpect).method.toUpperCase() && new RegExp((want as ApiExpect).path).test(step.path ?? ""))),
        );
      let hit = null as { step: PlanStep; index: number } | null;
      for (const h of hits) {
        const why = argsOk(h.step.kind === "comment" ? { body: h.step.say } : h.step.args, want.args);
        if (why) miss = why;
        else if (!e.ordered || h.index > cursor) {
          hit = h;
          break;
        } else miss = "it comes too early";
      }
      if (hit) {
        cursor = hit.index;
        checks.push({ ok: true, detail: `${label} is called` });
      } else if (want.optional) checks.push({ ok: true, detail: `${label} (optional) is not called` });
      else checks.push({ ok: false, detail: `${label} is missing: ${miss}` });
    }
  };
  find(e.toolCalls, "tool");
  find(e.apiCalls, "api");

  for (const f of e.forbid ?? []) {
    const hit = plan.find((step) => {
      if (step.kind !== "tool" && step.kind !== "api") return false;
      const named = f.tool || f.apiPath;
      if (!named && !f.args) return false;
      const byTool = !!f.tool && step.kind === "tool" && step.tool === f.tool;
      const byApi = !!f.apiPath && step.kind === "api" && new RegExp(f.apiPath).test(step.path ?? "") && (!f.method || step.method === f.method.toUpperCase());
      if (named && !byTool && !byApi) return false;
      return !f.args || argsOk(step.args, f.args) === null;
    });
    const said = f.text ? new RegExp(f.text, "i").test(allText(plan, summary)) : false;
    checks.push({ ok: !hit && !said, detail: !hit && !said ? `Not done: ${f.reason}` : `Forbidden, ${f.reason}${hit?.tool ? ` (it calls ${hit.tool})` : hit?.path ? ` (it calls ${hit.method ?? ""} ${hit.path})` : ""}` });
  }
  const text = allText(plan, summary);
  for (const p of e.mustSay ?? []) checks.push({ ok: new RegExp(p, "i").test(text), detail: `It says ${p}` });
  for (const p of e.mustNotSay ?? []) { const says = new RegExp(p, "i").test(text); checks.push({ ok: !says, detail: says ? `It says ${p}, which it must not` : `It does not say ${p}` }); }
  if (e.plainWriting) {
    const said = [summary, ...plan.flatMap((step) => (step.kind === "comment" ? [step.say ?? ""] : step.kind === "tool" && /:ask-owner$/.test(step.tool ?? "") ? [String(step.args?.question ?? ""), String(step.args?.why ?? ""), ...stringsIn(step.args?.steps)] : []))].join("\n");
    const found = writingFindings(said);
    checks.push({ ok: found.length === 0, detail: found.length === 0 ? "It writes in plain words" : `Plain writing: ${found.slice(0, 3).map((f) => `${f.rule} (${f.excerpt})`).join("; ")}` });
  }
  if (e.maxSteps !== undefined) checks.push({ ok: plan.length <= e.maxSteps, detail: `The plan has at most ${e.maxSteps} steps (it has ${plan.length})` });
  return { passed: checks.every((c) => c.ok), checks, steps: plan.length };
}

// ---------------------------------------------------------------------------
// Results, pass rates and the gate
// ---------------------------------------------------------------------------

export interface ResultRow {
  skillSlug: string;
  skillHash: string;
  scenarioId: string;
  scenarioHash: string;
  passed: boolean;
  gradedAt: string;
  mode?: string;
}

export interface ScenarioState {
  /** Runs graded for this skill text and this scenario text, newest first, at most `repeats`. */
  runs: number;
  passedRuns: number;
  /** All the runs it needs are in. */
  measured: boolean;
  passed: boolean;
}

export interface SkillState {
  hash: string;
  total: number;
  measured: number;
  passed: number;
  /** passed / total (an unmeasured scenario counts as not passed); null with no scenarios. */
  passRate: number | null;
  scenarios: Record<string, ScenarioState>;
  missing: string[];
}

/** Where a skill text stands on its scenarios: only results for this exact skill text and these exact scenario texts count. */
export function skillState(scenarios: Scenario[], hash: string, rows: ResultRow[]): SkillState {
  const states: Record<string, ScenarioState> = {};
  for (const s of scenarios) {
    const sh = scenarioHash(s);
    const mine = rows
      .filter((r) => r.skillHash === hash && r.scenarioId === s.id && r.scenarioHash === sh)
      .sort((a, b) => Date.parse(b.gradedAt) - Date.parse(a.gradedAt))
      .slice(0, s.repeats ?? 1);
    const need = s.repeats ?? 1;
    const passedRuns = mine.filter((r) => r.passed).length;
    states[s.id] = { runs: mine.length, passedRuns, measured: mine.length >= need, passed: mine.length >= need && passedRuns / mine.length >= (need === 1 ? 1 : SCENARIO_PASS_SHARE) };
  }
  const list = Object.entries(states);
  const measured = list.filter(([, v]) => v.measured).length;
  const passed = list.filter(([, v]) => v.passed).length;
  return { hash, total: scenarios.length, measured, passed, passRate: scenarios.length === 0 ? null : passed / scenarios.length, scenarios: states, missing: list.filter(([, v]) => !v.measured).map(([id]) => id) };
}

export interface Baseline {
  hash: string;
  passRate: number | null;
  /** Scenario id to whether it passed at the baseline. */
  scenarios: Record<string, boolean>;
  measuredAt?: string | null;
}

export type GateStatus = "pass" | "regressed" | "below-threshold" | "unmeasured" | "no-scenarios" | "no-baseline";

export interface GateVerdict {
  skill: string;
  hash: string;
  ship: boolean;
  status: GateStatus;
  reasons: string[];
  passRate: number | null;
  baselinePassRate: number | null;
  /** Scenarios that passed at the baseline and do not pass now. */
  regressions: string[];
  missing: string[];
}

/**
 * The rule the deploy process calls: no skill version ships if a golden scenario
 * regressed. In order: no scenarios means nothing to gate; the baseline's own text
 * passes; a scenario that passed at the baseline and does not pass now blocks; a pass
 * rate under the minimum blocks; unmeasured scenarios block when `requireFull`.
 */
export function gateSkill(input: { skill: string; hash: string; scenarios: Scenario[]; rows: ResultRow[]; baseline: Baseline | null; minPassRate?: number; requireFull?: boolean }): GateVerdict {
  const min = input.minPassRate ?? MIN_PASS_RATE;
  const base = { skill: input.skill, hash: input.hash, baselinePassRate: input.baseline?.passRate ?? null };
  if (input.scenarios.length === 0) return { ...base, ship: true, status: "no-scenarios", reasons: ["There are no scenarios for this skill, so nothing gates it."], passRate: null, regressions: [], missing: [] };
  const state = skillState(input.scenarios, input.hash, input.rows);
  const regressions = input.baseline && input.baseline.hash !== input.hash ? Object.entries(input.baseline.scenarios).filter(([id, was]) => was && input.scenarios.some((s) => s.id === id) && state.scenarios[id]?.measured && !state.scenarios[id]!.passed).map(([id]) => id) : [];
  const common = { ...base, passRate: state.passRate, regressions, missing: state.missing };
  if (regressions.length) return { ...common, ship: false, status: "regressed", reasons: [`${regressions.length} scenario${regressions.length === 1 ? "" : "s"} that passed before no longer pass: ${regressions.join(", ")}.`] };
  if (state.measured > 0 && (state.passRate ?? 0) < min && state.missing.length === 0) return { ...common, ship: false, status: "below-threshold", reasons: [`Only ${state.passed} of ${state.total} scenarios pass (${Math.round((state.passRate ?? 0) * 100)}%; the minimum is ${Math.round(min * 100)}%).`] };
  if (state.missing.length) {
    const why = `${state.missing.length} of ${state.total} scenarios have not been run on this skill text: ${state.missing.join(", ")}.`;
    return { ...common, ship: !(input.requireFull ?? true), status: "unmeasured", reasons: [why] };
  }
  if (!input.baseline) return { ...common, ship: true, status: "no-baseline", reasons: ["Every scenario passes, but no baseline is recorded yet: record this one (baseline) so the next change is compared with it."] };
  return { ...common, ship: true, status: "pass", reasons: [`All ${state.total} scenarios pass.`] };
}

// ---------------------------------------------------------------------------
// The committed gate file (offline: runs in the test suite and in the deploy)
// ---------------------------------------------------------------------------

export interface ResultsEntry {
  hash?: string;
  passRate: number | null;
  scenarios: Record<string, boolean>;
  measuredAt?: string | null;
  runs?: string[];
}

export interface Waiver {
  hash: string;
  reason: string;
  by: string;
  at: string;
}

export interface ResultsFile {
  version: number;
  /** False until the first baseline is recorded: before that there is nothing to regress from, and the gate only reports. */
  enforce: boolean;
  minPassRate: number;
  skills: Record<string, { baseline?: ResultsEntry & { hash: string }; candidates?: Record<string, ResultsEntry>; waivers?: Waiver[] }>;
}

export interface OfflineVerdict {
  skill: string;
  hash: string;
  ok: boolean;
  /** `skipped` while the file does not enforce. */
  status: "ok" | "unchanged" | "waived" | "regressed" | "below-threshold" | "unmeasured" | "no-baseline" | "not-enforced" | "no-scenarios";
  reason: string;
}

export function parseResultsFile(raw: unknown): ResultsFile {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.enforce !== "boolean" || typeof raw.minPassRate !== "number" || !isRecord(raw.skills)) throw new EvalError("evals/results.json is {version: 1, enforce, minPassRate, skills}.");
  return raw as unknown as ResultsFile;
}

/**
 * The gate against the committed file. A skill whose text changed since its baseline
 * needs recorded results for the new text (and no regression), or a waiver naming
 * who accepted the risk. Until `enforce` is true it reports and never blocks.
 */
export function offlineGate(skills: Array<{ slug: string; hash: string; scenarios: Scenario[] }>, file: ResultsFile): OfflineVerdict[] {
  return skills.map(({ slug, hash, scenarios }) => {
    const v = (status: OfflineVerdict["status"], ok: boolean, reason: string): OfflineVerdict => ({ skill: slug, hash, ok, status, reason });
    if (scenarios.length === 0) return v("no-scenarios", true, "No scenarios for this skill.");
    const entry = file.skills[slug];
    const baseline = entry?.baseline;
    const open = (status: OfflineVerdict["status"], reason: string) => v(status, !file.enforce, file.enforce ? reason : `${reason} (not enforced yet: record a baseline, then set enforce to true)`);
    if (!baseline) return open("no-baseline", `${slug} has no recorded baseline: run its scenarios, then record the baseline in evals/results.json.`);
    if (baseline.hash === hash) return v("unchanged", true, "The skill is the one the baseline was recorded for.");
    const waiver = entry?.waivers?.find((w) => w.hash === hash);
    if (waiver) return v("waived", true, `Waived by ${waiver.by} on ${waiver.at}: ${waiver.reason}`);
    const candidate = entry?.candidates?.[hash];
    if (!candidate) return open("unmeasured", `${slug} changed (${baseline.hash} to ${hash}) and no results are recorded for the new text: run its scenarios on the candidate and add the results to evals/results.json (or a waiver, with a reason).`);
    const regressed = Object.entries(baseline.scenarios).filter(([id, was]) => was && scenarios.some((s) => s.id === id) && candidate.scenarios[id] === false).map(([id]) => id);
    if (regressed.length) return open("regressed", `${slug}: ${regressed.join(", ")} passed at the baseline and fail on the new text.`);
    const missing = scenarios.filter((s) => !(s.id in candidate.scenarios)).map((s) => s.id);
    if (missing.length) return open("unmeasured", `${slug}: the recorded results lack ${missing.join(", ")}.`);
    const rate = scenarios.filter((s) => candidate.scenarios[s.id] === true).length / scenarios.length;
    if (rate < file.minPassRate) return open("below-threshold", `${slug}: ${Math.round(rate * 100)}% of scenarios pass; the minimum is ${Math.round(file.minPassRate * 100)}%.`);
    return v("ok", true, `The new text passes ${Math.round(rate * 100)}% of its scenarios with no regression.`);
  });
}

/** The entry `skill-eval baseline` and `report` print for evals/results.json, from a skill's state. */
export function resultsEntry(state: SkillState, measuredAt: string, runs: string[]): ResultsEntry & { hash: string } {
  return { hash: state.hash, passRate: state.passRate, scenarios: Object.fromEntries(Object.entries(state.scenarios).map(([id, v]) => [id, v.passed])), measuredAt, runs };
}
