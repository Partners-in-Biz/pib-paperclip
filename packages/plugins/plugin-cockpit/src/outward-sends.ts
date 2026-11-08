/**
 * Tier A client sends (client-send policy, PAR-7868). PiB marks each routine,
 * reversible client send with a comment on the client issue that starts with
 * `OUTWARD SEND (Tier A):` then `to <who> | <channel> | <what> | <issue>`.
 *
 * This module reads those comments from the host's issue comments (never agent
 * text), and gives: the "Outward sends today" section of the brief, a
 * dismissable info card in the owner's queue for the first 14 days, and the
 * `client_send:ungated` health check (a send with no gate approval behind it).
 */
import { readConfig, type HealthCheck, type WaitingItem } from "@partnersinbiz/pib-plugin-kit";
import { message, type Env } from "./env.js";

export const OUTWARD_SEND_PREFIX = "OUTWARD SEND (Tier A):";
export const UNGATED_CHECK_KEY = "client_send:ungated";
export const INFO_CARD_PREFIX = "outward-send:";
export const INFO_CARD_DAYS = 14;
const DAY_MS = 86_400_000;
/** The health rule looks back this far; the brief section and info cards use shorter windows. */
const HEALTH_WINDOW_DAYS = 7;
const CARD_WINDOW_DAYS = 3;
const ROW_LIMIT = 200;

export interface OutwardSend {
  commentId: string;
  issueId: string;
  identifier: string | null;
  issueTitle: string;
  at: string;
  to: string;
  channel: string;
  what: string;
  /** The issue the send names (last field), or null. */
  ref: string | null;
}

export interface GateComment {
  issueId: string;
  body: string;
  at: string;
}

/** Parses `OUTWARD SEND (Tier A): to <who> | <channel> | <what> | <issue>`; null when the body does not start with the marker. */
export function parseOutwardSend(body: string): Pick<OutwardSend, "to" | "channel" | "what" | "ref"> | null {
  const text = body.trimStart();
  if (!text.startsWith(OUTWARD_SEND_PREFIX)) return null;
  const rest = text.slice(OUTWARD_SEND_PREFIX.length).split("\n")[0]!.trim();
  const parts = rest.split("|").map((p) => p.trim());
  const to = (parts[0] ?? "").replace(/^to\s+/i, "").trim();
  return { to: to || "unknown", channel: parts[1] || "unknown", what: parts[2] || "", ref: parts[3] || null };
}

const VISUAL = /\b(image|images|visual|visuals|graphic|graphics|banner|design|mock-?up|screenshot|creative|video|poster|logo|photo|artwork|carousel|infographic)\b/i;
/** Whether the send carries a visual (judged from what the comment says it sent). */
export function carriesVisual(send: Pick<OutwardSend, "channel" | "what">): boolean {
  return VISUAL.test(`${send.channel} ${send.what}`);
}

const VISUAL_APPROVE = /VISUAL GATE:\s*APPROVE\b/i;
const REVIEWER_APPROVE = /^\s*(?:(?:REVIEW|REVIEWER|REVIEW OUTWARD):\s*(?:PASS|APPROVE[D]?)\b|PASS\b)/im;

/** Gate approvals that came before the send, on the same issue. */
export function isUngated(send: OutwardSend, gates: GateComment[]): boolean {
  const sent = Date.parse(send.at);
  const before = gates.filter((g) => g.issueId === send.issueId && (!Number.isFinite(sent) || Date.parse(g.at) <= sent));
  return carriesVisual(send) ? !before.some((g) => VISUAL_APPROVE.test(g.body)) : !before.some((g) => REVIEWER_APPROVE.test(g.body) || VISUAL_APPROVE.test(g.body));
}

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : String(value ?? "");
};

/** Tier A comments written since `sinceIso`, newest first, with the gate comments on their issues. */
export async function readOutwardSends(env: Env, companyId: string, sinceIso: string): Promise<{ sends: OutwardSend[]; gates: GateComment[] }> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(
    `SELECT c.id::text AS id, c.issue_id::text AS issue_id, c.body, c.created_at, i.identifier, i.title
       FROM public.issue_comments c JOIN public.issues i ON i.id = c.issue_id
      WHERE c.company_id = $1::uuid AND c.deleted_at IS NULL AND c.created_at >= $2::timestamptz AND c.body LIKE 'OUTWARD SEND (Tier A):%'
      ORDER BY c.created_at DESC LIMIT ${ROW_LIMIT}`,
    [companyId, sinceIso],
  );
  const sends: OutwardSend[] = [];
  for (const row of rows) {
    const parsed = parseOutwardSend(String(row.body ?? ""));
    if (!parsed) continue;
    sends.push({ commentId: String(row.id), issueId: String(row.issue_id), identifier: row.identifier == null ? null : String(row.identifier), issueTitle: String(row.title ?? ""), at: iso(row.created_at), ...parsed });
  }
  if (sends.length === 0) return { sends, gates: [] };
  const gateRows = await env.ctx.db.query<Record<string, unknown>>(
    `SELECT g.issue_id::text AS issue_id, g.body, g.created_at
       FROM public.issue_comments g
      WHERE g.company_id = $1::uuid AND g.deleted_at IS NULL
        AND (g.body ILIKE '%VISUAL GATE:%' OR g.body ILIKE '%PASS%' OR g.body ILIKE '%APPROVE%')
        AND g.issue_id IN (SELECT s.issue_id FROM public.issue_comments s WHERE s.company_id = $1::uuid AND s.created_at >= $2::timestamptz AND s.body LIKE 'OUTWARD SEND (Tier A):%')
      ORDER BY g.created_at DESC LIMIT 2000`,
    [companyId, sinceIso],
  );
  return { sends, gates: gateRows.map((r) => ({ issueId: String(r.issue_id), body: String(r.body ?? ""), at: iso(r.created_at) })) };
}

const sinceIso = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

// ---------------------------------------------------------------------------
// Brief section
// ---------------------------------------------------------------------------

export interface OutwardSendLine {
  issue: string;
  client: string;
  channel: string;
  what: string;
  at: string;
  line: string;
}

export interface OutwardSendsBrief {
  count: number;
  lines: OutwardSendLine[];
}

export function outwardSendsBrief(sends: OutwardSend[], now: Date, hours = 24): OutwardSendsBrief {
  const cutoff = now.getTime() - hours * 3_600_000;
  const lines = sends
    .filter((s) => Date.parse(s.at) >= cutoff)
    .map((s) => {
      const issue = s.identifier ?? s.issueId;
      return { issue, client: s.to, channel: s.channel, what: s.what, at: s.at, line: `${issue} | ${s.to} | ${s.channel} | ${s.what}` };
    });
  return { count: lines.length, lines };
}

/** "Outward sends today" for the daily brief; null when it could not be read. */
export async function outwardSendsToday(env: Env, companyId: string): Promise<OutwardSendsBrief | null> {
  try {
    const now = env.now();
    return outwardSendsBrief((await readOutwardSends(env, companyId, sinceIso(now, 1))).sends, now);
  } catch (error) {
    env.ctx.logger.info("Cockpit outward sends unreadable", { companyId, error: message(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health rule
// ---------------------------------------------------------------------------

export function ungatedCheck(sends: OutwardSend[], gates: GateComment[]): HealthCheck | null {
  const bad = sends.filter((s) => isUngated(s, gates));
  if (bad.length === 0) return null;
  const refs = bad.slice(0, 3).map((s) => s.identifier ?? s.issueId).join(", ");
  const oldest = bad.reduce((a, s) => (Date.parse(s.at) < Date.parse(a) ? s.at : a), bad[0]!.at);
  return {
    key: UNGATED_CHECK_KEY,
    title: `${bad.length} client ${bad.length === 1 ? "send" : "sends"} went out with no gate approval`,
    status: "bad",
    detail: `${refs}${bad.length > 3 ? " and more" : ""}: a Tier A send needs VISUAL GATE: APPROVE (when it carries a visual) or a Reviewer PASS (text) on the issue before it goes out.`,
    href: `/issues/${bad[0]!.identifier ?? bad[0]!.issueId}`,
    fix: "Open the issue, get the missing approval on it and tell PiB; if the send should not have gone out, pull it back with the client.",
    since: oldest,
  };
}

// ---------------------------------------------------------------------------
// Info cards (first 14 days)
// ---------------------------------------------------------------------------

const stateKey = (companyId: string, key: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: key });

/** When the Cockpit first saw this feature on (the deploy date for the default window), remembered once. */
async function firstSeen(env: Env, companyId: string): Promise<string> {
  const key = stateKey(companyId, "client-sends-first-seen");
  const stored = (await env.ctx.state.get(key)) as { at?: string } | null;
  if (stored?.at && Number.isFinite(Date.parse(stored.at))) return stored.at;
  const at = env.now().toISOString();
  await env.ctx.state.set(key, { at }).catch(() => undefined);
  return at;
}

/** Info cards stop at `clientSends.infoCardsUntil` (config), default the first deploy + 14 days. */
export async function infoCardsUntil(env: Env, companyId: string): Promise<number> {
  const config = (await readConfig(env.ctx, companyId).catch(() => ({}))) as { clientSends?: { infoCardsUntil?: string } };
  const set = config.clientSends?.infoCardsUntil ? Date.parse(config.clientSends.infoCardsUntil) : Number.NaN;
  if (Number.isFinite(set)) return set;
  return Date.parse(await firstSeen(env, companyId)) + INFO_CARD_DAYS * DAY_MS;
}

async function dismissed(env: Env, companyId: string): Promise<string[]> {
  const raw = await env.ctx.state.get(stateKey(companyId, "client-sends-dismissed")).catch(() => null);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Dismiss one info card (by comment id). Idempotent; keeps the list short. */
export async function dismissInfoCard(env: Env, companyId: string, id: string): Promise<{ dismissed: string[] }> {
  const commentId = id.startsWith(INFO_CARD_PREFIX) ? id.slice(INFO_CARD_PREFIX.length) : id;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(commentId)) throw new Error("Not an info card id");
  const list = await dismissed(env, companyId);
  if (!list.includes(commentId)) list.push(commentId);
  const kept = list.slice(-500);
  await env.ctx.state.set(stateKey(companyId, "client-sends-dismissed"), kept);
  return { dismissed: kept };
}

export function infoCardItems(sends: OutwardSend[], opts: { until: number; now: Date; dismissed: string[]; prefix?: string | null }): WaitingItem[] {
  if (opts.now.getTime() >= opts.until) return [];
  const skip = new Set(opts.dismissed);
  return sends
    .filter((s) => !skip.has(s.commentId) && Date.parse(s.at) >= opts.now.getTime() - CARD_WINDOW_DAYS * DAY_MS)
    .map((s) => ({
      key: `${INFO_CARD_PREFIX}${s.commentId}`,
      title: `Sent to ${s.to}: ${s.what || s.channel}`.slice(0, 160),
      why: `Info, no action needed. Tier A send by PiB via ${s.channel}. Use Pull back to open the issue if it should not have gone out.`,
      href: `/issues/${s.identifier ?? s.issueId}`,
      issueId: s.issueId,
      kind: "other" as const,
      since: s.at,
    }));
}

/** What the Cockpit's extra checks add: the ungated health check and the info cards. */
export async function clientSendChecks(env: Env, companyId: string): Promise<{ health: HealthCheck[]; waiting: WaitingItem[] }> {
  const now = env.now();
  const { sends, gates } = await readOutwardSends(env, companyId, sinceIso(now, HEALTH_WINDOW_DAYS));
  const check = ungatedCheck(sends, gates);
  const until = await infoCardsUntil(env, companyId);
  const waiting = infoCardItems(sends, { until, now, dismissed: await dismissed(env, companyId) });
  return { health: check ? [check] : [], waiting };
}
