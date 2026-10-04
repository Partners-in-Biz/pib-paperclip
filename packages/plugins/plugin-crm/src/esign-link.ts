/**
 * Signing links and the page files behind them (audit Q1b-11, Q10-14).
 *
 * A signing link has two secrets that do different jobs:
 * - the page id in the path (`.../ui/s/<page id>.html`, 120 bits) names the page. Anyone holding it can READ the document;
 * - the token in the address fragment (`#pibt_...`, 200 bits) is what signs or declines. A fragment is never sent to a
 *   server or written to an access log, and only its SHA-256 is stored here, so a copy of the database does not hold a
 *   usable link. The link is made when a person approves the email, never earlier. No CRM tool, issue or approval shows it, but the
 *   email that carries it is queued in the outbox and the Mailbox: the outbox row is blanked once the Mailbox answers
 *   (`scrubSettledBody` in `outbound.ts`), and the Mailbox's own record of the message is the Mailbox's to scrub.
 *
 * `publishPage` writes the page for a document's current state; `syncPages` rewrites every live page from the records
 * (a deploy removes them, see `esign-pages.ts`).
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { pluginUiBase, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { brandOf, markdownToHtml, renderSignPage, type DocBrand, type PageState, type SignedFacts } from "./esign-render.js";
import { insertToken, tokenHash, type SignDocument } from "./esign-store.js";
import { isPageId, pageFileName, pagesPresent, pageStateOnDisk, removePage, writePage, type WriteResult } from "./esign-pages.js";
import { SIGNED_PAGE_DAYS } from "./esign-templates.js";
import { DEFAULT_PUBLIC_BASE } from "./lead-embed.js";

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `pibt_` and 40 characters: 200 bits. */
export function generateSignToken(): string {
  const bytes = randomBytes(40);
  let out = "pibt_";
  for (let i = 0; i < 40; i += 1) out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  return out;
}

export function isSignToken(value: unknown): value is string {
  return typeof value === "string" && /^pibt_[a-z2-7]{40}$/.test(value);
}

export { SIGNED_PAGE_DAYS };

const DAY_MS = 86_400_000;

/**
 * The state its page shows, or null when the document has no page (it was never sent).
 * A document waiting for the Mailbox to confirm the send (`awaiting_approval` with an expiry) already has a live link: the link is
 * made when a person approves, and the status only moves to `sent` when the Mailbox answers, which can take a while. Its page stays.
 * An `awaiting_approval` document with no expiry is still waiting for the person: nothing was made, so there is no page.
 */
export function pageStateOf(doc: Pick<SignDocument, "status" | "expiresAt" | "signedAt">, now: number): PageState | null {
  switch (doc.status) {
    case "awaiting_approval":
      return doc.expiresAt ? (Date.parse(doc.expiresAt) < now ? "expired" : "open") : null;
    case "sent":
    case "viewed":
      return doc.expiresAt && Date.parse(doc.expiresAt) < now ? "expired" : "open";
    case "signed":
      return doc.signedAt && now - Date.parse(doc.signedAt) > SIGNED_PAGE_DAYS * DAY_MS ? "archived" : "signed";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "void":
      return "void";
    default:
      return null;
  }
}

export function docBrand(doc: Pick<SignDocument, "brand">): DocBrand {
  const b = doc.brand;
  return brandOf({ name: typeof b.name === "string" && b.name ? b.name : "Partners in Biz", primary: b.primary, accent: b.accent, logoUrl: b.logoUrl, footer: b.footer });
}

export function signedFactsOf(doc: SignDocument): SignedFacts | null {
  if (doc.status !== "signed" || !doc.signedAt || !doc.signerName) return null;
  return { signerName: doc.signerName, signedAt: doc.signedAt, reference: doc.id, auditHead: doc.auditHead };
}

/** The page for a document in its current state, or null when it has none. A closed page shows no document text. */
export function renderPageFor(doc: SignDocument, now: number): string | null {
  const state = pageStateOf(doc, now);
  if (!state) return null;
  const showsText = state === "open" || state === "signed";
  return renderSignPage({
    pageId: doc.pageId,
    title: doc.title,
    state,
    brand: docBrand(doc),
    recipientName: doc.recipientName,
    bodyHtml: showsText ? markdownToHtml(doc.content) : "",
    contentSha256: doc.contentSha256,
    consentText: doc.consentText,
    consentSha256: doc.consentSha256,
    validUntil: doc.expiresAt,
    signed: signedFactsOf(doc),
    declinedAt: doc.declinedAt,
  });
}

/** Writes (or removes) the page file for a document's current state. */
export function publishPage(doc: SignDocument, now = Date.now()): WriteResult {
  const html = renderPageFor(doc, now);
  if (html === null) {
    removePage(doc.pageId);
    return { ok: true };
  }
  return writePage(doc.pageId, html);
}

export interface SyncResult {
  written: number;
  removed: number;
  failed: number;
}

/**
 * Makes the folder match the records: a page for every document that has one, none for anything else. Run at start
 * (a deploy empties the folder) and every few minutes by the care job. A page whose file is already right is not rewritten
 * unless `force`: a file that already shows the right state is left alone.
 */
export function syncPages(docs: readonly SignDocument[], now = Date.now(), options: { force?: boolean; removeOrphans?: boolean } = {}): SyncResult {
  const present = pagesPresent();
  const result: SyncResult = { written: 0, removed: 0, failed: 0 };
  const byPage = new Map(docs.map((doc) => [doc.pageId, doc]));
  for (const doc of docs) {
    const state = pageStateOf(doc, now);
    if (!state) continue;
    // A page is rewritten when its file is gone (a deploy removes them) or shows another state than the record now says
    // (an open page whose time ran out, a signed copy that has been online long enough).
    if (present.has(doc.pageId) && !options.force && pageStateOnDisk(doc.pageId) === state) continue;
    if (publishPage(doc, now).ok) result.written += 1;
    else result.failed += 1;
  }
  for (const id of present) {
    const doc = byPage.get(id);
    // A page for a document that has none (never sent, or deleted with its client) is removed; an unknown file only when asked.
    if ((doc && pageStateOf(doc, now) === null) || (!doc && options.removeOrphans)) {
      removePage(id);
      result.removed += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface SignUrls {
  /** `<origin>/_plugins/<installation uuid>/ui/s/` */
  pageBase: string;
}

/** Said when a link is asked for before the CRM page has reported the plugin's address. */
export const NO_SIGN_ADDRESS_NOTE = "Open the CRM page once (CRM in the sidebar) so the plugin learns its public address, then send the document again: the signing link needs it.";

/**
 * Where pages are served, or null until the CRM page has been opened once and the installation uuid is known. The host serves a
 * plugin's static files only under its installation uuid: the plugin key address answers every request with an error, so a link
 * is never built on it. A caller that gets null refuses (nothing is made) rather than sending a link that cannot open.
 */
export async function signUrls(ctx: PluginContext, companyId: string): Promise<SignUrls | null> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  let origin = DEFAULT_PUBLIC_BASE;
  if (typeof config.publicBaseUrl === "string" && config.publicBaseUrl.trim()) {
    try {
      origin = new URL(config.publicBaseUrl.trim()).origin;
    } catch {
      origin = DEFAULT_PUBLIC_BASE;
    }
  }
  const base = await pluginUiBase(ctx).catch(() => null);
  if (typeof base !== "string" || !/^\/_plugins\/[0-9a-f-]{36}\/ui\/$/.test(base)) return null;
  return { pageBase: `${origin}${base}s/` };
}

/** Thrown when a link is asked for and the plugin's public address is not known (see `NO_SIGN_ADDRESS_NOTE`). */
export class SigningAddressUnknown extends Error {
  constructor() {
    super(NO_SIGN_ADDRESS_NOTE);
  }
}

/** The link the client opens: the page, and the token in the fragment. */
export function signingLink(pageBase: string, pageId: string, token: string): string {
  if (!isPageId(pageId) || !isSignToken(token)) throw new Error("not a page id or a token");
  return `${pageBase}${pageFileName(pageId)}#${token}`;
}

/**
 * Makes a link for an approved email: a token (stored as its hash, valid until `expiresAt`) and the page written for the
 * document's state. The token and link exist only in the returned value (the email that carries it is the one place they go). Throws,
 * naming why, when the page cannot be written or the plugin's public address is not known (checked before anything is stored).
 */
export async function mintLink(ctx: PluginContext, doc: SignDocument, input: { approvalId: string | null; expiresAt: string }): Promise<{ token: string; link: string }> {
  const urls = await signUrls(ctx, doc.companyId);
  if (!urls) throw new SigningAddressUnknown();
  const token = generateSignToken();
  await insertToken(ctx, { hash: tokenHash(token), companyId: doc.companyId, docId: doc.id, approvalId: input.approvalId, expiresAt: input.expiresAt });
  // The page shows the document as open (the status moves to sent when the Mailbox confirms): written from the state it will have.
  const written = publishPage({ ...doc, status: "sent", expiresAt: input.expiresAt });
  if (!written.ok) throw new Error(written.reason);
  return { token, link: signingLink(urls.pageBase, doc.pageId, token) };
}
