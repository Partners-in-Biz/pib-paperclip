/**
 * Plain writing for work that people and other agents read: comments, questions to the owner, briefs, reports,
 * review verdicts, pull request text, hand-off notes. The rules come from ASD-STE100 Simplified Technical English
 * (a controlled language built so a reader cannot misread an instruction), used at about 80% of its strictness and
 * without its dictionary: the principle (the plainest word, used the same way every time), not the word list.
 *
 * `WRITING_SECTION` is appended to every PiB skill by `withFrontmatter`. `writingFindings` is the mechanical part: only
 * rules a program can check (a word, a mark, a count), so an eval can grade them without a model's judgement.
 */
export const WRITING_HEADING = "## Writing";

export const WRITING_SECTION = `${WRITING_HEADING}

For text a person or another agent reads (comments, questions, briefs, reports, verdicts, pull request text):

- Result first, then the evidence. One idea per sentence, 20 words or fewer.
- Say who does what, in the active voice.
- One name per thing: never rotate synonyms. Plain words, no hedges (might, perhaps). If the doubt is the fact, say what you checked.
- Numbers in a table, commands and errors in a code block.
- Customer-facing copy (posts, emails, proposals, web pages) follows the brand voice instead.
`;

/** Appends the writing section once. */
export function withWritingSection(body: string): string {
  if (body.includes(WRITING_HEADING)) return body;
  return `${body.trimEnd()}\n\n${WRITING_SECTION}`;
}

export interface WritingFinding {
  rule: "long-sentence" | "semicolon" | "hedge" | "passive-no-actor" | "unplain-word";
  /** The words that break the rule, shortened. */
  excerpt: string;
}

export const MAX_SENTENCE_WORDS = 25;

/** Plain replacement for each word the checker flags (the STE habit: the simplest word that means one thing). */
export const UNPLAIN_WORDS: Record<string, string> = {
  utilize: "use",
  utilise: "use",
  leverage: "use",
  facilitate: "help",
  commence: "start",
  "prior to": "before",
  "in order to": "to",
  ensure: "make sure",
  subsequently: "then",
  approximately: "about",
  additional: "more",
  terminate: "end",
};

const HEDGES = /\b(might|perhaps|possibly|probably|it seems|i think|i believe|should be able to)\b/i;
const PASSIVE = /\b(should|must|needs to|need to|will|has|have|had|can|could) be(?:en)? (?:\w+ly )?\w+(?:ed|en)\b(?! by\b)/i;

function sentencesOf(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*#|-]+/, "").trim())
    .filter((s) => /\p{L}/u.test(s));
}

const clip = (value: string): string => (value.length > 60 ? `${value.slice(0, 59)}…` : value);

/** The mechanical rules, sentence by sentence. Code blocks, inline code and links are ignored. */
export function writingFindings(text: string): WritingFinding[] {
  const out: WritingFinding[] = [];
  for (const sentence of sentencesOf(text)) {
    const words = sentence.split(/\s+/).length;
    if (words > MAX_SENTENCE_WORDS) out.push({ rule: "long-sentence", excerpt: `${words} words: ${clip(sentence)}` });
    if (sentence.includes(";")) out.push({ rule: "semicolon", excerpt: clip(sentence) });
    const hedge = sentence.match(HEDGES);
    if (hedge) out.push({ rule: "hedge", excerpt: hedge[0] });
    const passive = sentence.match(PASSIVE);
    if (passive) out.push({ rule: "passive-no-actor", excerpt: passive[0] });
    for (const word of Object.keys(UNPLAIN_WORDS)) {
      if (new RegExp(`\\b${word}\\b`, "i").test(sentence)) out.push({ rule: "unplain-word", excerpt: `${word} (use "${UNPLAIN_WORDS[word]}")` });
    }
  }
  return out;
}
