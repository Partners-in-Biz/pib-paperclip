/** The daily calendar check: missed proposals, unapproved posts for the next 48 hours, and copies with the same opening. */
import { describe, expect, it } from "vitest";
import { calendarCheckDescription, calendarFindings, localDayHour, openingOf, type CalendarRow } from "../src/calendar-check.js";
import { calendarState } from "../src/ui/series.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const H = 3_600_000;
const row = (id: string, status: string, offsetH: number, body: string, accounts = ["acc-fb"]): CalendarRow => ({ id: `${id}-0000000`, status, at: new Date(NOW + offsetH * H).toISOString(), body, scopeKey: "own", accounts });

describe("calendarFindings", () => {
  it("lists missed proposals and unapproved posts for the next 48 hours, never scheduled or published ones", () => {
    const f = calendarFindings([
      row("a", "draft", -26, "Zetamac or Velox? Different jobs for different minds."),
      row("b", "review", -4, "Most bespoke software quotes start with a guess."),
      row("c", "review", 20, "Your app should work with no signal at all."),
      row("d", "scheduled", -2, "Three clubs, three subdomains, four weeks."),
      row("e", "draft", 24 * 20, "Far away post that nobody should list today."),
      row("f", "draft", -24 * 20, "Too old to list any more as a missed one."),
    ], NOW);
    expect(f.missed.map((r) => r.id[0])).toEqual(["a", "b"]);
    expect(f.upcoming.map((r) => r.id[0])).toEqual(["c"]);
  });

  it("groups copies with the same opening, and flags two scheduled copies on one account", () => {
    const f = calendarFindings([
      row("p", "published", -28, "8 seconds to 2. That is the page load on Loyalty Plus."),
      row("q", "review", -28, "8 seconds to 2. That is the page load on Loyalty Plus, rewritten."),
      row("s", "scheduled", 20, "1.4 seconds. That is how fast a Pretoria law firm's site loads."),
      row("t", "scheduled", 20, "1.4 seconds. That is how fast a Pretoria law firm's site loads!", ["acc-fb", "acc-li"]),
      row("x", "published", -50, "Already out once and only once, nothing to do."),
    ], NOW);
    expect(f.duplicates).toHaveLength(2);
    expect(f.duplicates[0]).toMatchObject({ doublePublish: true });
    expect(f.duplicates[0]!.rows.map((r) => r.id[0])).toEqual(["s", "t"]);
    expect(f.duplicates[1]).toMatchObject({ doublePublish: false });
  });

  it("ignores short openings", () => {
    expect(openingOf("Hi!")).toBeNull();
    expect(openingOf("  One codebase.   iOS and Android. ")).toBe("one codebase ios and android");
  });

  it("the issue text names each section and the tools to use", () => {
    const f = calendarFindings([row("a", "draft", -26, "Zetamac or Velox? Different jobs for different minds."), row("s", "scheduled", 20, "1.4 seconds. That is how fast a site loads."), row("t", "scheduled", 21, "1.4 seconds. That is how fast a site loads.")], NOW);
    const text = calendarCheckDescription(f, "Africa/Johannesburg", "/social");
    expect(text).toContain("## Will publish twice");
    expect(text).toContain("## Missed");
    expect(text).toContain("archive-post");
    expect(text).toContain("unschedule-post");
  });
});

describe("localDayHour", () => {
  it("reads the company's day and hour", () => {
    expect(localDayHour(new Date("2026-11-17T03:30:00Z"), "Africa/Johannesburg")).toEqual({ day: "2026-11-17", hour: 5 });
    expect(localDayHour(new Date("2026-11-17T23:30:00Z"), "Africa/Johannesburg")).toEqual({ day: "2026-11-18", hour: 1 });
  });
});

describe("calendarState (the calendar card)", () => {
  it("a scheduled post is solid; a draft is a dashed proposal; a passed proposal is missed", () => {
    expect(calendarState({ status: "scheduled", scheduledAt: new Date(NOW + H).toISOString() }, NOW)).toMatchObject({ proposal: false });
    expect(calendarState({ status: "draft", scheduledAt: new Date(NOW + H).toISOString() }, NOW)).toMatchObject({ proposal: true, label: "draft · not scheduled" });
    expect(calendarState({ status: "review", scheduledAt: new Date(NOW - H).toISOString() }, NOW)).toMatchObject({ proposal: true, tone: "bad", label: "missed: in review, never approved" });
  });
});
