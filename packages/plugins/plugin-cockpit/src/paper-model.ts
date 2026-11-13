/**
 * The Daily Paper (pure part, shared by the worker and the page): the owner's
 * morning and end-of-day report as a newspaper. The Operator writes each
 * edition from what the owner asked for (sections with an instruction each,
 * edited on Cockpit → Paper or with the `paper-settings` tool); the Cockpit
 * keeps every edition, so past ones can be read again.
 *
 * Here: the settings and their defaults, the checks on what an agent
 * publishes, the edition compiled from the numbers when none arrived, the
 * markdown copy that goes on the Daily brief issue, and when things are due.
 * No node or host imports.
 */

export const PAPER_EDITIONS = ["morning", "evening"] as const;
export type PaperEditionKey = (typeof PAPER_EDITIONS)[number];
export const EDITION_LABEL: Record<PaperEditionKey, string> = { morning: "Morning edition", evening: "Evening edition" };

/** Where a section's facts come from: the company's own records, or the outside world (news, an X account). */
export type SectionSource = "company" | "web";

export interface PaperSectionSpec {
  id: string;
  title: string;
  /** What the owner wants in it, in their own words. */
  instruction: string;
  source: SectionSource;
  enabled: boolean;
}

export interface PaperEditionSettings {
  enabled: boolean;
  /** `HH:MM` in SAST. Evening: when the Operator is asked to write it. Morning: when the daily review starts (the routine owns that time). */
  time: string;
  days: "every" | "weekdays";
  /** Standing instructions for this edition ("keep it under two minutes", "lead with cash"). */
  note: string;
  sections: PaperSectionSpec[];
}

export interface PaperSettings {
  /** The masthead. Empty: "The <company> Daily". */
  name: string;
  editions: Record<PaperEditionKey, PaperEditionSettings>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type FigureTone = "ok" | "warn" | "bad" | "neutral";

export interface PaperFigure {
  label: string;
  value: string;
  note?: string;
  tone?: FigureTone;
}

export interface PaperSection {
  id: string;
  title: string;
  /** Markdown: paragraphs, `-` and `1.` lists, `###` sub-heads, **bold**, links. */
  body: string;
  source: SectionSource;
}

export interface PaperEditionDoc {
  date: string;
  edition: PaperEditionKey;
  /** Counts up with every new edition of the company (the "No." on the masthead). */
  number: number;
  name: string;
  headline: string;
  standfirst: string;
  figures: PaperFigure[];
  sections: PaperSection[];
  /** `auto`: compiled by the Cockpit from the numbers because no written edition arrived. */
  source: "agent" | "auto";
  author: string | null;
  authorAgentId: string | null;
  publishedAt: string;
  revision: number;
  words: number;
}

/** What the archive lists (one per edition, kept per month). */
export interface PaperIndexEntry {
  date: string;
  edition: PaperEditionKey;
  number: number;
  headline: string;
  standfirst: string;
  source: "agent" | "auto";
  author: string | null;
  publishedAt: string;
  words: number;
}

export const PAPER_LIMITS = {
  name: 60,
  headline: 160,
  standfirst: 700,
  figures: 8,
  figureLabel: 40,
  figureValue: 40,
  figureNote: 90,
  sections: 16,
  sectionTitle: 60,
  sectionBody: 6000,
  instruction: 800,
  note: 1200,
  totalChars: 40_000,
  /** The standfirst kept in the archive list. */
  indexStandfirst: 220,
} as const;

/** How long after an edition's time the Cockpit waits before it compiles one itself. */
export const FALLBACK_AFTER_MINUTES = 120;
/** The Cockpit stops trying this long after an edition's time: a morning paper compiled at night is noise. */
export const FALLBACK_WINDOW_MINUTES = 480;
/** A written edition may be published for today or up to this many days back (a late one). */
export const BACKDATE_DAYS = 3;

// ---------------------------------------------------------------------------
// Time (SAST, as the digest)
// ---------------------------------------------------------------------------

const SAST_MS = 2 * 3_600_000;

export function sastDate(now: Date): string {
  return new Date(now.getTime() + SAST_MS).toISOString().slice(0, 10);
}

/** Minutes since midnight in SAST. */
export function sastMinutes(now: Date): number {
  const d = new Date(now.getTime() + SAST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 0 Sunday to 6 Saturday, in SAST. */
export function sastWeekday(now: Date): number {
  return new Date(now.getTime() + SAST_MS).getUTCDay();
}

export function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isEdition(value: unknown): value is PaperEditionKey {
  return value === "morning" || value === "evening";
}

export function timeMinutes(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "Friday, 13 November 2026" for a `YYYY-MM-DD` day. */
export function longDate(date: string): string {
  const t = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(t)) return date;
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(t));
}

/** "Fri 13 Nov". */
export function shortDate(date: string): string {
  const t = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(t)) return date;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(t)).replace(",", "");
}

/** `HH:MM` SAST of an ISO time. */
export function sastClock(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t + SAST_MS).toISOString().slice(11, 16);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const section = (id: string, title: string, instruction: string, source: SectionSource = "company", enabled = true): PaperSectionSpec => ({ id, title, instruction, source, enabled });

/** Sections the owner can add with one click (the editor lists them; an agent may add them too). */
export const SECTION_PRESETS: PaperSectionSpec[] = [
  section("tech-news", "Tech and AI news", "The five tech and AI stories of the last 24 hours that matter most to a small agency that builds with AI agents. One line each with the source link, and a few words on why it matters to us.", "web"),
  section("on-x", "On X", "What @account posted on X since the last edition: the posts worth reading, one line each with a link. Replace @account with the account to follow.", "web"),
  section("business-news", "Business news", "South African business news that touches us or our clients, and the rand against the US dollar. Three lines at most, each with a source link.", "web"),
  section("competitors", "Competitor watch", "Anything new from the competitors we name here (a launch, a price change, a post that did well). Name them in this instruction.", "web"),
  section("calendar", "Your day", "The owner's meetings and deadlines today, in time order, with what to prepare for each.", "company"),
];

export function defaultSections(edition: PaperEditionKey): PaperSectionSpec[] {
  if (edition === "morning") {
    return [
      section("needs-you", "Needs you", "What waits on the owner, the item that unblocks the most first. Group it: money (amount and link), client releases, sign-ins and access (the urgent one first, with why it matters), then one line with the counts of routine sign-offs. Say in one line what is the same as yesterday instead of repeating it."),
      section("money", "Money", "Cash, revenue this month, what is overdue and from whom, and the invoices and quotes sent or paid since the last edition."),
      section("clients", "Client desk", "One line or short paragraph per client that moved: work shipped, replies received, messages that went out, anything a client waits on."),
      section("sales-marketing", "Sales and marketing", "New leads, deals that moved, follow-ups due today; posts published and how the best one did; SEO work finished."),
      section("risks", "Risks", "What could hurt: outages, agents paused or stuck, credentials expiring or exposed, spend out of line, deadlines at risk. Say what is being done about each."),
      section("team", "The team", "What the agents finished since the last edition, by name. Who is stuck, paused or failing, and who is picking that work up."),
      section("today", "Today", "The few things that will move the numbers today, each with the agent that owns it."),
      section("good-news", "Good news", "Wins worth a smile: a result, a number, a kind reply from a client."),
      { ...SECTION_PRESETS[0]!, enabled: false },
    ];
  }
  return [
    section("done-today", "Done today", "What was finished today, by agent or by client, most important first, each with a link."),
    section("decided", "Decided today", "What the owner cleared today, what the deciding seats settled, and what the 24-hour rule answered by itself."),
    section("still-open", "Still open for you", "The five items that matter most out of what still waits on the owner, with links, then the count of the rest. Point to today's 16:00 digest for the full list."),
    section("money", "Money today", "Money in and out today: invoices sent and paid, quotes accepted, cash at the close, anything now overdue."),
    section("clients", "Client desk", "What each client saw from us today and what they said back."),
    section("incidents", "Incidents and risks", "What broke or nearly broke today, what was done, and what is still at risk tonight."),
    section("tomorrow", "Tomorrow", "What is planned for tomorrow and the one thing the owner could do tonight that would unblock the most."),
    { ...SECTION_PRESETS[0]!, enabled: false },
  ];
}

export function defaultSettings(): PaperSettings {
  return {
    name: "",
    editions: {
      morning: { enabled: true, time: "07:00", days: "every", note: "", sections: defaultSections("morning") },
      evening: { enabled: true, time: "17:00", days: "every", note: "", sections: defaultSections("evening") },
    },
    updatedAt: null,
    updatedBy: null,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

function oneLine(value: unknown, max: number): string {
  return text(value, max * 2).replace(/\s+/g, " ").slice(0, max).trim();
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Sections as stored: a title each, unique ids, at most {@link PAPER_LIMITS.sections}. Rows with no title are dropped. */
export function normalizeSections(value: unknown): PaperSectionSpec[] {
  if (!Array.isArray(value)) return [];
  const out: PaperSectionSpec[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const row = object(raw);
    if (!row) continue;
    const title = oneLine(row.title, PAPER_LIMITS.sectionTitle);
    if (!title) continue;
    let id = slug(typeof row.id === "string" && row.id ? row.id : title) || `section-${out.length + 1}`;
    for (let n = 2; seen.has(id); n += 1) id = `${id.replace(/-\d+$/, "")}-${n}`;
    seen.add(id);
    out.push({ id, title, instruction: text(row.instruction, PAPER_LIMITS.instruction), source: row.source === "web" ? "web" : "company", enabled: row.enabled !== false });
    if (out.length >= PAPER_LIMITS.sections) break;
  }
  return out;
}

/** Stored settings made whole: anything missing or malformed takes its default. */
export function normalizeSettings(value: unknown): PaperSettings {
  const base = defaultSettings();
  const row = object(value);
  if (!row) return base;
  const editions = object(row.editions) ?? {};
  for (const key of PAPER_EDITIONS) {
    const stored = object(editions[key]);
    if (!stored) continue;
    const fallback = base.editions[key];
    base.editions[key] = {
      enabled: stored.enabled !== false,
      // The morning edition follows the daily review routine, so its time is not the owner's to set here.
      time: key === "evening" && typeof stored.time === "string" && timeMinutes(stored.time) !== null ? stored.time : fallback.time,
      days: stored.days === "weekdays" ? "weekdays" : "every",
      note: text(stored.note, PAPER_LIMITS.note),
      sections: Array.isArray(stored.sections) ? normalizeSections(stored.sections) : fallback.sections,
    };
  }
  return {
    name: oneLine(row.name, PAPER_LIMITS.name),
    editions: base.editions,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    updatedBy: typeof row.updatedBy === "string" ? row.updatedBy : null,
  };
}

export function paperName(settings: Pick<PaperSettings, "name">, companyName: string | null | undefined): string {
  if (settings.name) return settings.name;
  const company = (companyName ?? "").trim();
  return company ? `The ${company} Daily` : "The Daily Paper";
}

/** True when this edition is written on the day `now` falls in. */
export function runsToday(settings: PaperEditionSettings, now: Date): boolean {
  if (!settings.enabled) return false;
  const day = sastWeekday(now);
  return settings.days === "every" || (day >= 1 && day <= 5);
}

/** The evening edition's writing task is due: its time has come today and none was opened or published for today. */
export function taskDue(settings: PaperEditionSettings, now: Date, state: { taskDate: string | null; publishedDate: string | null }): boolean {
  if (!runsToday(settings, now)) return false;
  const at = timeMinutes(settings.time);
  if (at === null || sastMinutes(now) < at) return false;
  const today = sastDate(now);
  return state.taskDate !== today && state.publishedDate !== today;
}

/**
 * No edition arrived {@link FALLBACK_AFTER_MINUTES} after its time: the Cockpit compiles one (today only, never a past day,
 * and not later than {@link FALLBACK_WINDOW_MINUTES} after the time). An edition whose time had already passed when the
 * paper was first switched on for the company (`firstSeenAt`) is not made up for.
 */
export function fallbackDue(settings: PaperEditionSettings, now: Date, state: { publishedDate: string | null; firstSeenAt?: string | null }): boolean {
  if (!runsToday(settings, now)) return false;
  const at = timeMinutes(settings.time);
  const minute = sastMinutes(now);
  if (at === null || minute < at + FALLBACK_AFTER_MINUTES || minute > at + FALLBACK_WINDOW_MINUTES) return false;
  const today = sastDate(now);
  if (state.publishedDate === today) return false;
  const due = Date.parse(`${today}T00:00:00.000Z`) - SAST_MS + at * 60_000;
  const seen = state.firstSeenAt ? Date.parse(state.firstSeenAt) : Number.NaN;
  return !(Number.isFinite(seen) && seen > due);
}

// ---------------------------------------------------------------------------
// What an agent publishes
// ---------------------------------------------------------------------------

export interface PublishInput {
  edition: PaperEditionKey;
  date: string;
  headline: string;
  standfirst: string;
  figures: PaperFigure[];
  sections: PaperSection[];
}

export type PublishCheck = { ok: true; input: PublishInput } | { ok: false; error: string };

export function countWords(doc: Pick<PaperEditionDoc, "headline" | "standfirst" | "sections">): number {
  const all = [doc.headline, doc.standfirst, ...doc.sections.map((s) => `${s.title} ${s.body}`)].join(" ");
  // A link counts as its label.
  return all.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const TONES = new Set<FigureTone>(["ok", "warn", "bad", "neutral"]);

/** Reads and checks a publish call. Sections take their source from the owner's section list (matched by id, then title). */
export function checkPublish(raw: unknown, spec: PaperSectionSpec[], now: Date): PublishCheck {
  const row = object(raw);
  if (!row) return { ok: false, error: "Pass an object with edition, headline, standfirst and sections." };
  if (!isEdition(row.edition)) return { ok: false, error: "edition must be \"morning\" or \"evening\"." };
  const today = sastDate(now);
  const date = row.date == null || row.date === "" ? today : row.date;
  if (!isDate(date)) return { ok: false, error: "date must be YYYY-MM-DD (leave it out for today)." };
  if (date > today) return { ok: false, error: `date ${date} is in the future; today is ${today}.` };
  if (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) > BACKDATE_DAYS * 86_400_000) return { ok: false, error: `date ${date} is more than ${BACKDATE_DAYS} days back.` };
  const headline = oneLine(row.headline, PAPER_LIMITS.headline);
  if (!headline) return { ok: false, error: "headline is required: the one thing the owner must know, in a few words." };
  const standfirst = text(row.standfirst, PAPER_LIMITS.standfirst).replace(/\n{2,}/g, "\n");
  if (!standfirst) return { ok: false, error: "standfirst is required: two or three sentences on where the company stands." };
  if (!Array.isArray(row.sections) || row.sections.length === 0) return { ok: false, error: "sections is required: one entry per section, each with a title and a body." };
  if (row.sections.length > PAPER_LIMITS.sections) return { ok: false, error: `At most ${PAPER_LIMITS.sections} sections.` };

  const byId = new Map(spec.map((s) => [s.id, s]));
  const byTitle = new Map(spec.map((s) => [s.title.toLowerCase(), s]));
  const sections: PaperSection[] = [];
  const seen = new Set<string>();
  let total = headline.length + standfirst.length;
  for (const [index, entry] of row.sections.entries()) {
    const item = object(entry);
    if (!item) return { ok: false, error: `sections[${index}] must be an object with title and body.` };
    const rawBody = typeof item.body === "string" ? item.body.replace(/\r\n?/g, "\n").trim() : "";
    if (!rawBody) continue;
    if (rawBody.length > PAPER_LIMITS.sectionBody) return { ok: false, error: `sections[${index}] is ${rawBody.length} characters; the most is ${PAPER_LIMITS.sectionBody}. Cut it: the owner reads this on a phone.` };
    const known = (typeof item.id === "string" && byId.get(slug(item.id))) || byTitle.get(oneLine(item.title, PAPER_LIMITS.sectionTitle).toLowerCase()) || null;
    const title = oneLine(item.title, PAPER_LIMITS.sectionTitle) || known?.title || "";
    if (!title) return { ok: false, error: `sections[${index}] needs a title.` };
    let id = known?.id ?? (slug(typeof item.id === "string" && item.id ? item.id : title) || `section-${index + 1}`);
    for (let n = 2; seen.has(id); n += 1) id = `${id.replace(/-\d+$/, "")}-${n}`;
    seen.add(id);
    total += rawBody.length;
    sections.push({ id, title, body: rawBody, source: known?.source ?? (item.source === "web" ? "web" : "company") });
  }
  if (sections.length === 0) return { ok: false, error: "Every section body is empty. Write at least one section." };
  if (total > PAPER_LIMITS.totalChars) return { ok: false, error: `The edition is ${total} characters; the most is ${PAPER_LIMITS.totalChars}.` };

  const figures: PaperFigure[] = [];
  if (row.figures != null) {
    if (!Array.isArray(row.figures)) return { ok: false, error: "figures must be a list of { label, value }." };
    for (const entry of row.figures.slice(0, PAPER_LIMITS.figures)) {
      const item = object(entry);
      const label = oneLine(item?.label, PAPER_LIMITS.figureLabel);
      const value = oneLine(typeof item?.value === "number" ? String(item.value) : item?.value, PAPER_LIMITS.figureValue);
      if (!label || !value) continue;
      const note = oneLine(item?.note, PAPER_LIMITS.figureNote);
      figures.push({ label, value, ...(note ? { note } : {}), ...(TONES.has(item?.tone as FigureTone) && item?.tone !== "neutral" ? { tone: item!.tone as FigureTone } : {}) });
    }
  }
  return { ok: true, input: { edition: row.edition, date, headline, standfirst, figures, sections } };
}

export function indexEntry(doc: PaperEditionDoc): PaperIndexEntry {
  const standfirst = doc.standfirst.replace(/\s+/g, " ");
  return {
    date: doc.date,
    edition: doc.edition,
    number: doc.number,
    headline: doc.headline,
    standfirst: standfirst.length > PAPER_LIMITS.indexStandfirst ? `${standfirst.slice(0, PAPER_LIMITS.indexStandfirst - 1).trimEnd()}…` : standfirst,
    source: doc.source,
    author: doc.author,
    publishedAt: doc.publishedAt,
    words: doc.words,
  };
}

const EDITION_ORDER: Record<PaperEditionKey, number> = { morning: 0, evening: 1 };

/** Newest first: by day, the evening edition above the morning one. */
export function sortIndex(entries: PaperIndexEntry[]): PaperIndexEntry[] {
  return [...entries].sort((a, b) => (a.date === b.date ? EDITION_ORDER[b.edition] - EDITION_ORDER[a.edition] : a.date < b.date ? 1 : -1));
}

/** The month's list with this edition put in (it replaces the same day and edition). */
export function upsertIndex(entries: PaperIndexEntry[], entry: PaperIndexEntry): PaperIndexEntry[] {
  return sortIndex([...entries.filter((e) => !(e.date === entry.date && e.edition === entry.edition)), entry]);
}

export function parseIndex(value: unknown): PaperIndexEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperIndexEntry[] = [];
  for (const raw of value) {
    const row = object(raw);
    if (!row || !isDate(row.date) || !isEdition(row.edition)) continue;
    out.push({
      date: row.date,
      edition: row.edition,
      number: typeof row.number === "number" ? row.number : 0,
      headline: typeof row.headline === "string" ? row.headline : "",
      standfirst: typeof row.standfirst === "string" ? row.standfirst : "",
      source: row.source === "auto" ? "auto" : "agent",
      author: typeof row.author === "string" ? row.author : null,
      publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : "",
      words: typeof row.words === "number" ? row.words : 0,
    });
  }
  return sortIndex(out);
}

export function parseEdition(value: unknown): PaperEditionDoc | null {
  const row = object(value);
  if (!row || !isDate(row.date) || !isEdition(row.edition) || typeof row.headline !== "string" || !Array.isArray(row.sections)) return null;
  return {
    date: row.date,
    edition: row.edition,
    number: typeof row.number === "number" ? row.number : 0,
    name: typeof row.name === "string" ? row.name : "The Daily Paper",
    headline: row.headline,
    standfirst: typeof row.standfirst === "string" ? row.standfirst : "",
    figures: Array.isArray(row.figures) ? (row.figures as unknown[]).flatMap((f) => {
      const item = object(f);
      return item && typeof item.label === "string" && typeof item.value === "string"
        ? [{ label: item.label, value: item.value, ...(typeof item.note === "string" ? { note: item.note } : {}), ...(TONES.has(item.tone as FigureTone) ? { tone: item.tone as FigureTone } : {}) }]
        : [];
    }) : [],
    sections: (row.sections as unknown[]).flatMap((s) => {
      const item = object(s);
      return item && typeof item.title === "string" && typeof item.body === "string"
        ? [{ id: typeof item.id === "string" ? item.id : slug(item.title), title: item.title, body: item.body, source: item.source === "web" ? ("web" as const) : ("company" as const) }]
        : [];
    }),
    source: row.source === "auto" ? "auto" : "agent",
    author: typeof row.author === "string" ? row.author : null,
    authorAgentId: typeof row.authorAgentId === "string" ? row.authorAgentId : null,
    publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : "",
    revision: typeof row.revision === "number" ? row.revision : 1,
    words: typeof row.words === "number" ? row.words : 0,
  };
}

// ---------------------------------------------------------------------------
// The copy on the Daily brief issue
// ---------------------------------------------------------------------------

/** The edition as one markdown comment (the Daily brief issue keeps the thread the owner replies on). Cut to `max` with a pointer to the paper. */
export function editionMarkdown(doc: PaperEditionDoc, paperHref: string, max = 7600): string {
  const head = [
    `**${doc.name}: ${EDITION_LABEL[doc.edition].toLowerCase()}, ${longDate(doc.date)}**`,
    "",
    `## ${doc.headline}`,
    "",
    doc.standfirst,
    ...(doc.figures.length ? ["", doc.figures.map((f) => `**${f.label}** ${f.value}${f.note ? ` (${f.note})` : ""}`).join(" · ")] : []),
  ].join("\n");
  const foot = `\n\n[Read it as a paper](${paperHref})`;
  let body = head;
  let cut = false;
  for (const s of doc.sections) {
    const next = `\n\n**${s.title}**\n\n${s.body}`;
    if (body.length + next.length + foot.length + 60 > max) {
      cut = true;
      break;
    }
    body += next;
  }
  return `${body}${cut ? "\n\n_The rest is in the paper._" : ""}${foot}`;
}

// ---------------------------------------------------------------------------
// The daily brief as an edition
// ---------------------------------------------------------------------------

const BRIEF_HEAD = /^\s*(?:#{1,6}\s+(.+?)|\*\*([^*]+)\*\*:?)\s*$/;
const BRIEF_TITLE = /^\s*\*\*((?:daily|morning|evening)\b[^*]*)\*\*\s*(.*)$/i;

function cutAt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30)).replace(/[\s,;:.]+$/, "")}…`;
}

/** Markdown without its marks, for a headline or a standfirst. */
function plainLine(value: string): string {
  return value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
}

/**
 * The Operator's markdown brief (`post-daily-brief`) read as an edition, so a company whose Operator still
 * posts the brief has a paper too: the bold lines and `##` heads become sections, the text before the first
 * one the standfirst. Null for the Weekly retro and for a text with no sections.
 */
export function briefToEdition(markdown: string): Omit<PublishInput, "edition" | "date"> | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  if (/weekly retro/i.test(lines.slice(0, 3).join(" "))) return null;
  let title = "";
  const preamble: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const line of lines) {
    const titled = !title && sections.length === 0 && preamble.every((l) => !l.trim()) ? BRIEF_TITLE.exec(line) : null;
    if (titled) {
      title = titled[1]!.replace(/[.:]\s*$/, "").trim();
      if (titled[2]) preamble.push(titled[2]);
      continue;
    }
    const head = BRIEF_HEAD.exec(line);
    if (head) {
      sections.push({ title: oneLine(head[1] ?? head[2], 200), lines: [] });
      continue;
    }
    (sections.length ? sections[sections.length - 1]!.lines : preamble).push(line);
  }
  const out: PaperSection[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    const body = s.lines.join("\n").trim().slice(0, PAPER_LIMITS.sectionBody);
    if (!body) continue;
    // "Waiting on Peet (65, batched; hard stops first)": the bracket is a note, not part of the title.
    const note = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s.title);
    const sectionTitle = oneLine(note ? note[1] : s.title, PAPER_LIMITS.sectionTitle) || "Notes";
    let id = slug(sectionTitle) || `section-${out.length + 1}`;
    for (let n = 2; seen.has(id); n += 1) id = `${id.replace(/-\d+$/, "")}-${n}`;
    seen.add(id);
    out.push({ id, title: sectionTitle, body, source: "company" });
    if (out.length >= PAPER_LIMITS.sections) break;
  }
  if (out.length === 0) return null;
  const intro = plainLine(preamble.join(" "));
  const waiting = sections.map((s) => /^waiting on\b[^()]*\((\d+)/i.exec(s.title)).find(Boolean);
  const firstLine = plainLine(out[0]!.body.split("\n").find((l) => l.trim()) ?? "");
  const headline = waiting ? `${waiting[1]} ${waiting[1] === "1" ? "item waits" : "items wait"} on you` : cutAt(intro || firstLine || title || "Daily brief", 110);
  const standfirst = cutAt(intro || (waiting ? firstLine : "") || title || "The Operator's daily brief.", 420);
  return { headline, standfirst, figures: [], sections: out };
}

// ---------------------------------------------------------------------------
// The edition the Cockpit compiles itself
// ---------------------------------------------------------------------------

/** The parts of the company brief the compiled edition reads (see `companyBrief`). */
export interface BriefLike {
  today: string;
  waiting: Array<{ title: string; why?: string | null; kind: string; href: string | null; identifier?: string | null; link?: string | null; ageHours?: number | null }>;
  health: { status: string; problems: Array<{ plugin: string; status: string; title: string; detail: string | null; href: string | null }>; agentAlerts: Array<{ title: string; detail: string | null; href: string | null }> };
  kpis: Record<string, Array<{ label: string; value: string | number; tone?: string; href: string | null }>>;
  activity: Array<{ agent: string; done: Array<{ text: string; href: string | null }> }>;
  agents: Array<{ name: string; status: string; alert?: string | null }>;
  degraded: string[];
  links: { cockpit: string | null };
}

const mdLink = (label: string, href: string | null | undefined) => (href ? `[${label}](${href})` : label);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function figureTone(tone: string | undefined): FigureTone | undefined {
  return tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "ok" ? "ok" : undefined;
}

/**
 * An edition from the numbers alone, for a day the written one did not arrive.
 * Company sections the Cockpit can fill from the brief are filled; sections
 * that need a writer (the web, a judgement) say so in one line.
 */
export function compileEdition(input: { brief: BriefLike; edition: PaperEditionKey; date: string; spec: PaperSectionSpec[]; why: string }): Omit<PublishInput, "edition" | "date"> {
  const { brief } = input;
  const waiting = brief.waiting;
  const oldestHours = waiting.reduce((max, w) => Math.max(max, w.ageHours ?? 0), 0);
  const problems = brief.health.problems.filter((p) => p.status === "bad");
  const headline = waiting.length
    ? `${plural(waiting.length, "item")} wait on you${oldestHours >= 48 ? `, the oldest for ${Math.floor(oldestHours / 24)} days` : ""}`
    : problems.length
      ? `${plural(problems.length, "problem")} in system health`
      : "Nothing waits on you";
  const standfirst = `${brief.today} ${input.why}`.trim();

  const money = brief.kpis.money ?? [];
  const figures: PaperFigure[] = [
    ...money.slice(0, 4).map((k) => ({ label: k.label, value: String(k.value), ...(figureTone(k.tone) ? { tone: figureTone(k.tone)! } : {}) })),
    { label: "Waiting on you", value: String(waiting.length), ...(waiting.length ? { tone: "warn" as const } : {}) },
    { label: "Agents active", value: String(brief.agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length) },
  ].slice(0, PAPER_LIMITS.figures);

  const waitingBody = waiting.length
    ? [
        ...waiting.slice(0, 12).map((w) => `- ${mdLink(w.identifier ? `${w.identifier}: ${w.title}` : w.title, w.link ?? w.href)}${w.why ? `. ${w.why}` : ""}`),
        ...(waiting.length > 12 ? [`- and ${waiting.length - 12} more in ${mdLink("the Cockpit", brief.links.cockpit)}.`] : []),
      ].join("\n")
    : "Nothing waits on you.";
  const moneyBody = money.length ? money.map((k) => `- ${mdLink(k.label, k.href)}: **${k.value}**`).join("\n") : "The money numbers were not reported.";
  const riskLines = [
    ...brief.health.problems.slice(0, 8).map((p) => `- ${mdLink(p.title, p.href)} (${p.plugin})${p.detail ? `: ${p.detail}` : ""}`),
    ...brief.health.agentAlerts.slice(0, 5).map((a) => `- ${mdLink(a.title, a.href)}${a.detail ? `: ${a.detail}` : ""}`),
  ];
  const riskBody = riskLines.length ? riskLines.join("\n") : "Every health check passes.";
  const teamLines = brief.activity.filter((g) => g.done.length).slice(0, 8).map((g) => `- **${g.agent}**: ${g.done.slice(0, 3).map((d) => mdLink(d.text, d.href)).join("; ")}`);
  const teamBody = teamLines.length ? teamLines.join("\n") : "No finished work was recorded in this period.";
  const pipeline = [...(brief.kpis.pipeline ?? []), ...(brief.kpis.marketing ?? []), ...(brief.kpis.delivery ?? [])];
  const pipelineBody = pipeline.length ? pipeline.slice(0, 10).map((k) => `- ${mdLink(k.label, k.href)}: **${k.value}**`).join("\n") : null;

  const fill: Record<string, string | null> = {
    "needs-you": waitingBody,
    "still-open": waitingBody,
    money: moneyBody,
    risks: riskBody,
    incidents: riskBody,
    team: teamBody,
    "done-today": teamBody,
    "sales-marketing": pipelineBody,
  };
  const sections: PaperSection[] = [];
  const unwritten: string[] = [];
  for (const s of input.spec.filter((x) => x.enabled)) {
    const body = fill[s.id];
    if (body) sections.push({ id: s.id, title: s.title, body, source: s.source });
    else unwritten.push(s.title);
  }
  if (sections.length === 0) sections.push({ id: "needs-you", title: "Needs you", body: waitingBody, source: "company" });
  if (unwritten.length) sections.push({ id: "not-written", title: "Not in this edition", body: `These sections need a writer and were left out: ${unwritten.join(", ")}.`, source: "company" });
  if (brief.degraded.length) sections.push({ id: "gaps", title: "Gaps", body: `Some numbers could not be read in time: ${brief.degraded.join(", ")}.`, source: "company" });
  return { headline, standfirst, figures, sections };
}

// ---------------------------------------------------------------------------
// What the writer is told
// ---------------------------------------------------------------------------

export const WRITING_RULES: readonly string[] = [
  "Write for the owner, who reads it on a phone. Plain words, short sentences, numbers with their unit. No filler and no hype.",
  "headline: the one thing the owner must know, 12 words at most. standfirst: two or three sentences on where the company stands (cash, revenue, what waits and for how long).",
  "figures: up to 6 numbers the owner tracks (cash, revenue this month, overdue, waiting on you, ...), each { label, value, note?, tone? } with tone ok, warn or bad when it is clearly good or bad.",
  "sections: one entry per section in the list, in that order, with the same id. The body is markdown: short paragraphs, - lists, **bold**, [links](...). Use ### for a sub-head inside a section. Link every item the owner can act on, as a Paperclip path (/PREFIX/issues/PREFIX-12) or an https address.",
  "A section with nothing new says so in one line (\"Nothing new since the last edition.\") or is left out. Never pad, and never repeat the previous edition: say what changed.",
  "source company: only facts from company-brief and the other tools. Never invent a number; say \"not reported\" when one is missing.",
  "source web: search the web (and X when the section names an account) for what the instruction asks, from the last 24 hours unless it says otherwise. Give the source link for every item. If it cannot be read today, say so in one line and why.",
];
