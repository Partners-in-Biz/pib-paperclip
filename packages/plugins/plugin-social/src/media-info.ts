/**
 * What a media file is, from its own bytes (Q1a-5, Q10-11).
 *
 * Issue attachments come back from the host with whatever content type the uploader sent:
 * the MP4s of the PARA-4 content batch are stored as `application/octet-stream`. So an
 * attachment is never trusted by its declared type or its name: the type is read from the
 * file's magic bytes, and its size (and, for video, length) from its headers, so a carousel
 * slide that is not 1080x1350 or a reel that is not 9:16 shows before a platform rejects it.
 * Pure, no I/O; every parser stops quietly on a file it does not understand.
 */

export interface MediaInfo {
  width: number | null;
  height: number | null;
  /** Seconds, video only. */
  durationS: number | null;
}

const EMPTY: MediaInfo = { width: null, height: null, durationS: null };

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && at + i < bytes.length; i += 1) out += String.fromCharCode(bytes[at + i]!);
  return out;
}

const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const be32 = (b: Uint8Array, at: number) => (((b[at] ?? 0) * 0x1000000) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))) >>> 0;
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);

/** The `ftyp` major brands of video files (MP4 and its relatives). */
const VIDEO_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "mp71", "avc1", "M4V ", "M4VH", "M4VP", "dash", "f4v ", "MSNV", "XAVC", "3gp4", "3gp5", "3gp6", "3g2a"]);
/** The `ftyp` major brands of still images in the same container (a phone's HEIC photo, an AVIF). Not a video, whatever the box says. */
const IMAGE_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

/** The media type a file's first bytes say it is (the types social posts accept), or null. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    // Only a video brand is a video: a HEIC photo from a phone has the same box and is not one.
    const brand = ascii(bytes, 8, 4);
    if (brand === "qt  ") return "video/quicktime";
    return VIDEO_BRANDS.has(brand) ? "video/mp4" : null;
  }
  return null;
}

const EXTENSION_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" };

/** The type a file name suggests (only used to say what a file probably is; the bytes decide). */
export function mimeFromName(fileName: string | null | undefined): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName ?? "")?.[1]?.toLowerCase();
  return ext ? EXTENSION_MIME[ext] ?? null : null;
}

/** A plain description of a file we cannot use, for the error. */
export function describeUnsupported(bytes: Uint8Array, declared: string | null, fileName: string | null): string {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "PK\u0003\u0004") return "a zip archive (unpack it and attach the images or videos themselves)";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "%PDF") return "a PDF (export the pages as PNG images instead)";
  if (/^\s*<(\?xml|svg)/i.test(ascii(bytes, 0, 64))) return "an SVG (render it to PNG first: platforms do not take SVG)";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && IMAGE_BRANDS.has(ascii(bytes, 8, 4))) return "a HEIC, HEIF or AVIF photo (export it as JPEG or PNG first: platforms do not take it)";
  return `a file of type ${declared && declared !== "application/octet-stream" ? declared : "unknown"}${fileName ? ` (${fileName})` : ""}`;
}

// ── images ──────────────────────────────────────────────────────────────────

function jpegInfo(b: Uint8Array): MediaInfo {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = be16(b, at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: be16(b, at + 7), height: be16(b, at + 5), durationS: null };
    if (length < 2) return EMPTY;
    at += 2 + length;
  }
  return EMPTY;
}

function webpInfo(b: Uint8Array): MediaInfo {
  const kind = ascii(b, 12, 4);
  const data = 20;
  if (kind === "VP8 " && b.length >= data + 10 && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
    return { width: le16(b, data + 6) & 0x3fff, height: le16(b, data + 8) & 0x3fff, durationS: null };
  }
  if (kind === "VP8L" && b.length >= data + 5 && b[data] === 0x2f) {
    const b0 = b[data + 1]!;
    const b1 = b[data + 2]!;
    const b2 = b[data + 3]!;
    const b3 = b[data + 4]!;
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), durationS: null };
  }
  if (kind === "VP8X" && b.length >= data + 10) return { width: 1 + le24(b, data + 4), height: 1 + le24(b, data + 7), durationS: null };
  return EMPTY;
}

// ── MP4 / MOV ───────────────────────────────────────────────────────────────

interface Box {
  type: string;
  start: number;
  /** First byte of the box's payload. */
  body: number;
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < 4000) {
    let size = be32(b, at);
    const type = ascii(b, at + 4, 4);
    let body = at + 8;
    if (size === 1) {
      // 64-bit size: only the low word matters for files that fit in memory.
      size = be32(b, at + 12);
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

function mp4Info(b: Uint8Array): MediaInfo {
  const moov = boxes(b, 0, b.length).find((box) => box.type === "moov");
  if (!moov) return EMPTY;
  const inside = boxes(b, moov.body, moov.end);
  const info: MediaInfo = { width: null, height: null, durationS: null };
  const mvhd = inside.find((box) => box.type === "mvhd");
  if (mvhd) {
    const version = b[mvhd.body] ?? 0;
    const timescale = version === 1 ? be32(b, mvhd.body + 20) : be32(b, mvhd.body + 12);
    const duration = version === 1 ? be32(b, mvhd.body + 28) : be32(b, mvhd.body + 16);
    if (timescale > 0 && duration > 0) info.durationS = Math.round((duration / timescale) * 100) / 100;
  }
  for (const trak of inside.filter((box) => box.type === "trak")) {
    const tkhd = boxes(b, trak.body, trak.end).find((box) => box.type === "tkhd");
    if (!tkhd) continue;
    const version = b[tkhd.body] ?? 0;
    const at = tkhd.body + (version === 1 ? 88 : 76);
    const width = be16(b, at);
    const height = be16(b, at + 4);
    if (width > 0 && height > 0) {
      info.width = width;
      info.height = height;
      break;
    }
  }
  return info;
}

/** Width, height and (video) length from the file's own headers. Best effort: unknown parts stay null. Never throws. */
export function mediaInfo(bytes: Uint8Array, mime: string): MediaInfo {
  try {
    if (mime === "image/png") return bytes.length >= 24 && ascii(bytes, 12, 4) === "IHDR" ? { width: be32(bytes, 16), height: be32(bytes, 20), durationS: null } : EMPTY;
    if (mime === "image/jpeg") return jpegInfo(bytes);
    if (mime === "image/gif") return bytes.length >= 10 ? { width: le16(bytes, 6), height: le16(bytes, 8), durationS: null } : EMPTY;
    if (mime === "image/webp") return webpInfo(bytes);
    if (mime === "video/mp4" || mime === "video/quicktime") return mp4Info(bytes);
  } catch {
    // a file that does not parse is still importable: the platform is the judge
  }
  return { ...EMPTY };
}

/** Shape notes worth showing the agent: what a platform will want that this file is not. Pure. */
export function shapeNotes(info: MediaInfo, mime: string): string[] {
  const notes: string[] = [];
  const { width, height } = info;
  if (!width || !height) return notes;
  const ratio = width / height;
  if (mime.startsWith("image/")) {
    if (Math.min(width, height) < 1080) notes.push(`${width}x${height}: under 1080 px on the short side (Instagram and LinkedIn want at least 1080).`);
    if (ratio < 0.8 - 0.01 || ratio > 1.91 + 0.01) notes.push(`${width}x${height}: Instagram feed images must be between 4:5 and 1.91:1.`);
  } else {
    const vertical = Math.abs(ratio - 9 / 16) < 0.02;
    if (!vertical) notes.push(`${width}x${height}: not 9:16, so it will not fill a Reel, TikTok or Short.`);
    if (info.durationS != null && info.durationS > 90) notes.push(`${info.durationS}s: Reels and Shorts perform best under 90 seconds.`);
  }
  return notes;
}
