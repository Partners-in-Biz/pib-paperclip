import { describe, expect, it } from "vitest";
import { capSpeech, chunk, stripMarkdown, toSpeech, REST_IN_CHAT } from "../src/ui/speech-text.js";

describe("stripMarkdown rules", () => {
  const cases: Array<[string, string, string]> = [
    ["heading and bold", "## Done\n**All** green", "Done. All green."],
    ["italic and strike", "It is *really* ~~not~~ fine", "It is really not fine."],
    ["list markers", "- one\n- two\n1. three", "one. two. three."],
    ["fenced code", "Run this:\n```bash\nrm -rf x\n```\nthen wait", "Run this: The code is in the chat. then wait."],
    ["inline code", "Use `pnpm test` now", "Use the code in the chat now."],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\nAfter", "There's a table in the chat. After."],
    ["link keeps its text", "See [the docs](https://example.com/docs) please", "See the docs please."],
    ["bare url", "Open https://example.com/a?b=1 now", "Open a link in the chat now."],
    ["emoji", "Shipped 🚀 it ✅", "Shipped it."],
    ["mention markup", "Thanks [@Ren](agent://abc123) and [Pete](user://u1)", "Thanks Ren and Pete."],
    ["voice footer", "Do the thing\n\n_Sent by voice from PAR-1._", "Do the thing."],
    ["blockquote", "> quoted line", "quoted line."],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(stripMarkdown(input)).toBe(expected));
  }
  it("an empty reply gives nothing to say", () => expect(toSpeech("🚀\n\n---\n")).toBe(""));
});

const FIXTURES = {
  status: `Done. I merged the change and the checks are green.

**What changed**
- Fixed the retry in \`sync.ts\`
- Added a test, see [the PR](https://github.com/acme/repo/pull/12)

Anything else? 🙂`,
  codeAndTable: `Here is the fix:

\`\`\`ts
export const x = 1;
\`\`\`

And the results:

| run | status |
|-----|--------|
| 1   | pass   |
| 2   | pass   |

Both runs passed.`,
  mentions: `[@Pete](user://u-1) your invoice is ready at https://app.example.com/invoices/42.

_Sent by voice from PAR-9._`,
};

describe("real agent reply fixtures", () => {
  it("status update", () => {
    expect(toSpeech(FIXTURES.status)).toBe(
      "Done. I merged the change and the checks are green. What changed. Fixed the retry in the code in the chat. Added a test, see the PR. Anything else?",
    );
  });
  it("code block and table", () => {
    expect(toSpeech(FIXTURES.codeAndTable)).toBe(
      "Here is the fix: The code is in the chat. And the results: There's a table in the chat. Both runs passed.",
    );
  });
  it("mention, bare url and footer", () => {
    expect(toSpeech(FIXTURES.mentions)).toBe("Pete your invoice is ready at a link in the chat.");
  });
});

describe("cap", () => {
  it("leaves short text alone", () => expect(capSpeech("Hi there.")).toBe("Hi there."));
  it("cuts at a sentence end within 1,500 and points to the chat", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} here.`).join(" ");
    const out = toSpeech(text);
    expect(out.endsWith(` ${REST_IN_CHAT}`)).toBe(true);
    const body = out.slice(0, -REST_IN_CHAT.length - 1);
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(body.endsWith("here.")).toBe(true);
  });
  it("falls back to a space when there is no sentence end", () => {
    const out = capSpeech("word ".repeat(600).trim());
    expect(out.endsWith(REST_IN_CHAT)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1500 + REST_IN_CHAT.length + 1);
  });
});

describe("chunk", () => {
  const long = Array.from({ length: 40 }, (_, i) => `This is sentence ${i}, with a comma.`).join(" ");
  it("first chunk at most 160, later at most 300, nothing lost", () => {
    const parts = chunk(long);
    expect(parts[0]!.length).toBeLessThanOrEqual(160);
    for (const part of parts.slice(1)) expect(part.length).toBeLessThanOrEqual(300);
    expect(parts.join(" ")).toBe(long);
  });
  it("breaks on sentence ends when it can", () => {
    for (const part of chunk(long)) expect(part.endsWith(".")).toBe(true);
  });
  it("splits one long sentence on commas, then spaces", () => {
    const sentence = `${"alpha beta, ".repeat(40)}end.`;
    const parts = chunk(sentence);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.length).toBeLessThanOrEqual(160);
    parts.slice(1).forEach(part => expect(part.length).toBeLessThanOrEqual(300));
    expect(parts.slice(0, -1).every(part => part.endsWith(","))).toBe(true);
    const noCommas = chunk("word ".repeat(200).trim());
    noCommas.forEach((part, i) => expect(part.length).toBeLessThanOrEqual(i === 0 ? 160 : 300));
    expect(noCommas.join(" ")).toBe("word ".repeat(200).trim());
  });
  it("short text is one chunk", () => expect(chunk("Hello.")).toEqual(["Hello."]));
});
