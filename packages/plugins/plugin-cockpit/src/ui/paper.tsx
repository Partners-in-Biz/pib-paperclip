/**
 * Cockpit → Paper: the owner's morning and end-of-day report as a newspaper.
 * Three views: the edition (masthead, headline, the day in numbers, sections
 * in columns), the archive of past editions, and the editor where the owner
 * says what each edition must hold. Read from `paper.load`; the bodies below
 * take plain props, so they render in tests without the host.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Input, Newspaper, PageMessage, Pill, Select, TextArea, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  EDITION_LABEL,
  FALLBACK_AFTER_MINUTES,
  PAPER_EDITIONS,
  PAPER_LIMITS,
  longDate,
  sastClock,
  shortDate,
  slug,
  sortIndex,
  timeMinutes,
  type PaperEditionDoc,
  type PaperEditionKey,
  type PaperIndexEntry,
  type PaperSectionSpec,
  type PaperSettings,
} from "../paper-model.js";
import type { PaperView } from "../paper.js";
import { PaperBody } from "./paper-markdown.js";
import { Muted, type LinkPropsFor } from "./components.js";

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const SERIF = `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif`;
const DISPLAY = `"Bodoni 72", "Bodoni MT", Didot, "Playfair Display", "Iowan Old Style", Georgia, "Times New Roman", serif`;

/** Paper and ink follow the host's light and dark theme (`.dark` on `<html>`). */
export const PAPER_CSS = `
.pib-paper { --paper-bg: #fbf8f1; --paper-ink: #1c1b18; --paper-soft: #5f5b52; --paper-hair: #d9d3c5; --paper-tint: #f2ede0; --paper-accent: #9b2c1f; --paper-ok: #2f6b3c; --paper-warn: #9a6200; --paper-bad: #a52a1c; }
.dark .pib-paper { --paper-bg: #1a1916; --paper-ink: #ece7da; --paper-soft: #a9a394; --paper-hair: #3b382f; --paper-tint: #23211c; --paper-accent: #e39a78; --paper-ok: #8cc79a; --paper-warn: #e3b55f; --paper-bad: #f0907f; }
.pib-paper { background: var(--paper-bg); color: var(--paper-ink); font-family: ${SERIF}; border: 1px solid var(--paper-hair); border-radius: 4px; padding: clamp(16px, 4vw, 44px); min-width: 0; box-shadow: 0 1px 0 var(--paper-hair), 0 10px 30px -18px rgba(0,0,0,.35); }
.pib-paper a { color: inherit; }
.pib-paper-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; font-family: ${SERIF}; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--paper-soft); border-top: 1px solid var(--paper-ink); border-bottom: 1px solid var(--paper-ink); padding: 6px 2px; }
.pib-paper-name { font-family: ${DISPLAY}; font-weight: 700; font-size: clamp(34px, 7.4vw, 76px); line-height: 1; letter-spacing: -.01em; text-align: center; margin: 18px 0 14px; overflow-wrap: anywhere; }
.pib-paper-rule { border: 0; border-top: 3px double var(--paper-ink); margin: 0; }
.pib-paper-headline { font-family: ${DISPLAY}; font-weight: 700; font-size: clamp(28px, 5vw, 52px); line-height: 1.06; letter-spacing: -.012em; margin: 26px 0 12px; text-wrap: balance; overflow-wrap: anywhere; }
.pib-paper-standfirst { font-size: clamp(17px, 2.1vw, 21px); line-height: 1.45; font-style: italic; color: var(--paper-ink); margin: 0 0 10px; max-width: 62ch; white-space: pre-line; }
.pib-paper-byline { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--paper-soft); margin: 0 0 22px; }
.pib-paper-figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1px solid var(--paper-ink); border-bottom: 1px solid var(--paper-ink); margin: 0 0 26px; }
.pib-paper-figure { padding: 12px 14px 12px 0; margin-left: 14px; min-width: 0; display: grid; grid-template-rows: minmax(2.5em, auto) auto auto; align-items: end; align-content: start; }
.pib-paper-figure-label { font-size: 11px; line-height: 1.25; letter-spacing: .14em; text-transform: uppercase; color: var(--paper-soft); }
.pib-paper-figure-value { font-family: ${DISPLAY}; font-size: clamp(20px, 2.4vw, 28px); font-weight: 700; line-height: 1.15; font-variant-numeric: lining-nums tabular-nums; overflow-wrap: break-word; word-break: normal; }
.pib-paper-figure-note { font-size: 13px; font-style: italic; color: var(--paper-soft); line-height: 1.3; }
.pib-paper-lead { column-width: 330px; column-gap: 38px; column-rule: 1px solid var(--paper-hair); margin-bottom: 30px; }
.pib-paper-cols { column-width: 290px; column-gap: 38px; column-rule: 1px solid var(--paper-hair); }
.pib-paper-section { break-inside: avoid; margin: 0 0 28px; min-width: 0; }
.pib-paper-section.long { break-inside: auto; }
.pib-paper-kicker { font-family: ${SERIF}; font-size: 12.5px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; border-top: 2px solid var(--paper-ink); border-bottom: 1px solid var(--paper-hair); padding: 6px 0 5px; margin: 0 0 10px; break-after: avoid; display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.pib-paper-lead > .pib-paper-kicker { column-span: all; }
.pib-paper-wire { font-weight: 400; font-style: italic; letter-spacing: .04em; text-transform: none; color: var(--paper-accent); }
.pib-paper-p { font-size: 16.5px; line-height: 1.58; margin: 0 0 10px; overflow-wrap: anywhere; hyphens: auto; }
.pib-paper-drop::first-letter { font-family: ${DISPLAY}; float: left; font-size: 3.5em; line-height: .82; font-weight: 700; padding: 5px 8px 0 0; }
.pib-paper-sub { font-family: ${SERIF}; font-size: 15px; font-weight: 700; font-style: italic; margin: 14px 0 6px; break-after: avoid; clear: left; }
.pib-paper-list { font-size: 16px; line-height: 1.5; margin: 0 0 10px; padding-left: 22px; overflow-wrap: anywhere; clear: left; list-style: disc outside; }
ol.pib-paper-list { list-style: decimal outside; }
.pib-paper-list li { margin: 0 0 6px; padding-left: 2px; display: list-item; }
.pib-paper-list li::marker { color: var(--paper-accent); }
.pib-paper-quote { margin: 0 0 10px; padding-left: 12px; border-left: 2px solid var(--paper-accent); font-style: italic; font-size: 16.5px; line-height: 1.5; }
.pib-paper-foot { border-top: 1px solid var(--paper-ink); margin-top: 6px; padding-top: 8px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--paper-soft); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pib-paper-row { display: grid; gap: 4px; padding: 14px 4px; border-bottom: 1px solid var(--paper-hair); text-decoration: none; cursor: pointer; background: none; border-left: 0; border-right: 0; border-top: 0; text-align: left; width: 100%; color: inherit; font: inherit; }
.pib-paper-row:hover .pib-paper-row-head { text-decoration: underline; text-decoration-color: var(--paper-accent); text-underline-offset: 4px; }
.pib-paper-row-head { font-family: ${DISPLAY}; font-size: clamp(19px, 2.6vw, 24px); font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
@media print { .pib-paper-chrome { display: none !important; } .pib-paper { border: 0; box-shadow: none; padding: 0; } }
`;

function PaperStyles() {
  return <style>{PAPER_CSS}</style>;
}

const TONE_VAR: Record<string, string> = { ok: "var(--paper-ok)", warn: "var(--paper-warn)", bad: "var(--paper-bad)" };

// ---------------------------------------------------------------------------
// The edition
// ---------------------------------------------------------------------------

/** One edition as a newspaper page. */
export function EditionPage({ doc, linkFor }: { doc: PaperEditionDoc; linkFor: LinkPropsFor }) {
  const [lead, ...rest] = doc.sections;
  return (
    <article className="pib-paper" aria-label={`${doc.name}, ${EDITION_LABEL[doc.edition]}, ${longDate(doc.date)}`}>
      <PaperStyles />
      <div className="pib-paper-meta">
        <span>No. {doc.number}</span>
        <span>{longDate(doc.date)}</span>
        <span>{EDITION_LABEL[doc.edition]}</span>
      </div>
      <div className="pib-paper-name">{doc.name}</div>
      <hr className="pib-paper-rule" />
      <h2 className="pib-paper-headline">{doc.headline}</h2>
      <p className="pib-paper-standfirst">{doc.standfirst}</p>
      <p className="pib-paper-byline">
        {doc.source === "auto" ? "Compiled by the Cockpit from the numbers" : `By ${doc.author ?? "the Operator"}`}
        {doc.publishedAt ? ` · ${sastClock(doc.publishedAt)}` : ""}
      </p>
      {doc.figures.length ? (
        <div className="pib-paper-figures" role="list" aria-label="The day in numbers">
          {doc.figures.map((f) => (
            <div key={f.label} className="pib-paper-figure" role="listitem">
              <div className="pib-paper-figure-label">{f.label}</div>
              <div className="pib-paper-figure-value" style={f.tone && TONE_VAR[f.tone] ? { color: TONE_VAR[f.tone] } : undefined}>{f.value}</div>
              {f.note ? <div className="pib-paper-figure-note">{f.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {lead ? (
        <section className="pib-paper-lead" aria-label={lead.title}>
          <h3 className="pib-paper-kicker"><span>{lead.title}</span>{lead.source === "web" ? <span className="pib-paper-wire">from the web</span> : null}</h3>
          <PaperBody markdown={lead.body} linkFor={linkFor} dropCap />
        </section>
      ) : null}
      {rest.length ? (
        <div className="pib-paper-cols">
          {rest.map((s) => (
            <section key={s.id} className={s.body.length > 1400 ? "pib-paper-section long" : "pib-paper-section"} aria-label={s.title}>
              <h3 className="pib-paper-kicker"><span>{s.title}</span>{s.source === "web" ? <span className="pib-paper-wire">from the web</span> : null}</h3>
              <PaperBody markdown={s.body} linkFor={linkFor} />
            </section>
          ))}
        </div>
      ) : null}
      <div className="pib-paper-foot">
        <span>{doc.words} words{doc.revision > 1 ? ` · revision ${doc.revision}` : ""}</span>
        <span>{doc.source === "auto" ? "No written edition arrived" : "Reply on the Daily brief issue to redirect the editor"}</span>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

export function monthLabel(month: string): string {
  const t = Date.parse(`${month}-15T12:00:00Z`);
  return Number.isNaN(t) ? month : new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(t));
}

export function filterEntries(entries: PaperIndexEntry[], query: string): PaperIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => `${e.headline} ${e.standfirst} ${e.date} ${e.edition} ${longDate(e.date)}`.toLowerCase().includes(q));
}

export function ArchiveList({ entries, onOpen, empty }: { entries: PaperIndexEntry[]; onOpen: (entry: PaperIndexEntry) => void; empty: string }) {
  if (!entries.length) return <Muted>{empty}</Muted>;
  return (
    <div className="pib-paper" style={{ paddingTop: 8, paddingBottom: 8 }}>
      <PaperStyles />
      {entries.map((e) => (
        <button key={`${e.date}:${e.edition}`} type="button" className="pib-paper-row" onClick={() => onOpen(e)}>
          <span className="pib-paper-figure-label">{shortDate(e.date)} · {EDITION_LABEL[e.edition]} · No. {e.number}{e.source === "auto" ? " · compiled" : ""}</span>
          <span className="pib-paper-row-head">{e.headline}</span>
          <span style={{ fontSize: 15, lineHeight: 1.45, color: "var(--paper-soft)", overflowWrap: "anywhere" }}>{e.standfirst}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.muted };
const card: CSSProperties = { display: "grid", gap: 12, padding: 14, border: `1px solid ${tokens.border}`, borderRadius: 12, background: tokens.card, minWidth: 0 };
const iconButton: CSSProperties = { minWidth: 36, minHeight: 36, padding: "0 8px" };

/** When this edition is written and when the Cockpit steps in, in the owner's words. */
export function timingText(edition: PaperEditionKey, time: string, operator: string | null): string {
  const who = operator ?? "the Operator";
  const at = timeMinutes(time) ?? 0;
  const late = at + FALLBACK_AFTER_MINUTES;
  const clock = `${String(Math.floor(late / 60) % 24).padStart(2, "0")}:${String(late % 60).padStart(2, "0")}`;
  return edition === "morning"
    ? `Written by ${who} at the end of the daily operations review, which starts at ${time}. If none has arrived by ${clock}, the Cockpit compiles one from the numbers.`
    : `${who} is asked to write it at ${time}. If none has arrived by ${clock}, the Cockpit compiles one from the numbers.`;
}

export function moveSection(sections: PaperSectionSpec[], index: number, by: -1 | 1): PaperSectionSpec[] {
  const to = index + by;
  if (to < 0 || to >= sections.length) return sections;
  const next = [...sections];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** A new section from a preset or a blank one, with an id no other section in the list has. */
export function addSection(sections: PaperSectionSpec[], preset?: PaperSectionSpec): PaperSectionSpec[] {
  const base = preset ?? { id: "", title: "", instruction: "", source: "company" as const, enabled: true };
  const ids = new Set(sections.map((s) => s.id));
  let id = base.id || `new-${sections.length + 1}`;
  for (let n = 2; ids.has(id); n += 1) id = `${base.id || "new"}-${n}`;
  return [...sections, { ...base, id, enabled: true }];
}

export function EditorBody({ settings, presets, operator, busy, dirty, onChange, onSave, onReset, onWriteNow, onCompileNow, onClose }: {
  settings: PaperSettings;
  presets: PaperSectionSpec[];
  operator: string | null;
  busy: boolean;
  dirty: boolean;
  onChange: (next: PaperSettings) => void;
  onSave: () => void;
  onReset: () => void;
  onWriteNow: (edition: PaperEditionKey) => void;
  onCompileNow: (edition: PaperEditionKey) => void;
  onClose: () => void;
}) {
  const [edition, setEdition] = useState<PaperEditionKey>("morning");
  const current = settings.editions[edition];
  const setEditionField = (patch: Partial<PaperSettings["editions"][PaperEditionKey]>) => onChange({ ...settings, editions: { ...settings.editions, [edition]: { ...current, ...patch } } });
  const setSection = (index: number, patch: Partial<PaperSectionSpec>) => setEditionField({ sections: current.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const full = current.sections.length >= PAPER_LIMITS.sections;
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={card}>
        <label style={{ display: "grid", gap: 4, maxWidth: 420 }}>
          <span style={label}>Name on the masthead</span>
          <Input value={settings.name} maxLength={PAPER_LIMITS.name} placeholder="The <company> Daily" onChange={(e) => onChange({ ...settings, name: e.target.value })} />
        </label>
        <Muted>Say what you want in each edition, in your own words. The editor reads this list before it writes, so a change shows in the next edition. You can also tell an agent ("add tech news to my morning paper") and it changes the list for you.</Muted>
      </div>

      <div role="group" aria-label="Edition" style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden", justifySelf: "start" }}>
        {PAPER_EDITIONS.map((e) => (
          <button key={e} type="button" aria-pressed={edition === e} onClick={() => setEdition(e)} style={{ appearance: "none", border: "none", minHeight: 38, padding: "6px 16px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: edition === e ? tokens.secondary : "transparent", color: edition === e ? tokens.fg : tokens.muted }}>
            {EDITION_LABEL[e]}{settings.editions[e].enabled ? "" : " (off)"}
          </button>
        ))}
      </div>

      <div style={card}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "end", minWidth: 0 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: tokens.fg, minHeight: 36 }}>
            <input type="checkbox" checked={current.enabled} onChange={(e) => setEditionField({ enabled: e.target.checked })} />
            Write this edition
          </label>
          {edition === "evening" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span style={label}>Time (SAST)</span>
              <Input type="time" value={current.time} style={{ width: 130 }} onChange={(e) => (timeMinutes(e.target.value) !== null ? setEditionField({ time: e.target.value }) : undefined)} />
            </label>
          ) : null}
          <label style={{ display: "grid", gap: 4 }}>
            <span style={label}>Days</span>
            <Select value={current.days} onChange={(e) => setEditionField({ days: e.target.value === "weekdays" ? "weekdays" : "every" })}>
              <option value="every">Every day</option>
              <option value="weekdays">Monday to Friday</option>
            </Select>
          </label>
        </div>
        <Muted>{timingText(edition, current.time, operator)}</Muted>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={label}>Standing note to the editor (optional)</span>
          <TextArea value={current.note} maxLength={PAPER_LIMITS.note} placeholder="For example: lead with cash; keep it to a two-minute read; always tell me what Velox did." onChange={(e) => setEditionField({ note: e.target.value })} />
        </label>
      </div>

      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        {current.sections.map((s, index) => (
          <div key={s.id} style={{ ...card, opacity: s.enabled ? 1 : 0.6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
              <span style={{ ...label, minWidth: 18 }}>{index + 1}</span>
              <Input aria-label="Section title" value={s.title} maxLength={PAPER_LIMITS.sectionTitle} placeholder="Section title" style={{ flex: "1 1 180px", fontWeight: 600 }} onChange={(e) => setSection(index, { title: e.target.value })} />
              <Select aria-label="Where it comes from" value={s.source} onChange={(e) => setSection(index, { source: e.target.value === "web" ? "web" : "company" })}>
                <option value="company">From the company</option>
                <option value="web">From the web</option>
              </Select>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: tokens.fg, minHeight: 36 }}>
                <input type="checkbox" checked={s.enabled} onChange={(e) => setSection(index, { enabled: e.target.checked })} />
                In the paper
              </label>
              <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                <Button type="button" variant="secondary" style={iconButton} aria-label={`Move ${s.title || "section"} up`} disabled={index === 0} onClick={() => setEditionField({ sections: moveSection(current.sections, index, -1) })}>↑</Button>
                <Button type="button" variant="secondary" style={iconButton} aria-label={`Move ${s.title || "section"} down`} disabled={index === current.sections.length - 1} onClick={() => setEditionField({ sections: moveSection(current.sections, index, 1) })}>↓</Button>
                <Button type="button" variant="secondary" style={iconButton} aria-label={`Remove ${s.title || "section"}`} disabled={current.sections.length === 1} onClick={() => setEditionField({ sections: current.sections.filter((_, i) => i !== index) })}>✕</Button>
              </div>
            </div>
            <TextArea aria-label="What you want in it" value={s.instruction} maxLength={PAPER_LIMITS.instruction} placeholder={s.source === "web" ? "What to look for on the web, e.g. what @account posted on X since yesterday, or the top AI news of the day." : "What you want to know, in your own words."} onChange={(e) => setSection(index, { instruction: e.target.value })} />
          </div>
        ))}
      </div>

      <div style={card}>
        <span style={label}>Add a section{full ? ` (an edition holds at most ${PAPER_LIMITS.sections})` : ""}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {presets.map((p) => (
            <Button key={p.id} type="button" variant="secondary" disabled={full} onClick={() => setEditionField({ sections: addSection(current.sections, p) })}>+ {p.title}</Button>
          ))}
          <Button type="button" variant="secondary" disabled={full} onClick={() => setEditionField({ sections: addSection(current.sections) })}>+ Your own</Button>
        </div>
      </div>

      <div style={card}>
        <span style={label}>Right now</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" disabled={busy || dirty} onClick={() => onWriteNow(edition)}>Write the {edition} edition now</Button>
          <Button type="button" variant="secondary" disabled={busy || dirty} title="An edition from the numbers alone, with no writer" onClick={() => onCompileNow(edition)}>Compile from the numbers</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onReset}>Restore the default sections</Button>
        </div>
        {dirty ? <Muted>Save your changes first, then ask for an edition.</Muted> : null}
      </div>

      {/* Only Save and Back stay in view: a bar that wraps to two rows covers the form on a narrow screen. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", position: "sticky", bottom: 0, padding: "10px 0", background: tokens.bg, borderTop: `1px solid ${tokens.border}` }}>
        <Button type="button" disabled={busy || !dirty} onClick={onSave}>{busy ? "Saving…" : dirty ? "Save" : "Saved"}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{dirty ? "Discard changes" : "Back to the paper"}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Mode = "read" | "archive" | "edit";

/** `?date=YYYY-MM-DD&edition=morning` picks an edition; `?view=archive` and `?view=edit` open those views. */
export function paperSelection(search: string | null | undefined): { date: string | null; edition: PaperEditionKey | null; mode: Mode } {
  const q = new URLSearchParams(search ?? "");
  const date = q.get("date");
  const edition = q.get("edition");
  const view = q.get("view");
  return {
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    edition: edition === "morning" || edition === "evening" ? edition : null,
    mode: view === "archive" || view === "edit" ? view : "read",
  };
}

export function paperHref(sel: { date?: string | null; edition?: PaperEditionKey | null; mode?: Mode }): string {
  const q = new URLSearchParams({ tab: "paper" });
  if (sel.mode && sel.mode !== "read") q.set("view", sel.mode);
  if (sel.date) q.set("date", sel.date);
  if (sel.edition) q.set("edition", sel.edition);
  return `/cockpit?${q.toString()}`;
}

/** The editions on either side of the one shown (the list is newest first). */
export function neighbours(recent: PaperIndexEntry[], doc: Pick<PaperEditionDoc, "date" | "edition"> | null): { earlier: PaperIndexEntry | null; later: PaperIndexEntry | null } {
  if (!doc) return { earlier: null, later: null };
  const list = sortIndex(recent);
  const at = list.findIndex((e) => e.date === doc.date && e.edition === doc.edition);
  if (at < 0) return { earlier: null, later: null };
  return { earlier: list[at + 1] ?? null, later: list[at - 1] ?? null };
}

function Chrome({ children }: { children: ReactNode }) {
  return <div className="pib-paper-chrome" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>{children}</div>;
}

export function PaperPanel({ search, linkFor, navigate, refreshKey = 0 }: { search: string; linkFor: LinkPropsFor; navigate: (href: string) => void; refreshKey?: number }) {
  const sel = useMemo(() => paperSelection(search), [search]);
  const load = usePluginAction("paper.load");
  const loadMonth = usePluginAction("paper.month");
  const save = usePluginAction("paper.save");
  const reset = usePluginAction("paper.reset");
  const writeNow = usePluginAction("paper.write-now");
  const compileNow = usePluginAction("paper.compile-now");
  const [view, setView] = useState<PaperView | null>(null);
  const [draft, setDraft] = useState<PaperSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [monthEntries, setMonthEntries] = useState<PaperIndexEntry[] | null>(null);
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = (await load({ ...(sel.date ? { date: sel.date } : {}), ...(sel.edition ? { edition: sel.edition } : {}) })) as PaperView;
      setView(next);
      setDraft((d) => d ?? next.settings);
    } catch (error) {
      setNote({ text: errorText(error), tone: "bad" });
    } finally {
      setLoading(false);
    }
  }, [load, sel.date, sel.edition]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!month) {
      setMonthEntries(null);
      return;
    }
    let live = true;
    void (loadMonth({ month }) as Promise<{ entries: PaperIndexEntry[] }>).then((r) => live && setMonthEntries(r.entries), (error) => live && setNote({ text: errorText(error), tone: "bad" }));
    return () => {
      live = false;
    };
  }, [month, loadMonth]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ text: await work(), tone: "ok" });
    } catch (error) {
      setNote({ text: errorText(error), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  if (!view || !draft) return <Muted>{loading ? "Fetching the paper…" : note?.text ?? "The paper could not be loaded."}</Muted>;

  const doc = view.edition;
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.settings);
  const { earlier, later } = neighbours(view.recent, doc);
  const sameDay = doc ? view.recent.filter((e) => e.date === doc.date) : [];
  const open = (e: { date: string; edition: PaperEditionKey }) => navigate(paperHref({ date: e.date, edition: e.edition }));
  const operatorName = view.operator?.name ?? null;
  const writingToday = PAPER_EDITIONS.filter((e) => view.writing[e]);

  const onSave = () => run(async () => {
    const titled = PAPER_EDITIONS.every((e) => draft.editions[e].sections.every((s) => s.title.trim()));
    if (!titled) throw new Error("Every section needs a title.");
    const withIds: PaperSettings = { ...draft, editions: Object.fromEntries(PAPER_EDITIONS.map((e) => [e, { ...draft.editions[e], sections: draft.editions[e].sections.map((s) => (s.id.startsWith("new-") ? { ...s, id: slug(s.title) } : s)) }])) as PaperSettings["editions"] };
    const result = (await save({ settings: withIds })) as { settings: PaperSettings };
    setView({ ...view, settings: result.settings });
    setDraft(result.settings);
    return "Saved. The next edition follows this list.";
  });
  const onReset = () => run(async () => {
    const result = (await reset({})) as { settings: PaperSettings };
    setView({ ...view, settings: result.settings });
    setDraft(result.settings);
    return "The default sections are back.";
  });
  const onWriteNow = (edition: PaperEditionKey) => run(async () => {
    const result = (await writeNow({ edition })) as { requested: boolean; reason?: string };
    if (!result.requested) throw new Error(result.reason === "no-operator" ? "There is no Operator to write it. Staff the role in Setup → Team." : result.reason === "operator-paused" ? `${operatorName ?? "The Operator"} is paused, so nobody can write it now. Compile one from the numbers instead.` : "That edition is switched off.");
    await reload();
    return `${operatorName ?? "The Operator"} is writing the ${edition} edition. It shows here when it is published, usually within a few minutes.`;
  });
  const onCompileNow = (edition: PaperEditionKey) => run(async () => {
    const result = (await compileNow({ edition })) as { date: string; edition: PaperEditionKey };
    setDraft(view.settings);
    navigate(paperHref({ date: result.date, edition: result.edition }));
    await reload();
    return "Compiled from the numbers.";
  });

  const message = <PageMessage message={note?.text} tone={note?.tone} />;

  if (sel.mode === "edit") {
    return (
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {message}
        <EditorBody
          settings={draft}
          presets={view.presets}
          operator={operatorName}
          busy={busy}
          dirty={dirty}
          onChange={setDraft}
          onSave={onSave}
          onReset={onReset}
          onWriteNow={onWriteNow}
          onCompileNow={onCompileNow}
          onClose={() => {
            setDraft(view.settings);
            navigate(paperHref({ date: sel.date, edition: sel.edition }));
          }}
        />
      </div>
    );
  }

  if (sel.mode === "archive") {
    const entries = filterEntries(month ? monthEntries ?? [] : view.recent, query);
    return (
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {message}
        <Chrome>
          <Button type="button" variant="secondary" onClick={() => navigate(paperHref({}))}>← Latest edition</Button>
          <Select aria-label="Month" value={month ?? ""} onChange={(e) => setMonth(e.target.value || null)}>
            <option value="">Latest editions</option>
            {view.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
          <Input aria-label="Search the archive" type="search" value={query} placeholder="Search headlines…" style={{ flex: "1 1 180px", maxWidth: 320 }} onChange={(e) => setQuery(e.target.value)} />
        </Chrome>
        <ArchiveList entries={entries} onOpen={open} empty={month && monthEntries === null ? "Loading…" : query ? "No edition matches that." : "No editions yet."} />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {message}
      <Chrome>
        {sameDay.length > 1 && doc ? (
          <div role="group" aria-label="Edition" style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden" }}>
            {PAPER_EDITIONS.filter((e) => sameDay.some((x) => x.edition === e)).map((e) => (
              <button key={e} type="button" aria-pressed={doc.edition === e} onClick={() => open({ date: doc.date, edition: e })} style={{ appearance: "none", border: "none", minHeight: 36, padding: "6px 14px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: doc.edition === e ? tokens.secondary : "transparent", color: doc.edition === e ? tokens.fg : tokens.muted }}>
                {e === "morning" ? "Morning" : "Evening"}
              </button>
            ))}
          </div>
        ) : null}
        <Button type="button" variant="secondary" disabled={!earlier} onClick={() => earlier && open(earlier)}>← Earlier</Button>
        <Button type="button" variant="secondary" disabled={!later} onClick={() => later && open(later)}>Later →</Button>
        {writingToday.map((e) => <Pill key={e} tone="info" dot>{operatorName ?? "The Operator"} is writing the {e} edition</Pill>)}
        <span style={{ flex: "1 1 12px" }} />
        <Button type="button" variant="secondary" onClick={() => navigate(paperHref({ mode: "archive" }))}>Archive</Button>
        <Button type="button" variant="secondary" onClick={() => navigate(paperHref({ mode: "edit", date: sel.date, edition: sel.edition }))}>Edit the paper</Button>
      </Chrome>
      {doc ? (
        <EditionPage doc={doc} linkFor={linkFor} />
      ) : sel.date ? (
        <EmptyState icon={Newspaper} title="No edition for that day" description="Open the archive to see the days that have one." action={<Button type="button" variant="secondary" onClick={() => navigate(paperHref({ mode: "archive" }))}>Open the archive</Button>} />
      ) : (
        <EmptyState
          icon={Newspaper}
          title="The first edition has not been printed yet"
          description={`${operatorName ?? "The Operator"} writes a morning edition after the daily review and an evening edition at ${view.settings.editions.evening.time}. Choose what goes in each under Edit the paper, or ask for one now.`}
          action={(
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Button type="button" disabled={busy} onClick={() => onWriteNow("morning")}>Write the first edition now</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => onCompileNow("morning")}>Compile one from the numbers</Button>
            </div>
          )}
        />
      )}
    </div>
  );
}
