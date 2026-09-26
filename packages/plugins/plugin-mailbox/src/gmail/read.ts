/**
 * On-demand reads (search, one body) and triage corrections. Bodies are
 * fetched only here, as text, truncated, never stored.
 */
import { correctDecision, MAIL_CATEGORIES, type MailCategory } from "@partnersinbiz/pib-plugin-kit";
import type { LoadedConfig } from "../config.js";
import { MailboxError } from "../domain.js";
import { getMessageFull, getMessageMetadata, listMessages, modifyMessage, type GmailPart } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { decodeEncodedWords, headerMap, parseAddressList } from "./headers.js";
import { ensureLabelIds } from "./labels.js";
import { htmlToText } from "./mime.js";
import { mapLimit } from "./sync.js";
import { withGmail } from "./tokens.js";
import { allTriageLabels, triageLabels } from "./triage.js";
import type { AccountRow, MessageRow, StoredTriage } from "./types.js";


function decodeBody(data: string, charset: string | null): string {
  const bytes = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const cs = (charset ?? "utf-8").toLowerCase();
  try {
    if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii") return bytes.toString("utf8");
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function charsetOf(part: GmailPart): string | null {
  const type = headerMap(part.headers).get("content-type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(type)?.[1] ?? null;
}

function findPart(part: GmailPart | null | undefined, mime: string): GmailPart | null {
  if (!part) return null;
  if ((part.mimeType ?? "").toLowerCase() === mime && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return null;
}

/** Plain text of a message: text/plain, else text/html converted. */
export function bodyText(payload: GmailPart | null): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBody(plain.body.data, charsetOf(plain)).replace(/\r\n/g, "\n");
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return htmlToText(decodeBody(html.body.data, charsetOf(html)));
  return "";
}

export async function readMessageBody(env: Env, loaded: LoadedConfig, account: AccountRow, gmailMessageId: string, maxChars: number) {
  const message = await withGmail(env, loaded, account, (token) => getMessageFull(env.fetch, token, gmailMessageId));
  const headers = headerMap(message.payload?.headers);
  const text = bodyText(message.payload);
  const limit = Math.max(200, Math.min(maxChars, 50_000));
  return {
    gmailMessageId: message.id,
    threadId: message.threadId,
    from: parseAddressList(headers.get("from"))[0] ?? null,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    subject: decodeEncodedWords(headers.get("subject") ?? ""),
    date: headers.get("date") ?? null,
    text: text.slice(0, limit),
    truncated: text.length > limit,
    length: text.length,
  };
}

export async function searchMail(env: Env, loaded: LoadedConfig, account: AccountRow, query: string, limit: number) {
  const q = query.trim().slice(0, 500);
  if (!q) throw new MailboxError("query is required");
  const listed = await withGmail(env, loaded, account, (token) => listMessages(env.fetch, token, q, { maxResults: Math.max(1, Math.min(limit, 25)) }));
  const results = await mapLimit(listed.messages, 5, async (item) => {
    const message = await withGmail(env, loaded, account, (token) =>
      getMessageMetadata(env.fetch, token, item.id, ["From", "To", "Subject", "Date"]),
    );
    const headers = headerMap(message.payload?.headers);
    const stored = await env.store.getMessageByGmailId(account.company_id, message.id);
    return {
      gmailMessageId: message.id,
      threadId: message.threadId,
      messageId: stored?.id ?? null,
      from: parseAddressList(headers.get("from"))[0] ?? null,
      to: parseAddressList(headers.get("to")),
      subject: decodeEncodedWords(headers.get("subject") ?? ""),
      date: headers.get("date") ?? null,
      snippet: message.snippet,
      labels: message.labelIds,
      category: stored?.category ?? null,
    };
  });
  return { accountId: account.id, address: account.address, query: q, count: results.length, messages: results, more: Boolean(listed.nextPageToken) };
}

export interface TriageCorrection {
  category?: string | null;
  urgency?: number | null;
  needsReply?: boolean | null;
  /** `company:<id>`, `contact:<id>`, or `none`. */
  client?: string | null;
}

function emptyTriage(): StoredTriage {
  return {
    category: null,
    urgency: null,
    needsReply: null,
    phishing: null,
    confidence: null,
    clientKind: null,
    clientRef: null,
    clientName: null,
    source: "correction",
    clientSource: null,
    decisionIds: {},
    model: null,
    labels: [],
  };
}

export async function correctTriage(
  env: Env,
  loaded: LoadedConfig,
  row: MessageRow,
  correction: TriageCorrection,
  correctedBy: string | null,
): Promise<{ messageId: string; triage: StoredTriage; decisionsCorrected: number; relabelled: boolean }> {
  const companyId = row.company_id;
  const before = row.triage ?? emptyTriage();
  const next: StoredTriage = { ...before, decisionIds: { ...before.decisionIds } };
  const corrections: Array<[string, string]> = [];

  if (correction.category != null) {
    if (!(MAIL_CATEGORIES as readonly string[]).includes(correction.category)) {
      throw new MailboxError(`category must be one of: ${MAIL_CATEGORIES.join(", ")}`);
    }
    if (correction.category !== before.category) corrections.push(["category", correction.category]);
    next.category = correction.category as MailCategory;
    next.source = "correction";
    next.confidence = 1;
  }
  if (correction.urgency != null) {
    const level = Number(correction.urgency);
    if (!Number.isInteger(level) || level < 0 || level > 3) throw new MailboxError("urgency must be 0, 1, 2 or 3");
    if (before.urgency == null || Math.round(before.urgency) !== level) corrections.push(["urgency", String(level)]);
    next.urgency = level;
  }
  if (correction.needsReply != null) {
    const yes = Boolean(correction.needsReply);
    if (before.needsReply == null || before.needsReply >= 0.5 !== yes) corrections.push(["needs_reply", yes ? "1" : "0"]);
    next.needsReply = yes ? 1 : 0;
  }
  if (correction.client != null) {
    const value = correction.client.trim();
    if (value === "none" || value === "") {
      if (before.clientRef) corrections.push(["client", "none"]);
      next.clientKind = null;
      next.clientRef = null;
      next.clientName = null;
    } else {
      const match = /^(company|contact):([A-Za-z0-9_-]{1,128})$/.exec(value);
      if (!match) throw new MailboxError("client must be company:<id>, contact:<id> or none");
      const kind = match[1] as "company" | "contact";
      const id = match[2]!;
      if (before.clientRef !== id || before.clientKind !== kind) corrections.push(["client", `${kind}:${id}`]);
      next.clientKind = kind;
      next.clientRef = id;
      next.clientName = kind === "company" ? (await env.store.crmCompany(companyId, id))?.name ?? null : null;
    }
    next.clientSource = "correction";
  }

  let decisionsCorrected = 0;
  for (const [key, value] of corrections) {
    const decisionId = before.decisionIds[key];
    if (decisionId && (await correctDecision(env.ctx, companyId, decisionId, value, correctedBy))) decisionsCorrected += 1;
  }

  const prefix = loaded.config.labelPrefix;
  const oldLabels = before.labels ?? [];
  next.labels = triageLabels(prefix, next);
  await env.store.setTriage(companyId, row.id, {
    triage: next,
    category: next.category,
    urgency: next.urgency,
    needsReply: next.needsReply,
    phishing: next.phishing,
    clientKind: next.clientKind,
    clientRef: next.clientRef,
    replyTo: row.reply_to,
  });

  let relabelled = false;
  const account = await env.store.getAccount(companyId, row.account_id);
  if (account?.status === "connected" && row.gmail_message_id) {
    try {
      await withGmail(env, loaded, account, async (token) => {
        const addIds = Object.values(await ensureLabelIds(env.fetch, env.store, account, token, next.labels));
        const removable = new Set([...oldLabels, ...allTriageLabels(prefix)].filter((name) => !next.labels.includes(name)));
        const removeIds = [...removable].map((name) => account.label_ids?.[name]).filter((id): id is string => Boolean(id));
        if (addIds.length + removeIds.length > 0) await modifyMessage(env.fetch, token, row.gmail_message_id!, addIds, removeIds);
      });
      relabelled = true;
    } catch (error) {
      env.ctx.logger.info("Gmail relabel after correction failed", { messageId: row.id, error: errorMessage(error) });
    }
  }
  return { messageId: row.id, triage: next, decisionsCorrected, relabelled };
}

/** Mirror a read mark to Gmail (best effort). */
export async function markReadInGmail(env: Env, loaded: LoadedConfig, row: MessageRow): Promise<boolean> {
  if (!row.gmail_message_id) return false;
  const account = await env.store.getAccount(row.company_id, row.account_id);
  if (account?.status !== "connected") return false;
  try {
    await withGmail(env, loaded, account, (token) => modifyMessage(env.fetch, token, row.gmail_message_id!, [], ["UNREAD"]));
    return true;
  } catch (error) {
    env.ctx.logger.info("Gmail read mark failed", { messageId: row.id, error: errorMessage(error) });
    return false;
  }
}
