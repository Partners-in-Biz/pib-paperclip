/**
 * Asking the owner (tool `ask-owner`): the pure parts shared by the worker
 * and the Cockpit page. No node imports.
 *
 * An agent asks once per issue: the question, options with its
 * recommendation first, why it matters, and links plus steps for anything
 * the owner must do. The issue goes to the owner (`in_review`, which in
 * Paperclip means "waiting on a person"), the ask shows first in "Waiting on
 * you" and in the daily brief, and the owner's reply on the issue hands it
 * back to the agent and wakes it.
 */
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { ASK_OWNER_COMMENT_MARK } from "@partnersinbiz/pib-plugin-kit/asking";
import type { WaitingItem } from "@partnersinbiz/pib-plugin-kit/cockpit";
import type { WaitingAskInfo } from "./merge.js";

export const ASK_KINDS = ["decision", "grant", "money", "legal", "info"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const ASK_LIMITS = {
  question: 600,
  why: 300,
  options: 5,
  optionChars: 200,
  links: 6,
  linkLabel: 80,
  linkHref: 500,
  steps: 8,
  stepChars: 300,
  /** Stored answer (the reply comment), and the part put in the wake reason. */
  answerChars: 2000,
  wakeAnswerChars: 300,
} as const;

/** An open ask older than this is a health warning. */
export const ASK_STALE_DAYS = 3;

export const ASK_KIND_LABEL: Record<AskKind, string> = {
  decision: "Decision",
  grant: "One-time grant",
  money: "Money",
  legal: "Legal",
  info: "Information",
};

/** How an ask sorts and groups among the other waiting items. */
export const ASK_WAITING_KIND: Record<AskKind, WaitingItem["kind"]> = {
  money: "money",
  legal: "legal",
  grant: "grant",
  decision: "judgement",
  info: "other",
};

/** Money and legal questions are red on the page; every other question is amber. */
export function askTone(kind: AskKind): "bad" | "warn" {
  return kind === "money" || kind === "legal" ? "bad" : "warn";
}

export function isAskKind(value: unknown): value is AskKind {
  return typeof value === "string" && (ASK_KINDS as readonly string[]).includes(value);
}

export interface AskLink {
  label: string;
  href: string;
}

/** What the system does once the owner says yes to the first option (kit `registerAskEffect`). Plain data. */
export interface AskEffect {
  key: string;
  params?: Record<string, string | number | boolean | null>;
}

/** `<plugin>.<action>`, a plugin the Cockpit knows. A plugin that does not handle the key answers nothing, so the ask times out and says so. */
export const EFFECT_KEY = /^(mailbox|crm|social|seo|billing|accounting|campaigns|payroll|partners|setup|cockpit)\.[a-z][a-z0-9-]{1,40}$/;

/**
 * Effects only the Cockpit's own questions may carry. An agent could otherwise
 * ask the owner a leading question and have a yes confirm an outside fact
 * (that sign-up is closed) or adopt goals the owner never read.
 * `cockpit.attest` is reserved: nothing handles it today, and it stays closed
 * to agents should it ever be registered.
 */
export const INTERNAL_EFFECTS: ReadonlySet<string> = new Set(["cockpit.activate-goals", "cockpit.attest"]);

/** The one line the card shows, worded exactly like kit `describeAskEffect` (a test keeps them equal; the page cannot import the kit index). */
export function describeEffect(effect: AskEffect): string {
  const params = Object.entries(effect.params ?? {}).map(([key, value]) => `${key}=${String(value).slice(0, 80)}`);
  return `Runs ${effect.key}${params.length ? ` with ${params.join(", ")}` : ""} when you say yes.`;
}

function parseEffect(value: unknown): AskEffect | null {
  if (value === undefined || value === null || value === "") return null;
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const key = typeof record?.key === "string" ? record.key.trim() : "";
  if (!record || !EFFECT_KEY.test(key)) throw new AskError('effect must be {key, params}: key is "<plugin>.<action>" (for example mailbox.delegate), the name a skill or the Setup checklist gives for what a yes should do.');
  const params: Record<string, string | number | boolean | null> = {};
  if (record.params !== undefined && record.params !== null) {
    if (typeof record.params !== "object" || Array.isArray(record.params)) throw new AskError("effect.params must be an object of plain values (text, number, true/false).");
    const entries = Object.entries(record.params as Record<string, unknown>);
    if (entries.length > 8) throw new AskError("effect.params: at most 8 values.");
    for (const [name, raw] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(name)) throw new AskError(`effect.params: "${name}" is not a valid name.`);
      if (raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new AskError(`effect.params.${name} must be text, a number or true/false.`);
      if (typeof raw === "string" && raw.length > 300) throw new AskError(`effect.params.${name} is at most 300 characters.`);
      params[name] = raw as string | number | boolean | null;
    }
  }
  return { key, ...(Object.keys(params).length ? { params } : {}) };
}

export interface AskInput {
  issueId: string;
  question: string;
  options: string[];
  why: string;
  kind: AskKind;
  links: AskLink[];
  steps: string[];
  client: string | null;
  dueBy: string | null;
  effect: AskEffect | null;
}

export class AskError extends Error {}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stringList(value: unknown, field: string, max: number, maxChars: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AskError(`${field} must be a list of strings.`);
  const out: string[] = [];
  for (const raw of value) {
    const item = textOf(raw);
    if (!item) continue;
    if (item.length > maxChars) throw new AskError(`Each of ${field} is at most ${maxChars} characters; one is ${item.length}. Keep it short.`);
    out.push(item);
  }
  if (out.length > max) throw new AskError(`${field}: at most ${max}, got ${out.length}.`);
  return out;
}

/** A Paperclip path (`/PIB/issues/PIB-3`, `/social?client=…`) or an https URL; never another scheme. */
export function safeHref(value: string): string | null {
  const href = value.trim();
  if (!href || /\s/.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Validates what an agent sent to `ask-owner`. Throws AskError with a message the agent can act on. */
export function parseAskInput(raw: Record<string, unknown>): AskInput {
  const issueId = textOf(raw.issueId);
  if (!issueId) throw new AskError("issueId is required: the issue you are working on (id or identifier, e.g. PIB-23).");
  const question = textOf(raw.question);
  if (!question) throw new AskError("question is required: one clear question the owner can answer.");
  if (question.length > ASK_LIMITS.question) throw new AskError(`question is ${question.length} characters; keep it under ${ASK_LIMITS.question}. Put detail in the issue, not the question.`);
  const why = textOf(raw.why);
  if (!why) throw new AskError("why is required: one or two sentences on why it matters and what waits on it.");
  if (why.length > ASK_LIMITS.why) throw new AskError(`why is ${why.length} characters; keep it under ${ASK_LIMITS.why}.`);
  const kind = raw.kind === undefined || raw.kind === null || raw.kind === "" ? "decision" : raw.kind;
  if (!isAskKind(kind)) throw new AskError(`kind must be one of ${ASK_KINDS.join(", ")}.`);
  const options = stringList(raw.options, "options", ASK_LIMITS.options, ASK_LIMITS.optionChars);
  const steps = stringList(raw.steps, "steps", ASK_LIMITS.steps, ASK_LIMITS.stepChars);
  const links: AskLink[] = [];
  if (raw.links != null) {
    if (!Array.isArray(raw.links)) throw new AskError("links must be a list of {label, href}.");
    for (const entry of raw.links) {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const label = textOf(record.label);
      const href = safeHref(typeof record.href === "string" ? record.href : "");
      if (!label || !href) throw new AskError("Each link needs a label and an href: a Paperclip path (/PIB/issues/PIB-3) or an https address.");
      if (label.length > ASK_LIMITS.linkLabel) throw new AskError(`A link label is at most ${ASK_LIMITS.linkLabel} characters.`);
      if (href.length > ASK_LIMITS.linkHref) throw new AskError(`A link is at most ${ASK_LIMITS.linkHref} characters.`);
      links.push({ label, href });
    }
    if (links.length > ASK_LIMITS.links) throw new AskError(`links: at most ${ASK_LIMITS.links}, got ${links.length}.`);
  }
  let client: string | null = null;
  if (raw.client != null && raw.client !== "") {
    const parsed = typeof raw.client === "string" ? parseClientParam(raw.client.trim()) : null;
    if (!parsed) throw new AskError('client must be "company:<crm id>" or "contact:<crm id>". Leave it out for own work.');
    client = `${parsed.kind}:${parsed.id}`;
  }
  let dueBy: string | null = null;
  if (raw.dueBy != null && raw.dueBy !== "") {
    const value = typeof raw.dueBy === "string" ? raw.dueBy.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new AskError("dueBy must be a date as YYYY-MM-DD.");
    dueBy = value;
  }
  const effect = parseEffect(raw.effect);
  return { issueId, question, options, why, kind, links, steps, client, dueBy, effect };
}

/** A Paperclip path with the company prefix (`/issues/X` → `/PIB/issues/X`); links that already have it, and https links, stay. */
export function prefixed(href: string, prefix: string | null): string {
  if (/^https?:\/\//i.test(href) || !prefix) return href;
  const path = href.startsWith("/") ? href : `/${href}`;
  return path === `/${prefix}` || path.startsWith(`/${prefix}/`) ? path : `/${prefix}${path}`;
}

/** The comment posted on the issue: question, options, why, what to do and links. */
export function askComment(input: {
  ask: Pick<AskInput, "question" | "options" | "why" | "kind" | "links" | "steps" | "dueBy"> & { effect?: AskEffect | null };
  agentName: string;
  clientLabel?: string | null;
  prefix: string | null;
  again?: boolean;
}): string {
  const { ask } = input;
  const meta = [ASK_KIND_LABEL[ask.kind], input.clientLabel ? `for ${input.clientLabel}` : null, ask.dueBy ? `needed by ${ask.dueBy}` : null].filter(Boolean).join(" · ");
  const lines = [`${ASK_OWNER_COMMENT_MARK}${input.again ? " (updated)" : ""}** · ${meta}`, "", ask.question, ""];
  if (ask.options.length) {
    lines.push("**Options** (recommended first)");
    ask.options.forEach((option, index) => lines.push(`${index + 1}. ${index === 0 ? `**${option}** (recommended)` : option}`));
    lines.push("");
  }
  lines.push(`**Why it matters:** ${ask.why}`, "");
  if (ask.steps.length) {
    lines.push("**What to do**");
    ask.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push("");
  }
  if (ask.links.length) {
    lines.push(`**Links:** ${ask.links.map((link) => `[${link.label.replace(/[[\]]/g, "")}](${prefixed(link.href, input.prefix)})`).join(" · ")}`, "");
  }
  if (ask.effect) lines.push(`**If you say yes to the first option:** ${describeEffect(ask.effect)} It is checked afterwards, and ${input.agentName} is told what happened.`, "");
  lines.push(`Reply here with your answer${ask.options.length ? " (the option number is enough)" : ""}. The issue then goes back to ${input.agentName}, who carries on.`);
  return lines.join("\n");
}

/** "2" → "Option 2: Publish on Tuesday" when the reply is just an option number. */
export function answerText(answer: string, options: string[]): string {
  const trimmed = answer.trim();
  const match = /^(?:option\s*)?(\d)[.)]?$/i.exec(trimmed);
  const index = match ? Number(match[1]) - 1 : -1;
  return index >= 0 && index < options.length ? `Option ${index + 1}: ${options[index]}` : trimmed;
}

/** The wake reason for the agent: its question's answer, short. */
export function wakeReason(input: { identifier: string | null; answer: string; options: string[]; effect?: string | null }): string {
  const answer = answerText(input.answer, input.options).replace(/\s+/g, " ");
  const short = answer.length > ASK_LIMITS.wakeAnswerChars ? `${answer.slice(0, ASK_LIMITS.wakeAnswerChars - 1)}…` : answer;
  const effect = input.effect ? ` What the answer was meant to do: ${input.effect}` : "";
  return `The owner answered your question${input.identifier ? ` on ${input.identifier}` : ""}: "${short}".${effect} Read the reply on the issue and carry on.`;
}

/** An open ask as the Cockpit page and the Operator see it. */
export interface AskView {
  id: string;
  issueId: string;
  identifier: string | null;
  issueTitle: string | null;
  kind: AskKind;
  question: string;
  options: string[];
  why: string | null;
  askedBy: string | null;
  askedByAgentId: string | null;
  askedAt: string;
  updatedAt: string;
  dueBy: string | null;
  clientRef: string | null;
  clientName: string | null;
  /** What a yes does, when the ask carries an effect. */
  effect?: { key: string; description: string } | null;
}

/** An open ask as a "Waiting on you" item (`ask` set, so it sorts first and renders as a question). */
export function askWaitingItem(ask: AskView): WaitingItem & { ask: WaitingAskInfo } {
  return {
    key: `ask:${ask.id}`,
    title: ask.question,
    why: [[ask.askedBy ? `${ask.askedBy} asks` : "An agent asks", ask.why].filter(Boolean).join(": "), ask.effect ? ask.effect.description : null].filter(Boolean).join(" "),
    href: `/issues/${ask.identifier ?? ask.issueId}`,
    issueId: ask.issueId,
    kind: ASK_WAITING_KIND[ask.kind],
    since: ask.askedAt,
    ask: { id: ask.id, kind: ask.kind, question: ask.question, options: ask.options, why: ask.why, askedBy: ask.askedBy, askedAt: ask.askedAt, dueBy: ask.dueBy, clientName: ask.clientName },
  };
}

/** Open asks older than {@link ASK_STALE_DAYS} days at `now`. */
export function staleAsks<T extends Pick<AskView, "askedAt">>(asks: T[], now: Date): T[] {
  return asks.filter((ask) => {
    const t = Date.parse(ask.askedAt);
    return Number.isFinite(t) && now.getTime() - t > ASK_STALE_DAYS * 86_400_000;
  });
}
