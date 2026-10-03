/**
 * The claims rule. Copy may describe how a business works (bidding, delivery, fees, guarantees, licences, ownership)
 * only with a wording from the client's fact sheet. A sentence that makes such a claim is checked against the
 * approved wordings; anything else is refused, whoever wrote it. Pure, so it is testable and the same everywhere.
 */

export interface ClientFact {
  kind: "say" | "avoid";
  text: string;
  source?: string | null;
}

/** Words that usually mean a promise or a rule about the business. Generic across clients; each sheet adds its own "avoid". */
export const CLAIM_TERMS: Array<{ re: RegExp; why: string }> = [
  { re: /\breserve(d)?\b/i, why: "a reserve price" },
  { re: /\b(is|are|will be|becomes?|goes? to) (yours|the winner|your)\b/i, why: "who gets or owns an item" },
  { re: /\bguarantee(d|s)?\b/i, why: "a guarantee" },
  { re: /\binspect(ed|ion|s)?\b/i, why: "inspection of goods" },
  { re: /\bverif(y|ied|ies|ication)\b/i, why: "verification of sellers or goods" },
  { re: /\b100\s*%/i, why: "an absolute percentage" },
  // Naming a licence page is fine; saying who needs one, who may hold one or what is allowed is a legal claim.
  { re: /(?=.*\blicen[cs](e|ed|es|ing)\b)(?=.*\b(need|needs|needed|require|requires|required|must|only|valid|without|cannot|can't|allowed|permitted|not|no)\b)/i, why: "licensing rules" },
  { re: /\bFICA\b/i, why: "FICA / legal compliance" },
  { re: /\brefund(s|ed)?\b/i, why: "refunds" },
  { re: /\bwarrant(y|ies)\b/i, why: "a warranty" },
  { re: /\bfree (delivery|shipping|courier)\b/i, why: "free delivery" },
  { re: /\b(lowest|best|cheapest) price/i, why: "a price promise" },
  { re: /\bno (hidden )?(fees?|charges?|commission)\b/i, why: "fees" },
  { re: /\bcommission\b/i, why: "commission" },
  { re: /\bwithin \d+ (working |business )?(hours?|days?)\b/i, why: "a time commitment" },
  { re: /\b(legal(ly)?|lawful(ly)?|compliant|compliance)\b/i, why: "legal compliance" },
];

export interface ClaimViolation {
  sentence: string;
  why: string;
  /** avoid = on the sheet's do-not-say list; unapproved = a claim with no approved wording. */
  kind: "avoid" | "unapproved";
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(" ").filter(Boolean));

/** Share of the sentence's words that are found in the approved wording (1 = the sentence is a cut-down version of it). */
function containment(sentence: string, wording: string): number {
  const s = tokens(sentence);
  if (s.size === 0) return 0;
  const w = tokens(wording);
  let hit = 0;
  for (const t of s) if (w.has(t)) hit += 1;
  return hit / s.size;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|div|tr|br)\s*>|<br\s*\/?>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'");
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
}

/** Minimum overlap with an approved wording for a claim sentence to count as that wording. */
export const APPROVED_OVERLAP = 0.85;

export function checkClaims(texts: Array<string | null | undefined>, facts: ClientFact[]): ClaimViolation[] {
  const say = facts.filter((f) => f.kind === "say");
  const avoid = facts.filter((f) => f.kind === "avoid");
  const out: ClaimViolation[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    for (const sentence of sentencesOf(htmlToText(raw))) {
      // A question is not a claim: its answer is checked.
      if (/\?\s*$/.test(sentence)) continue;
      const key = norm(sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      const avoided = avoid.find((a) => a.text.trim() && norm(sentence).includes(norm(a.text)));
      if (avoided) {
        out.push({ sentence, why: `the fact sheet says never to say: "${avoided.text}"`, kind: "avoid" });
        continue;
      }
      const term = CLAIM_TERMS.find((c) => c.re.test(sentence));
      if (!term) continue;
      if (say.some((f) => containment(sentence, f.text) >= APPROVED_OVERLAP)) continue;
      out.push({ sentence, why: `it makes a claim about ${term.why} and no approved wording covers it`, kind: "unapproved" });
    }
  }
  return out;
}

/** Parses the facts editor: one per line, "+ wording | source" to say, "- phrase" to avoid. */
export function parseFactLines(text: string): ClientFact[] {
  const facts: ClientFact[] = [];
  for (const line of text.split(/\n/)) {
    const m = /^\s*([+-])\s*(.+)$/.exec(line);
    if (!m) continue;
    const [body, source] = m[2]!.split(/\s\|\s/).map((p) => p.trim());
    if (!body) continue;
    facts.push({ kind: m[1] === "+" ? "say" : "avoid", text: body.slice(0, 600), ...(source ? { source: source.slice(0, 300) } : {}) });
  }
  return facts.slice(0, 200);
}

export function factLines(facts: ClientFact[]): string {
  return facts.map((f) => `${f.kind === "say" ? "+" : "-"} ${f.text}${f.source ? ` | ${f.source}` : ""}`).join("\n");
}
