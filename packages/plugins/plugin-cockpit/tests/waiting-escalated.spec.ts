import { describe, expect, it } from "vitest";
import type { WaitingItem } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { mergeWaiting } from "../src/merge.js";
import { askWaitingItem, type AskView } from "../src/ask-model.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");

const w = (key: string, kind: WaitingItem["kind"], extra: Partial<WaitingItem> = {}): WaitingItem => ({
  key,
  title: key,
  why: "because",
  kind,
  ...extra,
});

const askView = (id: string, askedAt: string, extra: Partial<AskView> = {}): AskView => ({
  id,
  issueId: `issue-${id}`,
  identifier: `PIB-${id}`,
  issueTitle: `Issue ${id}`,
  kind: "decision",
  question: `Question ${id}`,
  options: ["Yes", "No"],
  why: "Why it matters",
  askedBy: "Test Agent",
  askedByAgentId: "agent-1",
  askedAt,
  updatedAt: askedAt,
  dueBy: null,
  clientRef: null,
  clientName: null,
  ...extra,
});

describe("waiting on you: escalated asks ordering", () => {
  it("puts escalated asks first within the asks group, oldest escalated first", () => {
    // All asked at different times, so sort will use escalation status then asked time
    const older = askView("older-esc", "2026-09-25T08:00:00.000Z"); // asked earliest
    const newer = askView("newer-esc", "2026-09-25T09:00:00.000Z"); // asked middle
    const notEsc = askView("not-esc", "2026-09-25T10:00:00.000Z"); // asked latest

    const itemOlder = askWaitingItem(older, "2026-09-26T08:00:00.000Z"); // escalated earlier
    const itemNewer = askWaitingItem(newer, "2026-09-26T09:00:00.000Z"); // escalated later
    const itemNotEsc = askWaitingItem(notEsc); // no escalation

    const merged = mergeWaiting([
      {
        source: "asks",
        items: [itemNotEsc, itemNewer, itemOlder],
      },
    ]);

    // Escalated asks come first: older escalated (08:00), then newer escalated (09:00), then non-escalated
    expect(merged.map((m) => m.key)).toEqual([
      `ask:${older.id}`, // escalated at 08:00
      `ask:${newer.id}`, // escalated at 09:00
      `ask:${notEsc.id}`, // not escalated
    ]);
  });

  it("puts escalated asks before non-ask items (money, legal, etc.)", () => {
    const ask = askView("ask-esc", "2026-09-25T10:00:00.000Z");
    const money = w("money:1", "money", { since: "2026-09-26T09:00:00.000Z" });
    const legal = w("legal:1", "legal", { since: "2026-09-26T08:00:00.000Z" });

    const merged = mergeWaiting([
      { source: "asks", items: [{ ...askWaitingItem(ask, "2026-09-26T09:00:00.000Z") }] },
      { source: "billing", items: [money] },
      { source: "crm", items: [legal] },
    ]);

    // Asks come first (escalated or not), then money/legal
    expect(merged.map((m) => m.key)).toEqual([
      `ask:${ask.id}`,
      "money:1",
      "legal:1",
    ]);
  });

  it("preserves existing ordering for non-escalated asks by kind then asked time", () => {
    // Non-escalated asks should order by kind rank: money (0) < legal (1) < decision (judgement, 3)
    const legalAsk = askView("legal", "2026-09-25T08:00:00.000Z", { kind: "legal" }); // asked earliest
    const moneyAsk = askView("money", "2026-09-25T09:00:00.000Z", { kind: "money" }); // asked middle
    const decisionAsk = askView("decision", "2026-09-25T10:00:00.000Z", { kind: "decision" }); // asked latest

    const merged = mergeWaiting([
      {
        source: "asks",
        items: [
          { ...askWaitingItem(decisionAsk) },
          { ...askWaitingItem(moneyAsk) },
          { ...askWaitingItem(legalAsk) },
        ],
      },
    ]);

    // Non-escalated asks order by kind rank: money (0) < legal (1) < decision (judgement, 3)
    expect(merged.map((m) => m.key)).toEqual([
      `ask:${moneyAsk.id}`, // money kind (rank 0)
      `ask:${legalAsk.id}`, // legal kind (rank 1)
      `ask:${decisionAsk.id}`, // decision→judgement kind (rank 3)
    ]);
  });

  it("orders escalated asks by escalation time (oldest escalated first) within the escalated group", () => {
    // Two escalated asks and one not escalated, all asked at same time to isolate escalation ordering
    const escalated1 = askView("esc1", "2026-09-18T10:00:00.000Z"); // asked at same time
    const escalated2 = askView("esc2", "2026-09-18T10:00:00.000Z"); // asked at same time
    const notEscalated = askView("not-esc", "2026-09-18T10:00:00.000Z"); // asked at same time, not escalated

    const merged = mergeWaiting([
      {
        source: "asks",
        items: [
          { ...askWaitingItem(escalated1, "2026-09-26T10:00:00.000Z") }, // escalated at 10:00
          { ...askWaitingItem(escalated2, "2026-09-26T09:00:00.000Z") }, // escalated at 09:00
          { ...askWaitingItem(notEscalated) }, // not escalated
        ],
      },
    ]);

    // Escalated asks come first, oldest escalation time first
    expect(merged.map((m) => m.key)).toEqual([
      `ask:${escalated2.id}`, // escalated at 09:00 (earlier)
      `ask:${escalated1.id}`, // escalated at 10:00 (later)
      `ask:${notEscalated.id}`, // not escalated
    ]);
  });
});
