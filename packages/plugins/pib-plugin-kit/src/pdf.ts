/**
 * PDF documents (invoices, quotes, credit notes, statements, payslips,
 * reports) with pdf-lib: pure JS, standard fonts, no files on disk, so it
 * bundles into plugin workers.
 *
 * `renderDocumentPdf(spec)` lays out a header, two address blocks, key/value
 * details, a table with automatic page breaks, totals, notes and a footer.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface PdfParty {
  heading: string; // "From" / "Bill to" / "Employee"
  lines: string[];
}

export interface PdfColumn {
  key: string;
  label: string;
  /** Share of the table width; columns are scaled to fill it. */
  width: number;
  align?: "left" | "right";
}

export interface PdfDocumentSpec {
  title: string; // "Tax invoice"
  number?: string | null;
  /** Small label/value pairs beside the parties (Date, Due, Reference…). */
  details?: Array<[string, string]>;
  parties?: PdfParty[];
  columns?: PdfColumn[];
  rows?: Array<Record<string, string>>;
  totals?: Array<{ label: string; value: string; bold?: boolean }>;
  /** Titled paragraphs after the totals (payment details, notes, terms). */
  sections?: Array<{ heading: string; lines: string[] }>;
  footer?: string | null;
  /** Big status stamp (PAID, DRAFT, VOID). */
  stamp?: string | null;
  /** Sender's logo, PNG or JPEG bytes. Anything else (or a broken file) is skipped and the sender name shows instead. */
  logo?: Uint8Array | null;
  /** Name shown top left when there is no logo. */
  brandName?: string | null;
  /** Brand colour as `#rrggbb`; headings, the table header and the amount due use it. */
  accent?: string | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.86, 0.87, 0.9);
const SOFT = rgb(0.965, 0.97, 0.975);
const WHITE = rgb(1, 1, 1);
/** Default brand colour: the same navy the CRM's signing pages use. */
export const DEFAULT_PDF_ACCENT = "#14304f";
const LOGO_MAX_W = 170;
const LOGO_MAX_H = 54;

/** `#rrggbb` (or `#rgb`) to pdf-lib rgb, with the fallback for anything else. */
export function pdfColor(hex: string | null | undefined, fallback = DEFAULT_PDF_ACCENT): { r: number; g: number; b: number } {
  const pick = (value: string) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  };
  return (typeof hex === "string" && pick(hex)) || pick(fallback)!;
}

/** "png", "jpg" or null, from the file's first bytes (never from a name or a header). */
export function pdfImageType(bytes: Uint8Array | null | undefined): "png" | "jpg" | null {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}
/** Standard PDF fonts only encode WinAnsi; replace what they cannot draw. */
export function pdfSafe(text: string): string {
  return String(text ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[^\x20-\x7E¡-ÿ€•\n]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of pdfSafe(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      // Hard-break words wider than the column.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
        // Prefer a natural break (an email or web address): before "@", or after ".", "/", "-" or "_".
        const at = rest.lastIndexOf("@", cut);
        const soft = Math.max(...[".", "/", "-", "_"].map((c) => rest.lastIndexOf(c, cut - 1) + 1));
        const natural = Math.max(at > 0 ? at : 0, soft);
        if (natural >= Math.ceil(cut / 3)) cut = natural;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

export async function renderDocumentPdf(spec: PdfDocumentSpec): Promise<Uint8Array> {
  // No time-stamped metadata: pdf-lib would write CreationDate/ModDate as "now" (to the second), so the same document
  // rendered twice could hash differently, and the Drive filing relies on the same invoice giving the same sha256
  // (plugin-billing filing.pg.spec flaked on it, 2026-11-08). Title and producer are still set below.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(pdfSafe(`${spec.title}${spec.number ? ` ${spec.number}` : ""}`));
  pdf.setProducer("Partners in Biz · Paperclip");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const a = pdfColor(spec.accent);
  const ACCENT = rgb(a.r, a.g, a.b);
  // Light brand colours get dark text on top; dark ones get white.
  const ON_ACCENT = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b > 0.6 ? INK : WHITE;
  const TINT = rgb(1 - (1 - a.r) * 0.08, 1 - (1 - a.g) * 0.08, 1 - (1 - a.b) * 0.08);
  const width = A4[0] - MARGIN * 2;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;

  const band = (p: PDFPage) => p.drawRectangle({ x: 0, y: A4[1] - 6, width: A4[0], height: 6, color: ACCENT });
  band(page);
  const newPage = () => {
    page = pdf.addPage(A4);
    band(page);
    y = A4[1] - MARGIN;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN + 30) newPage();
  };
  const text = (value: string, x: number, size: number, font: PDFFont = regular, color = INK) => {
    page.drawText(pdfSafe(value), { x, y, size, font, color });
  };
  const right = (value: string, xRight: number, yAt: number, size: number, font: PDFFont = regular, color = INK) => {
    const v = pdfSafe(value);
    page.drawText(v, { x: xRight - font.widthOfTextAtSize(v, size), y: yAt, size, font, color });
  };

  // Header: logo (or the sender's name) on the left, the document title and number on the right.
  const top = y;
  let leftBottom = top - 20;
  const logoType = pdfImageType(spec.logo);
  let logoDrawn = false;
  if (logoType && spec.logo) {
    try {
      const image = logoType === "png" ? await pdf.embedPng(spec.logo) : await pdf.embedJpg(spec.logo);
      const scale = Math.min(LOGO_MAX_W / image.width, LOGO_MAX_H / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: MARGIN, y: top - h + 6, width: w, height: h });
      leftBottom = top - h + 6;
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn && spec.brandName) {
    const name = wrap(spec.brandName, bold, 16, width * 0.55)[0] ?? "";
    page.drawText(name, { x: MARGIN, y: top - 12, size: 16, font: bold, color: ACCENT });
    leftBottom = top - 16;
  }
  right(spec.title.toUpperCase(), MARGIN + width, top - 14, 20, bold, ACCENT);
  let rightBottom = top - 18;
  if (spec.number) {
    right(spec.number, MARGIN + width, top - 32, 11, bold, INK);
    rightBottom = top - 36;
  }
  if (spec.stamp) {
    // Status pill (DRAFT, PAID, VOID) under the number, right-aligned.
    const label = pdfSafe(spec.stamp.toUpperCase());
    const size = 9;
    const w = bold.widthOfTextAtSize(label, size) + 16;
    const red = rgb(0.75, 0.16, 0.16);
    const py = rightBottom - 16;
    page.drawRectangle({ x: MARGIN + width - w, y: py - 5, width: w, height: 17, borderColor: red, borderWidth: 1, color: rgb(1, 0.95, 0.95) });
    page.drawText(label, { x: MARGIN + width - w + 8, y: py, size, font: bold, color: red });
    rightBottom = py - 6;
  }
  y = Math.min(leftBottom, rightBottom) - 14;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.75, color: RULE });
  y -= 20;

  // Parties on the left, details in a tinted box on the right.
  const parties = spec.parties ?? [];
  const details = spec.details ?? [];
  const detailsW = details.length ? 170 : 0;
  const partyArea = width - (detailsW ? detailsW + 18 : 0);
  const colWidth = parties.length ? partyArea / parties.length - 12 : 0;
  const wrapped = parties.map((p) => p.lines.flatMap((l) => wrap(l, regular, 9.5, colWidth)));
  const partiesH = parties.length ? 15 + Math.max(...wrapped.map((w) => w.length)) * 12.5 : 0;
  const detailsH = details.length ? 14 + details.length * 14 : 0;
  ensure(Math.max(partiesH, detailsH));
  const blockTop = y;
  parties.forEach((party, i) => {
    const x = MARGIN + i * (partyArea / parties.length);
    y = blockTop;
    text(party.heading.toUpperCase(), x, 7.5, bold, ACCENT);
    y -= 14;
    wrapped[i]!.forEach((line, li) => {
      text(line, x, 9.5, li === 0 ? bold : regular, INK);
      y -= 12.5;
    });
  });
  if (details.length) {
    const bx = MARGIN + width - detailsW;
    page.drawRectangle({ x: bx, y: blockTop - detailsH + 9, width: detailsW, height: detailsH, color: TINT });
    page.drawRectangle({ x: bx, y: blockTop - detailsH + 9, width: 2.5, height: detailsH, color: ACCENT });
    y = blockTop - 5;
    for (const [label, value] of details) {
      text(label, bx + 12, 8.5, regular, MUTED);
      right(value, bx + detailsW - 10, y, 9, bold, INK);
      y -= 14;
    }
  }
  y = blockTop - Math.max(partiesH, detailsH) - 14;

  // Table
  const columns = spec.columns ?? [];
  if (columns.length) {
    const totalWeight = columns.reduce((s, c) => s + c.width, 0) || 1;
    const widths = columns.map((c) => (c.width / totalWeight) * width);
    const drawHeader = () => {
      ensure(26);
      page.drawRectangle({ x: MARGIN, y: y - 7, width, height: 21, color: ACCENT });
      let x = MARGIN;
      columns.forEach((c, i) => {
        const label = pdfSafe(c.label.toUpperCase());
        const cw = widths[i]!;
        const lx = c.align === "right" ? x + cw - 6 - bold.widthOfTextAtSize(label, 7.5) : x + 6;
        page.drawText(label, { x: lx, y, size: 7.5, font: bold, color: ON_ACCENT });
        x += cw;
      });
      y -= 23;
    };
    drawHeader();
    (spec.rows ?? []).forEach((row, ri) => {
      const cells = columns.map((c, i) => wrap(row[c.key] ?? "", regular, 9.5, widths[i]! - 12));
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const height = lines * 12 + 10;
      if (y - height < MARGIN + 30) {
        newPage();
        drawHeader();
      }
      if (ri % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - height + 12, width, height, color: SOFT });
      let x = MARGIN;
      columns.forEach((c, i) => {
        const cw = widths[i]!;
        cells[i]!.forEach((line, li) => {
          const lx = c.align === "right" ? x + cw - 6 - regular.widthOfTextAtSize(line, 9.5) : x + 6;
          page.drawText(line, { x: lx, y: y - li * 12, size: 9.5, font: regular, color: INK });
        });
        x += cw;
      });
      y -= height;
      page.drawLine({ start: { x: MARGIN, y: y + 12 }, end: { x: MARGIN + width, y: y + 12 }, thickness: 0.5, color: RULE });
    });
    y -= 10;
  }

  // Totals, right-aligned; the last bold line (amount or balance due) sits in a brand-coloured bar.
  const totals = spec.totals ?? [];
  const lastBold = totals.map((t) => Boolean(t.bold)).lastIndexOf(true);
  const tx = MARGIN + width - 220;
  totals.forEach((total, i) => {
    if (i === lastBold) {
      ensure(30);
      y -= 4;
      page.drawRectangle({ x: tx, y: y - 9, width: 220, height: 26, color: ACCENT });
      text(total.label, tx + 10, 11, bold, ON_ACCENT);
      right(total.value, MARGIN + width - 10, y, 12, bold, ON_ACCENT);
      y -= 32;
      return;
    }
    ensure(16);
    const font = total.bold ? bold : regular;
    const size = total.bold ? 10.5 : 9.5;
    if (total.bold) {
      page.drawLine({ start: { x: tx, y: y + 12 }, end: { x: MARGIN + width, y: y + 12 }, thickness: 0.5, color: RULE });
    }
    text(total.label, tx + 10, size, font, total.bold ? INK : MUTED);
    right(total.value, MARGIN + width - 10, y, size, font, INK);
    y -= total.bold ? 18 : 14;
  });
  y -= 10;

  for (const section of spec.sections ?? []) {
    const lines = section.lines.flatMap((l) => wrap(l, regular, 9.5, width - 12));
    ensure(22 + Math.min(lines.length, 4) * 12.5);
    text(section.heading.toUpperCase(), MARGIN, 7.5, bold, ACCENT);
    page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: MARGIN + 28, y: y - 4 }, thickness: 1.25, color: ACCENT });
    y -= 17;
    for (const line of lines) {
      ensure(13);
      text(line, MARGIN, 9.5);
      y -= 12.5;
    }
    y -= 10;
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 4 }, end: { x: MARGIN + width, y: MARGIN - 4 }, thickness: 0.5, color: RULE });
    if (spec.footer) p.drawText(pdfSafe(spec.footer), { x: MARGIN, y: MARGIN - 18, size: 7.5, font: regular, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: MARGIN + width - regular.widthOfTextAtSize(label, 7.5), y: MARGIN - 18, size: 7.5, font: regular, color: MUTED });
  });

  return pdf.save();
}

/** Format minor units as money for documents, e.g. `R 1,234.50` for ZAR. */
export function formatMoneyMinor(minor: number, currency: string): string {
  const value = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currency === "ZAR" ? "R " : currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  return minor < 0 ? `-${symbol}${value.replace("-", "")}` : `${symbol}${value}`;
}
