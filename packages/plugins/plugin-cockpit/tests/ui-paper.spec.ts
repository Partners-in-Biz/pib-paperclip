/**
 * Cockpit → Paper, rendered without the host: the edition as a newspaper page,
 * the archive list, the editor, the small markdown the writers use, and the
 * address rules (?tab=paper&date=…&edition=…&view=…).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultSettings, SECTION_PRESETS, type PaperEditionDoc, type PaperIndexEntry } from "../src/paper-model.js";
import { tabFromSearch } from "../src/ui/index.js";
import { isInternal, italicParts, paperBlocks } from "../src/ui/paper-markdown.js";
import { addSection, ArchiveList, EditionPage, EditorBody, filterEntries, monthLabel, moveSection, neighbours, PAPER_CSS, paperHref, paperSelection, timingText } from "../src/ui/paper.js";

const linkFor = (href: string) => ({ href, "data-internal": "1" }) as Record<string, string>;

const doc: PaperEditionDoc = {
  date: "2026-11-13",
  edition: "morning",
  number: 7,
  name: "The Partners in Biz Daily",
  headline: "Queue at 65, oldest item waits 12 days",
  standfirst: "Cash is R33,313 and nothing is overdue.",
  figures: [{ label: "Cash", value: "R33,313" }, { label: "Waiting on you", value: "65", note: "oldest 12 days", tone: "warn" }],
  sections: [
    { id: "needs-you", title: "Needs you", body: "Money first.\n\n- Approve the [Tvisha invoice](/PAR/issues/PAR-1) for **R6,250**.\n- See <script>alert(1)</script>", source: "company" },
    { id: "tech-news", title: "Tech and AI news", body: "### Models\n1. A new model shipped. [Source](https://example.com/a)", source: "web" },
  ],
  source: "agent",
  author: "Thandi",
  authorAgentId: "a1",
  publishedAt: "2026-11-13T05:03:00.000Z",
  revision: 2,
  words: 31,
};

const entry = (date: string, edition: "morning" | "evening", headline: string): PaperIndexEntry => ({ date, edition, number: 1, headline, standfirst: "Standfirst", source: "agent", author: "Thandi", publishedAt: "", words: 10 });

describe("Paper tab", () => {
  it("opens from ?tab=paper and reads the edition and view from the address", () => {
    expect(tabFromSearch("?tab=paper&date=2026-11-13")).toBe("paper");
    expect(paperSelection("?tab=paper&date=2026-11-13&edition=evening")).toEqual({ date: "2026-11-13", edition: "evening", mode: "read" });
    expect(paperSelection("?tab=paper&view=edit&date=13-11&edition=noon")).toEqual({ date: null, edition: null, mode: "edit" });
    expect(paperHref({})).toBe("/cockpit?tab=paper");
    expect(paperHref({ mode: "archive" })).toBe("/cockpit?tab=paper&view=archive");
    expect(paperHref({ date: "2026-11-13", edition: "morning" })).toBe("/cockpit?tab=paper&date=2026-11-13&edition=morning");
  });
});

describe("the edition page", () => {
  const html = renderToStaticMarkup(createElement(EditionPage, { doc, linkFor }));

  it("has the masthead, headline, byline and the day in numbers", () => {
    expect(html).toContain("No. 7");
    expect(html).toContain("Friday, 13 November 2026");
    expect(html).toContain("Morning edition");
    expect(html).toContain("The Partners in Biz Daily");
    expect(html).toContain("Queue at 65, oldest item waits 12 days");
    expect(html).toContain("By Thandi · 07:03");
    expect(html).toContain("R33,313");
    expect(html).toContain("oldest 12 days");
    expect(html).toContain("31 words · revision 2");
  });

  it("renders the writers' markdown, opens Paperclip links in the app and outside links in a new tab, and never as HTML", () => {
    expect(html).toContain('<a href="/PAR/issues/PAR-1" data-internal="1"');
    expect(html).toContain("<strong");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noreferrer"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("from the web");
    expect(html).toContain('class="pib-paper-sub"');
  });

  it("draws list markers itself (the host's base styles remove them) and keeps a number in one piece", () => {
    expect(PAPER_CSS).toContain("list-style: disc outside");
    expect(PAPER_CSS).toContain("ol.pib-paper-list { list-style: decimal outside; }");
    expect(PAPER_CSS).not.toMatch(/pib-paper-figure-value \{[^}]*overflow-wrap: anywhere/);
  });

  it("gives the lead a big first letter only when its first paragraph is a few lines long", () => {
    expect(html).not.toContain("pib-paper-drop\"");
    const long = { ...doc, sections: [{ ...doc.sections[0]!, body: `${"Three money approvals unblock the most today. ".repeat(6)}\n\n- one` }, doc.sections[1]!] };
    expect(renderToStaticMarkup(createElement(EditionPage, { doc: long, linkFor }))).toContain('class="pib-paper-p pib-paper-drop"');
  });

  it("says when the Cockpit compiled it", () => {
    const auto = renderToStaticMarkup(createElement(EditionPage, { doc: { ...doc, source: "auto", author: null }, linkFor }));
    expect(auto).toContain("Compiled by the Cockpit from the numbers");
    expect(auto).toContain("No written edition arrived");
  });
});

describe("the markdown", () => {
  it("splits into paragraphs, lists, sub-heads and quotes", () => {
    expect(paperBlocks("One line\nstill one.\n\n**Money**\n* a\n* b\n  more b\n1. first\n2) second\n> said\nlast")).toEqual([
      { kind: "p", text: "One line still one." },
      { kind: "h", text: "Money" },
      { kind: "ul", items: ["a", "b more b"] },
      { kind: "ol", items: ["first", "second"] },
      { kind: "quote", text: "said" },
      { kind: "p", text: "last" },
    ]);
  });

  it("reads italics only around whole words, so names with underscores stay as written", () => {
    expect(italicParts("the clip *You Didn't Surrender* got views")).toEqual(["the clip ", "*You Didn't Surrender*", " got views"]);
    expect(italicParts("say _so_ once")).toEqual(["say ", "_so_", " once"]);
    expect(italicParts("key as secret FIREBASE_SA_WEBTOOLS_382B9, or re-login")).toEqual(["key as secret FIREBASE_SA_WEBTOOLS_382B9, or re-login"]);
    expect(italicParts("2*3*4 and a_b_c and snake_case_name")).toEqual(["2*3*4 and a_b_c and snake_case_name"]);
    expect(italicParts("a * b * c")).toEqual(["a * b * c"]);
  });

  it("knows a Paperclip address from an outside one", () => {
    expect(isInternal("/PAR/issues/PAR-1", null)).toBe(true);
    expect(isInternal("https://paperclip.partnersinbiz.online/PAR/issues/PAR-1", "https://paperclip.partnersinbiz.online")).toBe(true);
    expect(isInternal("https://example.com/x", "https://paperclip.partnersinbiz.online")).toBe(false);
    expect(isInternal("//evil.example", "https://paperclip.partnersinbiz.online")).toBe(false);
  });
});

describe("the archive", () => {
  const list = [entry("2026-11-13", "evening", "Evening"), entry("2026-11-13", "morning", "Morning"), entry("2026-11-12", "morning", "Yesterday")];

  it("lists each edition with its day and headline, and filters by words", () => {
    const html = renderToStaticMarkup(createElement(ArchiveList, { entries: list, onOpen: () => undefined, empty: "None." }));
    expect(html).toContain("Fri 13 Nov · Evening edition · No. 1");
    expect(html).toContain("Yesterday");
    expect(filterEntries(list, "yester").map((e) => e.headline)).toEqual(["Yesterday"]);
    expect(filterEntries(list, "12 november")).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(ArchiveList, { entries: [], onOpen: () => undefined, empty: "No editions yet." }))).toContain("No editions yet.");
    expect(monthLabel("2026-11")).toBe("November 2026");
  });

  it("finds the earlier and later edition", () => {
    expect(neighbours(list, { date: "2026-11-13", edition: "morning" })).toMatchObject({ earlier: { headline: "Yesterday" }, later: { headline: "Evening" } });
    expect(neighbours(list, { date: "2026-11-13", edition: "evening" }).later).toBeNull();
    expect(neighbours(list, null)).toEqual({ earlier: null, later: null });
  });
});

describe("the editor", () => {
  const noop = () => undefined;
  const html = (dirty: boolean) =>
    renderToStaticMarkup(createElement(EditorBody, { settings: defaultSettings(), presets: SECTION_PRESETS, operator: "Thandi", busy: false, dirty, onChange: noop, onSave: noop, onReset: noop, onWriteNow: noop, onCompileNow: noop, onClose: noop }));

  it("shows every section with its instruction, the presets and when the edition is written", () => {
    const out = html(false);
    expect(out).toContain("Needs you");
    expect(out).toContain("What waits on the owner");
    expect(out).toContain("+ Tech and AI news");
    expect(out).toContain("+ On X");
    expect(out).toContain("+ Your own");
    expect(out).toContain("Written by Thandi at the end of the daily operations review, which starts at 07:00. If none has arrived by 09:00");
    expect(out).toContain("Saved");
    expect(html(true)).toContain("Discard changes");
    expect(html(true)).toContain("Save your changes first, then ask for an edition.");
    expect(out).toContain("Write the morning edition now");
  });

  it("words the timing of each edition", () => {
    expect(timingText("evening", "17:30", null)).toBe("the Operator is asked to write it at 17:30. If none has arrived by 19:30, the Cockpit compiles one from the numbers.");
  });

  it("moves and adds sections without repeating an id", () => {
    const sections = defaultSettings().editions.morning.sections;
    expect(moveSection(sections, 1, -1).slice(0, 2).map((s) => s.id)).toEqual(["money", "needs-you"]);
    expect(moveSection(sections, 0, -1)).toBe(sections);
    const withPreset = addSection(sections, SECTION_PRESETS[0]);
    expect(withPreset.at(-1)).toMatchObject({ id: "tech-news-2", enabled: true, source: "web" });
    expect(addSection(sections).at(-1)).toMatchObject({ id: `new-${sections.length + 1}`, title: "" });
  });
});
