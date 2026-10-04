/**
 * What a client sees when it is asked to sign (audit Q1b-11, Q10-14): the document as HTML, the public signing page,
 * and the signed copy. Pure rendering, no database and no host call.
 *
 * The document is written in Markdown (a template, or text an agent wrote) and frozen as text when it is sent;
 * its SHA-256 is what the signer signs. Everything is escaped for HTML: a name, a price or a sentence from an agent
 * can never become markup, a link is only ever https or mailto, and the page carries a Content-Security-Policy
 * that allows no inline script, so even a missed escape could not run code on the page.
 *
 * Signature type: a typed name with explicit consent is a basic electronic signature (South African ECT Act).
 * The page and the signed copy say that plainly and never call it an advanced electronic signature.
 */
import { createHash } from "node:crypto";
import { escapeHtml } from "./report-render.js";

/** The word the draft email carries where the private signing link goes. The link is made when a person approves the email, so nobody who reads the approval, the issue or a tool result ever sees it (the sent email carries it). */
export const SIGNING_LINK_TOKEN = "{{signing_link}}";
export const SIGNING_LINK_NOTE = "[the private signing link is added when the email is sent]";

/** Where the date the link stops working goes: it is set when the email is sent, so the email never states a date the link does not have. */
export const VALID_UNTIL_TOKEN = "{{valid_until}}";
export const VALID_UNTIL_NOTE = "[the date the link stops working, set when the email is sent]";

/** What a person reading the approval sees for a draft: the placeholders shown as notes. */
export function displayDraftText(text: string): string {
  return text.split(SIGNING_LINK_TOKEN).join(SIGNING_LINK_NOTE).split(VALID_UNTIL_TOKEN).join(VALID_UNTIL_NOTE);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Line endings made plain, trailing blanks removed, one final newline: the same text always gives the same hash. */
export function normaliseContent(text: string): string {
  return `${text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

export interface DocBrand {
  /** The sender's name as the client knows it. */
  name: string;
  primary: string;
  accent: string;
  /** A public https address of the logo, or null. */
  logoUrl: string | null;
  /** A line under the document: registration number, address. */
  footer: string | null;
}

export const DEFAULT_BRAND = { primary: "#14304f", accent: "#2a9d8f" } as const;

export function brandOf(input: { name: string; primary?: unknown; accent?: unknown; logoUrl?: unknown; footer?: unknown }): DocBrand {
  const logo = typeof input.logoUrl === "string" && /^https:\/\/[^\s"'<>]+$/i.test(input.logoUrl.trim()) && input.logoUrl.length <= 500 ? input.logoUrl.trim() : null;
  const footer = typeof input.footer === "string" && input.footer.trim() ? input.footer.replace(/\s+/g, " ").trim().slice(0, 300) : null;
  return { name: input.name.slice(0, 160), primary: safeColor(input.primary, DEFAULT_BRAND.primary), accent: safeColor(input.accent, DEFAULT_BRAND.accent), logoUrl: logo, footer };
}

// ---------------------------------------------------------------------------
// Markdown to HTML (a small, safe subset)
// ---------------------------------------------------------------------------

const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
const SAFE_URL = /^(https:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;

/** One line of text as HTML: links (https or mailto only), bold, italic and code. Everything else is text. */
function inline(raw: string): string {
  const links: Array<{ text: string; url: string }> = [];
  const marked = raw.replace(/\u0000/g, "").replace(LINK, (whole, text: string, url: string) => {
    if (!SAFE_URL.test(url)) return whole;
    links.push({ text, url });
    return `\u0000${links.length - 1}\u0000`;
  });
  let html = escapeHtml(marked)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");
  html = html.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => {
    const link = links[Number(index)];
    return link ? `<a href="${escapeHtml(link.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(link.text)}</a>` : "";
  });
  return html;
}

const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** The Markdown subset the templates use: headings, paragraphs, lists, tables, quotes, rules, bold, italic, code and safe links. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map((line) => inline(line.replace(/\s{2,}$/, ""))).join(" ")}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    if (quote.length) out.push(`<blockquote><p>${quote.map(inline).join(" ")}</p></blockquote>`);
    paragraph = [];
    list = null;
    quote = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out.push(`<h${m[1]!.length}>${inline(m[2]!)}</h${m[1]!.length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!.trim())) {
      flush();
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      i -= 1;
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      if (paragraph.length || list) flush();
      quote.push(m[1]!);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      if (paragraph.length || quote.length || (list && list.tag !== "ul")) flush();
      list = list ?? { tag: "ul", items: [] };
      list.items.push(m[1]!);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (paragraph.length || quote.length || (list && list.tag !== "ol")) flush();
      list = list ?? { tag: "ol", items: [] };
      list.items.push(m[1]!);
    } else {
      if (list || quote.length) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/** Markdown as plain text (for the email copy): markers removed, links as `text (url)`. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    .replace(/^\|(.*)\|$/gm, (_whole, row: string) => row.split("|").map((cell) => cell.trim()).join("   "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `3 Oct 2026` in South African time (UTC+2 all year). */
export function dateLabel(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const sast = new Date(time + 2 * 3_600_000);
  return `${sast.getUTCDate()} ${MONTHS[sast.getUTCMonth()]} ${sast.getUTCFullYear()}`;
}

/** `3 Oct 2026, 14:05 (South African time)`. */
export function dateTimeLabel(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const sast = new Date(time + 2 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dateLabel(iso)}, ${pad(sast.getUTCHours())}:${pad(sast.getUTCMinutes())} (South African time)`;
}

// ---------------------------------------------------------------------------
// The consent wording
// ---------------------------------------------------------------------------

/** What the signer ticks: the exact wording is stored with the document and hashed, and the page must show this text. */
export function consentTextFor(input: { title: string; companyName: string }): string {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 160);
  const company = input.companyName.replace(/\s+/g, " ").trim().slice(0, 160) || "the sender";
  return `I have read "${title}" from ${company} and I agree to it. I understand that typing my name below is my electronic signature.`;
}

export const SIGNATURE_TYPE = "Basic electronic signature (a typed name given with the signer's explicit consent). It is not an advanced electronic signature.";

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export type PageState = "open" | "signed" | "declined" | "expired" | "void" | "archived";

export interface SignedFacts {
  signerName: string;
  signedAt: string;
  reference: string;
  auditHead: string | null;
}

export interface PageInput {
  pageId: string;
  title: string;
  state: PageState;
  brand: DocBrand;
  /** Who it is for, as the CRM knows them (shown, never trusted). */
  recipientName: string | null;
  bodyHtml: string;
  contentSha256: string;
  consentText: string;
  consentSha256: string;
  validUntil: string | null;
  signed?: SignedFacts | null;
  declinedAt?: string | null;
}

const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function styles(brand: DocBrand): string {
  return `
  :root { --primary: ${brand.primary}; --accent: ${brand.accent}; --ink: #1f2933; --muted: #5f6b7a; --line: #d9dee5; --bad: #b42318; color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background: #f3f5f8; }
  header.top { background: var(--primary); color: #fff; padding: 18px 20px; }
  header.top .in, main, footer { max-width: 760px; margin: 0 auto; }
  header.top img { max-height: 40px; max-width: 220px; display: block; margin-bottom: 8px; background: #fff; padding: 4px 8px; border-radius: 6px; }
  header.top .brand { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; opacity: .85; }
  header.top h1 { font-size: 22px; margin: 4px 0 0; }
  header.top .for { font-size: 14px; opacity: .85; margin-top: 2px; }
  main { padding: 16px; }
  .paper { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 24px 22px; }
  .paper h1 { font-size: 24px; color: var(--primary); margin: 0 0 8px; }
  .paper h2 { font-size: 18px; color: var(--primary); margin: 24px 0 6px; border-bottom: 2px solid var(--line); padding-bottom: 4px; }
  .paper h3 { font-size: 16px; margin: 18px 0 4px; }
  .paper table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 15px; }
  .paper th, .paper td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  .paper th { background: #f3f5f8; }
  .paper blockquote { margin: 10px 0; padding: 4px 14px; border-left: 4px solid var(--accent); color: var(--muted); }
  .paper code { background: #f3f5f8; padding: 1px 4px; border-radius: 4px; }
  .box { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 18px 22px; margin-top: 16px; }
  .box h2 { margin: 0 0 6px; font-size: 18px; color: var(--primary); }
  .small { font-size: 13px; color: var(--muted); }
  .print { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
  label { display: block; font-weight: 600; font-size: 14px; margin: 12px 0 4px; }
  input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
  input:focus-visible, button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 40%, transparent); outline-offset: 1px; }
  .consent { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin-top: 12px; }
  .consent input { margin-top: 5px; flex: none; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
  button { background: var(--primary); color: #fff; border: 0; border-radius: 8px; padding: 11px 22px; font: inherit; font-weight: 600; cursor: pointer; }
  button.link { background: none; color: var(--muted); text-decoration: underline; padding: 8px; font-weight: 400; }
  button:disabled { opacity: .5; cursor: default; }
  .msg { min-height: 1.4em; margin: 10px 0 0; font-size: 14px; }
  .msg.bad { color: var(--bad); }
  .msg.good { color: #067647; font-weight: 600; }
  .stamp { border: 2px solid var(--accent); border-radius: 10px; padding: 14px 18px; background: #f2fbf9; }
  footer { padding: 8px 16px 32px; color: var(--muted); font-size: 12px; }
  [hidden] { display: none !important; }
  @media print { header.top { background: none; color: #000; padding: 0 0 8px; } body { background: #fff; } .box.noprint, .noprint { display: none !important; } .paper { border: 0; padding: 0; } }`;
}

function head(title: string, brand: DocBrand, state = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${state ? `<meta name="pib-state" content="${escapeHtml(state)}">\n` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}">
<title>${escapeHtml(title)}</title>
<style>${styles(brand)}</style>
</head>`;
}

function banner(input: PageInput): string {
  const logo = input.brand.logoUrl ? `<img src="${escapeHtml(input.brand.logoUrl)}" alt="${escapeHtml(input.brand.name)}">` : "";
  const parts = [input.recipientName ? `Prepared for ${input.recipientName}` : null, input.state === "open" && input.validUntil ? `open until ${dateLabel(input.validUntil)}` : null].filter((part): part is string => Boolean(part));
  return `<header class="top"><div class="in">${logo}<div class="brand">${escapeHtml(input.brand.name)}</div><h1>${escapeHtml(input.title)}</h1>${parts.length ? `<div class="for">${escapeHtml(parts.join(" · "))}</div>` : ""}</div></header>`;
}

function footer(brand: DocBrand): string {
  return `<footer>${brand.footer ? `${escapeHtml(brand.footer)} · ` : ""}Signed electronically through ${escapeHtml(brand.name)}. A typed name given with consent is a basic electronic signature.</footer>`;
}

function evidenceBlock(signed: SignedFacts, sha: string): string {
  return `<div class="stamp"><strong>Signed electronically</strong><br>Signed by <strong>${escapeHtml(signed.signerName)}</strong> on ${escapeHtml(dateTimeLabel(signed.signedAt))}.<br><span class="small">${escapeHtml(SIGNATURE_TYPE)}</span><div class="small" style="margin-top:8px">Reference <span class="print">${escapeHtml(signed.reference)}</span><br>Document fingerprint (SHA-256) <span class="print">${escapeHtml(sha)}</span>${signed.auditHead ? `<br>Audit trail fingerprint <span class="print">${escapeHtml(signed.auditHead)}</span>` : ""}</div></div>`;
}

/** The page a signer opens. It carries its facts in `data-` attributes for `sign.js`, and holds no inline script. */
export function renderSignPage(input: PageInput): string {
  const data = `id="sign" data-state="${input.state}" data-page="${escapeHtml(input.pageId)}" data-sha="${escapeHtml(input.contentSha256)}" data-consent-sha="${escapeHtml(input.consentSha256)}"`;
  let body: string;
  if (input.state === "open") {
    body = `<div class="paper">${input.bodyHtml}</div>
<div class="box noprint"><div class="small">Document fingerprint (SHA-256): <span class="print">${escapeHtml(input.contentSha256)}</span><br>It is a short code worked out from the exact words above. If a single character changed it would be different, so we can show later that you signed this text.</div></div>
<section class="box noprint" id="sign-box" aria-labelledby="sign-h">
<h2 id="sign-h">Sign this document</h2>
<p class="small" id="sign-help">Read the document above. To sign, type your full name, tick the box and press Sign. Your signature is your typed name, the time, and a record of your browser and a coded form of your network address.</p>
<p class="msg bad" id="link-problem" role="alert" hidden>This page needs the full link from your email (it ends with a long code). Open that link again.</p>
<label for="name">Your full name${input.recipientName ? ` (we expect ${escapeHtml(input.recipientName)})` : ""}</label>
<input type="text" id="name" name="name" autocomplete="name" maxlength="120" aria-describedby="sign-help">
<label class="consent" for="consent"><input type="checkbox" id="consent"><span id="consent-text">${escapeHtml(input.consentText)}</span></label>
<div class="row"><button type="button" id="sign-button" disabled>Sign</button><button type="button" class="link" id="decline-button">Decline</button></div>
<p class="msg" id="msg" role="status" aria-live="polite"></p>
</section>
<section class="box" id="done" hidden role="status"></section>`;
  } else if (input.state === "signed" && input.signed) {
    body = `<div class="paper">${input.bodyHtml}</div><div class="box">${evidenceBlock(input.signed, input.contentSha256)}<div class="row noprint"><button type="button" id="print-button">Print or save as PDF</button></div><p class="small noprint">Keep this page: it is your copy. Anyone with this link can read it, so do not share it.</p></div>`;
  } else if (input.state === "declined") {
    body = `<div class="box"><h2>You declined this document</h2><p>${input.declinedAt ? `You declined it on ${escapeHtml(dateLabel(input.declinedAt))}. ` : ""}Nothing was signed. If that was a mistake, ask ${escapeHtml(input.brand.name)} for a new link.</p></div>`;
  } else if (input.state === "archived") {
    body = `<div class="box"><h2>This copy is no longer online</h2><p>The signed document was kept for a while at this address and has now been taken down. Ask ${escapeHtml(input.brand.name)} for a copy if you need one.</p></div>`;
  } else {
    body = `<div class="box"><h2>${input.state === "expired" ? "This link has expired" : "This document is no longer open"}</h2><p>${input.state === "expired" ? "It was not signed in time." : "It was withdrawn."} Ask ${escapeHtml(input.brand.name)} for a new link if you still want to sign it.</p></div>`;
  }
  return `${head(input.title, input.brand, input.state)}
<body>
${banner(input)}
<main ${data}>
${body}
</main>
${footer(input.brand)}
<script src="../sign.js"></script>
</body>
</html>
`;
}

/** The signed document as a standalone page with no form and no script: the copy kept with the record. */
export function renderSignedHtml(input: Omit<PageInput, "state" | "pageId"> & { signed: SignedFacts }): string {
  return `${head(input.title, input.brand)}
<body>
${banner({ ...input, state: "signed", pageId: "" })}
<main>
<div class="paper">${input.bodyHtml}</div>
<div class="box">${evidenceBlock(input.signed, input.contentSha256)}</div>
</main>
${footer(input.brand)}
</body>
</html>
`;
}

/** The signed copy in Markdown: the exact text that was signed, then the evidence. Stored as the issue document. */
export function renderSignedMarkdown(input: { content: string; contentSha256: string; signed: SignedFacts; companyName: string; consentText: string }): string {
  return [
    input.content.trimEnd(),
    "",
    "---",
    "",
    "## Electronic signature",
    "",
    `- Signed by: ${input.signed.signerName}`,
    `- Signed at: ${dateTimeLabel(input.signed.signedAt)} (${input.signed.signedAt})`,
    `- Sent by: ${input.companyName}`,
    `- Consent given: ${input.consentText}`,
    `- Signature type: ${SIGNATURE_TYPE}`,
    `- Document fingerprint (SHA-256 of the text above, up to the line "---"): ${input.contentSha256}`,
    ...(input.signed.auditHead ? [`- Audit trail fingerprint: ${input.signed.auditHead}`] : []),
    `- Reference: ${input.signed.reference}`,
    "",
  ].join("\n");
}
