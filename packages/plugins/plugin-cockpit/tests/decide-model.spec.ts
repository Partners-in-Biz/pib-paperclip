import { describe, expect, it } from "vitest";
import {
  approvalDetails,
  approvalItem,
  approvalMode,
  askItem,
  buildQueue,
  cardItem,
  cardMode,
  keepRecommended,
  oneLine,
  rankItems,
  type ApprovalSource,
  type AskSource,
  type CardSource,
  type DecideItem,
} from "../src/decide-model.js";

const NOW = new Date("2026-11-28T12:00:00.000Z");
const OWNER = "user-owner";

const ask = (over: Partial<AskSource> = {}): AskSource => ({
  id: "a1", issueId: "i1", question: "Ship it?", why: "It is ready.", effect: null, options: ["Yes", "No"], recommended: "Yes", kind: "decision",
  askedAt: "2026-11-20T08:00:00.000Z", dueBy: null, deadlineAt: null, ownerUserId: null, rowKnown: true, href: "/issues/PAR-1", ...over,
});
const approval = (over: Partial<ApprovalSource> = {}): ApprovalSource => ({
  id: "p1", type: "request_board_approval", status: "pending", payload: { title: "Plan", cost: 12 }, title: "Board approval requested: Plan", why: "Only a board member can approve this.",
  kind: "judgement", createdAt: "2026-11-21T08:00:00.000Z", href: "/approvals/p1", ...over,
});
const card = (over: Partial<CardSource> = {}): CardSource => ({ id: "c1", issueId: "i2", kind: "request_confirmation", status: "pending", title: "Share the folder", text: "Do it then accept.", createdAt: "2026-11-22T08:00:00.000Z", ...over });

describe("rank", () => {
  const item = (over: Partial<DecideItem> & { id: string }): DecideItem => ({
    ref: { kind: "ask", id: over.id, issueId: null }, title: "t", why: "", options: [], recommended: null, details: [], mode: "open", href: null,
    since: "2026-11-20T00:00:00.000Z", overdue: false, class: "decision", ...over,
  });

  it("puts overdue first, then money > legal > grant > decision > other, then oldest, then id", () => {
    const ranked = rankItems([
      item({ id: "other", class: "other" }),
      item({ id: "decision-new", since: "2026-11-25T00:00:00.000Z" }),
      item({ id: "decision-old", since: "2026-11-01T00:00:00.000Z" }),
      item({ id: "grant", class: "grant" }),
      item({ id: "legal", class: "legal" }),
      item({ id: "money", class: "money" }),
      item({ id: "overdue-other", class: "other", overdue: true }),
      item({ id: "b-tie" }),
      item({ id: "a-tie" }),
      item({ id: "no-since", since: null }),
    ]);
    expect(ranked.map((i) => i.ref.id)).toEqual(["overdue-other", "money", "legal", "grant", "decision-old", "a-tie", "b-tie", "decision-new", "no-since", "other"]);
  });

  it("is stable whatever the input order", () => {
    const list = [item({ id: "z" }), item({ id: "y" }), item({ id: "x", overdue: true })];
    expect(rankItems([...list].reverse()).map((i) => i.ref.id)).toEqual(rankItems(list).map((i) => i.ref.id));
  });
});

describe("asks", () => {
  it("cuts the title to 140 characters on one line and keeps the recommended option only when it is an option", () => {
    const long = askItem(ask({ question: `${"word ".repeat(60)}\nsecond line` }), OWNER, NOW);
    expect(long.title.length).toBeLessThanOrEqual(140);
    expect(long.title).not.toContain("\n");
    expect(long.title.endsWith("…")).toBe(true);
    expect(askItem(ask({ recommended: "Yes" }), OWNER, NOW).recommended).toBe("Yes");
    expect(askItem(ask({ recommended: "Maybe" }), OWNER, NOW).recommended).toBeNull();
    expect(keepRecommended(null, ["a"])).toBeNull();
  });

  it("is overdue when the deadline or the due date has passed", () => {
    expect(askItem(ask({ deadlineAt: "2026-11-27T00:00:00.000Z" }), OWNER, NOW).overdue).toBe(true);
    expect(askItem(ask({ dueBy: "2026-11-27T00:00:00.000Z" }), OWNER, NOW).overdue).toBe(true);
    expect(askItem(ask({ deadlineAt: "2026-12-01T00:00:00.000Z" }), OWNER, NOW).overdue).toBe(false);
  });

  it("decides inline only with options, a known row and the owner as its owner", () => {
    expect(askItem(ask(), OWNER, NOW).mode).toBe("decide");
    expect(askItem(ask({ ownerUserId: OWNER }), OWNER, NOW).mode).toBe("decide");
    expect(askItem(ask({ ownerUserId: "someone-else" }), OWNER, NOW).mode).toBe("open");
    expect(askItem(ask({ options: [] }), OWNER, NOW).mode).toBe("open");
    expect(askItem(ask({ rowKnown: false }), OWNER, NOW).mode).toBe("open");
  });

  it("classes info as other and adds the effect to the why", () => {
    expect(askItem(ask({ kind: "info" }), OWNER, NOW).class).toBe("other");
    expect(askItem(ask({ kind: "money" }), OWNER, NOW).class).toBe("money");
    expect(askItem(ask({ effect: "Grants Drive access." }), OWNER, NOW).why).toContain("Grants Drive access.");
  });
});

describe("approvals", () => {
  it("decides only pending request_board_approval and approve_ceo_strategy", () => {
    expect(approvalMode("request_board_approval", "pending")).toBe("decide");
    expect(approvalMode("approve_ceo_strategy", "pending")).toBe("decide");
    expect(approvalMode("request_board_approval", "revision_requested")).toBe("open");
    expect(approvalMode("hire_agent", "pending")).toBe("open");
    expect(approvalMode("budget_override_required", "pending")).toBe("open");
  });

  it("shows details only on an inline approval, at most 8 fields of 200 characters, strings and numbers only", () => {
    const payload: Record<string, unknown> = { note: "x".repeat(500), cost: 12, nested: { a: 1 }, list: [1], flag: true, empty: "  " };
    for (let i = 0; i < 12; i += 1) payload[`f${i}`] = `v${i}`;
    const inline = approvalItem(approval({ payload }));
    expect(inline.details).toHaveLength(8);
    expect(inline.details[0]!.value.length).toBeLessThanOrEqual(200);
    expect(inline.details.map((d) => d.label)).toEqual(["note", "cost", "f0", "f1", "f2", "f3", "f4", "f5"]);
    expect(inline.options).toEqual(["Approve", "Reject"]);
    expect(approvalDetails(null)).toEqual([]);
    const open = approvalItem(approval({ type: "hire_agent", payload }));
    expect(open).toMatchObject({ mode: "open", details: [], options: [] });
    expect(approvalItem(approval({ status: "revision_requested" })).mode).toBe("open");
  });

  it("takes its class from the waiting kind", () => {
    expect(approvalItem(approval({ kind: "money" })).class).toBe("money");
    expect(approvalItem(approval({ kind: "grant" })).class).toBe("grant");
    expect(approvalItem(approval({ kind: "judgement" })).class).toBe("decision");
    expect(approvalItem(approval({ kind: "review" })).class).toBe("other");
  });
});

describe("cards", () => {
  it("classes a card per kind, status and addressee", () => {
    expect(cardMode(card(), OWNER)).toBe("decide");
    expect(cardMode(card({ addresseeUserId: OWNER }), OWNER)).toBe("decide");
    expect(cardMode(card({ addresseeUserId: "other" }), OWNER)).toBeNull();
    expect(cardMode(card({ addresseeAgentId: "agent" }), OWNER)).toBeNull();
    expect(cardMode(card({ status: "accepted" }), OWNER)).toBeNull();
    for (const kind of ["ask_user_questions", "request_checkbox_confirmation"]) expect(cardMode(card({ kind }), OWNER)).toBe("open");
  });

  it("uses the card's title, else its first line, and links to the task", () => {
    expect(cardItem(card(), OWNER)).toMatchObject({ title: "Share the folder", why: "Do it then accept.", href: "/issues/i2", mode: "decide", options: ["Accept", "Reject"] });
    expect(cardItem(card({ title: null, text: "First line\nSecond line" }), OWNER)).toMatchObject({ title: "First line", why: "Second line" });
    expect(cardItem(card({ kind: "ask_user_questions" }), OWNER)).toMatchObject({ mode: "open", options: [] });
    expect(cardItem(card({ addresseeUserId: "other" }), OWNER)).toBeNull();
  });
});

describe("buildQueue", () => {
  it("ranks asks, approvals and cards together and drops cards that are not the owner's", () => {
    const queue = buildQueue({
      now: NOW,
      ownerUserId: OWNER,
      asks: [ask({ id: "a-money", kind: "money" }), ask({ id: "a-late", deadlineAt: "2026-11-27T00:00:00.000Z" })],
      approvals: [approval()],
      cards: [card(), card({ id: "c-agent", addresseeAgentId: "agent" })],
    });
    expect(queue.map((i) => `${i.ref.kind}:${i.ref.id}`)).toEqual(["ask:a-late", "ask:a-money", "approval:p1", "card:c1"]);
  });

  it("flattens whitespace", () => {
    expect(oneLine("  a \n b\t c ", 20)).toBe("a b c");
  });
});
