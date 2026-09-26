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
  /** Small label/value pairs under the title (Date, Due, Reference…). */
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
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.85, 0.85, 0.88);

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
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${spec.title}${spec.number ? ` ${spec.number}` : ""}`));
  pdf.setProducer("Partners in Biz · Paperclip");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - MARGIN * 2;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;

  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN + 30) newPage();
  };
  const text = (value: string, x: number, size: number, font: PDFFont = regular, color = INK) => {
    page.drawText(pdfSafe(value), { x, y, size, font, color });
  };

  // Title and number
  text(spec.title, MARGIN, 20, bold);
  if (spec.number) {
    const label = pdfSafe(spec.number);
    page.drawText(label, { x: MARGIN + width - bold.widthOfTextAtSize(label, 14), y: y + 3, size: 14, font: bold, color: INK });
  }
  y -= 26;

  if (spec.stamp) {
    const stamp = pdfSafe(spec.stamp.toUpperCase());
    page.drawText(stamp, { x: MARGIN + width - bold.widthOfTextAtSize(stamp, 28) - 4, y: y - 30, size: 28, font: bold, color: rgb(0.8, 0.2, 0.2), opacity: 0.35 });
  }

  for (const [label, value] of spec.details ?? []) {
    text(`${label}:`, MARGIN, 9.5, bold, MUTED);
    text(value, MARGIN + 90, 9.5);
    y -= 13;
  }
  y -= 10;

  // Parties side by side
  const parties = spec.parties ?? [];
  if (parties.length) {
    const colWidth = width / parties.length - 12;
    const wrapped = parties.map((p) => p.lines.flatMap((l) => wrap(l, regular, 9.5, colWidth)));
    const height = 16 + Math.max(...wrapped.map((w) => w.length)) * 12.5;
    ensure(height);
    const top = y;
    parties.forEach((party, i) => {
      const x = MARGIN + i * (width / parties.length);
      y = top;
      text(party.heading.toUpperCase(), x, 8, bold, MUTED);
      y -= 14;
      for (const line of wrapped[i]!) {
        text(line, x, 9.5);
        y -= 12.5;
      }
    });
    y = top - height - 8;
  }

  // Table
  const columns = spec.columns ?? [];
  if (columns.length && (spec.rows?.length ?? 0) >= 0) {
    const totalWeight = columns.reduce((s, c) => s + c.width, 0) || 1;
    const widths = columns.map((c) => (c.width / totalWeight) * width);
    const drawHeader = () => {
      ensure(24);
      page.drawRectangle({ x: MARGIN, y: y - 5, width, height: 18, color: rgb(0.95, 0.95, 0.96) });
      let x = MARGIN;
      columns.forEach((c, i) => {
        const label = pdfSafe(c.label);
        const cw = widths[i]!;
        const lx = c.align === "right" ? x + cw - 4 - bold.widthOfTextAtSize(label, 8.5) : x + 4;
        page.drawText(label, { x: lx, y, size: 8.5, font: bold, color: MUTED });
        x += cw;
      });
      y -= 20;
    };
    drawHeader();
    for (const row of spec.rows ?? []) {
      const cells = columns.map((c, i) => wrap(row[c.key] ?? "", regular, 9.5, widths[i]! - 8));
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const height = lines * 12 + 6;
      if (y - height < MARGIN + 30) {
        newPage();
        drawHeader();
      }
      let x = MARGIN;
      columns.forEach((c, i) => {
        const cw = widths[i]!;
        cells[i]!.forEach((line, li) => {
          const lx = c.align === "right" ? x + cw - 4 - regular.widthOfTextAtSize(line, 9.5) : x + 4;
          page.drawText(line, { x: lx, y: y - li * 12, size: 9.5, font: regular, color: INK });
        });
        x += cw;
      });
      y -= height;
      page.drawLine({ start: { x: MARGIN, y: y + 11 }, end: { x: MARGIN + width, y: y + 11 }, thickness: 0.5, color: RULE });
    }
    y -= 6;
  }

  // Totals, right-aligned
  for (const total of spec.totals ?? []) {
    ensure(16);
    const font = total.bold ? bold : regular;
    const size = total.bold ? 11 : 9.5;
    const value = pdfSafe(total.value);
    const label = pdfSafe(total.label);
    page.drawText(label, { x: MARGIN + width - 190, y, size, font, color: total.bold ? INK : MUTED });
    page.drawText(value, { x: MARGIN + width - 4 - font.widthOfTextAtSize(value, size), y, size, font, color: INK });
    y -= total.bold ? 18 : 14;
  }
  y -= 8;

  for (const section of spec.sections ?? []) {
    const lines = section.lines.flatMap((l) => wrap(l, regular, 9.5, width));
    ensure(18 + Math.min(lines.length, 4) * 12.5);
    text(section.heading.toUpperCase(), MARGIN, 8, bold, MUTED);
    y -= 14;
    for (const line of lines) {
      ensure(13);
      text(line, MARGIN, 9.5);
      y -= 12.5;
    }
    y -= 8;
  }

  if (spec.footer) {
    const pages = pdf.getPages();
    pages.forEach((p, i) => {
      const label = pdfSafe(`${spec.footer}   ·   Page ${i + 1} of ${pages.length}`);
      p.drawText(label, { x: MARGIN, y: MARGIN - 16, size: 7.5, font: regular, color: MUTED });
    });
  }

  return pdf.save();
}

/** Format minor units as money for documents, e.g. `R 1,234.50` for ZAR. */
export function formatMoneyMinor(minor: number, currency: string): string {
  const value = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currency === "ZAR" ? "R " : currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  return minor < 0 ? `-${symbol}${value.replace("-", "")}` : `${symbol}${value}`;
}
