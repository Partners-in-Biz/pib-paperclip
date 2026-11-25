/**
 * Email cards on a planning canvas (PAR-14389 plan C.2 Mailbox row, Q&A 6, Risk 2).
 *
 * One kind, `card-mail` (the id is the message id), with `resolve` and `related` and no `search`: the Mailbox
 * adds no new way of listing mail (Risk 2). Who may see a card is who may open it through `mailbox.get-message`
 * on the Mailbox page: any person of the company (the page reads mail company-wide today). The kit
 * (`registerCanvasCards`) answers agents, restricted members and an unreadable restriction before a kind runs.
 *
 * A card shows the subject, the other party's address, the date and sent or received; never the body or the
 * snippet. A client message (`private-mail.ts`) shows its subject only.
 */
import { PIB_PLUGINS, capCardText, type CanvasCardCall, type CanvasCardInput, type CanvasCardKind, type MailAddress } from "@partnersinbiz/pib-plugin-kit";
import { MAIL_CARD } from "./constants.js";
import { MAIL_FOR_CLIENT_MAX, type SqlStore } from "./db.js";
import { sendingDomain } from "./dns.js";
import { isFreeMailDomain } from "./free-mail.js";
import type { MessageRow } from "./gmail/types.js";

export { MAIL_CARD };

/** CRM card types a `related` call can name (`of.type`). */
const CRM_CARD_KINDS: Record<string, "company" | "contact"> = { "card-company": "company", "card-contact": "contact" };
const NO_SUBJECT = "(no subject)";
/** A subject is cut here (the kit allows 200): a long "Re: Fwd: ..." line would push the date and "Open" out of a board-sized card. */
export const MAIL_CARD_TITLE_MAX = 120;

export interface MailCardDeps {
  store: () => SqlStore;
  /** True for a client message (the page's own check, `worker.ts` `isPrivateMessage`). */
  isPrivate: (companyId: string, row: MessageRow) => Promise<boolean>;
}

/** The Mailbox page link that opens this mail. */
export function mailHref(id: string): string {
  return `/mailbox?tab=inbox&mail=${encodeURIComponent(id)}`;
}

function firstEmail(list: MailAddress[] | null | undefined): string | null {
  for (const a of list ?? []) if (a && typeof a.email === "string" && a.email) return a.email;
  return null;
}

function mailStatus(row: MessageRow): string {
  if (row.direction === "inbound") return "Received";
  if (row.status === "draft") return "Draft";
  if (row.status === "queued") return "Sending";
  return "Sent";
}

/** A card for one message. Never the body or snippet; a client message keeps its subject only. */
export function mailCard(row: MessageRow, isPrivate: boolean): CanvasCardInput {
  const title = capCardText(row.subject?.trim() || NO_SUBJECT, MAIL_CARD_TITLE_MAX);
  const href = mailHref(row.id);
  if (isPrivate) return { id: row.id, title, href };
  const inbound = row.direction === "inbound";
  const other = inbound ? (row.from_addr?.email ?? null) : firstEmail(row.to_addrs);
  const date = (row.received_at ?? row.created_at ?? "").slice(0, 10);
  // The address goes in the subtitle (200 characters), so a long one keeps its domain; a meta value is cut at 80.
  return {
    id: row.id,
    title,
    subtitle: other ? `${inbound ? "From" : "To"} ${other}` : null,
    status: mailStatus(row),
    meta: date ? [{ label: "Date", value: date }] : [],
    href,
  };
}

async function cardsOf(deps: MailCardDeps, companyId: string, rows: MessageRow[]): Promise<CanvasCardInput[]> {
  const cards: CanvasCardInput[] = [];
  for (const row of rows) cards.push(mailCard(row, await deps.isPrivate(companyId, row)));
  return cards;
}

/** What the Mailbox matches a CRM client on: a contact by its addresses, a company by its domain (not a free-mail one). */
function clientAddresses(client: { kind: "company" | "contact"; domain: string | null; emails: string[] }) {
  if (client.kind === "contact") return { emails: client.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")), domains: [] as string[] };
  const domain = sendingDomain(client.domain);
  return { emails: [] as string[], domains: domain && !isFreeMailDomain(domain) ? [domain] : [] };
}

export function mailCardKind(deps: MailCardDeps): CanvasCardKind {
  return {
    type: MAIL_CARD,
    async resolve(ids: string[], call: CanvasCardCall) {
      return cardsOf(deps, call.companyId, await deps.store().messagesByIds(call.companyId, ids));
    },
    search: false,
    async related({ of }, call: CanvasCardCall) {
      const kind = of.plugin === PIB_PLUGINS.crm ? CRM_CARD_KINDS[of.type] : undefined;
      if (!kind) return [];
      const store = deps.store();
      // Only a client this company's CRM knows; another company's id or a deleted record answers nothing.
      const client = kind === "company" ? await store.crmCompany(call.companyId, of.id) : await store.crmContact(call.companyId, of.id);
      if (!client) return [];
      const rows = await store.mailForClient(call.companyId, { kind, id: client.id, ...clientAddresses(client) });
      return [{ relation: "emails", label: "Emails", cards: await cardsOf(deps, call.companyId, rows), more: rows.length >= MAIL_FOR_CLIENT_MAX }];
    },
  };
}
