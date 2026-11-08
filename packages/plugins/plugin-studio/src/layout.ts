/**
 * The Layout card's plain logic: the sizes stores and printers ask for, how words split into parts, and where text goes
 * on a page. No React, canvas or Node here, so the page and the tests share it. Real text is drawn by the browser
 * (`ui/layout-render.ts`), because image models garble lettering.
 *
 * Sizes checked 2026-11-07: Apple's screenshot specifications (iPhone 6.9" 1320x2868, iPad 13" 2064x2752) and Google's
 * preview asset rules (phone 1080x1920, feature graphic 1024x500). Stores change these: check before a submission.
 */

export interface LayoutSize {
  id: string;
  group: string;
  label: string;
  width: number;
  height: number;
}

export const LAYOUT_SIZES: readonly LayoutSize[] = [
  { id: "app-store-iphone", group: "App stores", label: 'App Store iPhone 6.9"', width: 1320, height: 2868 },
  { id: "app-store-ipad", group: "App stores", label: 'App Store iPad 13"', width: 2064, height: 2752 },
  { id: "play-phone", group: "App stores", label: "Google Play phone", width: 1080, height: 1920 },
  { id: "play-feature", group: "App stores", label: "Google Play feature graphic", width: 1024, height: 500 },
  { id: "social-portrait", group: "Social", label: "Portrait post", width: 1080, height: 1350 },
  { id: "social-square", group: "Social", label: "Square post", width: 1080, height: 1080 },
  { id: "social-story", group: "Social", label: "Story or reel cover", width: 1080, height: 1920 },
  { id: "ad-landscape", group: "Ads and video", label: "Landscape ad", width: 1200, height: 628 },
  { id: "youtube", group: "Ads and video", label: "YouTube thumbnail", width: 1280, height: 720 },
  { id: "ebook-cover", group: "Books", label: "Ebook cover", width: 1600, height: 2560 },
  { id: "book-a4", group: "Books", label: "A4 page, 300 dpi", width: 2480, height: 3508 },
  { id: "book-square", group: "Books", label: 'Square book page, 8.5"', width: 2550, height: 2550 },
  { id: "book-landscape", group: "Books", label: 'Landscape book page, 11 x 8.5"', width: 3300, height: 2550 },
];

export const DEFAULT_LAYOUT_SIZE = "social-portrait";

export const sizeById = (id: string | undefined): LayoutSize => LAYOUT_SIZES.find((s) => s.id === id) ?? LAYOUT_SIZES.find((s) => s.id === DEFAULT_LAYOUT_SIZE)!;

export type LayoutPosition = "top" | "middle" | "bottom" | "below";
export type LayoutAlign = "left" | "center";
export type LayoutScale = "s" | "m" | "l";
export type LayoutStyle = "headline" | "body";
export type LayoutFont = "sans" | "serif" | "rounded";
export type LayoutColour = "light" | "dark";

export interface LayoutOptions {
  position: LayoutPosition;
  align: LayoutAlign;
  scale: LayoutScale;
  style: LayoutStyle;
  font: LayoutFont;
  colour: LayoutColour;
}

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

/** A card's settings with anything missing or unknown set to its default. */
export function layoutOptions(data: Record<string, string | undefined>): LayoutOptions {
  return {
    position: pick(data.position, ["top", "middle", "bottom", "below"], "top"),
    align: pick(data.align, ["left", "center"], "center"),
    scale: pick(data.scale, ["s", "m", "l"], "m"),
    style: pick(data.style, ["headline", "body"], "headline"),
    font: pick(data.font, ["sans", "serif", "rounded"], "sans"),
    colour: pick(data.colour, ["light", "dark"], "light"),
  };
}

export const FONT_STACKS: Record<LayoutFont, string> = {
  sans: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  rounded: '"Avenir Next", "Trebuchet MS", "Segoe UI", Verdana, sans-serif',
};

/** One Text card can hold many parts, one per page or slide, split by a line holding only `---`. */
export function splitParts(text: string | undefined): string[] {
  return (text ?? "").split(/^\s*---\s*$/m).map((part) => part.trim()).filter(Boolean);
}

/** The part a Layout card shows. No part number: the whole text. A part past the end: nothing. */
export function partText(text: string | undefined, part: string | undefined): string {
  const n = Number(part);
  if (!part || !Number.isInteger(n) || n < 1) return (text ?? "").trim();
  return splitParts(text)[n - 1] ?? "";
}

export type Measure = (text: string) => number;

/** Greedy word wrap that keeps the line breaks a person typed. A word wider than the line stays on its own line. */
export function wrapLines(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (out.length) out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface PagePlan {
  /** Where the picture goes. */
  image: Rect;
  /** A solid paper panel behind the words (position "below"). */
  panel: Rect | null;
  /** A fade behind words on the picture: from `from` (strongest) to `to` (clear). */
  fade: { from: number; to: number } | null;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  weight: number;
  /** The text's anchor: left edge or centre, and the first line's top. */
  x: number;
  y: number;
  /** True when the words could not fit even at the smallest size, so some were cut off. */
  clipped: boolean;
}

const BASE = { headline: { s: 0.066, m: 0.084, l: 0.104 }, body: { s: 0.03, m: 0.036, l: 0.044 } };
const MIN_RATIO = 0.45;
const SHRINK = 0.93;

/**
 * Where everything goes on one page. `measure(text, fontSize)` measures a line. The size shrinks until the words fit
 * their space, so a long caption gets smaller rather than running off the page.
 */
export function planPage(width: number, height: number, text: string, options: LayoutOptions, measure: (text: string, fontSize: number) => number): PagePlan {
  const margin = Math.round(Math.min(width, height) * 0.075);
  const below = options.position === "below";
  const panelHeight = below ? Math.round(height * (options.style === "body" ? 0.3 : 0.24)) : 0;
  const image: Rect = { x: 0, y: 0, width, height: height - panelHeight };
  const panel: Rect | null = below ? { x: 0, y: height - panelHeight, width, height: panelHeight } : null;
  const room = below ? panelHeight - margin * 1.2 : height * (options.style === "body" ? 0.42 : 0.3);
  const maxWidth = width - margin * 2;
  const short = Math.min(width, height);
  // Tall pages size from the width, wide ones from the height, so a banner's caption isn't enormous.
  const base = BASE[options.style][options.scale] * (height >= width ? width : short * 1.25);
  const lineFactor = options.style === "body" ? 1.42 : 1.16;
  let size = base;
  let lines = wrapLines(text, maxWidth, (t) => measure(t, size));
  while (lines.length * size * lineFactor > room && size > base * MIN_RATIO) {
    size *= SHRINK;
    lines = wrapLines(text, maxWidth, (t) => measure(t, size));
  }
  const maxLines = Math.max(1, Math.floor(room / (size * lineFactor)));
  const clipped = lines.length > maxLines;
  if (clipped) lines = lines.slice(0, maxLines);
  const lineHeight = size * lineFactor;
  const block = lines.length * lineHeight;
  const y = below
    ? panel!.y + Math.max(margin * 0.6, (panelHeight - block) / 2)
    : options.position === "top"
      ? margin * (height > width * 1.5 ? 1.6 : 1)
      : options.position === "bottom"
        ? height - margin - block
        : (height - block) / 2;
  const fade = below
    ? null
    : options.position === "top"
      ? { from: 0, to: Math.min(height, y + block + margin * 1.6) }
      : options.position === "bottom"
        ? { from: height, to: Math.max(0, y - margin * 1.6) }
        : null;
  return { image, panel, fade, lines, fontSize: size, lineHeight, weight: options.style === "headline" ? 700 : 400, x: options.align === "center" ? width / 2 : margin, y, clipped };
}

/** The crop that fills `box` with the picture, keeping its centre, slightly favouring the top where faces tend to be. */
export function coverCrop(imageWidth: number, imageHeight: number, box: { width: number; height: number }): Rect {
  const scale = Math.max(box.width / imageWidth, box.height / imageHeight);
  const width = box.width / scale;
  const height = box.height / scale;
  return { x: (imageWidth - width) / 2, y: (imageHeight - height) * 0.35, width, height };
}

interface InputNode { id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, string | undefined> }

export interface LayoutInputs {
  imageAssetId: string | null;
  text: string;
  /** What is still missing, in words a person can act on. */
  missing: string[];
}

/** What feeds a Layout card: the first connected picture and the words from connected Text cards. */
export function layoutInputs(nodes: readonly InputNode[], edges: ReadonlyArray<{ source: string; target: string }>, cardId: string): LayoutInputs {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const card = byId.get(cardId);
  const pos = (n: InputNode) => n.position ?? { x: 0, y: 0 };
  const incoming = [...new Set(edges.filter((e) => e.target === cardId).map((e) => e.source))]
    .map((id) => byId.get(id))
    .filter((n): n is InputNode => Boolean(n))
    .sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x);
  const pictures = incoming.filter((n) => n.type === "image" || n.type === "output" || n.type === "source");
  const texts = incoming.filter((n) => n.type === "text");
  const imageAssetId = pictures.map((n) => n.data?.assetId).find((id): id is string => Boolean(id)) ?? null;
  const text = texts.map((n) => partText(n.data?.text, card?.data?.part)).filter(Boolean).join("\n\n");
  const missing: string[] = [];
  if (!pictures.length) missing.push("Connect a picture");
  else if (!imageAssetId) missing.push(`${pictures[0]!.data?.label ? `"${pictures[0]!.data.label}"` : "The picture"} has no result yet`);
  if (!texts.length) missing.push("Connect a Text card");
  else if (!text) missing.push(card?.data?.part ? `No words for part ${card.data.part} yet` : "The Text card is empty");
  return { imageAssetId, text, missing };
}

/** Board order, top to bottom then left to right: the order of pages in an export. */
export function pageOrder<T extends { id: string; position: { x: number; y: number } }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
}

/** A safe file name from a card's name. */
export function fileStem(name: string, index: number): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${String(index + 1).padStart(2, "0")}${clean ? `-${clean}` : ""}`;
}

/** What an agent is asked to do when a person presses "Ask an agent to write". */
export function writingTaskDescription(input: { canvasId: string; cardId: string; board: string; card: string; brief: string; current: string; client: string | null; pages: number }): string {
  const lines = [
    `Write the words for a card on the Studio canvas "${input.board}"${input.client ? `, for ${input.client}` : ""}.`,
    "",
    "**What to write**",
    input.brief.trim() || `The words for the card "${input.card}".`,
    "",
  ];
  if (input.current.trim()) lines.push("**What is on the card now** (improve it or replace it)", "```", input.current.trim().replace(/```/g, "'''"), "```", "");
  if (input.pages > 1) {
    lines.push(`This card feeds ${input.pages} pages or slides. Write exactly ${input.pages} parts, in order, with a line holding only \`---\` between them. Each part is the words for one page.`, "");
  }
  lines.push(
    "**How to deliver it**",
    `Call the \`partnersinbiz.studio:canvas-write-text\` tool with canvasId \`${input.canvasId}\`, cardId \`${input.cardId}\` and your text. It lands on the card for a person to check. Plain words only: no markdown, no notes to the reader.`,
    "",
    "These words get set over pictures, so keep them short enough to read at a glance. Don't send, post or publish anything.",
  );
  return lines.join("\n");
}
