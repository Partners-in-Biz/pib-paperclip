/**
 * Who may do what in the Mailbox (access stage A, spec PAR-12578 sections 4.4 and 4.6; PAR-12682). Keys: action key,
 * `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person needs the permission named here.
 * With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - `mailbox.mail`: the mail itself. `view` reads (inbox, sent, threads, messages, the mailbox picker); `create` puts new
 *   mail out (a draft, a reply, a send, a template); `edit` changes mail that exists (a draft, read marks, triage, a
 *   rewrite, a sync, the task link); `delete` deletes mail or a draft.
 * - `mailbox.accounts`: the connected mailboxes. Connect a Gmail account, disconnect it, delete it, make it the
 *   default, give it to a client, and the agents' delegations on it (who may read, draft or send there).
 * - `mailbox.settings`: sending domains and their DNS checks, reputation holds, the client mail maps and the
 *   unsubscribe link check.
 * - `ADMIN_ONLY`: the company preferences (the kit checks owner or admin there already) and the skill sync.
 *
 * A tool has the permission of the page action of the same work. No entry is `scoped`: the Mailbox does not filter by
 * the person's companies, and personal mailboxes are stage D. Mailbox is in no own-companies preset.
 */
import type { AccessTable, AccessTableEntry, ADMIN_ONLY as KIT_ADMIN_ONLY, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ADMIN_ONLY: typeof KIT_ADMIN_ONLY = "ADMIN_ONLY";
const mail = (action: PermissionAction): AccessTableEntry => ({ resource: "mailbox.mail", action });
const accounts = (action: PermissionAction): AccessTableEntry => ({ resource: "mailbox.accounts", action });
const settings = (action: PermissionAction): AccessTableEntry => ({ resource: "mailbox.settings", action });
const rows = (entry: AccessTableEntry, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, entry]));
const tools = (entry: AccessTableEntry, names: readonly string[]) => rows(entry, names.map((name) => `tool:${name}`));

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  ...rows(mail("view"), [
    "mailbox.load", "mailbox.list-email-templates", "mailbox.list-inbox", "mailbox.list-threads", "mailbox.inbox",
    "mailbox.sent", "mailbox.triage-stats", "mailbox.contact-search", "mailbox.gmail-signature", "mailbox.get-message",
    "mailbox.handoff-prepare", "mailbox.thread-context", "mailbox.task-links", "mailbox.crm-clients",
    "canvas.cards.resolve", "canvas.cards.related",
  ]),
  ...rows(mail("create"), [
    "mailbox.create-draft", "mailbox.create-email-template", "mailbox.start-reply", "mailbox.send-draft", "mailbox.retry-send",
  ]),
  ...rows(mail("edit"), [
    "mailbox.mark-read", "mailbox.sync-now", "mailbox.correct-triage", "mailbox.update-draft", "mailbox.request-rewrite",
    "mailbox.handoff-record",
  ]),
  ...rows(mail("delete"), ["mailbox.delete-draft", "mailbox.delete-mail"]),
  ...rows(accounts("create"), ["mailbox.create-account", "mailbox.connect-start"]),
  ...rows(accounts("edit"), [
    "mailbox.create-delegation", "mailbox.remove-delegation", "mailbox.disconnect", "mailbox.set-default",
    "mailbox.set-account-client",
  ]),
  "mailbox.delete-account": accounts("delete"),
  ...rows(settings("view"), ["mailbox.sending-domains", "mailbox.client-maps", "mailbox.check-unsubscribe-proxy"]),
  ...rows(settings("edit"), [
    "mailbox.check-domain", "mailbox.add-sending-domain", "mailbox.refresh-sending-domain", "mailbox.set-sending-domain",
    "mailbox.clear-reputation-hold", "mailbox.add-client-map", "mailbox.remove-client-map",
  ]),
  ...rows(ADMIN_ONLY, ["mailbox.preferences-load", "mailbox.preferences-save", "mailbox.sync-skills"]),

  // ── agent tools: the same permission as the page action ──
  ...tools(mail("view"), [
    "list-mailboxes", "list-inbox", "list-email-templates", "list-threads", "search-mail", "get-message",
    "get-attachment", "mail-status",
  ]),
  ...tools(mail("create"), ["create-draft", "send-draft", "create-email-template"]),
  ...tools(mail("edit"), ["update-draft", "mark-read", "correct-triage"]),
  ...tools(settings("view"), ["list-sending-domains", "sender-domain-health", "list-client-mail-maps"]),
  // check-sender-domain refreshes the provider's status and starts watching the domain unless `watch` is false.
  ...tools(settings("edit"), ["check-sender-domain", "add-sending-domain", "map-client-mail", "remove-client-mail-map"]),

  // ── API routes ──
  "api:oauth-complete": accounts("create"),
  "api:setup-status": settings("view"),
  "api:cockpit": mail("view"),
});
