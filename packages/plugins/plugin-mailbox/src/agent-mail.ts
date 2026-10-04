/**
 * Agent tools that read across the Mailbox: `list-mailboxes` (what an agent
 * may use) and `get-attachment` (one file, stored privately, with the text
 * of statements).
 */
import { loadMailboxConfig, privateR2, r2Configured } from "./config.js";
import { companyPrefix, delegationAsk } from "./delegations.js";
import { sendingDomain } from "./dns.js";
import { MailboxError } from "./domain.js";
import { isEspProvider } from "./esp/types.js";
import { ATTACHMENT_MAX_BYTES, decodeText, downloadAttachment, isTextAttachment, storeAttachment, TEXT_MAX_BYTES } from "./gmail/attachments.js";
import type { Env } from "./gmail/env.js";
import type { MessageRow } from "./gmail/types.js";

async function delegation(env: Env, accountId: string, agentId: string) {
  const row = await env.store.delegationFor(accountId, agentId);
  return row ? { canRead: row.can_read, canDraft: row.can_draft, canSend: row.can_send } : null;
}

async function findMessage(env: Env, companyId: string, id: string, accountId: string | null = null): Promise<MessageRow | null> {
  const row = (await env.store.getMessage(companyId, id)) ?? (await env.store.getMessageByGmailId(companyId, id, accountId));
  return row && (!accountId || row.account_id === accountId) ? row : null;
}

/** An account id, or the mailbox address from an issue; null when not given. */
async function accountIdFor(env: Env, companyId: string, account: string | null | undefined): Promise<string | null> {
  const value = account?.trim();
  if (!value) return null;
  if (!value.includes("@")) return value;
  const found = await env.store.findAccountByAddress(companyId, value);
  if (!found) throw new MailboxError(`No mailbox ${value} in this company. list-mailboxes shows the accounts.`);
  return found.id;
}

/** The agent's name for an ask card; its id when it cannot be read (the card works either way). */
async function agentLabel(env: Env, companyId: string, agentId: string): Promise<string | null> {
  try {
    const agent = (await env.ctx.agents.get(agentId, companyId)) as unknown as { name?: unknown } | null;
    return typeof agent?.name === "string" && agent.name ? agent.name : null;
  } catch {
    return null;
  }
}

/** Every account an agent can use, the default sender, each account's state, and this agent's delegation on it. */
export async function listMailboxes(env: Env, companyId: string, agentId: string) {
  const accounts = await env.store.listAccounts(companyId);
  const fallback = await env.store.defaultAccount(companyId);
  const items = [];
  // A send-only account has no inbox to read, so nobody needs read access to it.
  const needsAccess = (await Promise.all(accounts.filter((a) => a.status !== "disconnected" && !isEspProvider(a.provider)).map(async (a) => !(await delegation(env, a.id, agentId))?.canRead))).some(Boolean);
  const prefix = needsAccess ? await companyPrefix(env.ctx, companyId) : null;
  const name = needsAccess ? await agentLabel(env, companyId, agentId) : null;
  for (const account of accounts) {
    const grant = await delegation(env, account.id, agentId);
    const sendOnly = isEspProvider(account.provider);
    const gmail = !sendOnly && Boolean(account.token_sealed) && (account.status === "connected" || account.status === "needs_reconnect");
    const domain = sendingDomain(account.address);
    const domainCheck = domain ? await env.store.getDomainCheck(companyId, domain).catch(() => null) : null;
    items.push({
      accountId: account.id,
      address: account.address,
      status: account.status,
      /** `gmail`, or `email-provider`: a send-only address on a verified domain (no inbox, nothing to read). */
      kind: sendOnly ? "email-provider" : "gmail",
      isDefault: fallback?.id === account.id,
      lastSyncAt: account.last_sync_at,
      replyTo: account.reply_to,
      problem: sendOnly
        ? account.status === "pending"
          ? "Waiting for the domain's DNS records to be verified: list-sending-domains shows the records still to add."
          : account.status === "disconnected"
            ? "Disconnected."
            : null
        : account.status === "needs_reconnect"
          ? "Gmail must be reconnected by a person on the Mailbox page."
          : account.status === "disconnected"
            ? "Disconnected."
            : !gmail
              ? "Not connected to Gmail: drafts are sent by a person."
              : null,
      delegation: grant ? { read: grant.canRead, draft: grant.canDraft, send: grant.canSend } : null,
      mayRead: Boolean(grant?.canRead),
      mayDraft: Boolean(grant?.canDraft),
      maySend: Boolean(grant?.canSend) && (gmail || sendOnly) && account.status === "connected",
      /** The client this mailbox belongs to: it sends only that client's mail. Null: the company's own. */
      client: account.client_ref ? { kind: account.client_kind, ref: account.client_ref } : null,
      fromName: account.from_name,
      /** Mail authentication of the mailbox's domain from the last daily check (null: not checked, or a free-mail domain). */
      domainHealth: domainCheck ? { domain: domainCheck.domain, status: domainCheck.status, healthy: domainCheck.status === "healthy", checkedAt: domainCheck.checked_at } : null,
      /** No read access yet: pass this to partnersinbiz.cockpit:ask-owner; the owner's yes grants it and checks it, and you are woken with it in place. */
      askToOwner: grant?.canRead || account.status === "disconnected" || sendOnly ? null : delegationAsk({ accountId: account.id, address: account.address, agentId, agentName: name, prefix }),
    });
  }
  const usable = items.some((item) => item.mayDraft || item.mayRead);
  return {
    defaultAccountId: fallback?.id ?? null,
    defaultAddress: fallback?.address ?? null,
    accounts: items,
    next: usable
      ? "Use an accountId where mayDraft is true with create-draft; send-draft only where maySend is true. Mail other plugins send goes from the default account."
      : "You have no delegation on any mailbox. Call partnersinbiz.cockpit:ask-owner once with the askToOwner card of the mailbox you need: when the owner says yes the Mailbox gives you read and draft access and checks it, and you are woken with it in place. Do not ask again.",
  };
}

/**
 * One attachment for an agent: the file stored in private R2 with an https
 * `url` valid 15 minutes, plus `text` for statement files (CSV, OFX, QFX,
 * QIF, TXT, MT940) up to 200 KB. Both feed Accounting's `import-statement`
 * (`text` as `content`, or `url`).
 */
export async function getAttachment(env: Env, companyId: string, agentId: string, messageId: string, attachmentId: string, mailbox?: string | null) {
  const row = await findMessage(env, companyId, messageId, await accountIdFor(env, companyId, mailbox));
  if (!row) throw new MailboxError("Message not found. Pass the mailbox (account) too when several mailboxes are connected.");
  const grant = await delegation(env, row.account_id, agentId);
  if (!grant?.canRead) {
    const box = (await env.store.getAccount(companyId, row.account_id))?.address ?? row.account_id;
    throw new MailboxError(`You may not read ${box}. Call list-mailboxes: that mailbox carries an askToOwner card. Pass it to partnersinbiz.cockpit:ask-owner once; the owner's yes grants the access and you are woken with it in place.`);
  }
  const meta = (row.attachments ?? []).find((a) => a.attachmentId === attachmentId);
  if (!meta) throw new MailboxError("That attachment is not on this message. get-message lists each attachmentId.");
  if (meta.bytes > ATTACHMENT_MAX_BYTES) throw new MailboxError("That attachment is larger than 25 MB");
  const account = await env.store.getAccount(companyId, row.account_id);
  if (!account?.token_sealed || account.status !== "connected") throw new MailboxError("That mailbox is not connected to Gmail right now, so the attachment cannot be fetched");
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const bytes = await downloadAttachment(env, loaded, account, row, meta);
  const textType = isTextAttachment(meta.filename, meta.mime);
  const text = textType && bytes.byteLength <= TEXT_MAX_BYTES ? decodeText(bytes) : null;
  const r2 = await privateR2(loaded);
  const stored = r2 ? await storeAttachment(env, r2, companyId, meta, bytes) : null;
  const notes = [
    textType && text == null ? "The file is over 200 KB, so its text is not included; use the url." : null,
    stored
      ? null
      : r2Configured(loaded.raw)
        ? "Private storage (R2) is set up but its secret could not be read, so there is no link."
        : text != null
          ? "No link: private storage (R2) is not set up in the Mailbox settings. The text is included."
          : "No link: private storage (R2) is not set up in the Mailbox settings. Ask the owner once (partnersinbiz.cockpit:ask-owner) to add it.",
  ].filter(Boolean);
  return {
    messageId: row.id,
    gmailMessageId: row.gmail_message_id,
    accountId: row.account_id,
    attachmentId,
    filename: meta.filename,
    mime: meta.mime,
    bytes: bytes.byteLength,
    /** https download link, valid 15 minutes (null without private storage). */
    url: stored?.link ?? null,
    urlExpiresAt: stored?.expiresAt ?? null,
    text,
    note: notes.length ? notes.join(" ") : null,
    next: text != null
      ? "A statement: import it with partnersinbiz.accounting:import-statement (text as content, filename as fileName)."
      : stored
        ? "Open the url (it expires in 15 minutes), or pass it as url to partnersinbiz.accounting:import-statement for a statement."
        : null,
  };
}
