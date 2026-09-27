import { describe, expect, it } from "vitest";
import {
  crmTabBadges,
  dealClient,
  dealClientLabel,
  dealsByStage,
  delayText,
  displayText,
  followUpDue,
  gmailLine,
  gmailState,
  isLocked,
  moduleInstalled,
  moneyInputValue,
  parseMoneyInput,
  quoteHref,
  tabBadge,
  toggleOwned,
} from "../src/ui/crm-view.js";

describe("tab badges", () => {
  it("a plain count is neutral; a tinted one counts only what needs you", () => {
    expect(tabBadge(3)).toEqual({ count: 3 });
    expect(tabBadge(3, 0)).toEqual({ count: 3 });
    expect(tabBadge(3, 1)).toEqual({ count: 1, countTone: "warn" });
  });

  it("three contacts with nothing to follow up are a plain 3, not amber", () => {
    const badges = crmTabBadges({ companies: 1, contacts: 3, deals: 1, sequences: 2, products: 0, followUps: 0, dealsWithoutValue: 0, sequencesAwaitingApproval: 0 });
    expect(badges.contacts).toEqual({ count: 3 });
    expect(badges.overview).toEqual({ count: null });
    expect(badges.products).toEqual({ count: 0 });
  });

  it("the overview adds up everything that needs you", () => {
    const badges = crmTabBadges({ companies: 4, contacts: 9, deals: 5, sequences: 2, products: 1, followUps: 2, dealsWithoutValue: 1, sequencesAwaitingApproval: 1 });
    expect(badges.overview).toEqual({ count: 4, countTone: "warn" });
    expect(badges.contacts).toEqual({ count: 2, countTone: "warn" });
    expect(badges.deals).toEqual({ count: 1, countTone: "warn" });
    expect(badges.sequences).toEqual({ count: 1, countTone: "warn" });
    expect(badges.companies).toEqual({ count: 4 });
  });

  it("a follow-up is due when the next action's time has come (the Cockpit's rule)", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(followUpDue({ nextActionDueAt: "2026-09-27T11:00:00Z" }, now)).toBe(true);
    expect(followUpDue({ nextActionDueAt: "2026-09-20" }, now)).toBe(true);
    expect(followUpDue({ nextActionDueAt: "2026-09-28T09:00:00Z" }, now)).toBe(false);
    expect(followUpDue({ nextActionDueAt: null }, now)).toBe(false);
    expect(followUpDue({}, now)).toBe(false);
    expect(followUpDue({ nextActionDueAt: "soon" }, now)).toBe(false);
  });
});

describe("money a person types", () => {
  it("reads rand, with or without spaces, symbols, thousands and cents", () => {
    expect(parseMoneyInput("15000")).toBe(1_500_000);
    expect(parseMoneyInput("15 000")).toBe(1_500_000);
    expect(parseMoneyInput("R 15,000.50")).toBe(1_500_050);
    expect(parseMoneyInput("R15000")).toBe(1_500_000);
    expect(parseMoneyInput("ZAR 1 500")).toBe(150_000);
    expect(parseMoneyInput("1,500")).toBe(150_000);
    expect(parseMoneyInput("1,500,000")).toBe(150_000_000);
    expect(parseMoneyInput("1500,5")).toBe(150_050);
    expect(parseMoneyInput("1 500,50")).toBe(150_050);
    expect(parseMoneyInput("1.500,50")).toBe(150_050);
    expect(parseMoneyInput("1.500.000")).toBe(150_000_000);
    expect(parseMoneyInput("0.5")).toBe(50);
    expect(parseMoneyInput(" 7 500 ")).toBe(750_000);
  });

  it("empty is no value yet; anything else is refused", () => {
    expect(parseMoneyInput("")).toBe(0);
    expect(parseMoneyInput("   ")).toBe(0);
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("R")).toBeNull();
    expect(parseMoneyInput("-100")).toBeNull();
    expect(parseMoneyInput("1.505")).toBeNull();
    expect(parseMoneyInput("12a")).toBeNull();
    expect(parseMoneyInput(".")).toBeNull();
  });

  it("starts a money field from minor units", () => {
    expect(moneyInputValue(150_000)).toBe("1500");
    expect(moneyInputValue(150_050)).toBe("1500.50");
    expect(moneyInputValue(5)).toBe("0.05");
    expect(moneyInputValue(0)).toBe("");
    expect(parseMoneyInput(moneyInputValue(1_234_567))).toBe(1_234_567);
  });
});

describe("deals", () => {
  const names = { companies: { acme: "Acme" } as Record<string, string>, contacts: { ada: "Ada Lovelace" } as Record<string, string> };
  const company = (id: string) => names.companies[id] ?? null;
  const contact = (id: string) => names.contacts[id] ?? null;

  it("a deal is for its company, else its contact", () => {
    expect(dealClient({ id: "d", accountId: "acme", contactId: "ada" })).toEqual({ kind: "company", id: "acme" });
    expect(dealClient({ id: "d", accountId: null, contactId: "ada" })).toEqual({ kind: "contact", id: "ada" });
    expect(dealClient({ id: "d", accountId: null, contactId: null })).toBeNull();
  });

  it("shows who the deal is for on its card", () => {
    expect(dealClientLabel({ id: "d", accountId: "acme", contactId: "ada" }, company, contact)).toBe("Acme · Ada Lovelace");
    expect(dealClientLabel({ id: "d", accountId: "acme", contactId: null }, company, contact)).toBe("Acme");
    expect(dealClientLabel({ id: "d", accountId: null, contactId: "ada" }, company, contact)).toBe("Ada Lovelace");
    expect(dealClientLabel({ id: "d", accountId: null, contactId: null }, company, contact)).toBeNull();
  });

  it("drafts the quote in Billing for the deal's client", () => {
    expect(quoteHref({ id: "deal-1", accountId: "acme", contactId: "ada" })).toBe("/billing?tab=quotes&client=company%3Aacme");
    expect(quoteHref({ id: "deal-1", accountId: null, contactId: "ada" })).toBe("/billing?tab=quotes&client=contact%3Aada");
    expect(quoteHref({ id: "deal-1", accountId: "acme", contactId: null }, true)).toBe("/billing?tab=quotes&client=company%3Aacme&new=1&dealId=deal-1");
    expect(quoteHref({ id: "deal-1", accountId: null, contactId: null })).toBeNull();
  });

  it("groups deals by stage, open stages first", () => {
    const stages = [
      { id: "won", name: "Won", kind: "won", position: 3 },
      { id: "b", name: "Proposal", kind: "open", position: 1 },
      { id: "lost", name: "Lost", kind: "lost", position: 4 },
      { id: "a", name: "Discovery", kind: "open", position: 0 },
    ];
    const deals = [{ id: "1", stageId: "b" }, { id: "2", stageId: "a" }, { id: "3", stageId: "b" }];
    const grouped = dealsByStage(stages, deals);
    expect(grouped.map((g) => g.stage.name)).toEqual(["Discovery", "Proposal", "Won", "Lost"]);
    expect(grouped[1]!.deals.map((d) => d.id)).toEqual(["1", "3"]);
    expect(grouped[2]!.deals).toEqual([]);
  });
});

describe("field locks", () => {
  it("locks and unlocks a row's fields, keeping every other entry", () => {
    expect(toggleOwned(["name", "custom_x"], ["domain"], true)).toEqual(["name", "custom_x", "domain"]);
    expect(toggleOwned(["name", "domain"], ["domain"], false)).toEqual(["name"]);
    expect(toggleOwned(["tags"], ["nextActionKind", "nextActionDueAt"], true)).toEqual(["tags", "nextActionKind", "nextActionDueAt"]);
    expect(toggleOwned(["nextActionKind", "nextActionDueAt"], ["nextActionKind", "nextActionDueAt"], false)).toEqual([]);
  });

  it("a row is locked only when all of its fields are", () => {
    expect(isLocked(["name"], ["name"])).toBe(true);
    expect(isLocked(["nextActionKind"], ["nextActionKind", "nextActionDueAt"])).toBe(false);
    expect(isLocked([], [])).toBe(false);
  });
});

describe("other modules", () => {
  const contributions = [
    { pluginKey: "partnersinbiz.seo", slots: [{ type: "page" }, { type: "sidebar" }] },
    { pluginKey: "partnersinbiz.social", slots: [{ type: "sidebar" }] },
  ];

  it("a module card shows only when its page is installed", () => {
    expect(moduleInstalled(contributions, "partnersinbiz.seo")).toBe(true);
    expect(moduleInstalled(contributions, "partnersinbiz.social")).toBe(false);
    expect(moduleInstalled(contributions, "partnersinbiz.billing")).toBe(false);
    // Unknown while loading; shown when the list cannot be read (like the workspace tabs).
    expect(moduleInstalled(undefined, "partnersinbiz.seo")).toBeNull();
    expect(moduleInstalled(null, "partnersinbiz.billing")).toBe(true);
  });

  it("reads whether email steps can go out from the Mailbox checklist", () => {
    const status = (gmail: string) => ({ items: [{ key: "settings", status: "done" }, { key: "gmail", status: gmail }] });
    expect(gmailState(status("done"), true)).toBe("connected");
    expect(gmailState(status("missing"), true)).toBe("missing");
    expect(gmailState(status("blocked"), true)).toBe("reconnect");
    expect(gmailState(status("done"), false)).toBe("off");
    expect(gmailState(undefined, true)).toBeNull();
    expect(gmailState(status("done"), null)).toBeNull();
    expect(gmailState(null, true)).toBe("unknown");
  });

  it("says it in one line, only when email cannot go out", () => {
    expect(gmailLine("connected", 2)).toBeNull();
    expect(gmailLine("unknown", 2)).toBeNull();
    expect(gmailLine(null, 2)).toBeNull();
    expect(gmailLine("missing", 0)).toBe("Gmail isn't connected, so email steps can't go out yet.");
    expect(gmailLine("missing", 1)).toBe("Gmail isn't connected, so 1 email sequence can't send.");
    expect(gmailLine("missing", 3)).toBe("Gmail isn't connected, so 3 email sequences can't send.");
    expect(gmailLine("reconnect", 0)).toMatch(/reconnecting/);
    expect(gmailLine("off", 0)).toMatch(/switched off/);
  });
});

describe("other modules' summary text", () => {
  const now = new Date("2026-09-27T10:00:00");

  it("shows money and dates the way this page does", () => {
    expect(displayText("ZAR 7,500.00 outstanding", now)).toBe("R 7,500.00 outstanding");
    expect(displayText("ZAR 7,500.00", now)).toBe("R 7,500.00");
    expect(displayText("2026-09-28", now)).toBe("28 Sep");
    expect(displayText("2025-12-01", now)).toBe("1 Dec 2025");
    expect(displayText(new Date(2026, 8, 28, 15, 30).toISOString(), now)).toBe("28 Sep");
  });

  it("leaves everything else alone", () => {
    expect(displayText("Day 4/90 · Foundation", now)).toBe("Day 4/90 · Foundation");
    expect(displayText("—", now)).toBe("—");
    expect(displayText("ZARA fashion", now)).toBe("ZARA fashion");
    expect(displayText("2026-13-45", now)).toBe("2026-13-45");
  });
});

describe("sequence steps in plain words", () => {
  it("says when a step goes out", () => {
    expect(delayText(0)).toBe("Right away");
    expect(delayText(30)).toBe("After 30 min");
    expect(delayText(60)).toBe("After 1 hour");
    expect(delayText(180)).toBe("After 3 hours");
    expect(delayText(1440)).toBe("After 1 day");
    expect(delayText(4320)).toBe("After 3 days");
  });
});
