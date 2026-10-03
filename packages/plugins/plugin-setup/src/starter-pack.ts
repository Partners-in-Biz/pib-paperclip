/**
 * The curated memory starter pack (Q7-13). Pure, browser-safe.
 *
 * A new company's memory starts empty (the owner's rule: Paperclip memory is
 * self-contained and grows inside the company). A small pack of company-wide
 * lessons about how the platform and its tools behave can seed it, but only the
 * owner may say yes: the pack is OFF by default, marked "needs owner OK", and
 * only importable once the owner approved this exact content (its hash).
 *
 * The file is a Cockpit memory export (`pib-company-memory`, version 1), so the
 * Cockpit's own `memory.import` loads it: company-wide facts only (client facts
 * are skipped there), exact duplicates skipped, secrets refused, nothing the
 * company already has is changed. Extra keys (`_pack`, `_source`, `_excluded`)
 * are for the reviewer and are never sent.
 */
import { isMemoryArea, isMemoryKind, MEMORY_LIMITS } from "@partnersinbiz/pib-plugin-kit";
import { STARTER_PACK_JSON } from "./pack/data.generated.js";

export interface StarterFact {
  text: string;
  kind: string;
  area: string;
  pinned: boolean;
  status: "active";
  clientRef: null;
  /** Review only: where the fact came from in the live store. */
  source: { factId: string; origin: string; createdAt: string; pinnedLive: boolean; adapted: string } | null;
}

export interface StarterPack {
  name: string;
  version: number;
  status: string;
  needsOwnerOk: boolean;
  builtFrom: string;
  howToUse: string;
  reviewNotes: string[];
  facts: StarterFact[];
  excluded: Array<{ factId: string; reason: string }>;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Text that must never be in a shared fact. A safety net on top of the Cockpit's own filter at import. */
export function sensitiveHint(text: string): string | null {
  if (/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/.test(text)) return "a GitHub token";
  if (/\bsk-[A-Za-z0-9_-]{16,}/.test(text)) return "an API key";
  if (/\bAKIA[0-9A-Z]{12,}/.test(text)) return "an AWS key";
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(text)) return "a private key";
  if (/\b[A-Za-z0-9+/=_-]{40,}\b/.test(text)) return "a long opaque token";
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return "an email address";
  if (/\b\d{13,19}\b/.test(text)) return "a long number (card or id)";
  if (/\b(password|passwd|secret|token)\s*[:=]\s*\S+/i.test(text)) return "a credential";
  return null;
}

/** An issue identifier (`PAR-33`) belongs to one company's tracker; a starter fact must not carry one. */
const ISSUE_ID = /\b[A-Z]{2,6}-\d{1,5}\b/;
const PINNED_KINDS = new Set(["rule", "warning"]);

export function parseStarterPack(raw: unknown): { pack: StarterPack | null; problems: string[] } {
  const problems: string[] = [];
  const root = rec(raw);
  if (!root) return { pack: null, problems: ["the starter pack is not an object"] };
  if (root.format !== "pib-company-memory") problems.push("format must be pib-company-memory (a Cockpit memory export)");
  if (root.version !== 1) problems.push("version must be 1 (the version the Cockpit import reads)");
  const meta = rec(root._pack) ?? {};
  const version = Number(meta.version);
  if (!Number.isInteger(version) || version < 1) problems.push("_pack.version must be a whole number from 1");
  if (meta.needsOwnerOk !== true) problems.push("_pack.needsOwnerOk must stay true: the pack is never seeded without the owner's OK");
  const facts: StarterFact[] = [];
  const seen = new Set<string>();
  const pinnedPerArea = new Map<string, number>();
  const list = Array.isArray(root.facts) ? root.facts : [];
  if (list.length === 0) problems.push("the pack has no facts");
  list.forEach((entry, index) => {
    const fact = rec(entry);
    const where = `fact ${index + 1}`;
    if (!fact) {
      problems.push(`${where} is not an object`);
      return;
    }
    const text = str(fact.text).trim();
    if (text.length < MEMORY_LIMITS.factMinChars || text.length > MEMORY_LIMITS.factMaxChars) problems.push(`${where}: a fact is ${MEMORY_LIMITS.factMinChars} to ${MEMORY_LIMITS.factMaxChars} characters (this one is ${text.length})`);
    if (seen.has(text.toLowerCase())) problems.push(`${where}: the same text appears twice`);
    seen.add(text.toLowerCase());
    if (!isMemoryKind(fact.kind)) problems.push(`${where}: kind ${JSON.stringify(fact.kind)} is not a memory kind`);
    if (!isMemoryArea(fact.area)) problems.push(`${where}: area ${JSON.stringify(fact.area)} is not a memory area`);
    if (fact.clientRef !== null) problems.push(`${where}: a starter fact is company-wide (clientRef must be null)`);
    if (fact.status !== "active") problems.push(`${where}: only active facts are seeded`);
    const pinned = fact.pinned === true;
    if (pinned && !PINNED_KINDS.has(str(fact.kind))) problems.push(`${where}: only a rule or a warning can be pinned`);
    if (pinned) pinnedPerArea.set(str(fact.area), (pinnedPerArea.get(str(fact.area)) ?? 0) + 1);
    if ("sourceIssueId" in fact || "sourceIdentifier" in fact) problems.push(`${where}: carries an issue reference of another company`);
    const hint = sensitiveHint(text);
    if (hint) problems.push(`${where}: the text looks like it contains ${hint}`);
    if (ISSUE_ID.test(text)) problems.push(`${where}: the text names an issue of another company`);
    const source = rec(fact._source);
    facts.push({
      text,
      kind: str(fact.kind),
      area: str(fact.area),
      pinned,
      status: "active",
      clientRef: null,
      source: source ? { factId: str(source.factId), origin: str(source.origin), createdAt: str(source.createdAt), pinnedLive: source.pinnedLive === true, adapted: str(source.adapted) } : null,
    });
  });
  for (const [area, count] of pinnedPerArea) if (count > MEMORY_LIMITS.pinnedMaxPerScope) problems.push(`area ${area} pins ${count} facts (at most ${MEMORY_LIMITS.pinnedMaxPerScope} per scope)`);
  const excluded = (Array.isArray(root._excluded) ? root._excluded : []).map((entry) => {
    const row = rec(entry);
    if (row && "text" in row) problems.push("an excluded entry carries the fact's text: keep only its id and the reason");
    return { factId: str(row?.factId), reason: str(row?.reason) };
  });
  if (problems.length > 0) return { pack: null, problems };
  return {
    pack: {
      name: str(meta.name) || "Starter memory pack",
      version,
      status: str(meta.status) || "candidate",
      needsOwnerOk: true,
      builtFrom: str(meta.builtFrom),
      howToUse: str(meta.howToUse),
      reviewNotes: Array.isArray(meta.reviewNotes) ? meta.reviewNotes.filter((note): note is string => typeof note === "string") : [],
      facts,
      excluded,
    },
    problems,
  };
}

let cached: StarterPack | null = null;

export function loadStarterPack(): StarterPack {
  if (cached) return cached;
  const { pack, problems } = parseStarterPack(STARTER_PACK_JSON);
  if (!pack) throw new Error(`The memory starter pack is not sound: ${problems.slice(0, 5).join("; ")}`);
  cached = pack;
  return pack;
}

/** The body for the Cockpit's `memory.import` action: a memory export with only what the import reads. */
export function starterPackExport(pack: StarterPack, now: string): Record<string, unknown> {
  return {
    format: "pib-company-memory",
    version: 1,
    exportedAt: now,
    companyId: "pib-starter-pack",
    facts: pack.facts.map((fact) => ({ text: fact.text, kind: fact.kind, area: fact.area, pinned: fact.pinned, status: "active", clientRef: null })),
  };
}

/** What the importer reports (`ImportResult`), tolerant of a missing key. */
export function parseImportResult(body: unknown): { added: number; duplicates: number; skippedClient: number; invalid: number } {
  const row = rec(body) ?? {};
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return { added: num(row.added), duplicates: num(row.duplicates), skippedClient: num(row.skippedClient), invalid: Array.isArray(row.invalid) ? row.invalid.length : 0 };
}
