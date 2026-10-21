/**
 * Growth Lab agent tools, built once for every channel plugin.
 *
 * `growthToolDeclarations` is what a manifest lists; `registerGrowthTools`
 * registers the same eight tools on the worker. Each tool takes a `scope`
 * (own, a client, a product or a book). The factory refuses a scope the host
 * does not run and hands the host's handler a params object it already reads:
 * `client` for own and client scopes, `scopeKey` for product and book. A scope
 * is never guessed: a malformed or unsupported one fails before any read or write.
 */
import type { JsonSchema, PluginContext, PluginToolDeclaration, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { GrowthError } from "./engine.js";
import { formatScopeKey, parseScopeKey, type ScopeKey } from "../growth-scope.js";
import { normalizeToolResult } from "../tool-result.js";
import { EXPERIMENT_STATUS_VALUES, type GrowthActor } from "./service.js";

export const GROWTH_TOOL_NAMES = [
  "performance-review",
  "get-playbook",
  "propose-playbook-change",
  "decide-playbook-change",
  "list-experiments",
  "propose-experiment",
  "approve-experiment",
  "reject-experiment",
] as const;
export type GrowthToolName = (typeof GROWTH_TOOL_NAMES)[number];

export const GROWTH_SCOPE_KINDS = ["own", "client", "product", "book"] as const;
export type GrowthScopeKind = (typeof GROWTH_SCOPE_KINDS)[number];

export const MAX_PARAM_DESCRIPTION = 200;

const text = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const choice = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const schema = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", required, properties, additionalProperties: false });

const SCOPE_HELP = 'Whose work: "own", "client:company:<id>", "client:contact:<id>", "product:<projectId>" or "book:<projectId>". Omit for own work.';

const ARMS: JsonSchema = {
  type: "array",
  description: 'Exactly two arms: [{"key":"control","description":"what we do now"},{"key":"variant","description":"the one change"}].',
  items: {
    type: "object",
    required: ["key", "description"],
    additionalProperties: false,
    properties: {
      key: choice(["control", "variant"], "control (what we do now) or variant (the change)"),
      description: text("What the work in this arm does, in one line"),
    },
  },
};

export interface GrowthDeclarationOptions {
  /** Scope kinds the plugin runs (default own + client). The schema text lists them. */
  kinds?: readonly GrowthScopeKind[];
  /** Also take `client`, `clientKind` and `clientRef` (Social's older scope params). Default true. */
  legacyClientParams?: boolean;
  /** Replace a tool's description (channel wording such as "posts"). */
  descriptions?: Partial<Record<GrowthToolName, string>>;
}

export function growthToolDeclarations(options: GrowthDeclarationOptions = {}): PluginToolDeclaration[] {
  const kinds = options.kinds ?? ["own", "client"];
  const scopeHelp = kinds.length === GROWTH_SCOPE_KINDS.length ? SCOPE_HELP : `${SCOPE_HELP} Supported here: ${kinds.join(", ")}.`;
  const scope: Record<string, JsonSchema> = { scope: text(scopeHelp) };
  if (options.legacyClientParams !== false) {
    scope.client = text('Same as scope for a client: "company:<id>" or "contact:<id>" (from list-clients). Omit for own work. Do not pass with scope.');
    scope.clientKind = choice(["company", "contact"], "With clientRef: the kind of CRM record (default company). Prefer scope.");
    scope.clientRef = text("CRM company or contact id, with clientKind. Prefer scope.");
  }
  const OWN = " Omit scope for PiB's own work. Never mix scopes.";
  const d = (name: GrowthToolName, fallback: string) => options.descriptions?.[name] ?? fallback;
  return [
    {
      name: "performance-review",
      displayName: "Performance review",
      description: d("performance-review", `Growth Lab review of one scope: top and bottom work by 7-day lift, median lift per feature value, running and proposed experiments, pending playbook changes, hypothesis types ranked by UCB.${OWN}`),
      parametersSchema: schema([], { ...scope, periodDays: int("Days to review, 7–90 (default 28)") }),
    },
    {
      name: "get-playbook",
      displayName: "Get playbook",
      description: d("get-playbook", `The scope's playbook (markdown rules to follow when planning), its version, recent versions and pending changes. Created on first use.${OWN}`),
      parametersSchema: schema([], { ...scope }),
    },
    {
      name: "propose-playbook-change",
      displayName: "Propose playbook change",
      description: d("propose-playbook-change", `Propose one playbook edit with a reason: op add (a line in a section), remove (the exact line) or replace (the whole markdown). A person keeps or discards it unless autopilot is full.${OWN}`),
      parametersSchema: schema(["reason"], {
        ...scope,
        op: choice(["add", "remove", "replace"], "add (default) a line, remove an exact line, or replace the whole playbook"),
        section: choice(["rules", "avoid", "open", "constraints", "goal"], "For add: rules we follow, things to avoid, open questions, constraints (brand voice, links, banned words) or the goal"),
        text: text("add: the rule, one line; remove: the exact line from get-playbook"),
        playbook: text("replace: the whole new playbook markdown"),
        reason: text("Why, with the evidence (ids, measured lift)"),
      }),
    },
    {
      name: "decide-playbook-change",
      displayName: "Decide playbook change",
      description: d("decide-playbook-change", "Keep (new playbook version) or discard a pending playbook change. Agents may only decide when the program's autopilot is full; otherwise a person decides on the Growth tab."),
      parametersSchema: schema(["changeId", "decision"], {
        changeId: text("Pending change id (from get-playbook)"),
        decision: choice(["keep", "discard"], "keep writes a new playbook version; discard drops the change"),
        note: text("Why (shown with the decision)"),
      }),
    },
    {
      name: "list-experiments",
      displayName: "List experiments",
      description: d("list-experiments", `Growth Lab experiments of one scope with arms, counts per arm, verdicts and the scoreboard.${OWN}`),
      parametersSchema: schema([], {
        ...scope,
        status: { type: "array", items: { type: "string", enum: [...EXPERIMENT_STATUS_VALUES] }, description: "Only experiments in these statuses (default all)" },
      }),
    },
    {
      name: "propose-experiment",
      displayName: "Propose experiment",
      description: d("propose-experiment", `Propose one experiment that changes one variable. At most 3 running and 3 proposed per scope. Safe autopilot: a person approves it; full: it starts at once.${OWN}`),
      parametersSchema: schema(["hypothesis", "hypothesisType", "variable", "arms"], {
        ...scope,
        hypothesis: text("What you expect and why, one sentence"),
        hypothesisType: text("feature:value being tested, e.g. hook:question (pick from performance-review's ranked types)"),
        variable: text("The one thing the variant changes"),
        arms: ARMS,
        minPerArm: int("Items needed per arm before measuring, 2–20 (default 3)"),
        windowDays: int("Scoring window in days; only 7 is supported (the default)"),
      }),
    },
    {
      name: "approve-experiment",
      displayName: "Approve experiment",
      description: d("approve-experiment", "Start a proposed experiment. Only on full autopilot may an agent approve; otherwise a person approves on the Growth tab."),
      parametersSchema: schema(["experimentId"], { experimentId: text("Proposed experiment id (from list-experiments)"), note: text("Why (shown with the decision)") }),
    },
    {
      name: "reject-experiment",
      displayName: "Reject experiment",
      description: d("reject-experiment", "Reject a proposed experiment with a reason (its tags are cleared). Only on full autopilot may an agent reject."),
      parametersSchema: schema(["experimentId", "reason"], { experimentId: text("Proposed experiment id (from list-experiments)"), reason: text("Why it is rejected") }),
    },
  ];
}

const LEGACY_KEYS = ["client", "clientKind", "clientRef"] as const;

/**
 * Turns `scope` into the params the host's handlers read. Without `scope` the
 * params pass through (the older `client` form, or own work). Never defaults a
 * scope the caller named but the host does not run.
 */
export function resolveGrowthScopeParams(params: Record<string, unknown>, kinds: readonly GrowthScopeKind[] = ["own", "client"]): Record<string, unknown> {
  const { scope: raw, ...rest } = params;
  if (raw === undefined || raw === null || raw === "") return params;
  if (typeof raw !== "string") throw new GrowthError('scope must be text such as "own" or "client:company:<id>"');
  if (LEGACY_KEYS.some((key) => rest[key] !== undefined && rest[key] !== null && rest[key] !== "")) {
    throw new GrowthError("Pass scope or client, not both");
  }
  let key: ScopeKey;
  try {
    key = parseScopeKey(raw.trim());
  } catch {
    throw new GrowthError(`scope "${raw}" is not valid. Use own, client:company:<id>, client:contact:<id>, product:<projectId> or book:<projectId>`);
  }
  if (!kinds.includes(key.type)) throw new GrowthError(`This plugin does not run ${key.type} scopes (it runs: ${kinds.join(", ")})`);
  for (const k of LEGACY_KEYS) delete rest[k];
  if (key.type === "own") return { ...rest, client: null };
  if (key.type === "client") return { ...rest, client: `${key.kind}:${key.ref}` };
  return { ...rest, scopeKey: formatScopeKey(key) };
}

export type GrowthToolHandler<A extends GrowthActor = GrowthActor> = (actor: A, params: Record<string, unknown>) => Promise<unknown>;

export interface GrowthToolsHost<A extends GrowthActor = GrowthActor> extends GrowthDeclarationOptions {
  /** The caller for this run. Throw to refuse (a module switched off, an unknown company). */
  actor(run: ToolRunContext): Promise<A>;
  /** One handler per tool; they read `client` (or `scopeKey`) from the params. */
  handlers: Record<GrowthToolName, GrowthToolHandler<A>>;
  /** Result text from the data (default: the data as JSON, cut at 24,000 characters). */
  content?(name: GrowthToolName, data: unknown): string;
}

const objectParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

function defaultContent(data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? "null";
  return json.length > 24_000 ? `${json.slice(0, 24_000)}\n… (truncated; narrow the request)` : json;
}

export async function runGrowthTool<A extends GrowthActor>(host: GrowthToolsHost<A>, name: GrowthToolName, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const resolved = resolveGrowthScopeParams(objectParams(params), host.kinds);
    const actor = await host.actor(run);
    const data = await host.handlers[name](actor, resolved);
    return { content: host.content?.(name, data) ?? defaultContent(data), data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Growth tool failed" };
  }
}

/** Registers the eight tools. The manifest lists `growthToolDeclarations` with the same options. */
export function registerGrowthTools<A extends GrowthActor>(ctx: PluginContext, host: GrowthToolsHost<A>): void {
  for (const declaration of growthToolDeclarations(host)) {
    const name = declaration.name as GrowthToolName;
    ctx.tools.register(name, declaration, async (params, run) => normalizeToolResult(await runGrowthTool(host, name, params, run)));
  }
}
