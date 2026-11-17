/**
 * The refusal report (PAR-12578 plan, 4.4 "Report").
 *
 * Under `report` (the call goes through) and `enforce` (the call is refused) the
 * guard sends Setup `access.refusal { companyId, pluginKey, userId, key,
 * permission, viaAgentId }`, at most once per person and key per 10 minutes.
 * `viaAgentId` is set when an agent made the call, so the People screen can say
 * "through agent X". Under `off` nothing is sent.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AccessMode } from "./switch.js";

export const ACCESS_REFUSAL_EVENT = "access.refusal";
export const ACCESS_REFUSAL_INTERVAL_MS = 10 * 60_000;
const MAX_REFUSAL_ENTRIES = 5_000;

export interface AccessRefusal {
  companyId: string;
  pluginKey: string;
  /** The person refused: the caller, or the person the agent's run works for. Null when unknown. */
  userId: string | null;
  /** The guard key: action key, `api:<routeKey>` or `tool:<name>`. */
  key: string;
  /** The permission the table asks for (`crm.contacts:view`), `ADMIN_ONLY`, or null with no table entry. */
  permission: string | null;
  /** The agent that made the call, or null for a person's own call. */
  viaAgentId: string | null;
}

export interface ReportOptions {
  now?: () => number;
}

// Last report per company, person and key, per plugin context.
const lastSent = new WeakMap<PluginContext, Map<string, number>>();

function sendAllowed(ctx: PluginContext, r: AccessRefusal, now: number): boolean {
  let sent = lastSent.get(ctx);
  if (!sent) lastSent.set(ctx, (sent = new Map()));
  // With no person (an agent with no run), the agent stands in for him.
  const who = r.userId ? `u:${r.userId}` : `a:${r.viaAgentId ?? ""}`;
  const k = `${r.companyId}|${who}|${r.key}`;
  const last = sent.get(k);
  if (last !== undefined && now - last < ACCESS_REFUSAL_INTERVAL_MS) return false;
  // Recorded before the emit, so two refusals in flight together send one report.
  sent.delete(k);
  sent.set(k, now);
  if (sent.size > MAX_REFUSAL_ENTRIES) sent.delete(sent.keys().next().value as string);
  return true;
}

/**
 * Reports one refusal decision. Returns true when it was sent. Never throws: a
 * failed emit is logged and the call goes on as decided.
 */
export async function reportAccessRefusal(ctx: PluginContext, mode: AccessMode, refusal: AccessRefusal, options: ReportOptions = {}): Promise<boolean> {
  if (mode === "off") return false;
  if (!sendAllowed(ctx, refusal, (options.now ?? Date.now)())) return false;
  const payload = {
    companyId: refusal.companyId,
    pluginKey: refusal.pluginKey,
    userId: refusal.userId,
    key: refusal.key,
    permission: refusal.permission,
    viaAgentId: refusal.viaAgentId,
  };
  try {
    await ctx.events.emit(ACCESS_REFUSAL_EVENT, refusal.companyId, payload);
  } catch (error) {
    ctx.logger.info("Access refusal report failed", { companyId: refusal.companyId, key: refusal.key, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
