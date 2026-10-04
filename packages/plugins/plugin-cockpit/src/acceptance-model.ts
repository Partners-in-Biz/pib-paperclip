/**
 * Acceptance journeys, pure part (no node imports) (Q5-1, Q5-2).
 *
 * Nothing in Paperclip used a finished feature the way a customer would, and
 * nothing fired when a release shipped. An Acceptance agent now works scripted
 * customer journeys on ONE fixture client, the CRM canary (`company:canary-<id>`,
 * addresses on `@canary.invalid`), calling the real plugin tools in the draft and
 * dry-run modes that never reach a real customer.
 *
 * Who does what. A journey is data (`journeys/*.json`, versioned). The agent
 * makes each call; the Cockpit decides what counts: it hands out the next step,
 * checks what the agent reports against the step's expectations, runs the probes
 * it can run itself (an issue exists, an approval was routed to somebody), and
 * writes the report. A step the agent cannot prove is a failed step.
 *
 * Safety. A run starts only for the canary client. Every step's input, as the
 * agent reports it, is checked: another client, a real address or a real
 * domain fails the step and aborts the run. The plugins' own canary rules (CRM
 * canary flags, Billing filters `.invalid`) are the walls; this is the second lock.
 */

import { redactSecrets } from "./watch-model.js";

export const JOURNEY_SCHEMA_VERSION = 1;

/** The canary client's ref: its CRM id starts with `canary-` (real ids are UUIDs). */
export const CANARY_CLIENT_RE = /^company:canary-[a-z0-9]{4,40}$/;
export const CANARY_DOMAIN = "canary.invalid";

export class AcceptanceError extends Error {}

export type Trigger = "nightly" | "release" | "on-demand";
export const TRIGGERS: readonly Trigger[] = ["nightly", "release", "on-demand"];
export type StepKind = "tool" | "http" | "ui" | "check";
export const STEP_KINDS: readonly StepKind[] = ["tool", "http", "ui", "check"];

export interface Expectation {
  /** Dot path into what the step returned: `contact.email`, `sources[0].accepted`, `deals[id=abc].status`. `$` is the whole value. */
  path: string;
  equals?: unknown;
  matches?: string;
  contains?: string;
  endsWith?: string;
  exists?: boolean;
  notEmpty?: boolean;
  gte?: number;
  lte?: number;
  oneOf?: unknown[];
  /** Greater than (or at least) a number captured earlier in the run. */
  gtCapture?: string;
  gteCapture?: string;
}

export interface Capture {
  path: string;
  /** A prefix to cut off the captured text (`company:` turns `company:canary-1` into `canary-1`). */
  strip?: string;
}

/** What the Cockpit looks up itself, so the agent cannot just say it happened. */
export type Probe =
  | { kind: "issue"; idPath: string; status?: string[]; matches?: string }
  | { kind: "approval-route"; idPath: string; outward?: boolean };

export interface JourneyStep {
  id: string;
  title: string;
  kind: StepKind;
  /** `partnersinbiz.crm:create-canary-client` (kind tool). */
  tool?: string;
  /** The tool is promised by another plugin but not shipped yet: the step is skipped, and a test fails the day the tool appears so the flag is removed. */
  planned?: boolean;
  /** A step that may be skipped with a reason (a module that is off). */
  optional?: boolean;
  /** What to call it with. Strings may hold `{{name}}` (a capture or a built-in). */
  input?: Record<string, unknown>;
  /** What the agent must adapt or watch for, in a sentence. */
  note?: string;
  expect: Expectation[];
  capture?: Record<string, Capture>;
  probe?: Probe;
  /** The role that fixes a failure of this step (a kit team role, or `operator`). */
  ownerRole?: string;
  /** Runs even after an earlier step failed (cleanup). */
  always?: boolean;
  /** Evidence the step must come with. */
  evidence?: Array<"screenshot" | "curl" | "output">;
  /**
   * Paths in the step's answer that name an issue the rehearsal opened for the product's own sake (the work issue a document
   * opens for the deal desk): the Cockpit cancels the canary's own when the run ends, as it does an approval, so a rehearsal never
   * leaves work for an agent or a person.
   */
  cleanupIssues?: string[];
}

export interface Journey {
  key: string;
  version: number;
  title: string;
  summary: string;
  schedule: Trigger[];
  /** Plugin keys the journey exercises: a release of one of them runs it. */
  plugins: string[];
  ownerRole: string;
  steps: JourneyStep[];
}

// ---------------------------------------------------------------------------
// Journey definitions
// ---------------------------------------------------------------------------

/** Names a step's input may use without capturing them first. */
export const BUILT_IN_VARS = ["client", "companyRecordId", "runId", "date", "futureDate", "period"] as const;

const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL_RE = /^partnersinbiz\.[a-z]+:[a-z0-9-]+$/;
const PLUGIN_RE = /^partnersinbiz\.[a-z]+$/;
const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const OPS = ["equals", "matches", "contains", "endsWith", "exists", "notEmpty", "gte", "lte", "oneOf", "gtCapture", "gteCapture"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function varsIn(value: unknown, out: Set<string>): void {
  if (typeof value === "string") for (const m of value.matchAll(VAR_RE)) out.add(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => varsIn(v, out));
  else if (isRecord(value)) Object.values(value).forEach((v) => varsIn(v, out));
}

/**
 * Validates a journey file and returns it typed. Every problem is listed in one
 * error, so a bad file is fixed in one pass. `roles` are the team roles a
 * failure may be routed to (the kit's registry plus `operator`).
 */
export function parseJourney(raw: unknown, roles: readonly string[]): Journey {
  const problems: string[] = [];
  const bad = (text: string) => problems.push(text);
  if (!isRecord(raw)) throw new AcceptanceError("A journey is an object.");
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!KEY_RE.test(key)) bad("key must be lowercase words with dashes (for example lead-capture)");
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) bad("version must be a whole number from 1");
  if (typeof raw.title !== "string" || !raw.title.trim()) bad("title is required");
  if (typeof raw.summary !== "string" || !raw.summary.trim()) bad("summary is required");
  const schedule = Array.isArray(raw.schedule) ? raw.schedule : [];
  if (schedule.length === 0 || schedule.some((t) => !TRIGGERS.includes(t as Trigger))) bad(`schedule lists at least one of ${TRIGGERS.join(", ")}`);
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  if (plugins.length === 0 || plugins.some((p) => typeof p !== "string" || !PLUGIN_RE.test(p))) bad("plugins lists the plugin keys the journey exercises (partnersinbiz.<name>)");
  if (typeof raw.ownerRole !== "string" || !roles.includes(raw.ownerRole)) bad(`ownerRole must be one of ${roles.join(", ")}`);
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length < 1 || steps.length > 30) bad("a journey has 1 to 30 steps");

  const seen = new Set<string>();
  const known = new Set<string>(BUILT_IN_VARS);
  let sawAlways = false;
  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    if (!isRecord(step)) return bad(`${at} is not an object`);
    const id = typeof step.id === "string" ? step.id : "";
    if (!KEY_RE.test(id)) bad(`${at}: id must be lowercase words with dashes`);
    if (seen.has(id)) bad(`${at}: id ${id} is used twice`);
    seen.add(id);
    const label = `${at} (${id || "?"})`;
    if (typeof step.title !== "string" || !step.title.trim()) bad(`${label}: title is required`);
    if (!STEP_KINDS.includes(step.kind as StepKind)) bad(`${label}: kind is one of ${STEP_KINDS.join(", ")}`);
    if (step.kind === "tool") {
      if (typeof step.tool !== "string" || !TOOL_RE.test(step.tool)) bad(`${label}: a tool step names its tool as partnersinbiz.<plugin>:<tool>`);
    } else if (step.tool !== undefined) bad(`${label}: only a tool step has a tool`);
    const expect = Array.isArray(step.expect) ? step.expect : null;
    if (!expect) bad(`${label}: expect is a list (it may be empty only for a check step with a probe)`);
    else {
      if (expect.length === 0 && !isRecord(step.probe)) bad(`${label}: it expects nothing and probes nothing, so it could never fail`);
      expect.forEach((e, j) => {
        if (!isRecord(e) || typeof e.path !== "string" || !e.path) return bad(`${label}: expectation ${j + 1} needs a path`);
        const ops = OPS.filter((op) => op in e);
        if (ops.length === 0) bad(`${label}: expectation ${j + 1} (${e.path}) checks nothing: add one of ${OPS.join(", ")}`);
        for (const name of [e.gtCapture, e.gteCapture]) if (typeof name === "string" && !known.has(name)) bad(`${label}: expectation ${j + 1} compares with ${name}, which no earlier step captured`);
        if (typeof e.matches === "string") {
          try {
            new RegExp(e.matches);
          } catch {
            bad(`${label}: expectation ${j + 1} has an invalid pattern`);
          }
        }
      });
    }
    // Names a step uses must exist: a built-in, or captured by an earlier step.
    const used = new Set<string>();
    varsIn(step.input, used);
    varsIn(step.expect, used);
    varsIn(step.probe, used);
    for (const name of used) if (!known.has(name)) bad(`${label}: uses {{${name}}}, which no earlier step captures`);
    if (step.capture !== undefined) {
      if (!isRecord(step.capture)) bad(`${label}: capture is an object`);
      else {
        for (const [name, spec] of Object.entries(step.capture)) {
          if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) bad(`${label}: capture name ${name} is not a plain word`);
          if (!isRecord(spec) || typeof spec.path !== "string" || !spec.path) bad(`${label}: capture ${name} needs a path`);
        }
      }
    }
    if (step.probe !== undefined) {
      const probe = step.probe;
      if (!isRecord(probe) || !["issue", "approval-route"].includes(String(probe.kind)) || typeof probe.idPath !== "string") bad(`${label}: probe is {kind: issue | approval-route, idPath}`);
    }
    if (step.ownerRole !== undefined && (typeof step.ownerRole !== "string" || !roles.includes(step.ownerRole))) bad(`${label}: ownerRole must be one of ${roles.join(", ")}`);
    if (step.kind === "ui" && !(Array.isArray(step.evidence) && step.evidence.includes("screenshot"))) bad(`${label}: a ui step must list screenshot evidence`);
    if (step.cleanupIssues !== undefined) {
      const paths = step.cleanupIssues;
      if (step.kind !== "tool" || !Array.isArray(paths) || paths.length < 1 || paths.length > 3 || paths.some((p) => typeof p !== "string" || !p.trim() || p === "$")) bad(`${label}: cleanupIssues is one to three paths into a tool answer, each naming an issue id`);
    }
    if (step.always === true) sawAlways = true;
    else if (sawAlways) bad(`${label}: steps that always run (cleanup) come last`);
    if (isRecord(step.capture)) for (const name of Object.keys(step.capture)) known.add(name);
  });
  if (problems.length) throw new AcceptanceError(`Journey ${key || "(no key)"}: ${problems.join("; ")}.`);
  return raw as unknown as Journey;
}

// ---------------------------------------------------------------------------
// Paths, templates, expectations
// ---------------------------------------------------------------------------

const TOKEN = /\[(\d+)\]|\[([^=\]]+)=([^\]]*)\]|([^.[\]]+)/g;

/** Reads `a.b[0].c` or `items[id=7].status` out of a value. */
export function getPath(value: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "$" || path === "") return { found: value !== undefined, value };
  let cur: unknown = value;
  for (const m of path.matchAll(TOKEN)) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (m[1] !== undefined) {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      cur = cur[Number(m[1])];
    } else if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      cur = cur.find((item) => isRecord(item) && String(item[m[2]!]) === m[3]);
    } else {
      if (!isRecord(cur) && !Array.isArray(cur)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[m[4]!];
    }
    if (cur === undefined) return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

/** `{{name}}` filled from `vars`; a value that is exactly one `{{name}}` keeps its type. Unknown names stay and are listed. */
export function renderValue(value: unknown, vars: Record<string, unknown>, missing: Set<string> = new Set()): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}$/.exec(value);
    if (whole) {
      const v = vars[whole[1]!];
      if (v === undefined) {
        missing.add(whole[1]!);
        return value;
      }
      return v;
    }
    return value.replace(VAR_RE, (all, name: string) => {
      const v = vars[name];
      if (v === undefined) {
        missing.add(name);
        return all;
      }
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, vars, missing));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v, vars, missing)]));
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function empty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function shown(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export interface Check {
  ok: boolean;
  /** What was checked, one line, for the report. */
  detail: string;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

/** One expectation against what a step returned. Every operator in it must hold. */
export function checkExpectation(output: unknown, e: Expectation, captures: Record<string, unknown> = {}): Check[] {
  const got = getPath(output, e.path);
  const checks: Check[] = [];
  const add = (ok: boolean, text: string) => checks.push({ ok, detail: ok ? text : `${text}; got ${got.found ? shown(got.value) : "nothing there"}` });
  if (e.exists === false) {
    add(!got.found, `${e.path} is absent`);
    return checks;
  }
  if (!got.found) {
    return [{ ok: false, detail: `${e.path} is missing from the result` }];
  }
  const v = got.value;
  if (e.exists === true) add(true, `${e.path} is there`);
  if (e.notEmpty) add(!empty(v), `${e.path} is not empty`);
  if ("equals" in e) add(same(v, e.equals), `${e.path} is ${shown(e.equals)}`);
  if (e.matches !== undefined) add(new RegExp(e.matches).test(String(v)), `${e.path} matches ${e.matches}`);
  if (e.contains !== undefined) add(Array.isArray(v) ? v.some((x) => same(x, e.contains)) : String(v).includes(e.contains), `${e.path} contains ${shown(e.contains)}`);
  if (e.endsWith !== undefined) add(String(v).endsWith(e.endsWith), `${e.path} ends with ${shown(e.endsWith)}`);
  if (e.oneOf !== undefined) add(e.oneOf.some((x) => same(x, v)), `${e.path} is one of ${shown(e.oneOf)}`);
  if (e.gte !== undefined) add((num(v) ?? Number.NaN) >= e.gte, `${e.path} is at least ${e.gte}`);
  if (e.lte !== undefined) add((num(v) ?? Number.NaN) <= e.lte, `${e.path} is at most ${e.lte}`);
  if (e.gtCapture !== undefined) {
    const base = num(captures[e.gtCapture]);
    add(base !== null && (num(v) ?? Number.NaN) > base, `${e.path} is above ${e.gtCapture} (${base ?? "not captured"})`);
  }
  if (e.gteCapture !== undefined) {
    const base = num(captures[e.gteCapture]);
    add(base !== null && (num(v) ?? Number.NaN) >= base, `${e.path} is at least ${e.gteCapture} (${base ?? "not captured"})`);
  }
  return checks;
}

// ---------------------------------------------------------------------------
// The canary guard
// ---------------------------------------------------------------------------

export function isCanaryClientRef(ref: unknown): ref is string {
  return typeof ref === "string" && CANARY_CLIENT_RE.test(ref);
}

/** The CRM record id behind a client ref: `company:canary-1a2b3c4d` -> `canary-1a2b3c4d`. */
export function recordIdOf(ref: string): string {
  return ref.slice(ref.indexOf(":") + 1);
}

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const CLIENT_KEYS = new Set(["client", "clientref", "client_ref", "customerref", "companyrecordid", "recordid", "contactid", "clientkind"]);

/**
 * What the agent reports having sent is checked, not what it was told to send.
 * Returns the problems: another client or record, an email address that is not
 * on the canary domain (`.invalid` names are reserved: no mail system can
 * deliver to them). A step whose input has a problem fails and the run aborts.
 */
export function guardInput(input: unknown, canaryRef: string): string[] {
  const problems: string[] = [];
  const id = recordIdOf(canaryRef);
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(EMAIL_RE)) if (!m[1]!.toLowerCase().endsWith(".invalid")) problems.push(`it used the address ${m[0]}, which is not on a canary (.invalid) domain`);
      const k = key.toLowerCase();
      if (CLIENT_KEYS.has(k) && value && !(value === canaryRef || value === id || value.startsWith("canary-") || value === "company" || value === "contact")) problems.push(`${key} is ${shown(value)}, not the canary client`);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (isRecord(value)) for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(input, "");
  return [...new Set(problems)];
}

/**
 * A call that takes input (the journey gives it some) must come with the input it used. The guard can only check
 * what it is told, so a step recorded with none (or an empty one) is a step nobody
 * checked: it fails, and the agent is told to say what it sent.
 */
export function inputRequired(step: Pick<JourneyStep, "kind" | "input">): boolean {
  return (step.kind === "tool" || step.kind === "http") && isRecord(step.input) && Object.keys(step.input).length > 0;
}

export function isEmptyInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input === "string") return input.trim() === "";
  if (Array.isArray(input)) return input.length === 0;
  return isRecord(input) && Object.keys(input).length === 0;
}

const INPUT_LIMIT = 1500;
const SECRET_KEY = /token|secret|passw(?:or)?d|api[_-]?key|apikey|credential|authorization|signature/i;

function redactDeep(value: unknown, key: string, depth: number): unknown {
  if (depth > 6) return "[cut]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => redactDeep(v, key, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, redactDeep(v, k, depth + 1)]));
  if (SECRET_KEY.test(key)) return "[redacted]";
  return typeof value === "string" ? redactSecrets(value) : value;
}

/**
 * What the run keeps of the input the agent reported: anything under a secret-looking
 * name or that looks like a credential is blanked, and a long one is cut. The guard
 * has already looked at the raw input; the database never holds it.
 */
export function storedInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  const clean = redactDeep(input, "", 0);
  const text = JSON.stringify(clean) ?? "";
  return text.length <= INPUT_LIMIT ? clean : `${text.slice(0, INPUT_LIMIT - 1)}…`;
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "passed" | "failed" | "skipped" | "blocked";
export type RunStatus = "running" | "passed" | "failed" | "aborted";

export interface Evidence {
  kind: "screenshot" | "curl" | "output" | "link" | "note";
  /** A file path (screenshot), a link, or the text. */
  ref: string;
  note?: string;
  /** Set by the worker for a screenshot it found on disk. */
  bytes?: number;
}

export interface StepResult {
  id: string;
  status: StepStatus;
  checks: Check[];
  /** The input the agent says it used, and what came back (cut short). */
  input?: unknown;
  outputText?: string;
  error?: string | null;
  evidence: Evidence[];
  note?: string;
  at?: string;
}

export interface RunState {
  journey: string;
  version: number;
  clientRef: string;
  captures: Record<string, unknown>;
  steps: StepResult[];
  abortReason?: string | null;
  /** Approval issues this run opened (a send, a sequence): the worker cancels the canary's own when the run ends. */
  approvals?: string[];
  /** Work issues a step opened only because of the rehearsal (`cleanupIssues`): cancelled the same way, when the run ends. */
  rehearsalIssues?: string[];
}

/** The issue ids a step's answer names under its `cleanupIssues` paths: plain ids only, once each. Nothing is read from a call that failed. */
export function rehearsalIssueIds(step: Pick<JourneyStep, "cleanupIssues">, output: unknown): string[] {
  const ids = new Set<string>();
  for (const path of step.cleanupIssues ?? []) {
    const got = getPath(output, path);
    if (got.found && typeof got.value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(got.value)) ids.add(got.value);
  }
  return [...ids];
}

/** The month before `date` (YYYY-MM-DD) as YYYY-MM: what a monthly report is for. */
export function lastMonth(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function initRun(journey: Journey, clientRef: string, runId: string, date: string): RunState {
  if (!isCanaryClientRef(clientRef)) throw new AcceptanceError(`Acceptance runs only on the canary client (company:canary-<id>, from create-canary-client). ${shown(clientRef)} is not one.`);
  return {
    journey: journey.key,
    version: journey.version,
    clientRef,
    captures: { client: clientRef, companyRecordId: recordIdOf(clientRef), runId, date, futureDate: new Date(Date.parse(`${date}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10), period: lastMonth(date) },
    steps: journey.steps.map((s) => ({ id: s.id, status: "pending" as StepStatus, checks: [], evidence: [] })),
  };
}

/** One expectation in words, with the run's names filled in: what the agent is told the step must show. */
export function describeExpectation(e: Expectation, captures: Record<string, unknown> = {}): string {
  const r = renderValue(e, captures) as Expectation;
  const parts: string[] = [];
  if (r.exists === true) parts.push("is there");
  if (r.exists === false) parts.push("is absent");
  if (r.notEmpty) parts.push("is not empty");
  if ("equals" in r) parts.push(`is ${shown(r.equals)}`);
  if (r.matches !== undefined) parts.push(`matches ${r.matches}`);
  if (r.contains !== undefined) parts.push(`contains ${shown(r.contains)}`);
  if (r.endsWith !== undefined) parts.push(`ends with ${shown(r.endsWith)}`);
  if (r.oneOf !== undefined) parts.push(`is one of ${shown(r.oneOf)}`);
  if (r.gte !== undefined) parts.push(`is at least ${r.gte}`);
  if (r.lte !== undefined) parts.push(`is at most ${r.lte}`);
  if (r.gtCapture !== undefined) parts.push(`is above ${r.gtCapture} (${shown(captures[r.gtCapture])})`);
  if (r.gteCapture !== undefined) parts.push(`is at least ${r.gteCapture} (${shown(captures[r.gteCapture])})`);
  return `${e.path} ${parts.join(" and ")}`;
}

export interface NextStep {
  step: JourneyStep;
  /** The step's input with the captures filled in. */
  input: Record<string, unknown> | undefined;
  /** Names still unfilled (an earlier capture failed). */
  missing: string[];
  index: number;
  total: number;
}

/**
 * The step to do next: the first one still pending. After a failure the rest are
 * blocked, except steps that always run (cleanup). Planned steps (a tool that is
 * not shipped yet) are skipped here, so the agent never sees them.
 */
export function nextStep(journey: Journey, state: RunState): NextStep | null {
  if (state.abortReason) return null;
  const failed = state.steps.some((s) => s.status === "failed");
  for (let i = 0; i < journey.steps.length; i += 1) {
    const step = journey.steps[i]!;
    const result = state.steps[i]!;
    if (result.status !== "pending") continue;
    if (step.planned) continue;
    if (failed && !step.always) continue;
    const missing = new Set<string>();
    const input = step.input ? (renderValue(step.input, state.captures, missing) as Record<string, unknown>) : undefined;
    return { step, input, missing: [...missing], index: i + 1, total: journey.steps.length };
  }
  return null;
}

/** Settles what no agent will do: planned steps are skipped, and steps after a failure are blocked. */
export function settle(journey: Journey, state: RunState): RunState {
  const failed = state.steps.some((s) => s.status === "failed");
  const steps = state.steps.map((result, i) => {
    const step = journey.steps[i]!;
    if (result.status !== "pending") return result;
    if (step.planned) return { ...result, status: "skipped" as StepStatus, note: `Skipped: ${step.tool ?? step.id} is promised by another plugin and is not shipped yet.` };
    if (state.abortReason) return { ...result, status: "blocked" as StepStatus, note: "Not run: the run was aborted." };
    if (failed && !step.always) return { ...result, status: "blocked" as StepStatus, note: "Not run: an earlier step failed." };
    return result;
  });
  return { ...state, steps };
}

export function runFinished(journey: Journey, state: RunState): boolean {
  return runStatus(journey, state) !== "running";
}

export function runStatus(journey: Journey, state: RunState): RunStatus {
  const settled = settle(journey, state);
  if (state.abortReason) return "aborted";
  if (settled.steps.some((s) => s.status === "pending")) return "running";
  if (settled.steps.some((s) => s.status === "failed")) return "failed";
  return "passed";
}

export interface Facts {
  /** For an `issue` probe. */
  issue?: { id: string; status: string; title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null } | null;
  /** For an `approval-route` probe: who the approval reached. */
  assignedTo?: "reviewer" | "person" | "operator" | "nobody";
  /** Whether the company has the Reviewer on for outward work. */
  reviewOutward?: boolean;
  /** Screenshots the worker could not find on disk. */
  missingFiles?: string[];
}

export interface Report {
  /** What the agent said happened. */
  input?: unknown;
  output?: unknown;
  error?: string | null;
  evidence?: Evidence[];
  /** How many evidence items the agent sent that could not be read (no kind, or no ref): said in the failing check so the agent can fix its call. */
  evidenceIgnored?: number;
  skip?: string | null;
}

const OUTPUT_LIMIT = 600;

/** What a step returned, as the report keeps it: cut short, and with anything that looks like a secret blanked. */
export function outputText(output: unknown): string {
  const raw = typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output) ?? "";
  const text = redactSecrets(raw);
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT - 1)}…` : text;
}

/**
 * Records what the agent reported for the step it was given and decides the
 * step. Pure: the worker passes in what it looked up (`facts`). A step that
 * reports an error, misses an expectation, comes without the evidence it
 * lists, used something that is not the canary, or is skipped when it may not
 * be, fails. The run aborts when the input was not the canary's.
 */
export function recordStep(journey: Journey, state: RunState, stepId: string, report: Report, facts: Facts, at: string): { state: RunState; result: StepResult; aborted: boolean } {
  const index = journey.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new AcceptanceError(`This journey has no step ${stepId}.`);
  const step = journey.steps[index]!;
  const current = state.steps[index]!;
  if (current.status !== "pending") throw new AcceptanceError(`Step ${stepId} was already recorded (${current.status}).`);
  const expected = nextStep(journey, state);
  if (!expected || expected.step.id !== stepId) throw new AcceptanceError(`The next step is ${expected?.step.id ?? "none"}, not ${stepId}: take the steps in order.`);

  const checks: Check[] = [];
  const evidence = report.evidence ?? [];
  let status: StepStatus = "passed";
  let aborted = false;
  let captures = state.captures;

  if (report.skip) {
    if (step.optional || step.planned) status = "skipped";
    else {
      status = "failed";
      checks.push({ ok: false, detail: `Skipped (${report.skip}) but this step may not be skipped` });
    }
  } else {
    const guard = guardInput(report.input, state.clientRef);
    if (guard.length) {
      status = "failed";
      aborted = true;
      checks.push(...guard.map((detail) => ({ ok: false, detail: `Not the canary: ${detail}` })));
    } else if (inputRequired(step) && isEmptyInput(report.input)) {
      // Nothing was reported to check, which is not the same as nothing wrong: the step fails (the run is not aborted, nothing unsafe was shown).
      status = "failed";
      checks.push({ ok: false, detail: "No input was reported for this call, so the Cockpit cannot check it went to the canary client: record the input you actually used" });
    }
    if (report.error) {
      status = "failed";
      checks.push({ ok: false, detail: `The step reported an error: ${outputText(report.error)}` });
    } else if (!aborted) {
      // Expectations may name what the run captured (`equals: "{{client}}"`).
      for (const e of step.expect) checks.push(...checkExpectation(report.output, renderValue(e, state.captures) as Expectation, state.captures));
      if (step.probe) {
        if (step.probe.kind === "issue") {
          const issue = facts.issue;
          if (!issue) checks.push({ ok: false, detail: "The issue it named could not be found in this company" });
          else {
            checks.push({ ok: true, detail: `Issue ${issue.id} exists (${issue.status})` });
            if (step.probe.status) checks.push({ ok: step.probe.status.includes(issue.status), detail: `Issue is ${step.probe.status.join(" or ")}${step.probe.status.includes(issue.status) ? "" : `; it is ${issue.status}`}` });
            if (step.probe.matches) {
              const pattern = String(renderValue(step.probe.matches, state.captures));
              checks.push({ ok: new RegExp(pattern, "i").test(`${issue.title}\n${issue.description}`), detail: `Issue text matches ${pattern}` });
            }
          }
        } else {
          const to = facts.assignedTo ?? "nobody";
          checks.push({ ok: to !== "nobody", detail: to === "nobody" ? "The approval opened with nobody assigned (Q5-6: nobody would ever decide it)" : `The approval reached ${to === "reviewer" ? "the Reviewer" : to === "person" ? "a person" : "the Operator"}` });
          if (step.probe.outward && facts.reviewOutward) checks.push({ ok: to === "reviewer", detail: to === "reviewer" ? "Outward work went to the Reviewer first" : `Outward work went to ${to}, not the Reviewer first` });
        }
      }
      for (const kind of step.evidence ?? []) {
        if (kind === "output") continue;
        const have = evidence.some((ev) => ev.kind === kind);
        checks.push({ ok: have, detail: have ? `${kind} evidence attached` : `No ${kind} evidence attached${report.evidenceIgnored ? ` (${report.evidenceIgnored} item(s) you sent were ignored: each needs "kind" and "ref", the file path, command, link or text)` : ""}` });
      }
      for (const file of facts.missingFiles ?? []) checks.push({ ok: false, detail: `The screenshot ${file} was not found on disk (or is too small to be one)` });
      if (checks.some((c) => !c.ok)) status = "failed";
      else {
        // Capture only from a step that passed: a value read from a failed step is not trusted.
        captures = { ...state.captures };
        for (const [name, spec] of Object.entries(step.capture ?? {})) {
          const got = getPath(report.output, spec.path);
          if (!got.found || got.value === null || got.value === "") {
            status = "failed";
            checks.push({ ok: false, detail: `${spec.path} (needed later as ${name}) is missing from the result` });
          } else {
            const value = typeof got.value === "string" && spec.strip && got.value.startsWith(spec.strip) ? got.value.slice(spec.strip.length) : got.value;
            captures[name] = value;
          }
        }
      }
    }
  }
  const result: StepResult = { id: stepId, status, checks, input: storedInput(report.input), outputText: outputText(report.output), error: report.error ?? null, evidence, at, ...(report.skip ? { note: `Skipped: ${report.skip}` } : {}) };
  const steps = state.steps.map((s, i) => (i === index ? result : s));
  const next: RunState = { ...state, captures: status === "failed" ? state.captures : captures, steps, ...(aborted ? { abortReason: `Step ${stepId} used something that is not the canary client: ${checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}` } : {}) };
  return { state: settle(journey, next), result, aborted };
}

/** Ends a run early (a module that is off, a canary that cannot be created). It counts as not passed. */
export function abortRun(journey: Journey, state: RunState, reason: string): RunState {
  return settle(journey, { ...state, abortReason: reason.slice(0, 300) });
}

/** The same without the journey, for a run whose journey changed or is gone: every step still waiting is marked not run. */
export function abortState(state: RunState, reason: string): RunState {
  return { ...state, abortReason: reason.slice(0, 300), steps: state.steps.map((s) => (s.status === "pending" ? { ...s, status: "blocked" as StepStatus, note: "Not run: the run was aborted." } : s)) };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface FailurePlan {
  stepId: string;
  title: string;
  ownerRole: string;
  /** The issue text. */
  description: string;
  checks: Check[];
}

export function failurePlans(journey: Journey, state: RunState, ref: { runId: string; reportLink: string }): FailurePlan[] {
  const plans: FailurePlan[] = [];
  state.steps.forEach((result, i) => {
    if (result.status !== "failed") return;
    const step = journey.steps[i]!;
    const failed = result.checks.filter((c) => !c.ok);
    const lines = [
      `The acceptance journey **${journey.title}** (v${journey.version}) failed at step ${i + 1}, **${step.title}**${step.tool ? ` (\`${step.tool}\`)` : ""}.`,
      "",
      "What went wrong:",
      ...failed.map((c) => `- ${c.detail}`),
      "",
      result.outputText ? `What the step returned (cut short): \`${result.outputText.replace(/`/g, "'")}\`` : "It returned nothing.",
      "",
      `Report and evidence: ${ref.reportLink}. Run \`${ref.runId}\`, client \`${state.clientRef}\` (the canary: nothing real was touched).`,
      "",
      "Find the cause, fix it, then close this issue with what you changed. The next acceptance run (or an on-demand one) checks it again. If the journey itself is out of date (a renamed tool or field), say so and hand it to the Operator.",
    ];
    plans.push({ stepId: step.id, title: `Acceptance failure: ${journey.title}, ${step.title}`, ownerRole: step.ownerRole ?? journey.ownerRole, description: lines.join("\n"), checks: failed });
  });
  return plans;
}

const ICON: Record<StepStatus, string> = { passed: "pass", failed: "FAIL", skipped: "skipped", blocked: "not run", pending: "waiting" };

export interface ReportMeta {
  runId: string;
  trigger: Trigger;
  triggerRef: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Child issue links by step id. */
  children?: Record<string, string>;
}

export function reportMarkdown(journey: Journey, state: RunState, meta: ReportMeta): string {
  const settled = settle(journey, state);
  const status = runStatus(journey, state);
  const count = (s: StepStatus) => settled.steps.filter((r) => r.status === s).length;
  const head =
    status === "passed" ? "PASSED" : status === "failed" ? "FAILED" : status === "aborted" ? "ABORTED (not a pass)" : "IN PROGRESS";
  const lines = [
    `## Acceptance: ${journey.title} (v${journey.version}): ${head}`,
    "",
    `${count("passed")} of ${settled.steps.length} steps passed${count("failed") ? `, ${count("failed")} failed` : ""}${count("skipped") ? `, ${count("skipped")} skipped` : ""}${count("blocked") ? `, ${count("blocked")} not run` : ""}. Run \`${meta.runId}\`, ${meta.trigger}${meta.triggerRef ? ` (${meta.triggerRef})` : ""}, canary client \`${state.clientRef}\`, ${meta.startedAt.slice(0, 16).replace("T", " ")} UTC. Only the canary was touched.`,
  ];
  if (state.abortReason) lines.push("", `**Aborted:** ${state.abortReason}`);
  lines.push("", "| # | Step | Result | Checked |", "|---|---|---|---|");
  settled.steps.forEach((r, i) => {
    const step = journey.steps[i]!;
    const what = r.checks.length ? r.checks.map((c) => `${c.ok ? "ok" : "NOT"}: ${c.detail}`).join("; ") : r.note ?? "";
    lines.push(`| ${i + 1} | ${step.title} | ${ICON[r.status]} | ${what.replace(/\|/g, "/").slice(0, 400)} |`);
  });
  const failures = settled.steps.map((r, i) => ({ r, step: journey.steps[i]! })).filter(({ r }) => r.status === "failed");
  if (failures.length) {
    lines.push("", "### Failures");
    failures.forEach(({ r, step }) => {
      const link = meta.children?.[step.id];
      lines.push(`- **${step.title}** (owner: ${step.ownerRole ?? journey.ownerRole})${link ? `: ${link}` : ""}`, ...r.checks.filter((c) => !c.ok).map((c) => `  - ${c.detail}`));
    });
  }
  const evidence = settled.steps.flatMap((r, i) => r.evidence.map((e) => ({ step: journey.steps[i]!.title, e })));
  if (evidence.length) {
    lines.push("", "### Evidence");
    for (const { step, e } of evidence) lines.push(`- ${step}: ${e.kind}${e.kind === "screenshot" || e.kind === "link" ? ` ${redactSecrets(e.ref).slice(0, 200)}` : ""}${e.bytes ? ` (${e.bytes} bytes)` : ""}${e.note ? `, ${redactSecrets(e.note).slice(0, 200)}` : ""}`);
  }
  const skipped = settled.steps.map((r, i) => ({ r, step: journey.steps[i]! })).filter(({ r }) => r.status === "skipped");
  if (skipped.length) {
    lines.push("", "### Not covered", ...skipped.map(({ r, step }) => `- ${step.title}: ${r.note ?? "skipped"}`));
  }
  return lines.join("\n");
}

/** A one-line account of the run (the row in the list, the health check). */
export function runSummary(journey: Journey, state: RunState): string {
  const settled = settle(journey, state);
  const status = runStatus(journey, state);
  const failed = settled.steps.map((r, i) => ({ r, step: journey.steps[i]! })).filter(({ r }) => r.status === "failed");
  if (status === "passed") return `Passed: ${settled.steps.filter((r) => r.status === "passed").length} of ${settled.steps.length} steps.`;
  if (status === "aborted") return `Aborted: ${state.abortReason ?? "stopped early"}`;
  if (status === "failed") return `Failed at ${failed.map(({ step }) => step.title).join(", ")}.`;
  return "In progress.";
}
