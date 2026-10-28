import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WaitingList, ageText, holdsUpText } from "../src/ui/components.js";
import type { WaitingEntry } from "../src/merge.js";

const NOW = new Date("2026-10-28T10:00:00.000Z");
const linkFor = (path: string) => ({ href: path, onClick: () => {} });

function entry(n: number, extra: Partial<WaitingEntry> = {}): WaitingEntry {
  return { key: `k${n}`, title: `Issue ${n}`, why: "Needs you", kind: "judgement", href: `/PAR/issues/PAR-${n}`, source: "host", sourceTitle: "Paperclip", since: "2026-10-27T10:00:00.000Z", ...extra };
}
const render = (items: WaitingEntry[], limit?: number) =>
  renderToStaticMarkup(createElement(WaitingList, { items, linkFor: linkFor as never, now: NOW, limit }));

describe("Waiting on you list", () => {
  it("formats holds-up and age", () => {
    expect(holdsUpText(1)).toBe("holds up 1 issue");
    expect(holdsUpText(17)).toBe("holds up 17 issues");
    expect(ageText(5)).toBe("5h waiting");
    expect(ageText(50)).toBe("2d waiting");
  });

  it("shows holds up, age, recommended and the issue id, in the given order", () => {
    const html = render([
      entry(1, { rank: { identifier: "PAR-1", link: "/PAR/issues/PAR-1", holdsUp: 17, ageHours: 50, recommended: "Review it: approve or ask for changes." } }),
      entry(2, { rank: { identifier: "PAR-2", link: "/PAR/issues/PAR-2", holdsUp: 0, ageHours: 3, recommended: "Do it, or hand it back with a reason." } }),
    ]);
    expect(html).toContain("holds up 17 issues");
    expect(html).not.toContain("holds up 0");
    expect(html).toContain("2d waiting");
    expect(html).toContain("Recommended:");
    expect(html).toContain("PAR-1 Issue 1");
    expect(html.indexOf("PAR-1 Issue 1")).toBeLessThan(html.indexOf("PAR-2 Issue 2"));
    expect(html).toContain('href="/PAR/issues/PAR-1"');
  });

  it("shows the empty state", () => {
    expect(render([])).toContain("Nothing waits on you");
  });

  it("says how many are not shown past the limit", () => {
    const html = render(Array.from({ length: 120 }, (_, i) => entry(i + 1)), 100);
    expect(html).toContain("Showing 100 of 120. 20 more not shown.");
    expect(html).not.toContain("Issue 101<");
  });

  it("wraps a very long title rather than overflowing", () => {
    const html = render([entry(1, { title: "x".repeat(400) })]);
    expect(html).toContain("overflow-wrap:anywhere");
  });
});
