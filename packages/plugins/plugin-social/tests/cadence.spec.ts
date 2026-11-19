/** Posting cadence: what a person saves, the slot maths, and the free slots the daily check hands to the agent. */
import { describe, expect, it } from "vitest";
import { cadenceGaps, cadenceSection, cadenceSummary, localParts, normalizeCadence, slotTimes, targetFor, zonedInstant } from "../src/cadence.js";

const TZ = "Africa/Johannesburg";
const NOW = new Date("2026-11-17T04:00:00Z"); // Tue 17 Nov 06:00 local
const base = (extra: Record<string, unknown> = {}) => normalizeCadence({ postsPerDay: 3, windowStart: "08:00", windowEnd: "18:00", lookaheadDays: 1, ...extra }, "u1", NOW);
const accounts = [{ id: "fb", platform: "facebook", name: "Facebook (PIB)" }, { id: "li", platform: "linkedin", name: "LinkedIn (Peet)" }];

describe("normalizeCadence", () => {
  it("fills defaults and keeps a number per platform", () => {
    const c = normalizeCadence({ postsPerDay: "20", perPlatform: { linkedin: "2", facebook: "" } }, "u1", NOW);
    expect(c).toMatchObject({ postsPerDay: 20, perPlatform: { linkedin: 2 }, days: [0, 1, 2, 3, 4, 5, 6], windowStart: "07:00", windowEnd: "19:00", lookaheadDays: 2, setBy: "u1" });
    expect(targetFor(c, "linkedin")).toBe(2);
    expect(targetFor(c, "instagram")).toBe(20);
  });

  it("refuses bad numbers, hours and days", () => {
    expect(() => normalizeCadence({ postsPerDay: 51 }, "u", NOW)).toThrow("0 to 50");
    expect(() => normalizeCadence({ postsPerDay: 2.5 }, "u", NOW)).toThrow("whole number");
    expect(() => normalizeCadence({ postsPerDay: 3, windowStart: "19:00", windowEnd: "07:00" }, "u", NOW)).toThrow("after the first");
    expect(() => normalizeCadence({ postsPerDay: 3, days: [] }, "u", NOW)).toThrow("at least one day");
    expect(() => normalizeCadence({ postsPerDay: 0 }, "u", NOW)).toThrow("at least one post");
    expect(() => normalizeCadence({ postsPerDay: 3, perPlatform: { myspace: 1 } }, "u", NOW)).toThrow("Unknown platform");
  });

  it("summarises in one line", () => {
    expect(cadenceSummary(base({ perPlatform: { linkedin: 1 }, days: [1, 2, 3, 4, 5] }))).toBe("3 a day on every account (LinkedIn 1), Mon, Tue, Wed, Thu, Fri, 08:00–18:00");
  });
});

describe("slot maths", () => {
  it("spreads slots over the window, first and last on its edges", () => {
    expect(slotTimes(3, "08:00", "18:00")).toEqual(["08:00", "13:00", "18:00"]);
    expect(slotTimes(1, "08:00", "18:00")).toEqual(["13:00"]);
    expect(slotTimes(20, "07:00", "19:00")).toHaveLength(20);
    expect(slotTimes(0, "07:00", "19:00")).toEqual([]);
  });

  it("converts local times in the company's zone", () => {
    expect(zonedInstant("2026-11-18", "08:00", TZ).toISOString()).toBe("2026-11-18T06:00:00.000Z");
    expect(localParts(new Date("2026-11-17T22:30:00Z"), TZ)).toEqual({ day: "2026-11-18", weekday: 3, time: "00:30" });
  });
});

describe("cadenceGaps", () => {
  it("counts each account's posts and lists the free slots for today and the days ahead", () => {
    const posts = [
      { at: "2026-11-17T06:05:00Z", accounts: ["fb", "li"] }, // Tue 08:05 takes 08:00 on both
      { at: "2026-11-18T11:00:00Z", accounts: ["fb"] }, // Wed 13:00 on Facebook
    ];
    const days = cadenceGaps(base(), accounts, posts, NOW, TZ);
    expect(days.map((d) => d.label)).toEqual(["Tue 17", "Wed 18"]);
    expect(days[0]!.accounts).toEqual([
      { id: "fb", name: "Facebook (PIB)", platform: "facebook", target: 3, have: 1 },
      { id: "li", name: "LinkedIn (Peet)", platform: "linkedin", target: 3, have: 1 },
    ]);
    expect(days[0]!.free.map((f) => [f.time, f.accountIds])).toEqual([["13:00", ["fb", "li"]], ["18:00", ["fb", "li"]]]);
    expect(days[1]!.free.map((f) => [f.time, f.accountIds])).toEqual([["08:00", ["fb", "li"]], ["13:00", ["li"]], ["18:00", ["fb", "li"]]]);
    expect(days[1]!.free[0]!.at).toBe("2026-11-18T06:00:00.000Z");
  });

  it("skips slots under two hours away, days off, and platforms set to 0", () => {
    const late = new Date("2026-11-17T10:30:00Z"); // 12:30 local: 13:00 is too close
    const c = base({ perPlatform: { linkedin: 0 }, days: [2] }); // Tuesdays only
    const days = cadenceGaps(c, accounts, [], late, TZ);
    expect(days.map((d) => d.label)).toEqual(["Tue 17"]);
    expect(days[0]!.accounts.map((a) => a.id)).toEqual(["fb"]);
    expect(days[0]!.free.map((f) => f.time)).toEqual(["18:00"]);
  });

  it("the issue section names the slots, the accounts and the rule against copies", () => {
    const c = base();
    const text = cadenceSection(c, cadenceGaps(c, accounts, [], NOW, TZ), new Map(accounts.map((a) => [a.id, a.name]))).join("\n");
    expect(text).toContain("## Fill the calendar (cadence: 3 a day on every account, every day, 08:00–18:00)");
    expect(text).toContain("**Tue 17**: Facebook (PIB) 0/3, LinkedIn (Peet) 0/3");
    expect(text).toContain("- 08:00 (`2026-11-17T06:00:00.000Z`): Facebook (PIB), LinkedIn (Peet)");
    expect(text).toContain("validate-post");
    expect(cadenceSection(c, [], new Map())).toEqual([]);
  });
});
