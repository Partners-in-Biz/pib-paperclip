/**
 * What a person (or the drafting agent) does with a saved draft before it goes out: change the recipients, subject and
 * text, add or remove files, tick "use my Gmail signature", ask the agent for a new version, or delete it with a reason.
 *
 * Nothing here sends. The reason a person gives for a deletion or a rewrite goes to the drafting agent as a small issue,
 * and the agent's **Learned:** line is what the Cockpit keeps for next time (a plugin cannot write memory itself).
 */
import { randomUUID } from "node:crypto";
import { createWorkIssue, type MailAddress } from "@partnersinbiz/pib-plugin-kit";
import type { SqlStore } from "./db.js";
import { MailboxError } from "./domain.js";
import { getSendAsSignature } from "./gmail/api.js";
import { errorMessage, type Env } from "./gmail/env.js";
import { htmlToText, type MimeAttachment } from "./gmail/mime.js";
import { addressList } from "./gmail/send.js";
import { withGmail } from "./gmail/tokens.js";
import { loadMailboxConfig } from "./config.js";
import type { AccountRow, DraftExtras, DraftFile, MessageRow } from "./gmail/types.js";
import { PLUGIN_ID } from "./namespace.js";

export const MAX_DRAFT_FILES = 10;
/** One file travels in one page request, and the server takes 10 MB of JSON: 7 MB is 9.4 MB once encoded. */
export const MAX_DRAFT_FILE_BYTES = 7 * 1024 * 1024;
export const MAX_DRAFT_FILES_TOTAL_BYTES = 15 * 1024 * 1024;
const NOTE_MAX = 2000;

export type DraftActor = { kind: "agent" | "user"; id: string } | null;

function list(value: unknown, field: string): MailAddress[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]\s*/).filter((v) => v.trim()) : value == null ? [] : [value];
  const problems: string[] = [];
  const out = addressList(items, field, problems);
  if (problems.length) throw new MailboxError(problems[0]!);
  return out;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function cleanFileName(name: unknown): string {
  const base = typeof name === "string" ? name.replace(/[\\/\r\n"]+/g, "_").trim() : "";
  return (base || "attachment").slice(0, 160);
}

function decodedSize(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

async function openDraft(env: Env, companyId: string, messageId: string): Promise<MessageRow> {
  const row = await env.store.getMessage(companyId, messageId);
  if (!row || row.direction !== "outbound") throw new MailboxError("Draft was not found");
  if (row.status !== "draft") throw new MailboxError("Only a draft that has not been sent can be changed");
  return row;
}

export interface EditDraftResult {
  id: string;
  status: "draft";
  to: string[];
}

/**
 * Save a person's (or the drafting agent's) changes. A field that is left out stays as it is. A person who changes the
 * text drops the designed (HTML) version, so what they typed is what goes out; an agent may send a new `html` with it.
 */
export async function editDraft(
  env: Env,
  companyId: string,
  params: Record<string, unknown>,
  actor: DraftActor,
  /** An agent's call checks its delegation on the draft's mailbox first. */
  mayDraft?: (accountId: string) => Promise<void>,
): Promise<EditDraftResult> {
  const store = sqlStore(env);
  const row = await openDraft(env, companyId, String(params.messageId ?? ""));
  if (mayDraft) await mayDraft(row.account_id);
  const extras: DraftExtras = { ...(row.draft ?? {}) };

  const subject = text(params.subject, 900)?.replace(/[\r\n]+/g, " ").trim();
  if (subject !== undefined && !subject) throw new MailboxError("The subject cannot be empty");
  const body = text(params.body, 200_000);
  const to = list(params.to, "to") ?? row.to_addrs ?? [];
  const cc = list(params.cc, "cc") ?? row.cc_addrs ?? [];
  const bcc = list(params.bcc, "bcc") ?? row.bcc_addrs ?? [];

  if (typeof params.html === "string") extras.html = params.html.trim() ? params.html : null;
  else if (body !== undefined && body !== (row.body ?? "")) extras.html = null;
  if (typeof params.useSignature === "boolean") extras.useSignature = params.useSignature;

  const removeIds = new Set(Array.isArray(params.removeFileIds) ? params.removeFileIds.map(String) : []);
  let files: DraftFile[] = (extras.files ?? []).filter((f) => !removeIds.has(f.id));
  for (const item of Array.isArray(params.addFiles) ? params.addFiles : []) {
    const f = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const data = typeof f.data === "string" ? f.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new MailboxError("A file could not be read");
    const bytes = decodedSize(data);
    if (bytes > MAX_DRAFT_FILE_BYTES) throw new MailboxError(`${cleanFileName(f.name)} is larger than ${MAX_DRAFT_FILE_BYTES / 1024 / 1024} MB`);
    files.push({ id: randomUUID(), name: cleanFileName(f.name), mime: typeof f.mime === "string" && f.mime ? f.mime.slice(0, 200) : "application/octet-stream", bytes, data });
  }
  if (files.length > MAX_DRAFT_FILES) throw new MailboxError(`A draft can carry at most ${MAX_DRAFT_FILES} files`);
  if (files.reduce((sum, f) => sum + f.bytes, 0) > MAX_DRAFT_FILES_TOTAL_BYTES) throw new MailboxError(`The files together are larger than ${MAX_DRAFT_FILES_TOTAL_BYTES / 1024 / 1024} MB`);
  extras.files = files.length ? files : undefined;

  // A new version from the agent answers an open rewrite request.
  if (actor?.kind === "agent") extras.rewrite = null;
  if (actor?.kind === "user" && !extras.by) extras.by = actor;

  const saved = await store.updateDraft(companyId, row.id, { subject: subject ?? row.subject, body: body ?? row.body ?? "", to, cc, bcc, draft: extras });
  if (!saved) throw new MailboxError("Only a draft that has not been sent can be changed");
  return { id: row.id, status: "draft", to: to.map((a) => a.email) };
}

/** The page's actions run on the SQL store, which carries the draft queries the Gmail logic does not need. */
function sqlStore(env: Env): SqlStore {
  return env.store as unknown as SqlStore;
}

function reasonOf(params: Record<string, unknown>, key: string): string {
  const value = typeof params[key] === "string" ? (params[key] as string).trim() : "";
  if (value.length < 3) throw new MailboxError(key === "reason" ? "Say why, in a few words, so the agent can learn from it" : "Say what should change");
  return value.slice(0, NOTE_MAX);
}

function quote(value: string, max: number): string {
  return value.slice(0, max).split("\n").map((line) => `> ${line}`).join("\n");
}

async function tellAgent(env: Env, companyId: string, agentId: string, title: string, description: string, originId: string): Promise<string | null> {
  try {
    const created = await createWorkIssue(env.ctx, {
      companyId,
      title: title.slice(0, 200),
      description,
      assigneeAgentId: agentId,
      originKind: `plugin:${PLUGIN_ID}`,
      originId,
      priority: "low",
      wakeReason: "A person gave feedback on your draft",
    });
    return created.id;
  } catch (error) {
    env.ctx.logger.info("Draft feedback issue not created", { originId, error: errorMessage(error) });
    return null;
  }
}

function agentOf(row: MessageRow): string | null {
  const by = row.draft?.by;
  return by && by.kind === "agent" && by.id ? by.id : null;
}

/** Remove a draft. The reason is required for an agent's draft, whose agent is asked to keep one lesson from it. A person's own draft needs none. */
export async function deleteDraftWithReason(env: Env, companyId: string, params: Record<string, unknown>): Promise<{ deleted: true; agentTold: boolean }> {
  const store = sqlStore(env);
  const row = await openDraft(env, companyId, String(params.messageId ?? ""));
  const reason = agentOf(row) ? reasonOf(params, "reason") : "";
  if (!(await store.deleteDraft(companyId, row.id))) throw new MailboxError("Only a draft that has not been sent can be deleted");
  const agentId = agentOf(row);
  let agentTold = false;
  if (agentId) {
    const issueId = await tellAgent(
      env,
      companyId,
      agentId,
      `Draft deleted: ${row.subject || "(no subject)"}`,
      [
        "A person deleted a draft you wrote and gave a reason.",
        "",
        `- Subject: ${row.subject || "(no subject)"}`,
        `- To: ${(row.to_addrs ?? []).map((a) => a.email).join(", ") || "no recipient"}`,
        "",
        "**Reason**",
        quote(reason, NOTE_MAX),
        "",
        "**What I need from you:** do not draft it again. Reply with one closing comment that ends with a single **Learned:** line: what to do differently next time, as a rule or preference, in one sentence. Then mark this issue done.",
      ].join("\n"),
      `mailbox:draft-deleted:${row.id}`,
    );
    agentTold = Boolean(issueId);
  }
  env.ctx.logger.info("Draft deleted", { id: row.id, agentTold });
  return { deleted: true, agentTold };
}

/** Ask the drafting agent for a new version. The draft stays, marked as waiting; the agent saves the new text with `update-draft`. */
export async function requestRewrite(env: Env, companyId: string, params: Record<string, unknown>, userId: string | null): Promise<{ id: string; agentTold: boolean; note: string }> {
  const store = sqlStore(env);
  const note = reasonOf(params, "note");
  const row = await openDraft(env, companyId, String(params.messageId ?? ""));
  const agentId = agentOf(row);
  if (!agentId) throw new MailboxError("This draft was not written by an agent, so there is nobody to ask. Edit it yourself.");
  const extras: DraftExtras = { ...(row.draft ?? {}) };
  const issueId = await tellAgent(
    env,
    companyId,
    agentId,
    `Rewrite this draft: ${row.subject || "(no subject)"}`,
    [
      "A person read your draft and wants a new version.",
      "",
      `- Draft id: \`${row.id}\``,
      `- Subject: ${row.subject || "(no subject)"}`,
      `- To: ${(row.to_addrs ?? []).map((a) => a.email).join(", ") || "no recipient"}`,
      "",
      "**What to change**",
      quote(note, NOTE_MAX),
      "",
      "**Current text**",
      quote(row.body ?? "", 4000),
      "",
      `**What I need from you:** save the new version over the same draft with \`partnersinbiz.mailbox:update-draft\` (messageId \`${row.id}\`; send \`subject\`, \`body\` and, if you use one, \`html\`). Do not create a second draft and do not send it. Then comment what you changed. If the feedback holds a lasting preference, end the comment with one **Learned:** line.`,
    ].join("\n"),
    `mailbox:draft-rewrite:${row.id}:${Date.now()}`,
  );
  extras.rewrite = { note, requestedAt: new Date(env.now()).toISOString(), issueId };
  const saved = await store.updateDraft(companyId, row.id, { subject: row.subject, body: row.body ?? "", to: row.to_addrs ?? [], cc: row.cc_addrs ?? [], bcc: row.bcc_addrs ?? [], draft: extras });
  if (!saved) throw new MailboxError("Only a draft that has not been sent can be changed");
  env.ctx.logger.info("Draft rewrite requested", { id: row.id, by: userId, agentTold: Boolean(issueId) });
  return { id: row.id, agentTold: Boolean(issueId), note };
}

/** The Gmail signature of a mailbox, as HTML and as text. Empty when Gmail has none. */
export async function mailboxSignature(env: Env, companyId: string, account: AccountRow): Promise<{ html: string; text: string }> {
  if (!account.token_sealed) throw new MailboxError("Connect Gmail for this mailbox first");
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const html = (await withGmail(env, loaded, account, (token) => getSendAsSignature(env.fetch, token, account.address))).trim();
  return { html, text: html ? htmlToText(html).trim() : "" };
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The text and HTML a draft goes out with once its signature is added. Plain text stays plain except for the signature's own HTML. */
export function withSignature(input: { text: string | null; html: string | null }, signature: { html: string; text: string }): { text: string | null; html: string | null } {
  if (!signature.html) return input;
  const block = `<div class="gmail_signature" data-smartmail="gmail_signature">${signature.html}</div>`;
  const baseHtml = input.html ?? `<div style="white-space:pre-wrap">${escapeHtml(input.text ?? "")}</div>`;
  const html = /<\/body>/i.test(baseHtml) ? baseHtml.replace(/<\/body>/i, `<br>${block}</body>`) : `${baseHtml}<br>${block}`;
  const text = `${(input.text ?? "").trimEnd()}\n\n-- \n${signature.text}`;
  return { text, html };
}

/** A draft's files as the mail builder takes them. */
export function draftAttachments(extras: DraftExtras | null | undefined): MimeAttachment[] {
  return (extras?.files ?? []).map((f) => ({ filename: f.name, mime: f.mime, content: Uint8Array.from(Buffer.from(f.data, "base64")) }));
}
