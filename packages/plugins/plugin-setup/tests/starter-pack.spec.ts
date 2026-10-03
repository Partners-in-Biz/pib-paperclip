import { describe, expect, it } from "vitest";
import { MEMORY_LIMITS } from "@partnersinbiz/pib-plugin-kit";
import { STARTER_PACK_JSON } from "../src/pack/data.generated.js";
import { loadStarterPack, parseImportResult, parseStarterPack, sensitiveHint, starterPackExport } from "../src/starter-pack.js";

const raw = () => JSON.parse(JSON.stringify(STARTER_PACK_JSON)) as { facts: Array<Record<string, any>>; _excluded: Array<Record<string, any>>; _pack: Record<string, any>; [key: string]: any };

describe("the candidate starter pack", () => {
  it("is sound and marked as needing the owner's OK", () => {
    const pack = loadStarterPack();
    expect(pack.status).toBe("candidate");
    expect(pack.needsOwnerOk).toBe(true);
    expect(pack.version).toBe(1);
    expect(pack.facts.length).toBeGreaterThanOrEqual(10);
  });

  it("holds only company-wide lessons: no client, no issue number, no email, no secret, no price", () => {
    for (const fact of loadStarterPack().facts) {
      expect(fact.text.length, fact.text).toBeGreaterThanOrEqual(MEMORY_LIMITS.factMinChars);
      expect(fact.text.length, fact.text).toBeLessThanOrEqual(MEMORY_LIMITS.factMaxChars);
      expect(fact.clientRef).toBeNull();
      expect(fact.text, fact.text).not.toMatch(/\b[A-Z]{2,6}-\d{1,5}\b/);
      expect(fact.text, fact.text).not.toMatch(/@/);
      expect(fact.text, fact.text).not.toMatch(/\bR\s?\d[\d,.]*\b/);
      expect(sensitiveHint(fact.text), fact.text).toBeNull();
    }
  });

  it("pins only what is pinned in the live store (a rule or a warning), within the per-scope cap", () => {
    const pack = loadStarterPack();
    const pinned = pack.facts.filter((fact) => fact.pinned);
    expect(pinned.map((fact) => fact.source?.factId).sort()).toEqual(["mkr8xmkt58f", "mrjqvdcte69"]);
    for (const fact of pinned) expect(["rule", "warning"]).toContain(fact.kind);
    for (const fact of pack.facts) expect(fact.source?.pinnedLive ?? false).toBe(fact.pinned);
  });

  it("names where each fact came from and why 22 others were left out, without the left-out text", () => {
    const pack = loadStarterPack();
    const ids = pack.facts.map((fact) => fact.source?.factId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pack.excluded.length).toBe(22);
    for (const entry of pack.excluded) {
      expect(ids).not.toContain(entry.factId);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    expect(JSON.stringify(STARTER_PACK_JSON)).not.toMatch(/Magtape|Huur|FNB|Loyalty Plus|PiB books/);
  });

  it("exports exactly what the Cockpit memory import reads, and nothing for the reviewer", () => {
    const body = starterPackExport(loadStarterPack(), "2026-10-03T10:00:00.000Z") as { format: string; version: number; companyId: string; facts: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ format: "pib-company-memory", version: 1, companyId: "pib-starter-pack" });
    for (const fact of body.facts) {
      expect(Object.keys(fact).sort()).toEqual(["area", "clientRef", "kind", "pinned", "status", "text"]);
      expect(fact.clientRef).toBeNull();
      expect(fact.status).toBe("active");
    }
    expect(body.facts).toHaveLength(loadStarterPack().facts.length);
  });
});

describe("the starter pack validator can fail", () => {
  const problems = (mutate: (pack: ReturnType<typeof raw>) => void) => {
    const pack = raw();
    mutate(pack);
    return parseStarterPack(pack).problems.join(" | ");
  };

  it("refuses a client fact, an issue number, a secret and an email", () => {
    expect(problems((p) => { p.facts[0]!.clientRef = "company:abc"; })).toMatch(/company-wide/);
    expect(problems((p) => { p.facts[0]!.text = "The fix for PAR-33 is to rerun the sync before closing the task."; })).toMatch(/names an issue of another company/);
    expect(problems((p) => { p.facts[0]!.text = "Use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push to the repo."; })).toMatch(/GitHub token/);
    expect(problems((p) => { p.facts[0]!.text = "Mail the answer to someone@example.com when the check is done."; })).toMatch(/email address/);
    expect(problems((p) => { p.facts[0]!.sourceIssueId = "i1"; })).toMatch(/issue reference of another company/);
  });
  it("refuses a bad length, a duplicate, an unknown kind or area and a pinned lesson", () => {
    expect(problems((p) => { p.facts[0]!.text = "short"; })).toMatch(/characters/);
    expect(problems((p) => { p.facts[0]!.text = "x".repeat(301); })).toMatch(/characters/);
    expect(problems((p) => { p.facts[1]!.text = p.facts[0]!.text; })).toMatch(/same text appears twice/);
    expect(problems((p) => { p.facts[0]!.kind = "story"; })).toMatch(/not a memory kind/);
    expect(problems((p) => { p.facts[0]!.area = "legal"; })).toMatch(/not a memory area/);
    expect(problems((p) => { p.facts[0]!.kind = "lesson"; p.facts[0]!.pinned = true; })).toMatch(/only a rule or a warning can be pinned/);
  });
  it("refuses a pack that does not need the owner's OK, a wrong format and a leaked excluded text", () => {
    expect(problems((p) => { p._pack.needsOwnerOk = false; })).toMatch(/needsOwnerOk must stay true/);
    expect(problems((p) => { p.format = "other"; })).toMatch(/format must be pib-company-memory/);
    expect(problems((p) => { p._excluded[0]!.text = "the fact itself"; })).toMatch(/keep only its id and the reason/);
    expect(problems((p) => { p.facts = []; })).toMatch(/no facts/);
  });
  it("refuses more pinned facts in one area than the Cockpit allows", () => {
    expect(problems((p) => {
      p.facts = Array.from({ length: 6 }, (_v, index) => ({ text: `Rule number ${index} says something distinct and long enough.`, kind: "rule", area: "general", pinned: true, status: "active", clientRef: null }));
    })).toMatch(/area general pins 6/);
  });
});

describe("secret hints", () => {
  it("catches the usual shapes and lets plain text through", () => {
    expect(sensitiveHint("key sk-abcdefghijklmnopqrstuvwxyz")).toBe("an API key");
    expect(sensitiveHint("AKIAABCDEFGHIJKLMNOP is ours")).toBe("an AWS key");
    expect(sensitiveHint("-----BEGIN PRIVATE KEY-----")).toBe("a private key");
    expect(sensitiveHint("card 4111111111111111 on file")).toBe("a long number (card or id)");
    expect(sensitiveHint("password: hunter2")).toBe("a credential");
    expect(sensitiveHint("Search the bare name before concluding a client is not in the CRM.")).toBeNull();
  });
});

describe("import results", () => {
  it("reads the Cockpit's answer tolerantly", () => {
    expect(parseImportResult({ added: 3, duplicates: 2, skippedClient: 0, invalid: [{ text: "x", reason: "y" }] })).toEqual({ added: 3, duplicates: 2, skippedClient: 0, invalid: 1 });
    expect(parseImportResult(null)).toEqual({ added: 0, duplicates: 0, skippedClient: 0, invalid: 0 });
  });
});
