import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideItem } from "../src/decide-model.js";
import { DecideBody, clockSast } from "../src/ui/decide.js";
import { DecideSession, REFETCH_MS, decisionCall, keyIntent, pickMedia, type DecideData } from "../src/ui/decide-session.js";
import { renderDigest } from "../src/digest-model.js";
import { tabFromSearch } from "../src/ui/index.js";

const item = (id: string, over: Partial<DecideItem> = {}): DecideItem => ({
  ref: { kind: "ask", id, issueId: `iss-${id}` }, title: `Question ${id}`, why: "Because.", options: ["Yes", "No"], recommended: "Yes",
  details: [], mode: "decide", href: `/issues/${id}`, since: null, overdue: false, class: "decision", ...over,
});
const data = (items: DecideItem[], over: Partial<DecideData> = {}): DecideData => ({ items, notOwner: false, partial: [], cardsAsOf: "2026-11-28T12:02:00.000Z", cardsRefreshing: false, ...over });
const link = (href: string) => ({ href });

describe("Decide tab", () => {
  it("is a tab id", () => expect(tabFromSearch("?tab=decide")).toBe("decide"));

  it("renders one card with the recommended option marked, 3 of 12, partial and Cards as of", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(String(i)));
    const html = renderToStaticMarkup(createElement(DecideBody, {
      state: { data: data(items, { partial: ["approvals"] }), items, pos: 2, busy: false, flash: null, error: null, media: { "iss-2": { kind: "image", src: "/a.png", name: "shot" } }, loading: false, loadError: null },
      linkFor: link, onRefresh: () => undefined, onNext: () => undefined,
    }));
    expect(html).toContain("3 of 12");
    expect(html).toContain("Question 2");
    expect(html).not.toContain("Question 3");
    expect(html).toContain("Yes (recommended)");
    expect(html).toContain("Open task");
    expect(html).toContain("Cards as of 14:02");
    expect(html).toContain("Not fully read: approvals");
    expect(html).toContain("Refresh");
    expect(html).toContain('src="/a.png"');
  });

  it("an open-only card has no option buttons; empty and non-owner states", () => {
    const open = item("o", { mode: "open", options: [] });
    const base = { busy: false, flash: null, error: null, media: {}, loading: false, loadError: null };
    expect(renderToStaticMarkup(createElement(DecideBody, { state: { ...base, data: data([open]), items: [open], pos: 0 }, linkFor: link }))).toContain("cannot be decided here");
    expect(renderToStaticMarkup(createElement(DecideBody, { state: { ...base, data: data([]), items: [], pos: 0 }, linkFor: link }))).toContain("Nothing waits on you");
    expect(renderToStaticMarkup(createElement(DecideBody, { state: { ...base, data: data([], { notOwner: true }), items: [], pos: 0 }, linkFor: link }))).toContain("owner");
  });

  it("clock is SAST", () => expect(clockSast("2026-11-28T23:30:00.000Z")).toBe("01:30"));

  it("keys: Space next, Enter open, nothing else, nothing in a field or with a modifier", () => {
    expect(keyIntent({ key: " " })).toBe("next");
    expect(keyIntent({ key: "Enter" })).toBe("open");
    for (const key of ["1", "9", "a", "y", "Escape"]) expect(keyIntent({ key })).toBeNull();
    expect(keyIntent({ key: " ", shiftKey: true })).toBeNull();
    expect(keyIntent({ key: " ", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(keyIntent({ key: "Enter", metaKey: true })).toBeNull();
  });

  it("maps options to the three decide actions", () => {
    expect(decisionCall(item("a"), "Yes")).toEqual({ action: "decide.ask", params: { askId: "a", option: "Yes" } });
    expect(decisionCall(item("p", { ref: { kind: "approval", id: "p", issueId: null } }), "Reject").params).toEqual({ approvalId: "p", action: "reject" });
    expect(decisionCall(item("c", { ref: { kind: "card", id: "c", issueId: "i9" } }), "Accept").params).toEqual({ issueId: "i9", interactionId: "c", action: "accept" });
  });

  it("picks the newest image or video", () => {
    const rows = [
      { contentType: "image/png", contentPath: "/old.png", createdAt: "2026-11-01T00:00:00Z" },
      { contentType: "video/mp4", contentPath: "/new.mp4", createdAt: "2026-11-20T00:00:00Z" },
      { contentType: "application/pdf", contentPath: "/x.pdf", createdAt: "2026-11-25T00:00:00Z" },
      { contentType: "image/png", contentPath: "https://evil/x.png", createdAt: "2026-11-26T00:00:00Z" },
    ];
    expect(pickMedia(rows)).toMatchObject({ kind: "video", src: "/new.mp4" });
    expect(pickMedia([])).toBeNull();
    expect(pickMedia(null)).toBeNull();
  });
});

describe("DecideSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const make = (q: DecideData[], act = vi.fn(async (..._a: unknown[]) => "ok")) => {
    const load = vi.fn(async () => q.shift() ?? q[0]!);
    const media = vi.fn(async (_id: string) => null);
    return { s: new DecideSession({ load, act, media }), load, act, media };
  };

  it("a decision drops the card locally without re-fetching; media only for current and next", async () => {
    const items = [item("1"), item("2"), item("3")];
    const { s, load, act, media } = make([data(items)]);
    await s.refresh();
    expect(media.mock.calls.map((c) => c[0])).toEqual(["iss-1", "iss-2"]);
    await s.decide("Yes");
    expect(act).toHaveBeenCalledOnce();
    expect(s.state.flash).toBe("Done");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(s.state.items.map((i) => i.ref.id)).toEqual(["2", "3"]);
    expect(s.state.pos).toBe(0);
    expect(load).toHaveBeenCalledOnce();
    expect(media.mock.calls.map((c) => c[0])).toEqual(["iss-1", "iss-2", "iss-3"]);
  });

  it("already_decided drops the card too; an error keeps it", async () => {
    const a = make([data([item("1"), item("2")])], vi.fn(async (..._a: unknown[]) => "already_decided"));
    await a.s.refresh();
    await a.s.decide("No");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(a.s.state.items).toHaveLength(1);
    const b = make([data([item("1")])], vi.fn(async (..._a: unknown[]): Promise<string> => { throw new Error("boom"); }));
    await b.s.refresh();
    await b.s.decide("No");
    expect(b.s.state.error).toBe("boom");
    expect(b.s.state.items).toHaveLength(1);
    expect(b.s.state.busy).toBe(false);
  });

  it("Space moves on without deciding, wrapping at the end", async () => {
    const { s, act } = make([data([item("1"), item("2")])]);
    await s.refresh();
    s.next();
    expect(s.state.pos).toBe(1);
    s.next();
    expect(s.state.pos).toBe(0);
    expect(act).not.toHaveBeenCalled();
  });

  it("cardsRefreshing gives exactly one re-fetch after 20 s", async () => {
    const { s, load } = make([data([item("1")], { cardsRefreshing: true }), data([item("1")], { cardsRefreshing: true })]);
    await s.refresh();
    await vi.advanceTimersByTimeAsync(REFETCH_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REFETCH_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refresh keeps the card you are on", async () => {
    const { s } = make([data([item("1"), item("2")]), data([item("0"), item("1"), item("2")])]);
    await s.refresh();
    s.next();
    await s.refresh();
    expect(s.state.items[s.state.pos]!.ref.id).toBe("2");
  });
});

describe("digest link", () => {
  it("links to the Decide tab", () => {
    const body = renderDigest({ items: [], stats: { others: 0, newAsks: 0, routed: null, applied: [], history: [], unread: [] }, now: new Date("2026-11-28T14:00:00Z"), cockpitHref: "https://x.test/PAR/cockpit" });
    expect(body).toContain("[Decide one by one →](https://x.test/PAR/cockpit?tab=decide)");
  });
});
