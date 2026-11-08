/**
 * The bundled fonts' names and CSS stacks, pure (no React, no DOM) so the unit-tested modules can use them.
 * Copied, not imported, from `src/video-edit/fonts.ts` (which reads the disk); a test keeps the two equal.
 */
import type { LayoutFont } from "../layout.js";

export const UI_FONTS: Record<LayoutFont, { family: string; regular: string; bold: string }> = {
  sans: { family: "Inter", regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf" },
  serif: { family: "Lora", regular: "Lora-Regular.ttf", bold: "Lora-Bold.ttf" },
  rounded: { family: "Nunito", regular: "Nunito-Regular.ttf", bold: "Nunito-Bold.ttf" },
};

/** The CSS family a font id loads under. */
export const loadedFamily = (id: LayoutFont): string => `"Studio ${UI_FONTS[id].family}"`;
const FALLBACK: Record<LayoutFont, string> = { sans: "system-ui, sans-serif", serif: "Georgia, serif", rounded: "ui-rounded, system-ui, sans-serif" };
/** The loaded font first, a generic stack behind it until (or if) it loads. */
export const fontStack = (id: LayoutFont): string => `${loadedFamily(id)}, ${FALLBACK[id]}`;
