/**
 * The creative bar for a preview's copy. `create-preview` scores the proposed words with the kit's rubric and hands the
 * score and the notes back, and the Reviewer's check issue carries them. It advises: the claims rule and the Reviewer
 * still decide, so a low score never refuses a preview.
 */
import { scoreCreative, type CreativeRubricResult } from "@partnersinbiz/pib-plugin-kit";
import { htmlToText } from "./claims.js";
import type { PreviewChanges } from "./preview.js";

export interface PreviewRubric {
  score: number;
  pass: boolean;
  parts: CreativeRubricResult["parts"];
  notes: string[];
  blockers: string[];
}

/** The copy as a reader meets it: the headline first, then the description and the body text. Null when there is no copy. */
export function previewCopy(changes: PreviewChanges): string | null {
  const parts = [changes.h1 ?? changes.title, changes.metaDescription, changes.bodyHtml ? htmlToText(changes.bodyHtml) : undefined]
    .map((p) => p?.replace(/[ \t]+/g, " ").trim())
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join("\n") : null;
}

export function scorePreviewCopy(changes: PreviewChanges): PreviewRubric | null {
  const text = previewCopy(changes);
  if (!text) return null;
  const r = scoreCreative({ platform: "web", text });
  return { score: r.score, pass: r.pass, parts: r.parts, notes: r.notes, blockers: r.blockers.map((b) => b.text) };
}

export function rubricLines(r: PreviewRubric): string[] {
  const p = r.parts;
  return [
    `Creative score: ${r.score}/100, ${r.pass ? "passes" : "below the bar of 80"} (hook ${p.hook}, clarity ${p.clarity}, brand ${p.brand}, cta ${p.cta}, format ${p.format}). Advice only: tone is unscored here, so judge it yourself.`,
    ...r.blockers.map((b) => `Blocker: ${b}`),
    ...r.notes.map((n) => `Rubric note: ${n}`),
  ];
}
