/**
 * Watch live (PAR-14514 design 3, stage S3): the owner or an admin watches display :99 read-only from Cockpit.
 *
 * - Setting `browserLive: off | view | takeover`, default `off`, read through `readBrowserLiveSetting`, which answers
 *   `off` when the read fails (fail closed).
 * - `browser.live.ticket {mode: "view"}` hands a signed-in owner or admin of the owner company a random ticket. Memory
 *   keeps only its hash, the user id, the company, the mode, the identity and a 30-second expiry. The daemon is not
 *   contacted.
 * - `GET /browser/live` (websocket, board) repeats every check, redeems the ticket (single use, same user as the
 *   upgrade) and returns the daemon's local socket. Core then signs the upgrade for a session person only (design 1).
 *   Every refusal is the same answer as an unknown ticket.
 * - `browser.live.status` passes the daemon's `/status` through.
 *
 * Who: never an agent (also not one acting for an owner), never the local board user, never another company, never
 * a member who is not owner or admin. The core action route has no person-only mode, so these checks live here.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PluginApiRequestInput, PluginApiResponse, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany, LOCAL_BOARD_USER_ID, roleOf, type AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { BrowserDaemonError, browserLiveSocket, readBrowserDaemonStatus } from "./browser-daemon-client.js";
import { CockpitError, message, type Env } from "./env.js";

export const BROWSER_LIVE_ROUTE_KEY = "browser-live";
export const BROWSER_LIVE_SETTINGS = ["off", "view", "takeover"] as const;
export type BrowserLiveSetting = (typeof BROWSER_LIVE_SETTINGS)[number];
export type BrowserLiveMode = "view";

export const TICKET_TTL_MS = 30_000;
/** More open tickets than this is not a person clicking; the oldest go first. */
const MAX_TICKETS = 200;

/**
 * The one answer for every refused upgrade: an unknown, expired, used or foreign ticket, the wrong person, company or
 * role, the setting `off`, a failed read. 403 is also the access guard's refusal status, so a guard refusal looks the
 * same. Core turns any non-socket answer into `{ error: "Plugin connection unavailable" }` with this status.
 */
export const BROWSER_LIVE_REFUSAL: Readonly<PluginApiResponse> = Object.freeze({ status: 403, body: Object.freeze({ error: "Live browser unavailable" }) });
const refused = (): PluginApiResponse => ({ status: BROWSER_LIVE_REFUSAL.status, body: { ...(BROWSER_LIVE_REFUSAL.body as object) } });

/** `off` unless the company's saved Cockpit settings say `view` or `takeover`; `off` when the read fails. */
export async function readBrowserLiveSetting(env: Env, companyId: string): Promise<BrowserLiveSetting> {
  try {
    const config = (await env.ctx.config.get(companyId)) as Record<string, unknown> | null | undefined;
    const value = config?.browserLive;
    return value === "view" || value === "takeover" ? value : "off";
  } catch (error) {
    env.ctx.logger.warn("Browser live setting could not be read; treated as off", { companyId, error: message(error) });
    return "off";
  }
}

const modeAllowed = (setting: BrowserLiveSetting, mode: BrowserLiveMode) => setting !== "off" && mode === "view";

type PersonCheck = { ok: true; userId: string } | { ok: false; reason: string };

/** A signed-in person, not the local board, owner or admin of the owner company. */
async function checkPerson(env: Env, companyId: string | null, actorType: string | null | undefined, userId: string | null | undefined): Promise<PersonCheck> {
  if (actorType !== "user") return { ok: false, reason: "Only a signed-in person can watch the live browser" };
  const id = typeof userId === "string" ? userId.trim() : "";
  // The local board user is a board without a person (kit permissions.ts:331 lets it bypass roles); refused by name.
  if (!id || id === LOCAL_BOARD_USER_ID) return { ok: false, reason: "Only a signed-in person can watch the live browser" };
  if (!companyId || !(await isOwnerCompany(env.ctx, companyId))) return { ok: false, reason: "The live browser is only available in the owner company" };
  let role: string | null;
  try {
    role = await roleOf(env.ctx, companyId, id);
  } catch {
    return { ok: false, reason: "Cannot verify your role in this company" };
  }
  if (role !== "owner" && role !== "admin") return { ok: false, reason: "Only a company owner or admin can watch the live browser" };
  return { ok: true, userId: id };
}

interface TicketEntry {
  userId: string;
  companyId: string;
  mode: BrowserLiveMode;
  identity: string | null;
  expiresAt: number;
}

/** Per worker (per plugin context): ticket hash -> entry. Never the ticket itself. */
const STORES = new WeakMap<object, Map<string, TicketEntry>>();
function ticketStore(env: Env): Map<string, TicketEntry> {
  let store = STORES.get(env.ctx);
  if (!store) STORES.set(env.ctx, (store = new Map()));
  return store;
}
const hashTicket = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

function prune(store: Map<string, TicketEntry>, now: number): void {
  for (const [hash, entry] of store) if (entry.expiresAt <= now) store.delete(hash);
  // Map keeps insertion order, so the first keys are the oldest.
  while (store.size >= MAX_TICKETS) store.delete(store.keys().next().value as string);
}

/** Single use: the entry is gone whatever happens next, even when the rest of the checks refuse. */
function takeTicket(env: Env, ticket: string): TicketEntry | null {
  const store = ticketStore(env);
  const hash = hashTicket(ticket);
  const entry = store.get(hash) ?? null;
  store.delete(hash);
  return entry;
}

/** What the Browser tab may show this caller: the setting when they may watch, else `off`. Never throws. */
export async function browserLiveFor(env: Env, context: PluginPerformActionContext): Promise<BrowserLiveSetting> {
  try {
    const who = await checkPerson(env, context.companyId, context.actor?.type, context.actor?.userId);
    return who.ok ? await readBrowserLiveSetting(env, context.companyId!) : "off";
  } catch {
    return "off";
  }
}

export interface BrowserLiveTicket {
  ticket: string;
  mode: BrowserLiveMode;
  expiresAt: string;
}

export async function issueBrowserLiveTicket(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<BrowserLiveTicket> {
  const companyId = context.companyId;
  const who = await checkPerson(env, companyId, context.actor.type, context.actor.userId);
  if (!who.ok) throw new CockpitError(who.reason);
  if (params.mode !== "view") throw new CockpitError("mode must be view");
  // After the person check, so only an owner or admin learns how the setting stands.
  if (!modeAllowed(await readBrowserLiveSetting(env, companyId!), "view")) throw new CockpitError("Watch live is turned off in the Cockpit settings");
  const now = env.now().getTime();
  const store = ticketStore(env);
  prune(store, now);
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  store.set(hashTicket(ticket), { userId: who.userId, companyId: companyId!, mode: "view", identity: null, expiresAt });
  return { ticket, mode: "view", expiresAt: new Date(expiresAt).toISOString() };
}

function queryValue(query: PluginApiRequestInput["query"], key: string): string | null {
  const value = query?.[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

/** The websocket route's worker half. Never throws: any failure is the one refusal. */
export async function handleBrowserLiveRoute(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    const ticket = queryValue(input.query, "ticket");
    const entry = ticket ? takeTicket(env, ticket) : null;
    if (!entry || entry.expiresAt <= env.now().getTime()) return refused();
    const userId = input.actor?.actorType === "user" ? input.actor.userId ?? input.actor.actorId : null;
    if (entry.userId !== userId || entry.companyId !== input.companyId) return refused();
    const who = await checkPerson(env, input.companyId, input.actor.actorType, userId);
    if (!who.ok) return refused();
    if (!modeAllowed(await readBrowserLiveSetting(env, input.companyId), entry.mode)) return refused();
    // The record is part of the watch: no record, no stream. Identity and person only, never screen content.
    const recorded = await recordActivity(env.ctx, input.companyId, {
      key: `browser-live:watch:${hashTicket(ticket!).slice(0, 32)}`,
      kind: "browser_live",
      at: env.now().toISOString(),
      text: `Watch live started by user ${who.userId}${entry.identity ? ` (identity ${entry.identity})` : ""}`,
      href: "/cockpit",
      agentId: null,
    }).then(() => true, (error: unknown) => {
      env.ctx.logger.warn("Browser live watch not started: the activity record failed", { companyId: input.companyId, error: message(error) });
      return false;
    });
    if (!recorded) return refused();
    env.ctx.logger.info("Browser live watch started", { companyId: input.companyId, userId: who.userId, mode: entry.mode });
    return { websocket: { local: { socket: browserLiveSocket(), path: `/stream?mode=${entry.mode}` } } };
  } catch (error) {
    env.ctx.logger.warn("Browser live route refused after an error", { error: message(error) });
    return refused();
  }
}

export interface BrowserLiveStatus {
  reachable: boolean;
  /** The daemon's `/status`, unchanged; null when it could not be read. */
  status: Record<string, unknown> | null;
  reason?: BrowserDaemonError["reason"];
}

/** Works at every setting (design 3): the drawer must always see what is live. */
export async function loadBrowserLiveStatus(env: Env, context: PluginPerformActionContext, readStatus = readBrowserDaemonStatus): Promise<BrowserLiveStatus> {
  const who = await checkPerson(env, context.companyId, context.actor.type, context.actor.userId);
  if (!who.ok) throw new CockpitError(who.reason);
  try {
    return { reachable: true, status: await readStatus() };
  } catch (error) {
    if (error instanceof BrowserDaemonError) return { reachable: false, status: null, reason: error.reason };
    throw error;
  }
}

export function registerBrowserLive(env: Env, guard: AccessGuard): void {
  guard.action("browser.live.ticket", async (params, context) => issueBrowserLiveTicket(env, params, context));
  guard.action("browser.live.status", async (_params, context) => loadBrowserLiveStatus(env, context));
}
