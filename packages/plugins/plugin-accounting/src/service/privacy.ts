/**
 * Erasing one person from the books (audit Q10-13, POPIA).
 *
 * Accounting is where the law makes a company keep a person's trace: posted
 * journals are accounting records (Companies Act s24, Tax Administration Act s29
 * and VAT Act s55: five to seven years), and the journal hash chain would break
 * if one were edited. So the answer to an erasure request is mostly `retained`,
 * with the reason, and what can go does go:
 *
 * - closed receivables and payables projected from Billing lose the name and the
 *   payer references (`open_items`); an item still owed stays until it is paid;
 * - journals and bank statement lines that name the person are counted and
 *   reported as kept, never edited.
 *
 * The request carries a person's approval (the kit refuses one without it).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, registerEraseReceiver, type ContactEraseRequested, type EraseOutcome } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";

const RETENTION = "Companies Act s24 (7 years) and Tax Administration Act s29 / VAT Act s55 (5 years): accounting records are kept.";

export async function eraseFromBooks(ctx: PluginContext, request: ContactEraseRequested, companyId: string): Promise<EraseOutcome> {
  const counts: Record<string, number> = {};
  const retained: Array<{ what: string; why: string }> = [];
  const subject = request.subject;
  const clientKind = subject.clientKind === "company" || subject.clientKind === "contact" ? subject.clientKind : subject.contactId ? "contact" : null;
  const clientRef = subject.clientRef ?? subject.contactId ?? null;
  if (clientKind && clientRef) {
    const anonymised = await db.anonymiseClosedOpenItems(ctx.db, companyId, clientKind, clientRef);
    if (anonymised > 0) counts.open_items = anonymised;
    const owed = await db.countOpenItemsStillOwed(ctx.db, companyId, clientKind, clientRef);
    if (owed > 0) retained.push({ what: `${owed} receivable${owed === 1 ? "" : "s"} or payable${owed === 1 ? "" : "s"} still owed`, why: "Money is still owed, so the item and its name stay until it is settled; a later request clears it." });
    const journals = await db.countJournalsForClient(ctx.db, companyId, clientKind, clientRef);
    if (journals > 0) retained.push({ what: `${journals} posted journal${journals === 1 ? "" : "s"} naming the client`, why: `${RETENTION} The audit hash chain forbids editing a posted journal.` });
  }
  const mentions = await db.countBankLinesMentioning(ctx.db, companyId, [subject.email ?? "", subject.phone ?? ""]);
  if (mentions > 0) retained.push({ what: `${mentions} bank statement line${mentions === 1 ? "" : "s"} with the person's email or phone in the text`, why: `${RETENTION} Statement lines are the bank's record and are not edited.` });
  return { counts, retained };
}

/** Subscribes to the CRM's approved erasure requests (call once in `setup`). */
export function registerAccountingErasure(ctx: PluginContext): void {
  registerEraseReceiver(ctx, { plugin: PIB_PLUGINS.accounting, erase: (request, companyId) => eraseFromBooks(ctx, request, companyId) });
}
