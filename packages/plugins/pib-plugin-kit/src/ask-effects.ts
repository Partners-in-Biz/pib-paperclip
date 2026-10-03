/**
 * Asks that do something when they are answered (RC5: an answer was not an effect).
 *
 * The gap. The Operator's mailbox delegation ("grant read and draft on the
 * mailbox") was asked five times in five days. The owner answered each time,
 * nothing created the delegation, the Operator re-checked, re-blocked and spent
 * tokens, and four inbound-reply issues waited behind it. An answer was free
 * text on an issue; no code turned it into a grant.
 *
 * The loop, in events (a plugin cannot call another plugin, and the Cockpit owns
 * asks while the Mailbox owns delegations):
 *
 *   agent asks (`ask-owner`, with `effect: { key, params }`)
 *     -> owner answers on the issue
 *     -> Cockpit emits `ask.answered` (`emitAskAnswered`)
 *     -> the plugin that registered the effect key (`registerAskEffect` +
 *        `installAskEffects`) applies it, VERIFIES it by reading the real state
 *        back, and emits `ask.effect.result`
 *     -> Cockpit (`registerAskEffectResults`) posts `askEffectComment` on the
 *        blocked issue, saying what was applied, and wakes the agent
 *
 * Both sides are idempotent: a re-delivered `ask.answered` returns the stored
 * result and re-sends it, so the Cockpit re-announces an answered ask until the
 * result arrives (events are at-most-once). The Cockpit must not wake the agent
 * before the result (or a timeout), or the agent finds the grant still missing.
 *
 * Two safety rules, because an effect can be a permission grant and its key and
 * params are chosen by the AGENT that asked, not by the owner:
 *
 * 1. An effect runs only for an answer a person gave. `answeredByUserId` must be
 *    a real user (not empty, not the board sentinel, not the asking agent);
 *    otherwise the result is `refused` and the handler is never called. The
 *    Cockpit must emit only for a reply by the owner (or another company
 *    member), never for the agent's own comment, and must show the effect (key
 *    and params, see `describeAskEffect`) on the card the owner answers.
 * 2. The handler must not trust the params: whitelist and re-validate them in
 *    `validate` (`checkEffectParams`): the account belongs to this company, the
 *    scope is in an allowed list, the target agent is in this company. A refused
 *    validation applies nothing.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { COCKPIT_PLUGIN, assignableUserId } from "./cockpit.js";
import { PIB_PLUGINS } from "./contracts.js";

export const ASK_EVENTS = {
  /** Cockpit -> plugins. Payload: `AskAnswered`. */
  answered: "ask.answered",
  /** Plugin -> Cockpit. Payload: `AskEffectResult`. */
  effectResult: "ask.effect.result",
} as const;

/** Plugins that may register effects (the Cockpit listens to each for results). */
export const ASK_EFFECT_PLUGINS: string[] = [PIB_PLUGINS.mailbox, PIB_PLUGINS.crm, PIB_PLUGINS.social, PIB_PLUGINS.seo, PIB_PLUGINS.billing, PIB_PLUGINS.accounting, PIB_PLUGINS.campaigns, PIB_PLUGINS.payroll, PIB_PLUGINS.partners, PIB_PLUGINS.setup];

/** What an ask asks the system to do once the owner says yes. Plain data, so it survives JSON. */
export interface AskEffectSpec {
  /** The registered effect, `<plugin>.<action>` by convention, e.g. `mailbox.delegate`. */
  key: string;
  params?: Record<string, string | number | boolean | null>;
}

export interface AskAnswered {
  /** At-most-once key for this answer: `ask:<askId>:<answer stamp>`. */
  key: string;
  askId: string;
  issueId: string;
  issueIdentifier?: string | null;
  /** The ask card's kind (decision, grant, money, legal, info). */
  kind: string;
  effect: AskEffectSpec;
  question: string;
  options: string[];
  /** The owner's reply, as written. */
  answer: string;
  /** The person who answered. Required: an effect never runs for an answer nobody gave (see rule 1 above). */
  answeredByUserId: string;
  answeredAt: string;
  /** The agent to wake with the outcome. */
  returnAgentId?: string | null;
}

export type AskDecision = "approve" | "decline" | "unclear";

/** `refused`: the effect was not run because the answer or its params did not pass a safety check (no person behind it, params not allowed). */
export type AskEffectStatus = "applied" | "already_applied" | "declined" | "unclear" | "failed" | "refused";

export interface AskEffectResult {
  /** The `AskAnswered` key. */
  key: string;
  askId: string;
  effectKey: string;
  /** The plugin that answered. */
  plugin: string;
  status: AskEffectStatus;
  /** One line saying what was applied, or why not; goes into the issue comment. */
  detail: string;
  /** The effect was read back and is really in place. */
  verified: boolean;
  at: string;
}

export interface AskEffectInput {
  ctx: PluginContext;
  companyId: string;
  ask: AskAnswered;
  decision: AskDecision;
  /** Which option the owner picked when the answer matches one (0 = the first, the recommended one). */
  optionIndex: number | null;
}

export interface AskEffectHandler {
  /**
   * Re-validates the agent-supplied params against this company before anything
   * is done (`checkEffectParams` helps). Return null to go ahead, or one line
   * saying why not: the effect is then `refused`, `apply` is not called and
   * nothing is stored, so a corrected ask runs fresh.
   */
  validate?(input: AskEffectInput): Promise<string | null> | string | null;
  /** Does it. Return one line saying what was done. Throw to report a failure. */
  apply(input: AskEffectInput): Promise<{ detail: string }>;
  /** Reads the real state back; true when the effect is in place. A false is reported as a failure, not as applied. */
  verify?(input: AskEffectInput): Promise<boolean | { ok: boolean; detail?: string }>;
  /** Decisions the effect runs for. Default: approve only. */
  runOn?: AskDecision[];
}

// ---------------------------------------------------------------------------
// Reading the owner's answer
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

const NEGATIVE_START = /^(no|nope|nah|don'?t|do not|never|reject|rejected|decline|declined|cancel|cancelled|deny|denied|stop|skip|not now|leave it)\b/;
/** "No problem" opens a yes ("no problem, go ahead"), not a no. */
const REASSURANCE = /^(no problem|no worries|no issue|not a problem)\b[ ,]*/;
/** A yes that adds something ("yes, and send too") is a different, wider answer than the ask: ask again. */
const WIDENING = /\b(also|too|as well|plus|additionally|in addition|everything|anything else|all of it|and then)\b/;
const POSITIVE_START = /^(yes|y|yep|yeah|yup|ok|okay|approve|approved|grant|granted|go ahead|do it|sure|please do|confirmed|confirm|agree|agreed|accept|accepted|done|go for it|sounds good|that works|fine)\b/;
const NEGATION_ANYWHERE = /\b(not|never|don'?t|do not|except|only|but|without|instead)\b/;
const ORDINALS: Array<[RegExp, number]> = [
  [/^(option |choice )?(1|one|first|a)$/, 0],
  [/^(option |choice )?(2|two|second|b)$/, 1],
  [/^(option |choice )?(3|three|third|c)$/, 2],
  [/^(option |choice )?(4|four|fourth|d)$/, 3],
  [/^(option |choice )?(5|five|fifth|e)$/, 4],
];

/**
 * Reads an owner's reply against the ask's options (the recommendation is
 * first, by the asking rule). Approve means "do the effect": the first option,
 * a plain yes, or a reply that names the recommended option. Decline is a plain
 * no. Anything with a condition ("yes but only read"), an add-on ("yes, and
 * send too"), or a different option, is unclear and applies nothing: a
 * half-understood grant is worse than a second question. English only.
 */
export function classifyAskAnswer(answer: string, options: string[] = []): { decision: AskDecision; optionIndex: number | null } {
  const text = normalize(answer);
  if (!text) return { decision: "unclear", optionIndex: null };
  const normalizedOptions = options.map(normalize);
  let optionIndex: number | null = null;
  const ordinal = ORDINALS.find(([pattern]) => pattern.test(text));
  if (ordinal && ordinal[1] < options.length) optionIndex = ordinal[1];
  if (optionIndex === null) {
    const exact = normalizedOptions.findIndex((option) => option && option === text);
    const contained = exact >= 0 ? exact : normalizedOptions.findIndex((option) => option.length >= 6 && text.includes(option));
    if (contained >= 0) optionIndex = contained;
  }
  if (optionIndex !== null) {
    // The first option is the recommended one the effect applies; a later option that itself says no declines; any other is a different choice.
    const decision: AskDecision = optionIndex === 0 ? "approve" : NEGATIVE_START.test(normalizedOptions[optionIndex] ?? "") ? "decline" : "unclear";
    return { decision, optionIndex };
  }
  const reassured = REASSURANCE.test(text);
  const body = reassured ? text.replace(REASSURANCE, "").trim() : text;
  if (!reassured && NEGATIVE_START.test(text)) return { decision: "decline", optionIndex: null };
  const positive = reassured ? body === "" || POSITIVE_START.test(body) : POSITIVE_START.test(text);
  if (positive && !NEGATION_ANYWHERE.test(body) && !WIDENING.test(body)) return { decision: "approve", optionIndex: null };
  return { decision: "unclear", optionIndex: null };
}

// ---------------------------------------------------------------------------
// Params are agent-supplied: check them, show them
// ---------------------------------------------------------------------------

export interface EffectParamRule {
  required?: boolean;
  type?: "string" | "number" | "boolean";
  /** Only these values (exact match). */
  oneOf?: ReadonlyArray<string | number | boolean>;
  /** A string value must match. */
  pattern?: RegExp;
  maxLength?: number;
}

/**
 * Whitelists an effect's params. Every key must have a rule (an unknown key is
 * a problem, so an agent cannot smuggle a wider scope in), required keys must
 * be present, and each value must have the right type and be in `oneOf` /
 * match `pattern`. Returns the checked params, or the problems in plain words.
 * Checking that an id belongs to this company is still the handler's job (it
 * has the host calls); do it in `validate`.
 */
export function checkEffectParams(
  params: AskEffectSpec["params"] | undefined,
  rules: Record<string, EffectParamRule>,
): { ok: true; params: Record<string, string | number | boolean | null> } | { ok: false; problems: string[] } {
  const given = params ?? {};
  const problems: string[] = [];
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(given)) {
    if (!(key in rules)) problems.push(`"${key}" is not a parameter this effect accepts`);
  }
  for (const [key, rule] of Object.entries(rules)) {
    const value = given[key];
    if (value === undefined || value === null || value === "") {
      if (rule.required) problems.push(`"${key}" is required`);
      continue;
    }
    if (rule.type && typeof value !== rule.type) problems.push(`"${key}" must be a ${rule.type}`);
    else if (rule.oneOf && !rule.oneOf.includes(value)) problems.push(`"${key}" must be one of ${rule.oneOf.join(", ")}`);
    else if (rule.pattern && (typeof value !== "string" || !rule.pattern.test(value))) problems.push(`"${key}" is not in the expected form`);
    else if (rule.maxLength && typeof value === "string" && value.length > rule.maxLength) problems.push(`"${key}" is too long`);
    else out[key] = value;
  }
  return problems.length ? { ok: false, problems } : { ok: true, params: out };
}

/**
 * One line saying exactly what an ask will do when it is answered
 * ("Runs mailbox.delegate with accountId=acc-1, agentId=op, scope=read+draft"),
 * for the Cockpit to print on the card the owner answers: the owner approves
 * the effect, not just the sentence the agent wrote.
 */
export function describeAskEffect(effect: AskEffectSpec): string {
  const params = Object.entries(effect.params ?? {}).map(([key, value]) => `${key}=${String(value).slice(0, 80)}`);
  return `Runs ${effect.key}${params.length ? ` with ${params.join(", ")}` : ""} when you say yes.`;
}

// ---------------------------------------------------------------------------
// The plugin side
// ---------------------------------------------------------------------------

const effects = new Map<string, AskEffectHandler>();

/**
 * Registers what an effect key does (call at module load or in `setup`). `key`
 * is the effect's name (`mailbox.delegate`); a handler may be just the `apply`
 * function. A key registered twice keeps the last one.
 */
export function registerAskEffect(key: string, handler: AskEffectHandler | AskEffectHandler["apply"]): void {
  effects.set(key, typeof handler === "function" ? { apply: handler } : handler);
}

/** The effect keys this worker handles. */
export function askEffectKeys(): string[] {
  return [...effects.keys()];
}

/** Forgets every registered effect (tests). */
export function clearAskEffects(): void {
  effects.clear();
}

const effectState = (companyId: string, askKey: string, effectKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-kit", stateKey: `ask-effect:${askKey}:${effectKey}` });

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

/** The plugin this worker is (for the result), from its manifest. */
function ownPluginKey(ctx: PluginContext): string {
  try {
    return (ctx as { manifest?: { id?: string } }).manifest?.id ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Runs the registered effect for an answered ask. Returns null when this
 * plugin has no handler for the key (another plugin's effect). Idempotent per
 * answer: a result already stored is returned again (`already_applied` for an
 * applied one) without running the handler twice. Never throws.
 */
export async function runAskEffect(ctx: PluginContext, companyId: string, ask: AskAnswered, now: Date = new Date()): Promise<AskEffectResult | null> {
  const handler = effects.get(ask.effect?.key ?? "");
  if (!handler || !ask.effect?.key) return null;
  const plugin = ownPluginKey(ctx);
  const base = { key: ask.key, askId: ask.askId, effectKey: ask.effect.key, plugin, at: now.toISOString() };
  // Rule 1: an effect needs a person's answer. Checked before the stored result so nothing replays for a bad answer, and never stored.
  const answerer = assignableUserId(ask.answeredByUserId);
  if (!answerer || answerer === (ask.returnAgentId ?? "")) {
    return { ...base, status: "refused", detail: "Nothing was changed: this answer has no person behind it (an effect runs only for an answer the owner or another member gave).", verified: false };
  }
  const stateKey = effectState(companyId, ask.key, ask.effect.key);
  try {
    const stored = (await ctx.state.get(stateKey)) as AskEffectResult | null;
    if (stored && (stored.status === "applied" || stored.status === "declined")) return { ...stored, status: stored.status === "applied" ? "already_applied" : "declined" };
  } catch {
    // no memo: run it (the handler must be idempotent anyway)
  }
  const { decision, optionIndex } = classifyAskAnswer(ask.answer, ask.options);
  const input: AskEffectInput = { ctx, companyId, ask, decision, optionIndex };
  if (!(handler.runOn ?? ["approve"]).includes(decision)) {
    const result: AskEffectResult = decision === "decline"
      ? { ...base, status: "declined", detail: "The owner declined, so nothing was changed.", verified: true }
      : { ...base, status: "unclear", detail: "The answer was not a clear yes or no to the first option, so nothing was changed. Ask again with options the owner can pick by number.", verified: false };
    if (decision === "decline") await ctx.state.set(stateKey, result).catch(() => undefined);
    return result;
  }
  if (handler.validate) {
    let refusal: string | null;
    try {
      refusal = await handler.validate(input);
    } catch (error) {
      refusal = `the parameters could not be checked (${errorText(error)})`;
    }
    if (refusal) return { ...base, status: "refused", detail: `Nothing was changed: ${refusal}.`.replace(/\.\.$/, "."), verified: false };
  }
  try {
    const applied = await handler.apply(input);
    let verified = true;
    let detail = applied.detail;
    if (handler.verify) {
      const check = await handler.verify(input);
      const ok = typeof check === "boolean" ? check : check.ok;
      if (!ok) {
        const why = typeof check === "object" && check.detail ? `: ${check.detail}` : "";
        return { ...base, status: "failed", detail: `Applied, but reading it back did not confirm it${why}. It is not counted as done.`, verified: false };
      }
      if (typeof check === "object" && check.detail) detail = `${detail} (${check.detail})`;
      verified = true;
    }
    const result: AskEffectResult = { ...base, status: "applied", detail, verified };
    await ctx.state.set(stateKey, result).catch(() => undefined);
    return result;
  } catch (error) {
    ctx.logger.info("Ask effect failed", { effectKey: ask.effect.key, askId: ask.askId, error: errorText(error) });
    return { ...base, status: "failed", detail: `Could not apply it: ${errorText(error)}`, verified: false };
  }
}

/** The payload as an `AskAnswered`, or null when it is malformed or has no person who answered. */
export function asAnswered(payload: unknown): AskAnswered | null {
  const value = payload && typeof payload === "object" ? (payload as Partial<AskAnswered>) : null;
  if (!value || typeof value.key !== "string" || typeof value.askId !== "string" || typeof value.answer !== "string") return null;
  if (!value.effect || typeof value.effect.key !== "string" || !value.effect.key) return null;
  if (typeof value.answeredByUserId !== "string" || !value.answeredByUserId.trim()) return null;
  return {
    key: value.key,
    askId: value.askId,
    issueId: String(value.issueId ?? ""),
    issueIdentifier: typeof value.issueIdentifier === "string" ? value.issueIdentifier : null,
    kind: String(value.kind ?? "decision"),
    effect: { key: value.effect.key, ...(value.effect.params ? { params: value.effect.params } : {}) },
    question: String(value.question ?? ""),
    options: Array.isArray(value.options) ? value.options.filter((o): o is string => typeof o === "string") : [],
    answer: value.answer,
    answeredByUserId: value.answeredByUserId.trim(),
    answeredAt: typeof value.answeredAt === "string" ? value.answeredAt : new Date().toISOString(),
    returnAgentId: typeof value.returnAgentId === "string" ? value.returnAgentId : null,
  };
}

/**
 * An `ask.answered` for one of this plugin's effects that names nobody who
 * answered is answered with a `refused` result (so the Cockpit stops
 * re-announcing it), and the handler is never called. Payloads for other
 * plugins' effects, or too malformed to know the ask, are ignored.
 */
async function refuseUnattributed(ctx: PluginContext, companyId: string, payload: unknown): Promise<void> {
  const value = payload && typeof payload === "object" ? (payload as Partial<AskAnswered>) : null;
  const effectKey = value?.effect?.key;
  if (!value || typeof value.key !== "string" || typeof value.askId !== "string" || typeof effectKey !== "string" || !effects.has(effectKey)) return;
  const result: AskEffectResult = {
    key: value.key,
    askId: value.askId,
    effectKey,
    plugin: ownPluginKey(ctx),
    status: "refused",
    detail: "Nothing was changed: this answer has no person behind it (an effect runs only for an answer the owner or another member gave).",
    verified: false,
    at: new Date().toISOString(),
  };
  try {
    await ctx.events.emit(ASK_EVENTS.effectResult, companyId, result as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Ask effect refusal not sent", { askId: value.askId, error: errorText(error) });
  }
}

/**
 * Subscribes this plugin to answered asks (call once in `setup`, after the
 * `registerAskEffect` calls). Runs the matching effect and emits the result.
 */
export function installAskEffects(ctx: PluginContext): void {
  ctx.events.on(`plugin.${COCKPIT_PLUGIN}.${ASK_EVENTS.answered}`, async (event: PluginEvent) => {
    const companyId = event.companyId;
    const ask = asAnswered(event.payload);
    if (!companyId) return;
    if (!ask) {
      await refuseUnattributed(ctx, companyId, event.payload);
      return;
    }
    try {
      const result = await runAskEffect(ctx, companyId, ask);
      if (result) await ctx.events.emit(ASK_EVENTS.effectResult, companyId, result as unknown as Record<string, unknown>);
    } catch (error) {
      ctx.logger.info("Ask effect result not sent", { askId: ask.askId, error: errorText(error) });
    }
  });
}

// ---------------------------------------------------------------------------
// The Cockpit side
// ---------------------------------------------------------------------------

/** The at-most-once key for one answer. Changing the answer makes a new key, so a corrected answer runs again. */
export function askAnsweredKey(askId: string, answeredAt: string): string {
  return `ask:${askId}:${answeredAt}`;
}

/** Cockpit: announce an answered ask that carries an effect. Re-send it until a result comes back. */
export async function emitAskAnswered(ctx: PluginContext, companyId: string, ask: AskAnswered): Promise<void> {
  await ctx.events.emit(ASK_EVENTS.answered, companyId, ask as unknown as Record<string, unknown>);
}

/** Cockpit: handle the results plugins send back (call once in `setup`). */
export function registerAskEffectResults(ctx: PluginContext, onResult: (companyId: string, result: AskEffectResult) => Promise<void>): void {
  for (const plugin of ASK_EFFECT_PLUGINS) {
    ctx.events.on(`plugin.${plugin}.${ASK_EVENTS.effectResult}` as `plugin.${string}`, async (event: PluginEvent) => {
      const result = event.payload as Partial<AskEffectResult> | undefined;
      if (!event.companyId || !result || typeof result.key !== "string" || typeof result.status !== "string") return;
      try {
        await onResult(event.companyId, result as AskEffectResult);
      } catch (error) {
        ctx.logger.info("Ask effect result handling failed", { askId: result.askId, error: errorText(error) });
      }
    });
  }
}

/**
 * The comment the Cockpit puts on the blocked issue before it wakes the agent:
 * what was applied (verified), or why nothing was.
 */
export function askEffectComment(result: AskEffectResult): string {
  if (result.status === "applied" || result.status === "already_applied") {
    return `**Applied${result.verified ? " and checked" : ""}:** ${result.detail}\n\nYou can carry on; nothing more is needed from the owner for this.`;
  }
  if (result.status === "declined") return `**Not applied:** ${result.detail}\n\nWork on the parts that do not need it, or propose another way.`;
  if (result.status === "unclear") return `**Not applied:** ${result.detail}`;
  if (result.status === "refused") return `**Not applied:** ${result.detail}\n\nIf you still need it, ask again with \`ask-owner\`, naming exactly what you need.`;
  return `**Could not apply it:** ${result.detail}\n\nDo not ask again: a person has to look at why it failed.`;
}
