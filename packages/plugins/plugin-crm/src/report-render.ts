/**
 * The monthly client report as documents: pure rendering, no database.
 *
 * Three renderings of the same data:
 * - client Markdown: the plain-text body of the email, and the copy a person reads in the approval;
 * - client HTML: the branded page (inline styles, so it survives an email client), also the HTML body of the email;
 * - internal Markdown: the client version plus what only we see (where each number came from, what is
 *   still missing, the work done, the effort and the health score). It is the issue document the agent works from.
 *
 * Every piece of text is escaped for HTML; a number or a sentence from a module or an agent can never become markup.
 */
import type { SignalLine } from "./client-signals.js";
import type { ReportNarrative } from "./care-store.js";

export interface ReportSection {
  /** `seo`, `social`, `campaigns`, `billing`, `mailbox`, `website`, `support` or `work`. */
  module: string;
  title: string;
  /** Who said it: a module's event, an agent that read the module's tools, or the CRM's own records. */
  source: "event" | "agent" | "crm";
  headline: SignalLine[];
  bullets: string[];
  note?: string;
}

export interface MissingModule {
  module: string;
  title: string;
  plugin: string;
  tools: string[];
  ask: string;
}

export interface ReportData {
  version: 1;
  period: string;
  periodLabel: string;
  client: { ref: string; name: string; website: string | null };
  /** The company that sends the report ("Partners in Biz", "Partners in Apps"); the report names no sender when it is not known. */
  brand?: string | null;
  sections: ReportSection[];
  missing: MissingModule[];
  /** Requests the client still owes us, for "what we need from you". */
  waitingOnClient: Array<{ title: string; days: number }>;
  /** Internal only. */
  workDone: { count: number; titles: string[] };
  effort: { issues: number; costCents: number; inputTokens: number; outputTokens: number } | null;
  health: { score: number; band: string } | null;
}

export const EMPTY_NARRATIVE: ReportNarrative = { summary: "", highlights: [], next: [] };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-09` as September 2026. */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : period;
}

/** The SAST month a period covers, as UTC bounds (South Africa is UTC+2 all year). */
export function periodBounds(period: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error("period must be YYYY-MM");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const hours = 2 * 3_600_000;
  return { from: new Date(Date.UTC(year, month - 1, 1) - hours).toISOString(), to: new Date(Date.UTC(year, month, 1) - hours).toISOString() };
}

/** The month before the one `now` falls in, in South African time. */
export function previousPeriod(now: Date): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  const month = sast.getUTCMonth();
  return month === 0 ? `${sast.getUTCFullYear() - 1}-12` : `${sast.getUTCFullYear()}-${String(month).padStart(2, "0")}`;
}

/** The month `now` falls in, in South African time. */
export function currentPeriod(now: Date): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return `${sast.getUTCFullYear()}-${String(sast.getUTCMonth() + 1).padStart(2, "0")}`;
}

const line = (l: SignalLine) => `${l.label}: ${l.value}${l.delta ? ` (${l.delta})` : ""}`;

/** Up to six numbers from the sections, one or two per section, for the top of the report. */
export function atAGlance(sections: ReportSection[]): SignalLine[] {
  const out: SignalLine[] = [];
  for (const section of sections) {
    for (const item of section.headline.slice(0, 2)) if (out.length < 6) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** The report as a client reads it, in Markdown (also the plain-text email). */
export function renderClientMarkdown(data: ReportData, narrative: ReportNarrative): string {
  const out: string[] = [`# Monthly report: ${data.client.name}`, `${data.periodLabel}${data.brand ? ` · ${data.brand}` : ""}`, ""];
  if (narrative.summary.trim()) out.push(narrative.summary.trim(), "");
  const glance = atAGlance(data.sections);
  if (glance.length) out.push("## At a glance", ...glance.map((l) => `- ${line(l)}`), "");
  if (narrative.highlights.length) out.push("## Highlights", ...narrative.highlights.map((h) => `- ${h}`), "");
  for (const section of data.sections) {
    if (section.headline.length === 0 && section.bullets.length === 0 && !section.note) continue;
    out.push(`## ${section.title}`);
    for (const l of section.headline) out.push(`- ${line(l)}`);
    for (const b of section.bullets) out.push(`- ${b}`);
    if (section.note) out.push("", section.note);
    out.push("");
  }
  if (data.waitingOnClient.length) out.push("## What we need from you", ...data.waitingOnClient.map((w) => `- ${w.title} (asked ${w.days} day${w.days === 1 ? "" : "s"} ago)`), "");
  if (narrative.next.length) out.push("## Next month", ...narrative.next.map((n) => `- ${n}`), "");
  out.push("Questions about any of this? Reply to this email and we will answer within a working day.");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

const SOURCE_LABEL: Record<ReportSection["source"], string> = { event: "sent by the module", agent: "read by an agent from the module's tools", crm: "from the CRM's own records" };

/** The working copy: the client's report plus what only we see. The issue document the Account Manager edits through the tools. */
export function renderInternalMarkdown(data: ReportData, narrative: ReportNarrative): string {
  const out: string[] = [renderClientMarkdown(data, narrative), "", "---", "", "## Internal: not sent to the client", ""];
  out.push("### Where the numbers came from");
  for (const s of data.sections) out.push(`- ${s.title}: ${SOURCE_LABEL[s.source]}${s.headline.length + s.bullets.length === 0 ? " (nothing to show)" : ""}`);
  if (data.missing.length) {
    out.push("", "### Not in the report yet: read these and record them");
    for (const m of data.missing) {
      out.push(`- **${m.title}** (${m.plugin}): call ${m.tools.map((t) => `\`${t}\``).join(", ")} for this client and this month: ${m.ask}. Then \`record-client-signal\` with module \`${m.module}\`, period \`${data.period}\`, the headline numbers and a few bullets.`);
    }
  }
  if (!narrative.summary.trim()) out.push("", "### The summary is not written", "Write 3 to 5 plain sentences on how the month went, then `set-report-narrative` (summary, highlights, next).");
  if (data.workDone.count) {
    out.push("", `### Work completed in the client's project (${data.workDone.count})`, ...data.workDone.titles.map((t) => `- ${t}`));
    if (data.workDone.count > data.workDone.titles.length) out.push(`- ... and ${data.workDone.count - data.workDone.titles.length} more`);
    out.push("Pick the ones the client would care about and say them plainly in the highlights; never paste internal ticket titles.");
  }
  if (data.effort) {
    const dollars = (data.effort.costCents / 100).toFixed(2);
    out.push("", "### Effort (notional, internal)", `- ${data.effort.issues} tasks closed, agent compute about $${dollars} (${data.effort.inputTokens.toLocaleString("en-US")} tokens in, ${data.effort.outputTokens.toLocaleString("en-US")} out). Use it to judge whether the retainer is priced right; never show it to the client.`);
  }
  if (data.health) out.push("", "### Customer health", `- ${data.health.score} of 100 (${data.health.band.replace("_", " ")}).`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const NAVY = "#14304f";
const ACCENT = "#2a9d8f";
const INK = "#1f2933";
const MUTED = "#617080";
const RULE = "#e3e8ee";

function ul(items: string[]): string {
  return items.length ? `<ul style="margin:6px 0 0 18px;padding:0;color:${INK};font-size:14px;line-height:1.55">${items.map((i) => `<li style="margin:3px 0">${escapeHtml(i)}</li>`).join("")}</ul>` : "";
}

function heading(text: string): string {
  return `<h2 style="margin:26px 0 6px;font-size:16px;color:${NAVY};border-bottom:2px solid ${RULE};padding-bottom:6px">${escapeHtml(text)}</h2>`;
}

/** The branded page: a header band, the summary, the numbers in tiles, one block per module. Inline styles only. */
export function renderHtml(data: ReportData, narrative: ReportNarrative): string {
  const glance = atAGlance(data.sections);
  const tiles = glance
    .map((l) => `<td style="width:33%;padding:6px"><div style="background:#f6f8fa;border-radius:8px;padding:12px 14px"><div style="font-size:12px;color:${MUTED}">${escapeHtml(l.label)}</div><div style="font-size:22px;font-weight:700;color:${NAVY};margin-top:2px">${escapeHtml(l.value)}</div>${l.delta ? `<div style="font-size:12px;color:${ACCENT};margin-top:2px">${escapeHtml(l.delta)}</div>` : ""}</div></td>`);
  const rows: string[] = [];
  for (let i = 0; i < tiles.length; i += 3) rows.push(`<tr>${tiles.slice(i, i + 3).join("")}</tr>`);
  const sections = data.sections
    .filter((s) => s.headline.length > 0 || s.bullets.length > 0 || s.note)
    .map((s) => `${heading(s.title)}${ul([...s.headline.map(line), ...s.bullets])}${s.note ? `<p style="margin:8px 0 0;font-size:13px;color:${MUTED}">${escapeHtml(s.note)}</p>` : ""}`)
    .join("");
  return [
    `<div style="background:#eef1f5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">`,
    `<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};padding:22px 28px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9fb3c8">${data.brand ? `${escapeHtml(data.brand)} · ` : ""}Monthly report</div><div style="font-size:24px;font-weight:700;color:#ffffff;margin-top:6px">${escapeHtml(data.client.name)}</div><div style="font-size:14px;color:#c8d6e5;margin-top:2px">${escapeHtml(data.periodLabel)}</div></div>`,
    `<div style="padding:8px 28px 28px">`,
    narrative.summary.trim() ? `<p style="margin:18px 0 0;font-size:15px;line-height:1.6;color:${INK}">${escapeHtml(narrative.summary.trim())}</p>` : "",
    rows.length ? `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin-top:18px;border-collapse:separate">${rows.join("")}</table>` : "",
    narrative.highlights.length ? `${heading("Highlights")}${ul(narrative.highlights)}` : "",
    sections,
    data.waitingOnClient.length ? `${heading("What we need from you")}${ul(data.waitingOnClient.map((w) => `${w.title} (asked ${w.days} day${w.days === 1 ? "" : "s"} ago)`))}` : "",
    narrative.next.length ? `${heading("Next month")}${ul(narrative.next)}` : "",
    `<p style="margin:26px 0 0;font-size:13px;color:${MUTED}">Questions about any of this? Reply to this email and we will answer within a working day.</p>`,
    `</div></div></div>`,
  ].join("");
}
