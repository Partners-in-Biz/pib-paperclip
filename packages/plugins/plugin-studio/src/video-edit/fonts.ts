/**
 * The fonts a render draws text with. Three SIL OFL families ship in the plugin (`fonts/`, licence in `fonts/OFL.txt`),
 * one per Layout font id (`src/layout.ts` `LayoutFont`), so ffmpeg (drawtext `fontfile=`, ASS `fontsdir`) and, in
 * Phase B, the browser (`FontFace`) draw the same glyphs. Static, unmodified upstream files:
 *   sans    Inter 4.1      (rsms/inter release zip, extras/ttf)
 *   serif   Lora 3.021     (cyrealtype/Lora-Cyrillic fonts/ttf; "Lora" is a Reserved Font Name: never edit these files)
 *   rounded Nunito         (Google Fonts static instances, wght 400/700)
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LayoutFont } from "../layout.js";

export type FontWeight = "regular" | "bold";
export interface FontFamily { family: string; regular: string; bold: string }

export const FONT_IDS = ["sans", "serif", "rounded"] as const satisfies readonly LayoutFont[];
/** `family` is the name inside the TTF: ASS styles select by it, so it must match exactly. */
export const FONTS: Record<LayoutFont, FontFamily> = {
  sans: { family: "Inter", regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf" },
  serif: { family: "Lora", regular: "Lora-Regular.ttf", bold: "Lora-Bold.ttf" },
  rounded: { family: "Nunito", regular: "Nunito-Regular.ttf", bold: "Nunito-Bold.ttf" },
};
export const DEFAULT_FONT: LayoutFont = "sans";

/** The Layout id for a clip's `font` (null = default); undefined when it is not one of ours. */
export function fontId(font: string | null): LayoutFont | undefined {
  if (font === null) return DEFAULT_FONT;
  return (FONT_IDS as readonly string[]).includes(font) ? (font as LayoutFont) : undefined;
}

export function fontFile(id: LayoutFont, weight: FontWeight): string {
  return FONTS[id][weight];
}

/**
 * The folder holding the TTFs: `dist/fonts` beside the built worker (the build copies `fonts/` there), or the package's
 * `fonts/` when running from source (tests). Throws when neither exists, so a broken build fails loudly, not with tofu.
 */
export function fontsDir(): string {
  const candidates = [new URL("./fonts/", import.meta.url), new URL("../../fonts/", import.meta.url)];
  for (const url of candidates) {
    const dir = fileURLToPath(url);
    if (existsSync(`${dir}${FONTS.sans.regular}`)) return dir.replace(/\/$/, "");
  }
  throw new Error("Studio fonts are missing: expected fonts/*.ttf beside the worker (check the plugin build).");
}
