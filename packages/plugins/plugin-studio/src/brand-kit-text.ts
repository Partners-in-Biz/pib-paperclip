/** The card prompt with a brand kit added (PAR-8134). Plain module so the page and tests share it. */
import { MAX_TEXT } from "./canvas-rules.js";

/** The prompt with the kit added once, at the end. Null when it would not fit, so the prompt is never cut. */
export function withBrandKit(prompt: string, kitText: string): string | null {
  if (!kitText || prompt.includes(kitText)) return prompt;
  const next = prompt.trim() ? `${prompt.trimEnd()}\n\n${kitText}` : kitText;
  return next.length > MAX_TEXT ? null : next;
}
