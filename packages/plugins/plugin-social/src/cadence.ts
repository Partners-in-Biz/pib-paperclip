/**
 * A brand's posting cadence (Peet, 17 Nov 2026: "on one brand I might want to post 3 times daily on all social
 * accounts, on another 20 times a day"). One setting per scope: posts a day per connected account (with an optional
 * number per platform), the days it posts on, and the hours it posts between. The daily calendar check counts each
 * account's posts per day against it and hands the free slots to the Social agent; `get-cadence` shows the same to an
 * agent. A post going to several accounts counts once for each of them.
 *
 * Storage: plugin state (company scope, namespace `social-cadence`, key = the scope key, `own` or `company:<id>`). A
 * person sets it on the Growth tab; agents only read it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, type ClientScope } from "./clients.js";
import { SocialError } from "./domain.js";
import { isSocialPlatform, PLATFORM_LABELS, type SocialPlatform } from "./platforms.js";

export interface Cadence {
  /** Posts a day on every connected account in the scope. */
  postsPerDay: number;
  /** A different number for one platform (0 leaves that platform out). */
  perPlatform: Partial<Record<SocialPlatform, number>>;
  /** Days it posts on, 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** First and last posting time of the day, "HH:MM" in the company's time zone. */
  windowStart: string;
  windowEnd: string;
  /** How many days ahead the daily check fills (today's later slots included). */
  lookaheadDays: number;
  setBy: string;
  setAt: string;
}

export const MAX_PER_DAY = 50;
export const MIN_LEAD_MS = 2 * 3_600_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATE = (companyId: string, key: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "social-cadence", stateKey: key });

export function cadenceKey(scope: ClientScope): string {
  return scope ? formatClientParam(scope).toLowerCase() : "own";
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function count(value: unknown, what: string): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_PER_DAY) throw new SocialError(`${what} must be a whole number from 0 to ${MAX_PER_DAY}`);
  return n;
}

/** Checks and normalises what a person saves. Throws a SocialError on bad input. Pure. */
export function normalizeCadence(input: Record<string, unknown>, by: string, now: Date = new Date()): Cadence {
  const postsPerDay = count(input.postsPerDay, "Posts a day");
  const perPlatform: Cadence["perPlatform"] = {};
  const raw = input.perPlatform && typeof input.perPlatform === "object" ? (input.perPlatform as Record<string, unknown>) : {};
  for (const [platform, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === "") continue;
    if (!isSocialPlatform(platform)) throw new SocialError(`Unknown platform ${platform}`);
    perPlatform[platform] = count(value, `Posts a day on ${PLATFORM_LABELS[platform]}`);
  }
  const days = Array.isArray(input.days) ? Array.from(new Set(input.days.map(Number))).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [0, 1, 2, 3, 4, 5, 6];
  if (days.length === 0) throw new SocialError("Pick at least one day to post on");
  const windowStart = typeof input.windowStart === "string" && input.windowStart ? input.windowStart : "07:00";
  const windowEnd = typeof input.windowEnd === "string" && input.windowEnd ? input.windowEnd : "19:00";
  if (!TIME.test(windowStart) || !TIME.test(windowEnd)) throw new SocialError("Posting hours must be times like 07:00");
  if (minutes(windowEnd) <= minutes(windowStart)) throw new SocialError("The last posting time must be after the first");
  const lookaheadDays = input.lookaheadDays === undefined || input.lookaheadDays === null || input.lookaheadDays === "" ? 2 : Number(input.lookaheadDays);
  if (!Number.isInteger(lookaheadDays) || lookaheadDays < 1 || lookaheadDays > 7) throw new SocialError("Days ahead must be from 1 to 7");
  if (postsPerDay === 0 && !Object.values(perPlatform).some((n) => (n ?? 0) > 0)) throw new SocialError("Set at least one post a day, or clear the cadence");
  return { postsPerDay, perPlatform, days, windowStart, windowEnd, lookaheadDays, setBy: by, setAt: now.toISOString() };
}

function parse(value: unknown): Cadence | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  try {
    return normalizeCadence(v, typeof v.setBy === "string" ? v.setBy : "", new Date(typeof v.setAt === "string" ? v.setAt : Date.now()));
  } catch {
    return null;
  }
}

export async function getCadence(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<Cadence | null> {
  return parse(await ctx.state.get(STATE(companyId, cadenceKey(scope))).catch(() => null));
}

/** Every scope key with a cadence. Reads the keys it is given (plugin state has no list call). */
export async function cadencesFor(ctx: PluginContext, companyId: string, scopes: ClientScope[]): Promise<Map<string, Cadence>> {
  const out = new Map<string, Cadence>();
  for (const scope of scopes) {
    const c = await getCadence(ctx, companyId, scope);
    if (c) out.set(cadenceKey(scope), c);
  }
  return out;
}

export async function setCadence(ctx: PluginContext, companyId: string, scope: ClientScope, cadence: Cadence | null): Promise<void> {
  await ctx.state.set(STATE(companyId, cadenceKey(scope)), cadence);
}

/** Posts a day for one account. Pure. */
export function targetFor(cadence: Cadence, platform: string): number {
  const own = isSocialPlatform(platform) ? cadence.perPlatform[platform] : undefined;
  return own ?? cadence.postsPerDay;
}

/** `n` times spread evenly over the window, rounded to 5 minutes. Pure. */
export function slotTimes(n: number, windowStart: string, windowEnd: string): string[] {
  if (n <= 0) return [];
  const from = minutes(windowStart);
  const span = minutes(windowEnd) - from;
  if (n === 1) return [hhmm(from + Math.round(span / 2 / 5) * 5)];
  return Array.from({ length: n }, (_, i) => hhmm(from + Math.round((span * i) / (n - 1) / 5) * 5));
}

/** The company's calendar day ("YYYY-MM-DD"), weekday (0 = Sunday) and "HH:MM" for an instant. Pure. */
export function localParts(at: Date, timeZone: string): { day: string; weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, weekday: DAY_NAMES.indexOf(get("weekday")), time: `${get("hour")}:${get("minute")}` };
}

/** The instant of a local day and time in a time zone. Pure. */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  const seen = localParts(new Date(guess), timeZone);
  const [sy, sm, sd] = seen.day.split("-").map(Number) as [number, number, number];
  const seenUtc = Date.UTC(sy, sm - 1, sd, Number(seen.time.slice(0, 2)), Number(seen.time.slice(3, 5)));
  return new Date(guess - (seenUtc - guess));
}

export interface CadenceAccount {
  id: string;
  platform: string;
  name: string;
}

export interface CadencePost {
  /** When it goes (or went) out. */
  at: string;
  accounts: string[];
}

export interface DayGaps {
  day: string;
  label: string;
  accounts: Array<{ id: string; name: string; platform: string; target: number; have: number }>;
  /** Free slots: the time (local), its instant, and the accounts with no post near it. */
  free: Array<{ time: string; at: string; accountIds: string[] }>;
}

/**
 * Per day ahead (today's slots at least two hours away, then `lookaheadDays` more days on the cadence's days): each
 * account's target and posts, and the free slots. A slot is taken when a post for that account is nearer to it than to
 * any other slot. Pure.
 */
export function cadenceGaps(cadence: Cadence, accounts: CadenceAccount[], posts: CadencePost[], now: Date, timeZone: string): DayGaps[] {
  const today = localParts(now, timeZone);
  const out: DayGaps[] = [];
  for (let offset = 0; offset <= cadence.lookaheadDays; offset++) {
    const probe = localParts(new Date(zonedInstant(today.day, "12:00", timeZone).getTime() + offset * 86_400_000), timeZone);
    if (!cadence.days.includes(probe.weekday)) continue;
    const day: DayGaps = { day: probe.day, label: `${DAY_NAMES[probe.weekday]} ${Number(probe.day.slice(8))}`, accounts: [], free: [] };
    const free = new Map<string, string[]>();
    for (const account of accounts) {
      const target = targetFor(cadence, account.platform);
      if (target <= 0) continue;
      const times = posts
        .filter((p) => p.accounts.includes(account.id))
        .map((p) => localParts(new Date(p.at), timeZone))
        .filter((p) => p.day === probe.day)
        .map((p) => minutes(p.time));
      day.accounts.push({ id: account.id, name: account.name, platform: account.platform, target, have: times.length });
      const slots = slotTimes(target, cadence.windowStart, cadence.windowEnd).map((t) => ({ t, m: minutes(t), taken: false }));
      // Each post takes the nearest open slot.
      for (const m of times.sort((a, b) => a - b)) {
        const open = slots.filter((s) => !s.taken).sort((a, b) => Math.abs(a.m - m) - Math.abs(b.m - m))[0];
        if (open) open.taken = true;
      }
      for (const slot of slots) {
        if (slot.taken) continue;
        if (zonedInstant(probe.day, slot.t, timeZone).getTime() < now.getTime() + MIN_LEAD_MS) continue;
        free.set(slot.t, [...(free.get(slot.t) ?? []), account.id]);
      }
    }
    day.free = [...free.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, accountIds]) => ({ time, at: zonedInstant(probe.day, time, timeZone).toISOString(), accountIds }));
    if (day.accounts.length) out.push(day);
  }
  return out;
}

/** "3 a day on every account (LinkedIn 1), Mon–Fri, 07:00–19:00". Pure. */
export function cadenceSummary(cadence: Cadence): string {
  const extra = Object.entries(cadence.perPlatform).map(([p, n]) => `${PLATFORM_LABELS[p as SocialPlatform] ?? p} ${n}`);
  const days = cadence.days.length === 7 ? "every day" : cadence.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${cadence.postsPerDay} a day on every account${extra.length ? ` (${extra.join(", ")})` : ""}, ${days}, ${cadence.windowStart}–${cadence.windowEnd}`;
}

/** The issue section for one scope's gaps; empty when every slot is taken. Pure. */
export function cadenceSection(cadence: Cadence, gaps: DayGaps[], names: Map<string, string>): string[] {
  const open = gaps.filter((d) => d.free.length);
  if (!open.length) return [];
  const out = [
    `## Fill the calendar (cadence: ${cadenceSummary(cadence)})`,
    "Draft one post per free slot below: `create-post` with that `scheduledAt` and those accounts, tagged `hook:`, `body:`, `cta:`; then `validate-post` and `request-review`. One post may go to several accounts. Every post needs its own opening: `validate-post` refuses the same post twice on one account within 48 hours.",
    "",
  ];
  for (const day of open) {
    out.push(`**${day.label}**: ${day.accounts.map((a) => `${a.name} ${a.have}/${a.target}`).join(", ")}`);
    const lines = day.free.map((slot) => `- ${slot.time} (\`${slot.at}\`): ${slot.accountIds.map((id) => names.get(id) ?? id).join(", ")}`);
    out.push(...(lines.length > 25 ? [...lines.slice(0, 25), `- … and ${lines.length - 25} more slots`] : lines), "");
  }
  return out;
}
