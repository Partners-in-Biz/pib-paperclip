/**
 * The monthly focus of one scope (own work, or one client): one theme, one audience, one ask and one number for the
 * month, with the real material the posts are built from. Every plan, hook and post of that month serves it, and at
 * the end of the month it is closed with what was learned. It lives in the scope's Growth program (`constraints.focus`,
 * history in `constraints.focusLog`), so `get-playbook`, `performance-review` and the Growth tab all carry it.
 */
import { GrowthError } from "@partnersinbiz/pib-plugin-kit";
import type { GrowthActor, GrowthEnv } from "./growth/host.js";
import type { Program } from "./growth/store.js";

export interface MonthlyFocus {
  /** `YYYY-MM`, in the company's time zone. */
  month: string;
  /** What the month is about, in one line. */
  theme: string;
  /** Who it is for: one kind of person, and the moment they are in. */
  audience: string;
  /** The one thing we want them to do. */
  offer: string;
  /** Real material to build from: results with their source, client stories, screens, numbers. Never invented. */
  proof: string[];
  /** The one number that says the month worked. */
  metric: string;
  setBy: string;
  setAt: string;
}

export interface ClosedFocus extends MonthlyFocus {
  /** What the month taught: the hooks and formats to keep, and the ones to drop. */
  learned: string | null;
  closedAt: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOG_MAX = 12;

/** The month of `now` in a time zone, as `YYYY-MM`. */
export function monthIn(timezone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
    return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
  } catch {
    return now.toISOString().slice(0, 7);
  }
}

const isFocus = (v: unknown): v is MonthlyFocus => Boolean(v) && typeof v === "object" && typeof (v as MonthlyFocus).month === "string" && typeof (v as MonthlyFocus).theme === "string";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The stored value as text fields only, whatever was written by hand into the program. */
function clean<T extends MonthlyFocus>(focus: T): T {
  return { ...focus, audience: str(focus.audience), offer: str(focus.offer), metric: str(focus.metric), proof: Array.isArray(focus.proof) ? focus.proof.filter((p): p is string => typeof p === "string") : [] };
}

export function focusOf(program: Pick<Program, "constraints">): MonthlyFocus | null {
  const focus = (program.constraints as Record<string, unknown>).focus;
  return isFocus(focus) ? clean(focus) : null;
}

export function focusLogOf(program: Pick<Program, "constraints">): ClosedFocus[] {
  const log = (program.constraints as Record<string, unknown>).focusLog;
  return Array.isArray(log) ? (log.filter(isFocus) as ClosedFocus[]).map((f) => ({ ...clean(f), learned: typeof f.learned === "string" ? f.learned : null })) : [];
}

/** What agents and the Growth tab see: the focus, whether it is this month's, and what to do when it is not. */
export function focusOut(program: Pick<Program, "constraints">, thisMonth: string) {
  const focus = focusOf(program);
  const state = !focus ? "none" : focus.month === thisMonth ? "current" : focus.month > thisMonth ? "next" : "expired";
  const note =
    state === "none"
      ? `No focus is set. Before you plan or draft, set this month's (${thisMonth}) with set-focus: one theme, one audience, one ask, one number, and the real material to build from.`
      : state === "expired"
        ? `The focus is from ${focus!.month}. Close it and set ${thisMonth}'s with set-focus: say what last month taught (learned), from hook-board.`
        : null;
  return { focus, state, thisMonth, ...(note ? { note } : {}), past: focusLogOf(program).slice(0, 3) };
}

function line(params: Record<string, unknown>, key: string, max: number, required = true): string | null {
  const value = params[key];
  if (value == null || value === "") {
    if (required) throw new GrowthError(`${key} is required`);
    return null;
  }
  if (typeof value !== "string") throw new GrowthError(`${key} must be text`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    if (required) throw new GrowthError(`${key} is required`);
    return null;
  }
  if (text.length > max) throw new GrowthError(`${key} is ${text.length} characters; at most ${max}`);
  return text;
}

function proofList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n+/) : [];
  const out = Array.from(new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean)));
  if (out.length === 0) throw new GrowthError("proof is required: list the real material this month's posts are built from (a result with its source, a client story, a real screen, a number). Ask for it if you have none; never invent it.");
  if (out.length > 10 || out.some((p) => p.length > 300)) throw new GrowthError("proof: up to 10 items, 300 characters each");
  return out;
}

/**
 * Set a scope's focus for the current month. A focus of another month is closed first: `learned` (what worked and what
 * did not, from the hook board) is required and goes into the log. Setting the same month again replaces it. There is
 * one focus per scope at a time, so next month's is set when that month starts.
 */
export async function setFocusRecord(env: GrowthEnv, actor: GrowthActor, program: Program, timezone: string, params: Record<string, unknown>) {
  const thisMonth = monthIn(timezone);
  const month = line(params, "month", 7, false) ?? thisMonth;
  if (!MONTH.test(month)) throw new GrowthError("month must look like 2026-11");
  if (month !== thisMonth) throw new GrowthError(`A focus is set for the current month (${thisMonth}). Set the next month's when it starts.`);
  const current = focusOf(program);
  const log = focusLogOf(program);
  const constraints: Record<string, unknown> = { ...(program.constraints as Record<string, unknown>) };
  if (current && current.month !== month) {
    const learned = line(params, "learned", 800, false);
    if (!learned) throw new GrowthError(`The focus of ${current.month} ("${current.theme}") is still open. Pass learned: what that month taught (hooks and formats to keep, and to drop), from hook-board.`);
    constraints.focusLog = [{ ...current, learned, closedAt: new Date().toISOString() }, ...log].slice(0, LOG_MAX);
  }
  const focus: MonthlyFocus = {
    month,
    theme: line(params, "theme", 200)!,
    audience: line(params, "audience", 300)!,
    offer: line(params, "offer", 300)!,
    proof: proofList(params.proof),
    metric: line(params, "metric", 160)!,
    setBy: actor.isAgent ? `agent:${actor.agentId ?? "?"}` : `user:${actor.userId ?? "?"}`,
    setAt: new Date().toISOString(),
  };
  constraints.focus = focus;
  await env.store.updateProgram(actor.companyId, program.id, { constraints });
  const updated = (await env.store.getProgram(actor.companyId, program.id))!;
  return { programId: program.id, ...focusOut(updated, thisMonth), replaced: Boolean(current && current.month === month) };
}
