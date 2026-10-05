import { describe, expect, it } from "vitest";
import {
  baselineSelect,
  clientChoice,
  clientsMentioned,
  estimateTokens,
  factHash,
  factLine,
  isLive,
  jevBatches,
  jevSelect,
  normalizeFactText,
  overlap,
  parseLearned,
  pack,
  rankFacts,
  renderBrief,
  scoresFrom,
  SELECTION,
  sensitiveReason,
  tokenize,
  type MemoryFact,
  type TaskContext,
} from "../src/memory/engine.js";
import { factValue } from "../src/memory/service.js";
import { knownClientsFrom, type CrmClientRow } from "../src/clients.js";

const NOW = new Date("2026-09-27T12:00:00Z");

function fact(partial: Partial<MemoryFact> & { id: string; text: string }): MemoryFact {
  return {
    companyId: "co",
    clientRef: null,
    clientName: null,
    area: "general",
    kind: "fact",
    pinned: false,
    status: "active",
    supersedes: null,
    supersededBy: null,
    sourceIssueId: null,
    sourceIdentifier: null,
    origin: "tool",
    sourceCommentId: null,
    createdByAgentId: null,
    createdByUserId: null,
    expiresAt: null,
    useCount: 0,
    lastUsedAt: null,
    helpfulCount: 0,
    noiseCount: 0,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...partial,
  };
}

function task(partial: Partial<TaskContext> = {}): TaskContext {
  return { issueId: "i1", identifier: "PIB-1", title: "Write the Northwind blog post", description: "", context: [], clientRefs: ["company:nw"], clientNames: ["Northwind"], area: "seo", ...partial };
}

describe("text helpers", () => {
  it("normalizes one line and drops list markers", () => {
    expect(normalizeFactText("  - Uses   WordPress\n on WP Engine ")).toBe("Uses WordPress on WP Engine");
    expect(normalizeFactText("2) Posts go out at 09:00")).toBe("Posts go out at 09:00");
  });

  it("tokenizes with stop words and crude stems", () => {
    expect(tokenize("The client prefers posting blogs on Mondays")).toEqual(["prefer", "post", "blog", "monday"]);
    expect(tokenize("a to of 2026")).toEqual([]);
  });

  it("hashes the same fact the same way regardless of case and punctuation, per scope", () => {
    expect(factHash("company:a", "Uses WordPress.")).toBe(factHash("company:a", "uses wordpress"));
    expect(factHash("company:a", "Uses WordPress")).not.toBe(factHash("company:b", "Uses WordPress"));
    expect(factHash(null, "x y z")).not.toBe(factHash("company:a", "x y z"));
  });

  it("measures overlap for near-duplicates", () => {
    expect(overlap("Blog posts must use British spelling", "Use British spelling in blog posts")).toBeGreaterThanOrEqual(0.7);
    expect(overlap("Invoices go out on the 25th", "Blog posts must use British spelling")).toBe(0);
  });

  it("estimates tokens at about four characters each", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});

describe("secret guard", () => {
  it.each([
    ["sk-live-abcdefghijklmnopqrstuvwxyz123456", "an API key"],
    ["token: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD", "a GitHub token"],
    ["the password: hunter2!!", "a password or key"],
    ["AKIAABCDEFGHIJKLMNOP is the key", "an AWS access key"],
    ["card 4111 1111 1111 1111 on file", "a card number"],
    ["ID 8001015009087", "an ID number"],
    ["-----BEGIN RSA PRIVATE KEY----- xyz", "a private key"],
  ])("refuses %s", (text, reason) => {
    expect(sensitiveReason(text)).toBe(reason);
  });

  it.each([
    "Northwind prefers British spelling and a friendly tone.",
    "Their site runs on WordPress; deploys go through WP Engine staging.",
    "Invoices are due in 14 days; they pay on the 25th.",
    "The API key is in the SEO plugin settings.",
    "Phone +27 82 555 1234 is the office line.",
  ])("allows %s", (text) => {
    expect(sensitiveReason(text)).toBeNull();
  });
});

describe("clients", () => {
  const known = [
    { clientRef: "company:nw", clientName: "Northwind" },
    { clientRef: "company:ac", clientName: "Acme & Co" },
    { clientRef: "contact:jo", clientName: "Jo" },
  ];

  it("finds whole-word client names, case-insensitively", () => {
    expect(clientsMentioned("[Northwind] Fix meta titles", known)).toEqual(["company:nw"]);
    expect(clientsMentioned("Post for acme & co and northwind", known)).toEqual(["company:nw", "company:ac"]);
    expect(clientsMentioned("Northwinds are cold", known)).toEqual([]);
    expect(clientsMentioned("Jo wants a call", known)).toEqual([]); // names under 3 characters are ignored
  });

  it("a person who works for several known companies names every one of them", () => {
    const crm: CrmClientRow[] = [
      { kind: "company", id: "b", name: "Bravo Farms", domain: null, lifecycle: "customer", accountIds: [] },
      { kind: "company", id: "a", name: "Alpha Legal", domain: null, lifecycle: "customer", accountIds: [] },
      { kind: "company", id: "c", name: "Charlie Auctions", domain: null, lifecycle: "lead", accountIds: [] },
      { kind: "contact", id: "p1", name: "Pieter Goosen", domain: null, lifecycle: "customer", accountIds: ["c", "gone", "a", "b", "a"] },
      { kind: "contact", id: "p2", name: "Solo Trader", domain: null, lifecycle: "lead", accountIds: ["gone"] },
    ];
    const known = knownClientsFrom(crm, []);
    // Sorted by id and deduplicated; a link to a company the CRM no longer has is ignored.
    expect(clientsMentioned("Draft an email to Pieter Goosen", known)).toEqual(["company:a", "company:b", "company:c"]);
    // Naming one company still finds just that one.
    expect(clientsMentioned("[Alpha Legal] renew the retainer", known)).toEqual(["company:a"]);
    // A contact with no known company is still its own client.
    expect(clientsMentioned("Call Solo Trader", known)).toEqual(["contact:p2"]);
  });

  it("builds a Jev choice over known clients with a none option", () => {
    const choice = clientChoice(task({ clientRefs: [], clientNames: [] }), known)!;
    expect(Object.values(choice.options)).toEqual(["company:nw", "company:ac", "contact:jo"]);
    const criteria = (choice.questions.client as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toContain("none");
    expect(clientChoice(task(), [])).toBeNull();
  });
});

describe("ranking and selection", () => {
  const facts = [
    fact({ id: "blog", text: "Northwind blog posts use British spelling and a friendly tone.", clientRef: "company:nw", clientName: "Northwind", area: "seo" }),
    fact({ id: "invoice", text: "Northwind pays invoices on the 25th.", clientRef: "company:nw", clientName: "Northwind", area: "billing" }),
    fact({ id: "rule", text: "Never publish on Sundays.", kind: "rule", pinned: true }),
    fact({ id: "misc", text: "The office coffee machine is broken.", area: "operations" }),
  ];

  it("ranks pinned, client, area and keyword matches first", () => {
    const ranked = rankFacts(facts, task(), NOW);
    expect(ranked[0]!.fact.id).toBe("rule");
    expect(ranked[1]!.fact.id).toBe("blog");
    expect(ranked.at(-1)!.fact.id).toBe("misc");
    expect(ranked.find((r) => r.fact.id === "blog")!.lexical).toBeGreaterThan(0);
  });

  it("baseline keeps pinned and matching facts, not unrelated ones", () => {
    const ids = baselineSelect(rankFacts(facts, task(), NOW)).map((r) => r.fact.id);
    expect(ids).toContain("rule");
    expect(ids).toContain("blog");
    expect(ids).not.toContain("misc");
  });

  it("Jev selection keeps pinned plus facts at or above the threshold, most likely first", () => {
    const ranked = rankFacts(facts, task(), NOW);
    const picked = jevSelect(ranked, { blog: 0.9, invoice: 0.2, misc: SELECTION.jevThreshold }).map((r) => r.fact.id);
    expect(picked).toEqual(["rule", "blog", "misc"]);
  });

  it("packs within the fact and token caps, pinned first", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ fact: fact({ id: `f${i}`, text: `Fact number ${i} about the Northwind blog and its many pages. `.repeat(3).slice(0, 290) }), score: 1, lexical: 1, clientMatch: true, areaMatch: true, pinApplies: false }));
    const pinned = { fact: fact({ id: "p", text: "Pinned rule", pinned: true, kind: "rule" }), score: 0, lexical: 0, clientMatch: false, areaMatch: false, pinApplies: true };
    const packed = pack([...many, pinned]);
    expect(packed.facts[0]!.fact.id).toBe("p");
    expect(packed.facts.length).toBeLessThanOrEqual(12);
    expect(packed.tokens).toBeLessThanOrEqual(1500);
    const tight = pack([...many], { maxFacts: 50, maxTokens: 300 });
    expect(tight.tokens).toBeLessThanOrEqual(300);
  });

  it("a brief for several clients keeps each client's best facts, then fills by rank", () => {
    const row = (id: string, ref: string, score: number) => ({ fact: fact({ id, text: `Fact ${id}.`, clientRef: ref, clientName: ref }), score, lexical: 0, clientMatch: true, areaMatch: true, pinApplies: false });
    const ordered = [
      ...Array.from({ length: 10 }, (_, i) => row(`a${i}`, "company:a", 10 - i)),
      row("b0", "company:b", 0.9),
      row("b1", "company:b", 0.8),
      row("c0", "company:c", 0.7),
    ];
    const ids = pack(ordered, { maxFacts: 6, maxTokens: 1500 }).facts.map((r) => r.fact.id);
    expect(ids).toEqual(expect.arrayContaining(["a0", "b0", "b1", "c0"]));
    expect(ids).toHaveLength(6);
    // Five clients in the usual 12 slots: every one appears (2 each), none is left out.
    const five = ["a", "b", "c", "d", "e"].flatMap((c, k) => Array.from({ length: 6 }, (_, i) => row(`${c}${i}`, `company:${c}`, 10 - k - i * 0.1)));
    const shared = pack(five.sort((x, y) => y.score - x.score)).facts.map((r) => r.fact.clientRef);
    expect(new Set(shared).size).toBe(5);
    expect(shared).toHaveLength(12);
    // One client: plain rank order, unchanged.
    const single = pack(ordered.filter((r) => r.fact.clientRef === "company:a"), { maxFacts: 4, maxTokens: 1500 }).facts.map((r) => r.fact.id);
    expect(single).toEqual(["a0", "a1", "a2", "a3"]);
  });

  describe("pinned rules from another area", () => {
    const mixed = [
      fact({ id: "books", text: "Books start on 1 March: never import earlier bank statements.", kind: "rule", pinned: true, area: "accounting" }),
      fact({ id: "everywhere", text: "Always call the tools as MCP tools.", kind: "rule", pinned: true, area: "general" }),
      fact({ id: "clientpin", text: "Northwind never wants comparisons with other suppliers.", kind: "rule", pinned: true, clientRef: "company:nw", clientName: "Northwind", area: "billing" }),
      fact({ id: "blog", text: "Northwind blog posts use British spelling and a friendly tone.", clientRef: "company:nw", clientName: "Northwind", area: "seo" }),
    ];
    const applies = (ranked: ReturnType<typeof rankFacts>, id: string) => ranked.find((r) => r.fact.id === id)!.pinApplies;

    it("forces a pin only when it applies: the client's own, company-wide general, or the task's area", () => {
      const seo = rankFacts(mixed, task(), NOW);
      expect(applies(seo, "books")).toBe(false);
      expect(applies(seo, "everywhere")).toBe(true);
      expect(applies(seo, "clientpin")).toBe(true);
      expect(applies(seo, "blog")).toBe(false); // not pinned
      const accounting = rankFacts(mixed, task({ area: "accounting", title: "Reconcile the bank", clientRefs: [], clientNames: [] }), NOW);
      expect(applies(accounting, "books")).toBe(true);
      const unknownArea = rankFacts(mixed, task({ area: null }), NOW);
      expect(applies(unknownArea, "books")).toBe(false);
      expect(applies(unknownArea, "everywhere")).toBe(true);
    });

    it("Jev selection leaves another area's pin out unless Jev says the task needs it", () => {
      const ranked = rankFacts(mixed, task(), NOW);
      const without = jevSelect(ranked, { blog: 0.9, books: 0.1 }).map((r) => r.fact.id);
      expect(without).toContain("everywhere");
      expect(without).toContain("clientpin");
      expect(without).toContain("blog");
      expect(without).not.toContain("books");
      const needed = jevSelect(ranked, { blog: 0.9, books: 0.8 }).map((r) => r.fact.id);
      expect(needed).toContain("books");
      expect(needed.indexOf("books")).toBeGreaterThan(needed.indexOf("clientpin")); // a normal pick, after the forced pins
    });

    it("baseline keeps another area's pin only when the task shares words with it", () => {
      const quiet = baselineSelect(rankFacts(mixed, task(), NOW)).map((r) => r.fact.id);
      expect(quiet).not.toContain("books");
      const related = baselineSelect(rankFacts(mixed, task({ title: "Import the bank statements for the Northwind blog" }), NOW)).map((r) => r.fact.id);
      expect(related).toContain("books");
    });

    it("packs the pins that apply first and lets the others compete for the remaining slots", () => {
      const ranked = rankFacts(mixed, task(), NOW);
      const packed = pack(ranked).facts.map((r) => r.fact.id);
      expect(packed.slice(0, 2).sort()).toEqual(["clientpin", "everywhere"]);
      expect(packed).toContain("books"); // room is left, so it still follows as a normal fact
    });
  });

  it("skips expired and inactive facts", () => {
    expect(isLive(fact({ id: "a", text: "x", expiresAt: "2026-09-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isLive(fact({ id: "a", text: "x", expiresAt: "2026-12-01T00:00:00Z" }), NOW)).toBe(true);
    expect(isLive(fact({ id: "a", text: "x", status: "archived" }), NOW)).toBe(false);
  });
});

describe("Jev requests", () => {
  it("batches candidates with one yes/no question each and maps answers back", () => {
    const ranked = rankFacts(Array.from({ length: 45 }, (_, i) => fact({ id: `m${i}`, text: `Fact ${i}` })), task(), NOW);
    const batches = jevBatches(task(), ranked, 40);
    expect(batches).toHaveLength(2);
    expect(Object.keys(batches[0]!.questions)).toHaveLength(40);
    expect(Object.keys(batches[1]!.questions)).toHaveLength(5);
    const q = batches[0]!.questions.f1 as { type: string; instructions: string };
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("facts.f1");
    expect((batches[0]!.state as { task: { title: string } }).task.title).toBe("Write the Northwind blog post");
    const scores = scoresFrom(batches, [{ f1: { type: "noul", noul: 0.8 }, f2: { type: "choice" } }, null]);
    expect(scores).toEqual({ [batches[0]!.keys.f1!]: 0.8 });
  });

  it("keeps the task text short", () => {
    const long = task({ description: "x".repeat(10_000) });
    const batch = jevBatches(long, rankFacts([fact({ id: "a", text: "A fact" })], long, NOW))[0]!;
    expect(((batch.state as { task: { description: string } }).task.description).length).toBe(SELECTION.taskTextMaxChars);
  });
});

describe("rendering and upkeep value", () => {
  it("renders a compact brief with ids and sources", () => {
    const f = fact({ id: "m1", text: "Uses WordPress.", clientName: "Northwind", clientRef: "company:nw", area: "seo", sourceIdentifier: "PIB-9" });
    expect(factLine(f)).toBe("- [m1] (Northwind · seo) Uses WordPress. — PIB-9, 2026-09-20");
    const body = renderBrief({ task: task(), selection: { method: "jev", selected: [{ fact: f, score: 1, lexical: 1, clientMatch: true, areaMatch: true, pinApplies: false }], baselineIds: [], scores: {}, tokens: 10, candidateCount: 1 }, totalFacts: 7, briefId: "b1" });
    expect(body.split("\n")[0]).toBe("Memory brief for PIB-1 (1 of 7 facts, picked by Jev; brief b1):");
    expect(renderBrief({ task: task(), selection: { method: "empty", selected: [], baselineIds: [], scores: {}, tokens: 0, candidateCount: 0 }, totalFacts: 0, briefId: "b2" })).toContain("no stored facts yet");
  });

  it("values useful, recent rules above noisy, old facts", () => {
    const now = NOW.getTime();
    const good = fact({ id: "g", text: "x", helpfulCount: 3, useCount: 10, kind: "rule", lastUsedAt: "2026-09-26T00:00:00Z" });
    const bad = fact({ id: "b", text: "y", noiseCount: 4, lastUsedAt: "2025-01-01T00:00:00Z" });
    expect(factValue(good, now)).toBeGreaterThan(factValue(bad, now));
  });
});

describe("Learned lines", () => {
  it("reads the label line and the bullets under it", () => {
    const body = [
      "Published the post and closed the sprint task.",
      "",
      "**Learned:**",
      "- Northwind wants a booking link at the end of every post.",
      "- Rule: never publish on public holidays.",
      "- Warning: their staging site is slow; allow 10 minutes",
      "  before checking the deploy.",
      "",
      "**Next:** schedule the LinkedIn repurpose.",
    ].join("\n");
    expect(parseLearned(body)).toEqual([
      { text: "Northwind wants a booking link at the end of every post.", kind: null },
      { text: "Never publish on public holidays.", kind: "rule" },
      { text: "Their staging site is slow; allow 10 minutes before checking the deploy.", kind: "warning" },
    ]);
  });

  it.each([
    ["Learned: Acme approves posts on Tuesdays only.", ["Acme approves posts on Tuesdays only."]],
    ["**Learned:** Preference: short captions, no emojis.", ["Short captions, no emojis."]],
    ["## Learned\n1. Pages load faster with WebP.\n2) Keep titles under 60 characters.", ["Pages load faster with WebP.", "Keep titles under 60 characters."]],
    ["What I learned:\n* The CRM export drops contacts without email.", ["The CRM export drops contacts without email."]],
    ["- **Learned:** the invoice template needs the VAT number.", ["the invoice template needs the VAT number."]],
  ])("accepts %s", (body, texts) => {
    expect(parseLearned(body).map((i) => i.text)).toEqual(texts);
  });

  it.each([
    "Learned a lot today about their brand.",
    "**Learned:** none",
    "Learned: nothing new.",
    "Learned: n/a",
    "No label here, just work notes.\n- a bullet that is not a lesson",
    "```\nLearned: this is inside code\n```",
  ])("ignores %s", (body) => {
    expect(parseLearned(body)).toEqual([]);
  });

  it("stops at the next label or text after a blank line, dedupes and caps at five", () => {
    const body = ["Learned:", "- One fact here.", "- one fact here.", "", "Some closing words that are not a lesson.", "- not part of it"].join("\n");
    expect(parseLearned(body).map((i) => i.text)).toEqual(["One fact here."]);
    const many = ["Learned:", ...Array.from({ length: 8 }, (_, i) => `- Fact number ${i} is worth keeping.`)].join("\n");
    expect(parseLearned(many)).toHaveLength(5);
  });
});

