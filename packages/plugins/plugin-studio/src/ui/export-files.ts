/**
 * Small file writers for exporting a board: a ZIP of images and a PDF of pages. Pure, so they're tested without a
 * browser, and no dependency: a ZIP that stores JPEGs needs no compression, and a PDF can hold JPEGs as they are.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const encoder = new TextEncoder();

/** A ZIP that stores each file as it is. Images are already compressed, so nothing is gained by compressing again. */
export function makeZip(files: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const head = new Uint8Array(30);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, file.bytes.length, true);
    h.setUint32(22, file.bytes.length, true);
    h.setUint16(26, name.length, true);
    local.push(head, name, file.bytes);
    const entry = new Uint8Array(46);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, file.bytes.length, true);
    c.setUint32(24, file.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(entry, name);
    offset += head.length + name.length + file.bytes.length;
  }
  const directory = concat(central);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directory.length, true);
  e.setUint32(16, offset, true);
  return concat([...local, directory, end]);
}

export interface PdfPage {
  jpeg: Uint8Array;
  /** Pixels. */
  width: number;
  height: number;
}

/** A PDF with one full-page JPEG per page, at 300 dots per inch. */
export function makePdf(pages: readonly PdfPage[]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    at += bytes.length;
  };
  const open = (id: number) => {
    offsets[id] = at;
    push(`${id} 0 obj\n`);
  };
  push("%PDF-1.4\n");
  const pageIds = pages.map((_, i) => 3 + i * 3);
  open(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  open(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>\nendobj\n`);
  pages.forEach((page, i) => {
    const pageId = 3 + i * 3;
    const w = (page.width * 72) / 300;
    const h = (page.height * 72) / 300;
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
    open(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>\nendobj\n`);
    open(pageId + 1);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
    push(page.jpeg);
    push("\nendstream\nendobj\n");
    open(pageId + 2);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });
  const xref = at;
  const count = 3 + pages.length * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks);
}
