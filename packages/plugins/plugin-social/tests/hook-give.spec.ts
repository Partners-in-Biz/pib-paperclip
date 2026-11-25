/** Give to agent from the hook board: the New Task prefill for one part or the whole board. */
import { describe, expect, it } from "vitest";
import { hookGiveText, nextStep, GIVE_NOTE_PLACEHOLDER } from "../src/hook-give.js";
import type { PartRow } from "../src/hook-board.js";

const row = (name: string, verdict: PartRow["verdict"], extra: Partial<PartRow> = {}): PartRow => ({ name, posts: 2, reach: 6, actions: 0, rate: null, verdict, postIds: ["d09de416-aaaa", "e51da063-bbbb"], ...extra });
const board = {
  periodDays: 28, published: 36, tagged: 5, reach: 297,
  control: { hook: null, body: "show-it", cta: "book-20" },
  hooks: [row("loyalty-8to2", "too little reach"), row("four-numbers", "double down", { reach: 400, rate: 6 })],
  bodies: [row("show-it", "keep testing")],
  ctas: [row("book-20", "drop")],
  notes: ["No hook has reached 100 people yet."],
};

describe("hookGiveText", () => {
  it("one hook: the person's line first, its numbers and posts, and a next step for its verdict", () => {
    const out = hookGiveText(board, "hook", "loyalty-8to2", {}, null, "/PAR/social?tab=growth");
    expect(out.title).toBe('Social: more or change hook "loyalty-8to2"');
    expect(out.description.startsWith(GIVE_NOTE_PLACEHOLDER)).toBe(true);
    expect(out.description).toContain("own work (no client)");
    expect(out.description).toContain("verdict **too little reach**");
    expect(out.description).toContain("`d09de416`");
    expect(out.description).toContain("short video");
    expect(out.description).toContain("/PAR/social?tab=growth");
  });

  it("a client's part carries the client in the title and the scope", () => {
    const out = hookGiveText(board, "cta", "book-20", { client_kind: "company", client_ref: "abc", client_name: "Velox" }, "company:abc", null);
    expect(out.title).toBe('[Velox] Social: more or change ask "book-20"');
    expect(out.description).toContain("client `company:abc`");
    expect(out.description).toContain("Stop using this ask");
  });

  it("the whole board lists every part, the control and the board's notes", () => {
    const out = hookGiveText(board, "board", null, {}, null, null);
    expect(out.title).toBe("Social: act on the hook board");
    expect(out.description).toContain("hook `four-numbers`");
    expect(out.description).toContain("body `show-it`, ask `book-20`");
    expect(out.description).toContain("No hook has reached 100 people yet.");
  });

  it("refuses a part that is not on the board", () => {
    expect(() => hookGiveText(board, "hook", "gone", {}, null, null)).toThrow("not on the hook board");
  });
});

describe("nextStep", () => {
  it("fits the verdict", () => {
    expect(nextStep("hook", row("x", "double down"), board.control)).toContain("on the control body `body:show-it` and ask `cta:book-20`");
    expect(nextStep("body", row("x", "keep testing"), board.control)).toContain("one or two more posts");
    expect(nextStep("cta", row("x", "drop"), board.control)).toContain("Stop using this ask");
  });
});
