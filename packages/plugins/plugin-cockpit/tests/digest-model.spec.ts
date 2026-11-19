import { describe, expect, it } from "vitest";
import {
  DIGEST_PLACES,
  digestDue,
  digestLine,
  digestTitle,
  groupDigest,
  nextHistory,
  oldestItem,
  parseHistory,
  placeOf,
  renderDigest,
  sastDate,
  sastDayStart,
  sastHour,
  type DigestItem,
  type DigestStats,
} from "../src/digest-model.js";

const NOW = new Date("2026-11-11T14:05:00.000Z"); // 16:05 SAST
const BASE = "https://paperclip.partnersinbiz.online/PAR/issues/";

function item(identifier: string, action: string, extra: Partial<DigestItem> = {}): DigestItem {
  return { key: `card:${identifier}`, source: "card", action, detail: null, href: `${BASE}${identifier}`, issueId: identifier, identifier, since: "2026-11-10T10:00:00.000Z", holds: 0, ...extra };
}

const NO_STATS: DigestStats = { newAsks: 0, routed: 0, applied: [], history: [], unread: [] };

describe("grouping by where the owner acts", () => {
  // The owner session's hand-made list of 11 Nov 2026 (needs-peet-2026-11-11), one real line per place.
  it.each([
    ["Share the Drive folder \"SA Gun Auctions (Werner)\" with the pib-drive service account as Editor", "quick"],
    ["Open the drafted reply to Ozow in your mailbox and press Send", "quick"],
    ["Export the Apple Distribution certificate from Keychain Access as sga-dist.p12", "mac"],
    ["Put the real upload keystore on the Mac with ~/.config/pib/sga-android.env", "mac"],
    ["Run firebase login --reauth so the Slimwerk deploys work", "mac"],
    ["domains.co.za login or registration", "vault"],
    ["Add the xneelo hosting panel login to the vault", "vault"],
    ["Save REVENUECAT_WEBHOOK_AUTH as a company secret", "secrets"],
    ["Paste the three DKIM CNAME pairs, or a limited SES key", "secrets"],
    ["Add the AdMob rows to the Velox App Privacy form", "stores"],
    ["Create the Xcode Cloud workflow for Velox", "stores"],
    ["Recreate the App Store Connect API key", "stores"],
    ["Connect the PiB LinkedIn company page and reconnect X in Social", "social"],
    ["TikTok Marketing API access: apply for developer access", "applications"],
    ["Google OAuth verification: update the scopes, record the demo video and reply to Google", "applications"],
    ["Install Lumen Read 1.7.2 from TestFlight on your iPhone and post the three sign-in screenshots", "device"],
    ["One R1111 Ozow sandbox EFT for Talent Hub in a normal browser", "device"],
    ["A no-spend test purchase on an Android phone signed in as the licence tester", "device"],
    ["Dolphin Coast Deals: pick logo concept A, B or C", "decisions"],
    ["Deploy the Xero contact-number fix to huntandgun.co.za on Fri 13 Nov?", "decisions"],
  ] as const)("%s -> %s", (action, place) => {
    expect(placeOf({ action, detail: null, source: "card" })).toBe(place);
  });

  it("reads the headline first: a decision stays a decision when its small print mentions a secret", () => {
    expect(placeOf({ action: "Approve the Covalonic M0 release to production?", detail: "The probe needs the admin token and credentials.", source: "card" })).toBe("decisions");
    // With nothing in the headline, the detail places it.
    expect(placeOf({ action: "Two values needed", detail: "Paste the App Store Connect provider token.", source: "card" })).toBe("stores");
  });

  it("a change that is prepared but not applied is a decision, not an application (the first live digest, 11 Nov)", () => {
    expect(placeOf({ action: "Hunt and Gun Sign off: Add 3 internal links to the \"used guns for sale\" page", detail: "Change policy is pr_only. Three contextual links are drafted, not applied.", source: "plugin" })).toBe("decisions");
    expect(placeOf({ action: "Hunt and Gun Sign off: Fix Core Web Vitals on https://huntandgun.co.za/buy-a-gun/", detail: "Prepared, not applied. Policy is pr_only and safe mode.", source: "plugin" })).toBe("decisions");
    expect(placeOf({ action: "MT-S (Peet): Meta apps for Velox and Lumen", detail: null, source: "issue" })).toBe("applications");
    expect(placeOf({ action: "Apply for TikTok Marketing API access", detail: null, source: "issue" })).toBe("applications");
  });

  it("an approval with nothing else to go on is a quick click; anything else unplaced is a decision", () => {
    expect(placeOf({ action: "Hire request", detail: null, source: "approval" })).toBe("quick");
    expect(placeOf({ action: "Hire request", detail: null, source: "issue" })).toBe("decisions");
  });

  it("lists the places in the owner's order and leaves empty ones out", () => {
    const groups = groupDigest([
      item("PAR-3", "Pick logo concept A, B or C"),
      item("PAR-1", "Run firebase login --reauth"),
      item("PAR-2", "Share the Drive folder with the service account"),
    ]);
    expect(groups.map((g) => g.place)).toEqual(["quick", "mac", "decisions"]);
    expect(groups.map((g) => g.title)).toEqual(["Quick clicks", "At the Mac", "Decisions"]);
    expect(DIGEST_PLACES).toEqual(["quick", "mac", "vault", "secrets", "stores", "social", "applications", "device", "decisions"]);
  });

  it("within a place: what holds most first, then the oldest", () => {
    const groups = groupDigest([
      item("PAR-1", "Pick A or B", { holds: 0, since: "2026-11-01T00:00:00.000Z" }),
      item("PAR-2", "Pick C or D", { holds: 6, since: "2026-11-10T00:00:00.000Z" }),
      item("PAR-3", "Pick E or F", { holds: 0, since: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(groups[0]!.items.map((i) => i.identifier)).toEqual(["PAR-2", "PAR-3", "PAR-1"]);
  });
});

describe("a line", () => {
  it("is one action with a link, and says how many open tasks wait behind it", () => {
    expect(digestLine(item("PAR-7277", "Paste Apple's reply about South Africa", { holds: 14, since: "2026-11-02T10:00:00.000Z" }), NOW)).toBe(
      `- [PAR-7277](${BASE}PAR-7277) Paste Apple's reply about South Africa. Holds 14. Waited 9 days.`,
    );
  });

  it("leaves out what is not there: nothing held, raised today", () => {
    expect(digestLine(item("PAR-1", "Pick A or B?", { since: "2026-11-11T09:00:00.000Z" }), NOW)).toBe(`- [PAR-1](${BASE}PAR-1) Pick A or B?`);
  });

  it("says when the answer applies by itself", () => {
    const line = digestLine(item("PAR-9", "Which layout?", { autoApply: { answer: "Layout A", at: "2026-11-12T08:30:00.000Z" } }), NOW);
    expect(line).toContain("Applies by itself Thu 10:30: Layout A.");
  });

  it("flattens markdown and long text so the list stays a list", () => {
    const line = digestLine(item("PAR-2", `# Heading [link](x)\n\n${"word ".repeat(80)}`), NOW);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("[link]");
    expect(line.length).toBeLessThan(260);
  });
});

describe("the digest", () => {
  const items = [
    item("PAR-760", "Paste the App Store Connect provider token", { since: "2026-09-28T08:00:00.000Z", holds: 1 }),
    item("PAR-7024", "Run firebase login --reauth", { holds: 2 }),
    item("PAR-9331", "Who runs the staging payout re-test?", { since: "2026-11-11T08:00:00.000Z" }),
  ];

  it("opens with the count, the new asks that day and the oldest open one", () => {
    const body = renderDigest({ items, stats: { ...NO_STATS, newAsks: 6, history: [{ date: "2026-11-10", newAsks: 3, open: 30, oldestDays: 43 }] }, now: NOW });
    const head = body.split("\n")[0]!;
    expect(head).toBe(`3 items wait on you, in 3 places. New asks today: 6 (11-10: 3). Oldest open: [PAR-760](${BASE}PAR-760), 44 days.`);
  });

  it("says first reading when there is no earlier day, and not counted when the count failed", () => {
    expect(renderDigest({ items, stats: { ...NO_STATS, newAsks: 2 }, now: NOW })).toContain("New asks today: 2 (first reading).");
    expect(renderDigest({ items, stats: { ...NO_STATS, newAsks: null }, now: NOW })).toContain("New asks today: not counted.");
  });

  it("shows the trend once there are two earlier digests", () => {
    const history = [
      { date: "2026-11-09", newAsks: 8, open: 80, oldestDays: 40 },
      { date: "2026-11-10", newAsks: 3, open: 30, oldestDays: 43 },
    ];
    expect(renderDigest({ items, stats: { ...NO_STATS, history }, now: NOW })).toContain("Last 2 digests, open items: 80, 30. New asks: 8, 3.");
  });

  it("has one section per place, each line once", () => {
    const body = renderDigest({ items, stats: NO_STATS, now: NOW });
    expect(body).toContain("**At the Mac** (1)");
    expect(body).toContain("**Store consoles** (1)");
    expect(body).toContain("**Decisions** (1)");
    expect(body.match(/^- \[PAR-/gm)).toHaveLength(3);
    expect(body.indexOf("At the Mac")).toBeLessThan(body.indexOf("Store consoles"));
  });

  it("reports what answered itself, what went to a seat, and what could not be read", () => {
    const body = renderDigest({
      items,
      stats: { newAsks: 1, routed: 4, applied: [{ identifier: "PAR-9", href: `${BASE}PAR-9`, answer: "Layout A" }], history: [], unread: ["approval cards (the Cockpit is not allowed to read them yet)"] },
      now: NOW,
    });
    expect(body).toContain("**Applied by itself since the last digest**");
    expect(body).toContain(`- [PAR-9](${BASE}PAR-9) Layout A`);
    expect(body).toContain("4 asks today went to the seat that decides them, not to you.");
    expect(body).toContain("Not read this time: approval cards (the Cockpit is not allowed to read them yet).");
  });

  it("caps the list and counts the rest", () => {
    const many = Array.from({ length: 95 }, (_, i) => item(`PAR-${i + 1}`, `Pick option ${i + 1}`));
    const body = renderDigest({ items: many, stats: NO_STATS, now: NOW, cockpitHref: "https://x/PAR/cockpit" });
    expect(body.match(/^- \[PAR-/gm)).toHaveLength(80);
    expect(body).toContain("15 more not shown: [Waiting on you](https://x/PAR/cockpit).");
  });

  it("finds the oldest item", () => {
    expect(oldestItem(items)?.identifier).toBe("PAR-760");
    expect(oldestItem([item("PAR-1", "x", { since: null })])).toBeNull();
  });
});

describe("once a day at 16:00 SAST", () => {
  it("is due from 16:00 to the evening, once per SAST day", () => {
    expect(digestDue(new Date("2026-11-11T13:59:00.000Z"), null)).toBe(false); // 15:59
    expect(digestDue(new Date("2026-11-11T14:00:00.000Z"), null)).toBe(true); // 16:00
    expect(digestDue(new Date("2026-11-11T14:15:00.000Z"), "2026-11-11")).toBe(false); // posted today
    expect(digestDue(new Date("2026-11-11T14:15:00.000Z"), "2026-11-10")).toBe(true);
    expect(digestDue(new Date("2026-11-11T19:45:00.000Z"), null)).toBe(true); // 21:45, a missed one is caught up
    expect(digestDue(new Date("2026-11-11T20:00:00.000Z"), null)).toBe(false); // 22:00, too late: tomorrow
  });

  it("keeps SAST days", () => {
    expect(sastDate(new Date("2026-11-11T22:30:00.000Z"))).toBe("2026-11-12");
    expect(sastHour(new Date("2026-11-11T22:30:00.000Z"))).toBe(0);
    expect(sastDayStart(new Date("2026-11-11T14:00:00.000Z")).toISOString()).toBe("2026-11-10T22:00:00.000Z");
    expect(digestTitle(NOW)).toBe("16:00 digest 2026-11-11");
  });

  it("keeps two weeks of history, one row per day", () => {
    const days = Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, newAsks: i, open: i, oldestDays: i }));
    const next = nextHistory(days, { date: "2026-10-20", newAsks: 99, open: 5, oldestDays: 2 });
    expect(next).toHaveLength(14);
    expect(next.at(-1)).toEqual({ date: "2026-10-20", newAsks: 99, open: 5, oldestDays: 2 });
    expect(parseHistory([{ date: "bad" }, { date: "2026-11-10", newAsks: 3, open: 30 }, null])).toEqual([{ date: "2026-11-10", newAsks: 3, open: 30, oldestDays: null }]);
  });
});
