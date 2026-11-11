/**
 * The owner's daily digest: the pure parts. No node imports.
 *
 * Everything that waits on the owner reaches them once a day as one list,
 * grouped by WHERE they act, so one sitting at the Mac or one store-console
 * session clears a whole group. Each line is one action with a link and the
 * number of open tasks that wait behind it. The header carries the count of
 * new asks that day and the oldest open one, so the trend is visible.
 */

/** Where the owner acts, in the order the digest lists them (quickest first). */
export const DIGEST_PLACES = ["quick", "mac", "vault", "secrets", "stores", "social", "applications", "device", "decisions"] as const;
export type DigestPlace = (typeof DIGEST_PLACES)[number];

export const DIGEST_PLACE_TITLE: Record<DigestPlace, string> = {
  quick: "Quick clicks",
  mac: "At the Mac",
  vault: "Logins for the vault",
  secrets: "Secrets to save",
  stores: "Store consoles",
  social: "Social connections",
  applications: "Outside applications",
  device: "Device tests",
  decisions: "Decisions",
};

/** The SAST hour the digest is posted, and the last hour a missed one is still caught up. */
export const DIGEST_HOUR_SAST = 16;
export const DIGEST_LAST_HOUR_SAST = 21;
/** Most lines one digest shows; the rest are counted. */
export const DIGEST_MAX_LINES = 80;
const ACTION_MAX = 180;
const SAST_MS = 2 * 3_600_000;

export type DigestSource = "ask" | "card" | "issue" | "plugin" | "approval";

export interface DigestItem {
  /** Stable key (`ask:<id>`, `card:<id>`, `issue:<id>`, a plugin's key). */
  key: string;
  source: DigestSource;
  /** The one thing to do, in the asker's words. */
  action: string;
  /** More of what the asker wrote (why, steps, prompt): read for the grouping only. */
  detail?: string | null;
  /** Absolute link to where the owner acts or reads. */
  href: string | null;
  issueId: string | null;
  identifier: string | null;
  /** ISO time the item started waiting. */
  since: string | null;
  /** Open tasks that wait behind it. */
  holds: number;
  /** Set when the answer applies by itself: the answer and when. */
  autoApply?: { answer: string; at: string } | null;
  /** The Cockpit ask kind when the item is an ask. */
  askKind?: string | null;
}

const PLACE_RULES: Array<[DigestPlace, RegExp]> = [
  // One click that reads like something bigger: sharing a folder, pressing Send on a drafted reply.
  ["quick", /\bshare (the |a )?(drive )?folder\b|\b(press|hit|click) send\b|\bsend (the |this )?(drafted |draft )?(reply|email|message)\b|\bclick upgrade\b/i],
  // The owner's own hands on a phone or in a normal browser.
  ["device", /\b(on|with|from) your (phone|iphone|ipad|android|device)\b|\byour (android|iphone|ipad) (phone|device)?\b|\binstall (it |the build |\S+ ){0,4}(from|on) (testflight|your)\b|\btest purchase\b|\blicen[cs]e[- ]tester purchase\b|\bsandbox (eft|purchase|payment)\b|\bin a normal browser\b|\blive test\b|\bscreenshots? (of|from) your\b|\b(android|ios|device) pass\b/i],
  ["mac", /\b(on|at) the mac\b|\bkeychain\b|\bkeystore\b|~\/\.config|\bxcode\b(?! cloud)|\b(firebase|gcloud) (login|auth)\b|\bin (a |the )?terminal\b|\.p12\b|\bprovisioning profile\b/i],
  ["social", /\b(re)?connect\b.{0,60}\b(linkedin|instagram|facebook|tiktok|youtube|threads|x|twitter)\b|\b(linkedin|instagram|facebook|tiktok|youtube|x|twitter)\b.{0,40}\b(re)?connect(ed|ion)?\b|\bin social\b|\bsocial accounts?\b/i],
  ["applications", /\b(appl(y|ied|ying) (for|to join)|(access|developer|api|platform) applications?|applications? (to|with|for) (google|apple|meta|tiktok|linkedin|aws)|(meta|tiktok|linkedin|google) (apps?|marketing api)|developer (access|token|platform)|standard access|api access|verification|app review|demo video|waiting on (google|apple|meta|tiktok|linkedin|ozow|aws)|(google|apple|meta|tiktok|linkedin)('s)? (reply|approval|review)|repl(y|ied) to (google|apple|meta|tiktok|linkedin)|sign[- ]?ups?|create(d)? (the )?accounts?)\b/i],
  ["stores", /\b(app store connect|play console|app store|play store|google play|testflight|app privacy|xcode cloud|licen[cs]e[- ]tester|sandbox tester|apple ads|store listing)\b/i],
  ["vault", /\bvault\b|\b(log ?in|login|sign ?in)\b.{0,40}\b(panel|hosting|registrar|portal|admin|dashboard|account)\b|\b(hosting|registrar|cpanel|wp admin|wordpress admin) (log ?in|login|panel)\b|\b\S+\.(co\.za|com) (log ?in|login)\b|\busername and password\b|\bno agent has an? .{0,40}login\b/i],
  ["secrets", /\b(secrets?|api keys?|private keys?|access keys?|service account (json|key)|webhook (secret|auth|id)|tokens?|dkim|cname|dns records?|env(ironment)? var\w*|credentials?|deploy access)\b/i],
  ["quick", /\b(click|press|tick|by hand|confirm (that|you|once|only)|have you|did you|accept when|upgrade in)\b/i],
];

/** A headline that opens with a choice is a decision, whatever the small print mentions. */
const DECISION_HEADLINE = /^(approve|deploy|merge|release|which|pick|choose|decide|should|plan sign-off|accept this plan)\b/i;

/** Where the owner acts for one item, read from what the asker wrote: the headline first, then the rest. Anything unplaced is a decision. */
export function placeOf(item: Pick<DigestItem, "action" | "detail" | "source" | "askKind">): DigestPlace {
  for (const [place, rule] of PLACE_RULES) if (rule.test(item.action)) return place;
  if (DECISION_HEADLINE.test(item.action.trim())) return "decisions";
  const text = `${item.action}\n${item.detail ?? ""}`;
  for (const [place, rule] of PLACE_RULES) if (rule.test(text)) return place;
  // An approval card with nothing else to go on is one click.
  return item.source === "approval" ? "quick" : "decisions";
}

/** `YYYY-MM-DD` of the SAST day `now` falls in. */
export function sastDate(now: Date): string {
  return new Date(now.getTime() + SAST_MS).toISOString().slice(0, 10);
}

/** The hour (0-23) in SAST. */
export function sastHour(now: Date): number {
  return new Date(now.getTime() + SAST_MS).getUTCHours();
}

/** The UTC instant the SAST day of `now` began. */
export function sastDayStart(now: Date): Date {
  return new Date(Date.parse(`${sastDate(now)}T00:00:00.000Z`) - SAST_MS);
}

/** True when the digest should be posted now: from 16:00 SAST, caught up until the evening, once a day. */
export function digestDue(now: Date, lastPostedDate: string | null): boolean {
  const hour = sastHour(now);
  return hour >= DIGEST_HOUR_SAST && hour <= DIGEST_LAST_HOUR_SAST && lastPostedDate !== sastDate(now);
}

function daysWaited(since: string | null, now: Date): number | null {
  const t = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

function oneLine(text: string, max = ACTION_MAX): string {
  // Markdown that would break the list (links are added by the digest itself) is flattened.
  const flat = text.replace(/\s+/g, " ").replace(/[[\]]/g, "").replace(/^[#>*\-\s]+/, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function clock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + SAST_MS);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export interface DigestGroup {
  place: DigestPlace;
  title: string;
  items: DigestItem[];
}

/** Items by place, each group ordered by what unblocks most, then oldest. Empty groups are left out. */
export function groupDigest(items: DigestItem[]): DigestGroup[] {
  const byPlace = new Map<DigestPlace, DigestItem[]>();
  for (const item of items) {
    const place = placeOf(item);
    const list = byPlace.get(place);
    if (list) list.push(item);
    else byPlace.set(place, [item]);
  }
  const time = (item: DigestItem) => (item.since && Number.isFinite(Date.parse(item.since)) ? Date.parse(item.since) : Number.POSITIVE_INFINITY);
  return DIGEST_PLACES.filter((place) => byPlace.has(place)).map((place) => ({
    place,
    title: DIGEST_PLACE_TITLE[place],
    items: byPlace.get(place)!.sort((a, b) => b.holds - a.holds || time(a) - time(b) || a.key.localeCompare(b.key)),
  }));
}

/** One day's numbers, kept so the next digests can show the trend. */
export interface DigestDay {
  date: string;
  /** Asks raised to the owner that day (Cockpit asks and host cards). */
  newAsks: number;
  /** Items open when the digest was built. */
  open: number;
  /** Days the oldest open item had waited. */
  oldestDays: number | null;
}

export interface DigestStats {
  /** Asks raised to the owner today, or null when they could not be counted. */
  newAsks: number | null;
  /** Asks that went to a deciding seat today instead of the owner. */
  routed: number | null;
  /** Answers applied by the 24-hour rule since the last digest. */
  applied: Array<{ identifier: string | null; href: string | null; answer: string }>;
  /** Earlier days, newest last (from the stored digests). */
  history: DigestDay[];
  /** Sources that could not be read, in plain words. */
  unread: string[];
}

export function oldestItem(items: DigestItem[]): DigestItem | null {
  let oldest: DigestItem | null = null;
  for (const item of items) {
    const t = item.since ? Date.parse(item.since) : Number.NaN;
    if (!Number.isFinite(t)) continue;
    if (!oldest || t < Date.parse(oldest.since!)) oldest = item;
  }
  return oldest;
}

function link(item: Pick<DigestItem, "identifier" | "href">): string {
  const label = item.identifier ?? "Open";
  return item.href ? `[${label}](${item.href})` : label;
}

export function digestLine(item: DigestItem, now: Date): string {
  const parts = [`- ${link(item)} ${oneLine(item.action)}`.trimEnd()];
  const tail: string[] = [];
  if (item.holds > 0) tail.push(`Holds ${item.holds}.`);
  const days = daysWaited(item.since, now);
  if (days !== null && days >= 2) tail.push(`Waited ${days} days.`);
  if (item.autoApply) tail.push(`Applies by itself ${clock(item.autoApply.at)}: ${oneLine(item.autoApply.answer, 80)}.`);
  const head = parts[0]!.replace(/[.\s]+$/, "");
  return [/[?!…]$/.test(head) ? head : `${head}.`, ...tail].join(" ");
}

export function digestTitle(now: Date): string {
  return `16:00 digest ${sastDate(now)}`;
}

/** The digest as markdown: header with the trend, then one section per place. */
export function renderDigest(input: { items: DigestItem[]; stats: DigestStats; now: Date; cockpitHref?: string | null }): string {
  const { items, stats, now } = input;
  const groups = groupDigest(items);
  const oldest = oldestItem(items);
  const oldestDays = oldest ? daysWaited(oldest.since, now) : null;
  const yesterday = stats.history.at(-1) ?? null;
  const head = [
    `${items.length} ${items.length === 1 ? "item waits" : "items wait"} on you, in ${groups.length} ${groups.length === 1 ? "place" : "places"}.`,
    stats.newAsks === null ? "New asks today: not counted." : `New asks today: ${stats.newAsks}${yesterday ? ` (${yesterday.date.slice(5)}: ${yesterday.newAsks})` : " (first reading)"}.`,
    oldest && oldestDays !== null ? `Oldest open: ${link(oldest)}, ${oldestDays} ${oldestDays === 1 ? "day" : "days"}.` : null,
  ].filter(Boolean);
  const lines: string[] = [head.join(" "), ""];
  if (stats.history.length > 1) {
    const recent = stats.history.slice(-7);
    lines.push(`Last ${recent.length} digests, open items: ${recent.map((d) => d.open).join(", ")}. New asks: ${recent.map((d) => d.newAsks).join(", ")}.`, "");
  }
  let shown = 0;
  for (const group of groups) {
    if (shown >= DIGEST_MAX_LINES) break;
    lines.push(`**${group.title}** (${group.items.length})`);
    for (const item of group.items) {
      if (shown >= DIGEST_MAX_LINES) break;
      lines.push(digestLine(item, now));
      shown += 1;
    }
    lines.push("");
  }
  if (shown < items.length) lines.push(`${items.length - shown} more not shown${input.cockpitHref ? `: [Waiting on you](${input.cockpitHref})` : ""}.`, "");
  if (stats.applied.length) {
    lines.push("**Applied by itself since the last digest** (not hard stops, recommended answer, no reply in 24 hours; reply on the task to change one)");
    for (const a of stats.applied.slice(0, 15)) lines.push(`- ${link(a)} ${oneLine(a.answer, 120)}`);
    lines.push("");
  }
  const foot: string[] = [];
  if (stats.routed !== null && stats.routed > 0) foot.push(`${stats.routed} ${stats.routed === 1 ? "ask" : "asks"} today went to the seat that decides ${stats.routed === 1 ? "it" : "them"}, not to you.`);
  if (stats.unread.length) foot.push(`Not read this time: ${stats.unread.join(", ")}.`);
  foot.push("Answer on each task. This list is rebuilt tomorrow at 16:00; yesterday's is closed.");
  lines.push(foot.join(" "));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The day's numbers to store, and the history trimmed to two weeks. */
export function nextHistory(history: DigestDay[], today: DigestDay): DigestDay[] {
  return [...history.filter((d) => d.date !== today.date), today].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
}

export function parseHistory(value: unknown): DigestDay[] {
  if (!Array.isArray(value)) return [];
  const out: DigestDay[] = [];
  for (const raw of value) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!row || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    out.push({
      date: row.date,
      newAsks: typeof row.newAsks === "number" && Number.isFinite(row.newAsks) ? row.newAsks : 0,
      open: typeof row.open === "number" && Number.isFinite(row.open) ? row.open : 0,
      oldestDays: typeof row.oldestDays === "number" && Number.isFinite(row.oldestDays) ? row.oldestDays : null,
    });
  }
  return out.slice(-14);
}
