import { describe, expect, it } from "vitest";
import { chunkForBatch, decide, decideBatch, type JevQuestions } from "../src/decisions.js";
import { WRITING_HEADING, withWritingSection, writingFindings } from "../src/writing.js";
import { withFrontmatter } from "../src/skills.js";

function fakeCtx() {
  const rows: unknown[][] = [];
  return {
    rows,
    ctx: {
      db: { namespace: "plugin_test_abc", execute: async (_sql: string, params: unknown[]) => (rows.push(params), { rowCount: 1 }) },
      logger: { warn: () => undefined, info: () => undefined },
    } as never,
  };
}

const config = { apiKey: "k", model: "jev-1.13.0", endpoint: "https://jev.test/x" };
const questions: JevQuestions = { intent: { type: "choice", instructions: "Which bucket?", criteria: { a: "A", b: "B" } } };

function jevFetch(handler: (body: { state: any; questions: Record<string, any> }) => Record<string, unknown> | "fail") {
  const calls: Array<{ state: any; questions: Record<string, any> }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers = handler(body);
    if (answers === "fail") return new Response("nope", { status: 400 });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const choiceFor = (choice: string) => ({ type: "choice", choice, probabilities: { [choice]: 0.97 }, confidence: 0.94 });

describe("decideBatch", () => {
  it("asks once for many items, sends the shared context once and splits the answers back per item", async () => {
    const { ctx, rows } = fakeCtx();
    const items = ["x", "y", "z"];
    const jev = jevFetch((body) => Object.fromEntries(Object.keys(body.questions).map((name) => [name, choiceFor(body.state.items[name.endsWith("__0") ? "x" : name.endsWith("__1") ? "y" : "z"] === "bee" ? "b" : "a")])));
    const results = await decideBatch(ctx, "co-1", {
      config,
      purpose: "test.batch",
      subjectKind: "thing",
      items,
      idOf: (i) => i,
      stateOf: (i) => (i === "y" ? "bee" : "ay"),
      questions,
      context: { site: "Acme" },
      fetchImpl: jev.fetchImpl,
    });
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]!.state.context).toEqual({ site: "Acme" });
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["intent__0", "intent__1", "intent__2"]);
    expect(jev.calls[0]!.questions.intent__1.instructions).toContain('"y"');
    expect(results.map((r) => (r!.answers.intent as { choice: string }).choice)).toEqual(["a", "b", "a"]);
    expect(rows).toHaveLength(3); // one logged decision per item, as decide would write
    expect(rows.map((r) => r[4])).toEqual(["x", "y", "z"]);
    expect(results[0]!.ids.intent).toBeTruthy();
  });

  it("splits into requests by item count and falls back to one item at a time when a request fails", async () => {
    const { ctx } = fakeCtx();
    const items = Array.from({ length: 5 }, (_, i) => `i${i}`);
    let first = true;
    const jev = jevFetch((body) => {
      if (first && Object.keys(body.questions).length > 1) {
        first = false;
        return "fail";
      }
      return Object.fromEntries(Object.keys(body.questions).map((n) => [n, choiceFor("a")]));
    });
    const results = await decideBatch(ctx, "co-1", { config, purpose: "p", subjectKind: "t", items, idOf: (i) => i, stateOf: (i) => i, questions, maxItems: 3, fetchImpl: jev.fetchImpl });
    // chunk 1 (3 items) fails then 3 single calls; chunk 2 (2 items) is one call
    expect(jev.calls).toHaveLength(1 + 3 + 1);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it("returns nulls without a key and never calls out", async () => {
    const { ctx } = fakeCtx();
    const jev = jevFetch(() => ({}));
    const results = await decideBatch(ctx, "co-1", { config: null, purpose: "p", subjectKind: "t", items: ["a"], idOf: (i) => i, stateOf: (i) => i, questions, fetchImpl: jev.fetchImpl });
    expect(results).toEqual([null]);
    expect(jev.calls).toHaveLength(0);
    expect(await decide(ctx, "co-1", { config: null, purpose: "p", subject: { kind: "t", id: "a" }, state: "s", questions })).toBeNull();
  });

  it("chunks by characters too, and keeps an oversized item alone", () => {
    expect(chunkForBatch([1, 2, 3, 4], () => 40, 10, 100)).toEqual([[1, 2], [3, 4]]);
    expect(chunkForBatch([1, 2], (n) => (n === 1 ? 500 : 10), 10, 100)).toEqual([[1], [2]]);
  });
});

describe("writing", () => {
  it("is appended once to every skill by withFrontmatter, and can be left out", () => {
    const skill = withFrontmatter({ name: "pib-x", description: "x" }, "# X\n\nBody.");
    expect(skill).toContain(WRITING_HEADING);
    expect(skill.match(/## Writing/g)).toHaveLength(1);
    expect(withWritingSection(skill)).toBe(skill);
    expect(withFrontmatter({ name: "pib-x", description: "x", writing: false }, "# X")).not.toContain(WRITING_HEADING);
  });

  it("finds long sentences, semicolons, hedges, passive without an actor and unplain words, and ignores code and links", () => {
    const text = [
      "Prior to commencing the installation, it should be ensured that all components have been thoroughly inspected for damage and tested against every requirement we listed in the earlier plan.",
      "The task is blocked; we might fix it.",
      "The invoice must be approved.",
      "Use the key at https://example.com/a-very-long-link-that-should-not-count-as-words and run `utilize --prior to` now.",
    ].join(" ");
    const rules = writingFindings(text).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["long-sentence", "semicolon", "hedge", "passive-no-actor", "unplain-word"]));
    expect(writingFindings("Peet approves the invoice. The sync failed. Check the key before you start.")).toEqual([]);
    expect(writingFindings("```\nutilize this; prior to that\n```\nDone.")).toEqual([]);
  });
});
