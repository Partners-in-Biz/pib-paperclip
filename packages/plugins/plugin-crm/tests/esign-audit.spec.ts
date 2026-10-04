import { describe, expect, it } from "vitest";
import { canonicalJson, eventHash, genesisHash, verifyChain, type EventFacts } from "../src/esign-audit.js";
import type { SignEvent } from "../src/esign-store.js";

const DOC = "doc-1";
const TEXT_SHA = "a".repeat(64);

function facts(seq: number, extra: Partial<EventFacts> = {}): EventFacts {
  return { docId: DOC, seq, kind: seq === 1 ? "created" : "viewed", at: `2026-10-0${seq}T10:00:00.000Z`, actor: "agent:am-1", ipHash: null, userAgent: null, detail: { n: seq }, ...extra };
}

/** A trail of n rows written the way `appendEvent` writes them. */
function trail(n: number): SignEvent[] {
  const rows: SignEvent[] = [];
  let prev = genesisHash(DOC, TEXT_SHA);
  for (let seq = 1; seq <= n; seq += 1) {
    const f = facts(seq);
    const hash = eventHash(prev, f);
    rows.push({ id: `e${seq}`, companyId: "co-1", ...f, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe("the hash of one row", () => {
  it("is the same for the same facts whatever order the keys were written in", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(eventHash("p", facts(1, { detail: { a: 1, b: 2 } }))).toBe(eventHash("p", facts(1, { detail: { b: 2, a: 1 } })));
  });

  it("depends on the row before it", () => {
    expect(eventHash("one", facts(2))).not.toBe(eventHash("two", facts(2)));
  });

  it("depends on every fact it records", () => {
    const base = eventHash("p", facts(2));
    const changed: Array<Partial<EventFacts>> = [
      { docId: "doc-2" },
      { seq: 3 },
      { kind: "signed" },
      { at: "2026-10-09T10:00:00.000Z" },
      { actor: "signer" },
      { ipHash: "b".repeat(32) },
      { userAgent: "Mozilla/5.0" },
      { detail: { n: 99 } },
    ];
    for (const change of changed) expect(eventHash("p", facts(2, change)), JSON.stringify(change)).not.toBe(base);
  });

  it("the start of a trail depends on the document and on its exact text", () => {
    expect(genesisHash("doc-1", TEXT_SHA)).not.toBe(genesisHash("doc-2", TEXT_SHA));
    expect(genesisHash("doc-1", TEXT_SHA)).not.toBe(genesisHash("doc-1", "b".repeat(64)));
  });
});

describe("checking a whole trail", () => {
  it("accepts an untouched trail, and an empty one starts from the genesis hash", () => {
    const rows = trail(5);
    expect(verifyChain(DOC, TEXT_SHA, rows)).toMatchObject({ ok: true, problems: [], events: 5, head: rows[4]!.hash });
    expect(verifyChain(DOC, TEXT_SHA, [])).toMatchObject({ ok: true, events: 0, head: genesisHash(DOC, TEXT_SHA) });
  });

  it("finds a changed fact, and names the row", () => {
    const rows = trail(4);
    rows[2] = { ...rows[2]!, actor: "someone-else" };
    const check = verifyChain(DOC, TEXT_SHA, rows);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/Row 3 \(viewed\) was changed/);
  });

  it("finds a row that was pointed at another row, even when its own hash still fits its own facts", () => {
    const rows = trail(4);
    // Row 3 keeps its facts and its hash but claims to follow something else.
    rows[2] = { ...rows[2]!, prevHash: "f".repeat(64) };
    const check = verifyChain(DOC, TEXT_SHA, rows);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/Row 3 \(viewed\) does not follow the row before it/);
  });

  it("finds a row rewritten together with its own hash (the next row no longer follows it)", () => {
    const rows = trail(4);
    const forged = facts(2, { detail: { n: 999 } });
    rows[1] = { ...rows[1]!, ...forged, hash: eventHash(rows[1]!.prevHash, forged) };
    const check = verifyChain(DOC, TEXT_SHA, rows);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/Row 3 .* does not follow the row before it/);
  });

  it("finds a removed row and a swapped pair", () => {
    const rows = trail(4);
    expect(verifyChain(DOC, TEXT_SHA, [rows[0]!, rows[2]!, rows[3]!]).problems[0]).toMatch(/a row is missing/);
    expect(verifyChain(DOC, TEXT_SHA, [rows[0]!, rows[2]!, rows[1]!, rows[3]!]).ok).toBe(false);
  });

  it("finds a row from another document, and a trail rebuilt for other text", () => {
    const rows = trail(3);
    rows[1] = { ...rows[1]!, docId: "doc-9" };
    expect(verifyChain(DOC, TEXT_SHA, rows).problems[0]).toMatch(/belongs to another document/);
    expect(verifyChain(DOC, "c".repeat(64), trail(3)).ok).toBe(false);
  });
});
